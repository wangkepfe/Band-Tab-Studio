/* ============================================================================
 * drum-roll.js  —  Canvas 2D multi-lane drum grid with full edit support.
 *
 * Requires drum-tab-core.js (uses DrumTabCore.LANES / TYPE_TO_IDX).
 *
 * DrumRoll.create(canvas[, opts]) → controller
 *
 * Edit features:
 *   Select tool  — click to select, shift-click to add/remove, drag to move,
 *                  drag empty space for rubber-band selection
 *   Draw tool    — click empty space to add hit, click existing hit to delete
 *   Velocity lane — drag bars to adjust per-hit velocity
 *   Undo / Redo   — full history (Ctrl-Z / Ctrl-Shift-Z / Ctrl-Y)
 *   Delete        — Del / Backspace removes selected hits
 *   Select all    — Ctrl-A
 *   Escape        — clear selection
 *
 * Layout:
 *   ┌──────────┬────── time ruler (HEADER_H) ──────────────────┐
 *   │ labels   │  lanes × N_LANES   (scrolls horizontally)     │
 *   │ (LABEL_W)├────── velocity lane (VEL_H) ──────────────────┤
 *   │          │  scrollbar (SB_H)                              │
 *   └──────────┴────────────────────────────────────────────────┘
 * ========================================================================== */
var DrumRoll = (function () {
  'use strict';

  var HEADER_H = 36;
  var LABEL_W  = 72;
  var LANE_H   = 44;
  var VEL_H    = 56;
  var SB_H     = 12;
  var HIT_PAD  = 5;
  var MAX_HIST = 80;

  var C = {
    bg:      '#0e1117', bgAlt:  '#111820',
    panel:   '#161b22', panel2: '#1c2230',
    line:    '#2b3240', line2:  '#1e2633',
    ink:     '#e6edf3', muted:  '#8b97a7',
    dim:     '#3a4455', play:   '#ffcf4d',
    sel:     'rgba(79,157,255,0.18)',
    selBdr:  'rgba(79,157,255,0.75)',
  };

  var LANES = (typeof DrumTabCore !== 'undefined') ? DrumTabCore.LANES : [];

  var _uid = 1;   // monotonic hit-ID counter

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function roundRect(cx, x, y, w, h, r) {
    if (w < 1 || h < 1) return;
    r = Math.min(r, w / 2, h / 2);
    if (cx.roundRect) { cx.beginPath(); cx.roundRect(x, y, w, h, r); return; }
    cx.beginPath();
    cx.moveTo(x + r, y); cx.lineTo(x + w - r, y); cx.arcTo(x + w, y, x + w, y + r, r);
    cx.lineTo(x + w, y + h - r); cx.arcTo(x + w, y + h, x + w - r, y + h, r);
    cx.lineTo(x + r, y + h); cx.arcTo(x, y + h, x, y + h - r, r);
    cx.lineTo(x, y + r); cx.arcTo(x, y, x + r, y, r);
    cx.closePath();
  }

  // ---- factory ---------------------------------------------------------------
  function create(canvas, opts) {
    opts = opts || {};
    var onEdit    = opts.onEdit    || null;  // callback(events[]) on any change
    var onHistory = opts.onHistory || null;  // callback(canUndo, canRedo) for button states
    var onTool    = opts.onTool    || null;  // callback(tool) so the toolbar can follow keyboard tool changes
    var onSeek    = opts.onSeekSeconds || null; // callback(sec) — click/scrub the timeline to move the playhead
    var isPlaying = opts.isPlaying || null;  // () => bool — drives play-time auto-follow of the playhead
    var modalOpen = opts.modalOpen || null;  // () => bool — a dialog is open, so stand down on hotkeys

    var cx  = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var W = 0, H = 0;

    // ---- playhead overlay ----------------------------------------------------
    // Same trick as the piano roll: a transparent canvas stacked over the grid,
    // carrying only the play cursor. render() here is eight passes over every lane,
    // every beat line and all ~1,800 hits (drawn twice — grid and velocity lane),
    // and setPlayhead used to call it every frame purely to shift a dashed line.
    // At the default zoomFit the grid cannot even scroll (maxScrollX() is 0), so
    // that repaint was redrawing a pixel-identical image sixty times a second.
    //
    // Drawing on top is faithful to the old z-order: the cursor was painted after
    // the lanes, hits, header and labels and before the scrollbar, and it is bounded
    // to x >= LABEL_W and y < sbTop(), so it never covered the labels or the
    // scrollbar then either.
    var over = document.createElement('canvas');
    over.style.cssText = 'position:absolute;top:0;left:0;display:block;pointer-events:none';
    var octx = over.getContext('2d');
    var phLastX = -1;
    // Start collapsed. A fresh <canvas> defaults to a 300x150 box, and until the
    // first sync (which cannot happen while the pane is hidden and measures 0)
    // that phantom box would sit over the top-left corner of the view.
    over.width = over.height = 0;


    // ---- state ---------------------------------------------------------------
    var st = {
      data:     null,   // { events, tempo, duration } from backend
      events:   [],     // editable copy with _id on each hit
      sel:      new Set(),
      scrollX:  0,
      zoom:     80,
      playhead: -1,
      tool:     'select',  // 'select' | 'draw'
      snap:     true,
      gridSub:  16,        // 4 / 8 / 16 / 32
      gridOffset: 0,       // bar-grid shift in seconds (notes stay put, the grid moves)
    };

    var history = [], future = [];
    var drag = null;  // current interaction

    // ---- geometry ------------------------------------------------------------
    function gridW()      { return Math.max(10, W - LABEL_W); }
    function gridH()      { return LANES.length * LANE_H; }
    function velTop()     { return HEADER_H + gridH(); }
    function sbTop()      { return velTop() + VEL_H; }
    function contentW()   { return st.data ? Math.max(1, st.data.duration * st.zoom) : 0; }
    function maxScrollX() { return Math.max(0, contentW() - gridW()); }
    function timeToX(t)   { return LABEL_W - st.scrollX + t * st.zoom; }
    function xToTime(x)   { return (x - LABEL_W + st.scrollX) / st.zoom; }
    function yToLane(y)   { return Math.floor((y - HEADER_H) / LANE_H); }

    function inGrid(x, y) { return x >= LABEL_W && y >= HEADER_H && y < velTop(); }
    function inVel(x, y)  { return x >= LABEL_W && y >= velTop() && y < sbTop(); }
    function inSB(x, y)   { return x >= LABEL_W && y >= sbTop()  && y < sbTop() + SB_H; }

    function snapTime(t) {
      if (!st.snap || !st.data || !st.data.tempo) return Math.max(0, t);
      var g = (60 / st.data.tempo) / (st.gridSub / 4), o = st.gridOffset || 0;
      return Math.max(0, Math.round((t - o) / g) * g + o);   // snap relative to the (shifted) bar grid
    }

    function hitW() { return Math.max(5, st.zoom / 18); }

    // ---- hit testing ---------------------------------------------------------
    function hitTol() { return hitW() / 2 / st.zoom + 0.001; }

    function hitAtXY(x, y) {
      if (!inGrid(x, y)) return null;
      var li = yToLane(y);
      if (li < 0 || li >= LANES.length) return null;
      var t = xToTime(x), hwSec = hitW() / st.zoom, eps = 3 / st.zoom;
      var best = null, bd = Infinity;
      st.events.forEach(function (ev) {
        if (DrumTabCore.TYPE_TO_IDX[ev.type] !== li) return;
        if (t < ev.time_sec - eps || t > ev.time_sec + hwSec + eps) return;
        var d = Math.abs(t - (ev.time_sec + hwSec * 0.5));
        if (d < bd) { bd = d; best = ev; }
      });
      return best;
    }

    function velHitAtXY(x, y) {
      if (!inVel(x, y)) return null;
      var t = xToTime(x), hwSec = hitW() / st.zoom, eps = 3 / st.zoom;
      var best = null, bd = Infinity;
      st.events.forEach(function (ev) {
        if (t < ev.time_sec - eps || t > ev.time_sec + hwSec + eps) return;
        var d = Math.abs(t - ev.time_sec);
        if (d < bd) { bd = d; best = ev; }
      });
      return best;
    }

    // ---- history -------------------------------------------------------------
    function snap_()     { return JSON.parse(JSON.stringify(st.events)); }
    function notifyHist(){ if (onHistory) onHistory(history.length > 0, future.length > 0); }

    function commit(pre) {
      history.push(pre);
      if (history.length > MAX_HIST) history.shift();
      future = [];
      notifyHist();
    }

    function saveAndApply(newEvents) {
      commit(snap_());
      st.events = newEvents;
      st.events.sort(function (a, b) { return a.time_sec - b.time_sec; });
      if (onEdit) onEdit(st.events);
      render();
    }

    function undo() {
      if (!history.length) return;
      future.push(snap_());
      st.events = history.pop();
      st.sel.clear();
      notifyHist();
      if (onEdit) onEdit(st.events);
      render();
    }

    function redo() {
      if (!future.length) return;
      history.push(snap_());
      st.events = future.pop();
      st.sel.clear();
      notifyHist();
      if (onEdit) onEdit(st.events);
      render();
    }

    // ---- hit CRUD ------------------------------------------------------------
    function makeHit(type, t, vel) {
      return { _id: _uid++, time_sec: t, type: type, velocity: vel || 100 };
    }

    function addHit(laneIdx, rawT) {
      var t = snapTime(rawT);
      // reject duplicate at same snap position in this lane
      var type = LANES[laneIdx].id;
      var tol  = (60 / (st.data ? st.data.tempo : 120)) / (st.gridSub / 4) * 0.4;
      if (st.events.some(function (ev) { return ev.type === type && Math.abs(ev.time_sec - t) < tol; })) return;
      var copy = snap_();
      var hit  = makeHit(type, t, 100);
      commit(copy);
      st.events.push(hit);
      st.events.sort(function (a, b) { return a.time_sec - b.time_sec; });
      st.sel.clear(); st.sel.add(hit._id);
      if (onEdit) onEdit(st.events);
      render();
    }

    function deleteSelected() {
      if (!st.sel.size) return;
      var ids = st.sel;
      saveAndApply(st.events.filter(function (ev) { return !ids.has(ev._id); }));
      st.sel.clear();
    }

    function selectAll() {
      st.sel.clear();
      st.events.forEach(function (ev) { st.sel.add(ev._id); });
      render();
    }

    // Advanced quantize (whole track) via QuantizeCore — swing / bias / strength.
    // Quantizes relative to the shifted bar grid so it respects the grid offset.
    function quantizeAdvanced(o) {
      if (!st.events.length) return 0;
      commit(snap_());
      var g = o.gridSec, origin = st.gridOffset || 0;
      st.events.forEach(function (ev) {
        var nt = QuantizeCore.snap((ev.time_sec || 0) - origin, g, o) + origin;
        ev.time_sec = Math.max(0, nt);
      });
      st.events.sort(function (a, b) { return a.time_sec - b.time_sec; });
      st.sel.clear();
      if (onEdit) onEdit(st.events);
      render();
      return st.events.length;
    }

    // ---- rendering -----------------------------------------------------------
    function render() {
      cx.clearRect(0, 0, W, H);
      drawLaneBg();
      drawGrid();
      drawHits();
      if (drag && drag.mode === 'rubber') drawRubberBand();
      drawVelLane();
      drawHeader();
      drawLabels();
      drawScrollbar();
      drawPlayheadLayer();     // cursor lives on the overlay; keep it after a repaint
    }

    // Repaint ONLY the play cursor, clearing just the band the last one occupied
    // (a full retina-canvas clear is megabytes of writes per frame).
    function drawPlayheadLayer() {
      if (W <= 0 || H <= 0) return;
      var bot = sbTop();
      if (phLastX >= 0) octx.clearRect(phLastX - 7, 0, 14, bot);
      phLastX = -1;
      if (st.playhead < 0) return;
      var x = timeToX(st.playhead);
      if (x < LABEL_W || x > W) return;
      octx.strokeStyle = C.play; octx.lineWidth = 1.5;
      octx.setLineDash([3, 3]);
      octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, bot); octx.stroke();
      octx.setLineDash([]);
      octx.fillStyle = C.play;
      octx.beginPath(); octx.moveTo(x - 5, 0); octx.lineTo(x + 5, 0); octx.lineTo(x, 9); octx.closePath(); octx.fill();
      phLastX = x;
    }

    function drawLaneBg() {
      for (var i = 0; i < LANES.length; i++) {
        cx.fillStyle = i % 2 === 0 ? C.bg : C.bgAlt;
        cx.fillRect(LABEL_W, HEADER_H + i * LANE_H, gridW(), LANE_H);
      }
      cx.strokeStyle = C.line2; cx.lineWidth = 0.5;
      for (var j = 1; j < LANES.length; j++) {
        var ly = HEADER_H + j * LANE_H - 0.5;
        cx.beginPath(); cx.moveTo(LABEL_W, ly); cx.lineTo(W, ly); cx.stroke();
      }
    }

    function drawGrid() {
      if (!st.data || !st.data.tempo) return;
      var spb = 60 / st.data.tempo, o = st.gridOffset || 0;
      var t0  = xToTime(LABEL_W) - spb;
      var t1  = xToTime(W) + spb;
      var top = HEADER_H, bot = velTop();

      // All of these are vertical lines that differ only by stroke style, so they
      // go down as ONE path per style instead of a beginPath/stroke per line. Same
      // pixels; a screenful of beats was ~230 separate path submissions per frame,
      // and this is the pass that still has to run whenever the grid scrolls under
      // the playhead. Three strokes now, whatever the zoom.
      function strokeAll(xs, style, width) {
        if (!xs.length) return;
        cx.strokeStyle = style; cx.lineWidth = width;
        cx.beginPath();
        for (var i = 0; i < xs.length; i++) { cx.moveTo(xs[i], top); cx.lineTo(xs[i], bot); }
        cx.stroke();
      }

      // subdivision grid lines (faint) — indexed from the (shifted) grid origin
      if (st.gridSub > 4 && st.zoom > 40) {
        var spg = spb / (st.gridSub / 4);
        var gS = Math.floor((t0 - o) / spg), gE = Math.ceil((t1 - o) / spg);
        var subs = [];
        for (var g = gS; g <= gE; g++) {
          var gx = timeToX(o + g * spg);
          if (gx < LABEL_W || gx > W) continue;
          if (((g % (st.gridSub / 4)) + (st.gridSub / 4)) % (st.gridSub / 4) === 0) continue; // beat lines drawn below
          subs.push(gx);
        }
        strokeAll(subs, 'rgba(43,50,64,0.6)', 0.5);
      }

      // beat / bar lines
      var bS = Math.floor((t0 - o) / spb), bE = Math.ceil((t1 - o) / spb);
      var bars = [], beats = [];
      for (var b = bS; b <= bE; b++) {
        var bx = timeToX(o + b * spb);
        if (bx < LABEL_W - 1 || bx > W + 1) continue;
        (((b % 4) + 4) % 4 === 0 ? bars : beats).push(bx);
      }
      // Every 4th beat IS the bar line, so the two sets are disjoint by construction
      // and never share an x — splitting the one interleaved loop into two passes
      // cannot change which line wins anywhere.
      strokeAll(beats, C.line2, 0.5);
      strokeAll(bars, C.line, 1.0);
    }

    function drawHits() {
      if (!st.events.length) return;
      var t0 = xToTime(LABEL_W) - 0.2, t1 = xToTime(W) + 0.2;
      var hw = hitW();

      st.events.forEach(function (ev) {
        if (ev.time_sec < t0 || ev.time_sec > t1) return;
        var idx = DrumTabCore.TYPE_TO_IDX[ev.type];
        if (idx === undefined) return;
        var lane = LANES[idx];
        var x       = timeToX(ev.time_sec);
        var laneTop = HEADER_H + idx * LANE_H + HIT_PAD;
        var fullH   = LANE_H - HIT_PAD * 2;
        var isSel   = st.sel.has(ev._id);

        // Velocity → visual weight. Softer hits read shorter + more transparent,
        // harder hits taller + opaque (both cues move together for a clear accent
        // feel). Floors keep even ghost notes legible; a full-velocity hit fills
        // the lane exactly as before. Bar stays centred in the lane.
        var vel   = clamp((ev.velocity || 100) / 127, 0, 1);
        var h     = fullH * (0.45 + 0.55 * vel);
        var y     = laneTop + (fullH - h) / 2;
        var alpha = 0.45 + 0.55 * vel;

        cx.fillStyle   = lane.color;
        cx.globalAlpha = isSel ? 1.0 : alpha;
        roundRect(cx, x, y, hw, h, 3);
        cx.fill();

        if (isSel) {
          cx.strokeStyle = '#fff';
          cx.lineWidth   = 1.5;
          cx.globalAlpha = 0.85;
          roundRect(cx, x, y, hw, h, 3);
          cx.stroke();
        }
        cx.globalAlpha = 1;
      });
    }

    function drawRubberBand() {
      var r  = drag.rect;
      var x0 = Math.max(LABEL_W, Math.min(r.x0, r.x1));
      var x1 = Math.max(LABEL_W, Math.max(r.x0, r.x1));
      var y0 = Math.max(HEADER_H, Math.min(r.y0, r.y1));
      var y1 = Math.min(velTop(), Math.max(r.y0, r.y1));
      if (x1 <= x0 || y1 <= y0) return;
      cx.fillStyle   = C.sel;
      cx.strokeStyle = C.selBdr;
      cx.lineWidth   = 1;
      cx.beginPath(); cx.rect(x0, y0, x1 - x0, y1 - y0);
      cx.fill(); cx.stroke();
    }

    function drawVelLane() {
      var vy = velTop();
      cx.fillStyle = C.panel2;
      cx.fillRect(LABEL_W, vy, gridW(), VEL_H);
      cx.fillStyle = C.line;
      cx.fillRect(LABEL_W, vy, gridW(), 1);

      // label
      cx.fillStyle   = C.dim;
      cx.font        = '9.5px sans-serif';
      cx.textAlign   = 'right';
      cx.textBaseline = 'middle';
      cx.fillText('vel', LABEL_W - 8, vy + VEL_H / 2);

      var t0 = xToTime(LABEL_W) - 0.2, t1 = xToTime(W) + 0.2;
      st.events.forEach(function (ev) {
        if (ev.time_sec < t0 || ev.time_sec > t1) return;
        var idx = DrumTabCore.TYPE_TO_IDX[ev.type];
        if (idx === undefined) return;
        var lane  = LANES[idx];
        var x     = timeToX(ev.time_sec);
        var vel   = clamp((ev.velocity || 100) / 127, 0, 1);
        var barH  = Math.max(2, Math.round(vel * (VEL_H - 6)));
        var isSel = st.sel.has(ev._id);

        cx.fillStyle   = isSel ? '#ffffff' : lane.color;
        cx.globalAlpha = isSel ? 0.95 : 0.65;
        cx.fillRect(x, vy + VEL_H - 3 - barH, 5, barH);
        cx.globalAlpha = 1;
      });
    }

    function drawHeader() {
      cx.fillStyle = C.panel;
      cx.fillRect(0, 0, W, HEADER_H);
      cx.fillStyle = C.line;
      cx.fillRect(LABEL_W, HEADER_H - 1, W - LABEL_W, 1);
      if (!st.data || !st.data.tempo) return;

      var spb = 60 / st.data.tempo, spbar = spb * 4, o = st.gridOffset || 0;
      var t0  = xToTime(LABEL_W) - spbar, t1 = xToTime(W) + spbar;
      var bS  = Math.floor((t0 - o) / spbar), bE = Math.ceil((t1 - o) / spbar);

      cx.textBaseline = 'middle'; cx.textAlign = 'left';
      for (var bar = bS; bar <= bE; bar++) {
        var bx = timeToX(o + bar * spbar);
        if (bx > W + 1) break;
        if (bx < LABEL_W - 1 || bar < 0) continue;   // don't number bars left of the grid origin
        cx.font = 'bold 11px monospace'; cx.fillStyle = C.ink;
        cx.fillText(bar + 1, bx + 3, HEADER_H / 2);
        for (var beat = 1; beat < 4; beat++) {
          var bx2 = timeToX(o + bar * spbar + beat * spb);
          if (bx2 > LABEL_W && bx2 < W) {
            cx.font = '10px monospace'; cx.fillStyle = C.muted;
            cx.fillText(beat + 1, bx2 + 2, HEADER_H / 2);
          }
        }
      }
    }

    function drawLabels() {
      cx.fillStyle = C.panel;
      cx.fillRect(0, 0, LABEL_W, H);
      cx.fillStyle = C.line;
      cx.fillRect(LABEL_W - 1, 0, 1, H);
      cx.textBaseline = 'middle'; cx.textAlign = 'right';

      for (var i = 0; i < LANES.length; i++) {
        var lane = LANES[i];
        var midY = HEADER_H + i * LANE_H + LANE_H / 2;
        cx.fillStyle = lane.color; cx.globalAlpha = 0.7;
        cx.fillRect(7, HEADER_H + i * LANE_H + 9, 3, LANE_H - 18);
        cx.globalAlpha = 1;
        cx.font = 'bold 12px monospace'; cx.fillStyle = C.muted;
        cx.fillText(lane.label, LABEL_W - 10, midY - 5);
        cx.font = '9.5px sans-serif';    cx.fillStyle = C.dim;
        cx.fillText(lane.name, LABEL_W - 10, midY + 7);
      }
    }

    function drawScrollbar() {
      var total = contentW(), view = gridW(), sby = sbTop();
      cx.fillStyle = C.panel2;
      cx.fillRect(LABEL_W, sby, view, SB_H);
      if (total <= view) return;
      var thumbW = Math.max(24, view * view / total);
      var range  = view - thumbW;
      var thumbX = LABEL_W + (range > 0 ? (st.scrollX / (total - view)) * range : 0);
      cx.fillStyle = C.dim;
      roundRect(cx, thumbX + 2, sby + 3, thumbW - 4, SB_H - 6, 3);
      cx.fill();
    }

    // ---- cursor --------------------------------------------------------------
    function updateCursor(x, y) {
      if (!st.data) { canvas.style.cursor = ''; return; }
      if (y < HEADER_H && x >= LABEL_W) { canvas.style.cursor = onSeek ? 'pointer' : 'default'; return; }
      if (inSB(x, y)) { canvas.style.cursor = 'default'; return; }
      if (inVel(x, y)) {
        canvas.style.cursor = velHitAtXY(x, y) ? 'ns-resize' : 'default';
        return;
      }
      if (inGrid(x, y)) {
        if (st.tool === 'draw') { canvas.style.cursor = 'crosshair'; return; }
        // select tool: grab over a hit, else crosshair to hint click-to-seek
        canvas.style.cursor = hitAtXY(x, y) ? 'grab' : (onSeek ? 'crosshair' : 'default');
        return;
      }
      canvas.style.cursor = 'default';
    }

    // ---- pointer interaction -------------------------------------------------
    function pxy(e) {
      var r = canvas.getBoundingClientRect(), s = e.touches ? e.touches[0] : e;
      return { x: s.clientX - r.left, y: s.clientY - r.top };
    }

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {                            // ctrl/cmd + wheel = zoom (timeline scaling), anchored at the pointer
        var p = pxy(e), tAnchor = xToTime(p.x), f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        st.zoom = clamp(st.zoom * f, 10, 800);
        st.scrollX = clamp(LABEL_W + tAnchor * st.zoom - p.x, 0, maxScrollX());
        render(); return;
      }
      var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      st.scrollX = clamp(st.scrollX + d, 0, maxScrollX());
      render();
    }, { passive: false });
    canvas.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });   // suppress middle-click autoscroll

    canvas.addEventListener('pointermove', function (e) {
      if (!e.isPrimary) return;            // ignore extra touch fingers
      var p = pxy(e);
      if (!drag) { updateCursor(p.x, p.y); return; }

      if (drag.mode === 'sb') {
        st.scrollX = clamp(drag.s0 + (p.x - drag.sx) * drag.ratio, 0, maxScrollX());
        render(); return;
      }
      if (drag.mode === 'pan') {
        st.scrollX = clamp(drag.s0 - (p.x - drag.sx), 0, maxScrollX());
        render(); return;
      }
      if (drag.mode === 'seek') {
        if (onSeek) onSeek(Math.max(0, xToTime(p.x)));
        return;
      }
      if (drag.mode === 'vel') {
        var dv = (drag.y0 - p.y) / VEL_H * 127;
        drag.ev.velocity = clamp(Math.round(drag.v0 + dv), 1, 127);
        render(); return;
      }
      if (drag.mode === 'move') {
        var rawDt = xToTime(p.x) - drag.mt0, free = e.ctrlKey || e.metaKey;   // Ctrl/Cmd = ignore snap (fine adjust)
        if (Math.abs(rawDt) > 0.003) drag.moved = true;
        st.events.forEach(function (ev) {
          if (!st.sel.has(ev._id)) return;
          var orig = drag.origT[ev._id];
          if (orig !== undefined) ev.time_sec = Math.max(0, free ? orig + rawDt : snapTime(orig + rawDt));
        });
        render(); return;
      }
      if (drag.mode === 'rubber') {
        drag.rect.x1 = p.x; drag.rect.y1 = p.y;
        render(); return;
      }
    });

    canvas.addEventListener('pointerdown', function (e) {
      if (!e.isPrimary) return;            // only the primary pointer drives a gesture
      canvas.focus();
      var p = pxy(e), shift = e.shiftKey;

      // middle-button drag = pan the view
      if (e.button === 1) { e.preventDefault(); drag = { mode: 'pan', sx: p.x, s0: st.scrollX }; canvas.setPointerCapture(e.pointerId); return; }

      // timeline (header ruler) = seek / scrub the playhead
      if (onSeek && st.data && p.y < HEADER_H && p.x >= LABEL_W) {
        onSeek(Math.max(0, xToTime(p.x)));
        drag = { mode: 'seek' };
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      // scrollbar
      if (inSB(p.x, p.y)) {
        var tot = contentW(), vw = gridW();
        var tw  = Math.max(24, vw * vw / tot);
        var rng = vw - tw;
        drag = { mode: 'sb', sx: p.x, s0: st.scrollX, ratio: rng > 0 ? (tot - vw) / rng : 1 };
        canvas.setPointerCapture(e.pointerId); return;
      }

      // velocity lane
      if (inVel(p.x, p.y)) {
        var vhit = velHitAtXY(p.x, p.y);
        if (vhit) {
          drag = { mode: 'vel', ev: vhit, v0: vhit.velocity || 100, y0: p.y, pre: snap_() };
          canvas.setPointerCapture(e.pointerId);
        }
        return;
      }

      // grid
      if (!inGrid(p.x, p.y)) return;
      var hit = hitAtXY(p.x, p.y);

      if (st.tool === 'draw') {
        if (hit) {
          // delete
          saveAndApply(st.events.filter(function (ev) { return ev._id !== hit._id; }));
          st.sel.delete(hit._id);
        } else {
          var li = yToLane(p.y);
          if (li >= 0 && li < LANES.length) addHit(li, xToTime(p.x));
        }
        return;
      }

      // select tool
      if (hit) {
        if (shift) {
          if (st.sel.has(hit._id)) st.sel.delete(hit._id); else st.sel.add(hit._id);
        } else {
          if (!st.sel.has(hit._id)) { st.sel.clear(); st.sel.add(hit._id); }
        }
        if (e.altKey) {                                  // alt-drag = duplicate (copy) the selection, then drag the copies
          var preC = snap_(), clones = [];
          st.events.filter(function (ev) { return st.sel.has(ev._id); }).forEach(function (ev) {
            var c = makeHit(ev.type, ev.time_sec, ev.velocity); st.events.push(c); clones.push(c._id);
          });
          st.events.sort(function (a, b) { return a.time_sec - b.time_sec; });
          st.sel = new Set(clones);
          var origC = {}; st.sel.forEach(function (id) { var ev = st.events.find(function (ev) { return ev._id === id; }); if (ev) origC[id] = ev.time_sec; });
          drag = { mode: 'move', mt0: xToTime(p.x), origT: origC, pre: preC, moved: true };
          canvas.setPointerCapture(e.pointerId); render(); return;
        }
        // prepare move drag
        var origT = {};
        st.sel.forEach(function (id) {
          var ev = st.events.find(function (ev) { return ev._id === id; });
          if (ev) origT[id] = ev.time_sec;
        });
        drag = { mode: 'move', mt0: xToTime(p.x), origT: origT, pre: snap_(), moved: false, shift: shift };
        canvas.setPointerCapture(e.pointerId);
      } else if (e.pointerType === 'touch') {     // one-finger drag on empty grid = pan (rubber-select is mouse-only)
        drag = { mode: 'pan', sx: p.x, s0: st.scrollX };
        canvas.setPointerCapture(e.pointerId);
      } else {
        if (!shift) st.sel.clear();
        drag = { mode: 'rubber', rect: { x0: p.x, y0: p.y, x1: p.x, y1: p.y }, shift: shift };
        canvas.setPointerCapture(e.pointerId);
      }
      render();
    });

    // Finalize the active drag. Called by BOTH pointerup and pointercancel so an
    // interrupted gesture (touch interruption, lost pointer capture) still commits
    // — otherwise an alt-copy's clones leak into st.events with no history step and
    // without syncing onEdit (playback/persist). `e` is null on cancel (the rubber
    // selection needs the up-event's shiftKey, so it only resolves on a real up).
    function commitDrag(e) {
      if (!drag) return;
      if (drag.mode === 'vel') {
        if (drag.ev.velocity !== drag.v0) { commit(drag.pre); if (onEdit) onEdit(st.events); }
      } else if (drag.mode === 'move') {
        if (drag.moved) {
          commit(drag.pre);
          st.events.sort(function (a, b) { return a.time_sec - b.time_sec; });
          if (onEdit) onEdit(st.events);
        } else {
          // no movement — revert any tiny drift from snapping
          st.events.forEach(function (ev) {
            if (st.sel.has(ev._id) && drag.origT[ev._id] !== undefined) ev.time_sec = drag.origT[ev._id];
          });
          // a plain (non-shift) click on a hit ALSO seeks, so a click in the dense
          // grid always moves the playhead — not just a click on an empty cell.
          if (onSeek && !drag.shift) onSeek(Math.max(0, drag.mt0));
        }
      } else if (drag.mode === 'rubber' && e) {
        var r  = drag.rect;
        // A plain click on empty grid (no drag) seeks the playhead — same feel as
        // the bass tab / the header ruler. A real drag rubber-band-selects.
        if (Math.abs(r.x1 - r.x0) <= 3 && Math.abs(r.y1 - r.y0) <= 3) {
          if (onSeek && !drag.shift && r.x0 >= LABEL_W) onSeek(Math.max(0, xToTime(r.x0)));
        } else {
          var t0 = xToTime(Math.min(r.x0, r.x1)), t1 = xToTime(Math.max(r.x0, r.x1));
          var li0 = Math.max(0, yToLane(Math.min(r.y0, r.y1)));
          var li1 = Math.min(LANES.length - 1, yToLane(Math.max(r.y0, r.y1)));
          if (!e.shiftKey) st.sel.clear();
          st.events.forEach(function (ev) {
            var li = DrumTabCore.TYPE_TO_IDX[ev.type];
            if (li >= li0 && li <= li1 && ev.time_sec >= t0 && ev.time_sec <= t1) st.sel.add(ev._id);
          });
        }
      }
      drag = null;
      render();
    }
    canvas.addEventListener('pointerup', function (e) { if (!e.isPrimary) return; commitDrag(e); });
    canvas.addEventListener('pointercancel', function (e) { if (!e.isPrimary) return; commitDrag(null); });

    // ---- tool + keyboard -----------------------------------------------------
    function applyTool(t) {
      st.tool = t;
      canvas.style.cursor = t === 'draw' ? 'crosshair' : 'default';
      if (onTool) onTool(t);
      render();
    }

    // Scoped to the drum view: only acts while the drum canvas is the visible
    // editor (offsetParent is null when its pane is display:none).
    function onKey(e) {
      if (canvas.offsetParent === null) return;
      if (modalOpen && modalOpen()) return;                 // a dialog (help / library) is open — don't act behind it
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }   // selectAll() already renders
      switch (e.key) {
        case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
        case 'Escape': st.sel.clear(); render(); break;
        case 'b': case 'B': applyTool('draw'); break;
        case 'v': case 'V': if (!mod) applyTool('select'); break;
      }
    }
    document.addEventListener('keydown', onKey);

    // ---- resize --------------------------------------------------------------
    function resize() {
      dpr = window.devicePixelRatio || 1;
      var par = canvas.parentElement || canvas;
      W = par.clientWidth  || 600;
      H = par.clientHeight || (sbTop() + SB_H);
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width  = W + 'px';
      canvas.style.height = H + 'px';
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // the overlay tracks the base canvas exactly; assigning width/height also
      // wipes it, so the remembered dirty band is void
      if (!over.parentNode && canvas.parentNode) canvas.parentNode.insertBefore(over, canvas.nextSibling);
      over.width  = canvas.width;
      over.height = canvas.height;
      over.style.width  = W + 'px';
      over.style.height = H + 'px';
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      phLastX = -1;
      render();
    }

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { requestAnimationFrame(resize); })
        .observe(canvas.parentElement || canvas);
    }
    resize();

    // ---- zoom helper ---------------------------------------------------------
    function applyZoom(z) {
      var centre = xToTime(W / 2);
      st.zoom = clamp(z, 10, 800);
      st.scrollX = clamp(LABEL_W + centre * st.zoom - W / 2, 0, maxScrollX());
      render();
    }

    // ---- public API ----------------------------------------------------------
    return {
      setData: function (drumData) {
        st.data   = drumData;
        st.events = (drumData.events || []).map(function (ev) {
          return Object.assign({ _id: _uid++ }, ev);
        });
        st.gridOffset = drumData.gridOffset || 0;
        st.sel.clear();
        st.scrollX = 0;
        history = []; future = [];
        notifyHist();
        render();
      },

      clearData: function () {
        st.data = null; st.events = []; st.sel.clear(); st.scrollX = 0;
        st.gridOffset = 0;
        history = []; future = []; notifyHist(); render();
      },

      setPlayhead: function (t) {
        st.playhead = t;
        // While playing, auto-follow so the playhead rides ~30% from the left of
        // the grid. When paused/seeking, leave the view put so a click on the
        // timeline lands the cursor exactly where it was clicked.
        var sx = st.scrollX;
        if (t >= 0 && isPlaying && isPlaying()) {
          st.scrollX = clamp(t * st.zoom - (W - LABEL_W) * 0.30, 0, maxScrollX());
        }
        // Repaint the grid only if it genuinely moved. Whenever the whole song
        // fits (the default after zoomFit, where maxScrollX() is 0) it never does,
        // so playback costs one thin overlay redraw per frame instead of eight
        // full passes over every lane, beat line and hit.
        if (st.scrollX !== sx) render();
        else drawPlayheadLayer();
      },

      setTool:    function (t) { applyTool(t); },
      setSnap:    function (on) { st.snap = on; },
      setGridSub: function (n) { st.gridSub = n; render(); },
      setGridOffset: function (s) { st.gridOffset = s || 0; render(); },
      getGridOffset: function () { return st.gridOffset || 0; },
      quantizeAdvanced: quantizeAdvanced,
      getGridSub: function () { return st.gridSub; },

      zoomIn:  function () { applyZoom(st.zoom * 1.5); },
      zoomOut: function () { applyZoom(st.zoom / 1.5); },
      zoomFit: function () { if (st.data) applyZoom(gridW() / Math.max(1, st.data.duration)); },
      setZoom: function (z) { applyZoom(z); },

      undo: undo,
      redo: redo,
      hasUndo: function () { return history.length > 0; },
      hasRedo: function () { return future.length > 0; },

      selectAll:      function () { selectAll(); },   // selectAll() already renders
      deleteSelected: deleteSelected,

      getEvents: function () { return st.events; },
      render:    render,
      // render() draws at the CURRENT W/H; only resize() re-measures the parent and
      // resizes the backing store. Exported because the panel fold changes the pane's
      // height with no window resize event behind it, and the ResizeObserver above is
      // rAF-driven — so the shell asks for the re-measure directly. resize() renders.
      resize:    resize,
      debug:     function () { return { zoom: st.zoom, scrollX: st.scrollX, tool: st.tool, sel: st.sel.size, events: st.events.length, playhead: st.playhead }; },
    };
  }

  return { create: create };
})();
