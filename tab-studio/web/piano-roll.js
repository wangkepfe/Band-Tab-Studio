/* ============================================================================
 * piano-roll.js  —  Canvas 2D DAW-style piano-roll editor.
 *
 * One canvas fills the viewport; scroll/zoom are managed manually (custom
 * scrollbars) so dragging many notes stays smooth. Regions: top ruler, left
 * keyboard gutter, main note grid, bottom velocity lane.
 *
 * Project model (ticks at project PPQ):
 *   { ppq, tempo, timeSig:{num,den}, lengthTicks, notes:[{id,start,end,pitch,velocity}] }
 *
 * PianoRoll.create(canvas, opts) -> controller with load/getProject + every
 * editing command (used by the toolbar) and pointer/keyboard interaction.
 * ========================================================================== */
var PianoRoll = (function () {
  'use strict';

  // layout (CSS px)
  var RULER_H = 26, KEYS_W = 58, VEL_H = 96, SB = 12, VEL_HEAD = 16;
  var MIN_PITCH = 0, MAX_PITCH = 127, NPITCH = 128;
  var WHITE = { 0: 1, 2: 1, 4: 1, 5: 1, 7: 1, 9: 1, 11: 1 };
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var BASS_STRINGS = { 28: 'E', 33: 'A', 38: 'D', 43: 'G' };   // bass standard tuning markers (default)
  var HISTORY_CAP = 200;

  function pitchName(p) { return NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function create(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;

    // ---- playhead overlay ---------------------------------------------------
    // A second, transparent canvas stacked exactly over the first, holding nothing
    // but the play cursor. Without it, advancing the cursor meant a full render():
    // clear + grid + every visible note + velocity lane + ruler + keyboard +
    // scrollbars, ~300-400 Canvas2D calls, sixty times a second, to move a 2px
    // line. Nothing else on screen had changed. Now the base canvas repaints only
    // when the view really changes (scroll, zoom, edit, selection) and playback
    // touches this layer alone — and only the narrow band the cursor occupies.
    //
    // Safe to draw ON TOP even though render() used to draw the playhead beneath
    // the ruler/keyboard/scrollbars: drawPlayheadLayer clips itself to the grid
    // rect (x in [KEYS_W, gridRight()], y in [RULER_H, H-SB]), which is exactly the
    // region none of that chrome occupies. Same pixels, different layer.
    var over = document.createElement('canvas');
    over.style.cssText = 'position:absolute;top:0;left:0;display:block;pointer-events:none';
    var octx = over.getContext('2d');
    var ovW = 0, ovH = 0, phLastX = -1;
    // Start collapsed. A fresh <canvas> defaults to a 300x150 box, and until the
    // first sync (which cannot happen while the pane is hidden and measures 0)
    // that phantom box would sit over the top-left corner of the view.
    over.width = over.height = 0;

    if (canvas.parentNode) canvas.parentNode.insertBefore(over, canvas.nextSibling);

    // P.timelineTempo anchors the tick axis to real time: the notes were written at
    // that tempo (the transcription's own), so tick × 60/(timelineTempo × ppq) = the
    // second it sounds in the song. P.tempo is the MUSICAL tempo the user dials in —
    // it spaces the bar grid (and the metronome) without ever re-timing a note.
    var P = {                                   // project
      ppq: 480, tempo: 120, timelineTempo: 120, timeSig: { num: 4, den: 4 },
      lengthTicks: 480 * 4 * 8, notes: []
    };
    var view = { pxPerQuarter: 64, rowH: 13, scrollX: 0, scrollY: 0 };
    // grid.offset slides the bar/beat/sub-division lines in time WITHOUT touching a
    // single note — the tool for lining bar 1 up with music that starts off-grid.
    var grid = { ticks: 480 / 4, snap: true, triplet: false, offset: 0 };   // default 1/16
    var sel = new Set();
    var clipboard = [];
    var tool = 'select';                        // 'select' | 'draw'
    var playhead = 0;
    var guides = { markers: BASS_STRINGS, centerPitch: 40 };   // instrument guide markers + view centre
    var idSeq = 1;
    var undo = [], redo = [];
    var drag = null;                            // active interaction
    var W = 0, H = 0;

    // ---- geometry -----------------------------------------------------------
    function pxPerTick() { return view.pxPerQuarter / P.ppq; }
    function contentW() { return P.lengthTicks * pxPerTick(); }
    function contentH() { return NPITCH * view.rowH; }
    function gridRight() { return W - SB; }
    function gridBottom() { return H - VEL_H - SB; }
    function gridViewW() { return Math.max(10, gridRight() - KEYS_W); }
    function gridViewH() { return Math.max(10, gridBottom() - RULER_H); }
    function maxScrollX() { return Math.max(0, contentW() - gridViewW()); }
    function maxScrollY() { return Math.max(0, contentH() - gridViewH()); }
    function tickToX(t) { return KEYS_W - view.scrollX + t * pxPerTick(); }
    function xToTick(x) { return (x - KEYS_W + view.scrollX) / pxPerTick(); }
    function pitchTopY(p) { return RULER_H - view.scrollY + (MAX_PITCH - p) * view.rowH; }
    function yToPitch(y) { return MAX_PITCH - Math.floor((y - RULER_H + view.scrollY) / view.rowH); }
    function beatTicks() { return P.ppq * 4 / (P.timeSig.den || 4); }
    function barTicks() { return beatTicks() * (P.timeSig.num || 4); }
    // The grid is drawn in timeline ticks, so a musical tempo below the timeline's
    // stretches it (a 96-BPM bar covers 1.25× the ticks of a 120-BPM one) — that is
    // how the BPM box re-spaces the bars over notes that never move.
    function gridScale() { return (P.timelineTempo || P.tempo || 120) / (P.tempo || 120); }
    function beatT() { return beatTicks() * gridScale(); }
    function barT() { return barTicks() * gridScale(); }
    // The division is read as a fraction OF THE BEAT, not as a tick count: at ppq 220 a
    // 1/32 is 27.5 ticks and callers can only hand us 28, which would walk the sub-grid
    // off the beats a little more every bar. Round the ratio instead and the two grids
    // are the same grid.
    function divPerBeat() { return Math.max(1, Math.round(beatTicks() / (grid.ticks || beatTicks() / 4))); }
    function stepT() { return beatT() / divPerBeat(); }                    // one grid division
    function inGrid(x, y) { return x >= KEYS_W && x < gridRight() && y >= RULER_H && y < gridBottom(); }
    function inVel(x, y) { return x >= KEYS_W && x < gridRight() && y >= gridBottom() && y < H - SB; }
    function inRuler(x, y) { return x >= KEYS_W && y < RULER_H; }

    // Snapping follows the visible grid, so a shifted grid snaps to the shifted lines.
    function snap(tick) {
      if (!grid.snap || !grid.ticks) return Math.max(0, Math.round(tick));
      var o = grid.offset || 0, step = stepT();
      return Math.max(0, Math.round(Math.round((tick - o) / step) * step + o));
    }

    // ---- history ------------------------------------------------------------
    function snapshot() { return { notes: JSON.parse(JSON.stringify(P.notes)), sel: Array.from(sel) }; }
    function restore(s) {
      P.notes = JSON.parse(JSON.stringify(s.notes));
      sel = new Set(s.sel.filter(function (id) { return P.notes.some(function (n) { return n.id === id; }); }));
      idSeq = P.notes.reduce(function (m, n) { return Math.max(m, n.id); }, 0) + 1;
      changed();
    }
    function pushHistory(before) {
      undo.push(before); if (undo.length > HISTORY_CAP) undo.shift(); redo = [];
    }
    function undoCmd() { if (!undo.length) return; redo.push(snapshot()); restore(undo.pop()); }
    function redoCmd() { if (!redo.length) return; undo.push(snapshot()); restore(redo.pop()); }

    // ---- change notification ------------------------------------------------
    var drawQueued = false;
    function draw() { if (!drawQueued) return; drawQueued = false; render(); }
    function scheduleDraw() {
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(draw);
      setTimeout(draw, 50);   // fallback: rAF is throttled in hidden/headless tabs
    }
    function changed() {
      growLengthToFit();
      if (opts.onChange) opts.onChange();
      if (opts.onSelection) opts.onSelection(sel.size);
      scheduleDraw();
    }
    function growLengthToFit() {
      var maxEnd = P.notes.reduce(function (m, n) { return Math.max(m, n.end); }, 0);
      var bar = Math.max(1, Math.round(barT())), pad = bar * 2;
      var need = Math.ceil((maxEnd + pad) / bar) * bar;
      if (need > P.lengthTicks) P.lengthTicks = need;
    }

    // ---- note helpers -------------------------------------------------------
    function byId(id) { return P.notes.find(function (n) { return n.id === id; }); }
    function addNote(start, end, pitch, vel) {
      var n = { id: idSeq++, start: start, end: end, pitch: clamp(pitch, 0, 127), velocity: vel || 100 };
      P.notes.push(n); return n;
    }
    function selectedNotes() { return P.notes.filter(function (n) { return sel.has(n.id); }); }
    function noteHit(x, y) {
      // topmost first
      for (var i = P.notes.length - 1; i >= 0; i--) {
        var n = P.notes[i], ny = pitchTopY(n.pitch), x0 = tickToX(n.start), x1 = tickToX(n.end);
        if (y >= ny && y < ny + view.rowH && x >= x0 - 3 && x <= x1 + 3) {
          var edge = (Math.abs(x - x1) <= 5) ? 'right' : (Math.abs(x - x0) <= 5 && (x1 - x0) > 12) ? 'left' : 'body';
          return { note: n, edge: edge };
        }
      }
      return null;
    }
    function velHit(x) {
      var best = null, bestDx = 7;
      P.notes.forEach(function (n) { var dx = Math.abs(tickToX(n.start) - x); if (dx < bestDx) { bestDx = dx; best = n; } });
      return best;
    }

    // ====================================================================== //
    //  RENDER
    // ====================================================================== //
    function render() {
      W = canvas.clientWidth; H = canvas.clientHeight;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      }
      view.scrollX = clamp(view.scrollX, 0, maxScrollX());
      view.scrollY = clamp(view.scrollY, 0, maxScrollY());
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      drawGrid();
      drawNotes();
      drawVelLane();
      drawRuler();
      drawKeyboard();
      drawScrollbars();
      if (drag && drag.mode === 'marquee') drawMarquee();
      ctx.fillStyle = '#0e1117'; ctx.fillRect(0, 0, KEYS_W, RULER_H);   // top-left corner
      drawPlayheadLayer();     // the cursor lives on the overlay now, but a full
                               // repaint still has to leave it on screen
    }

    // Keep the overlay's box and backing store in step with the base canvas.
    // Assigning width/height also wipes it, so the remembered dirty band is void.
    function syncOverlay() {
      if (!over.parentNode && canvas.parentNode) canvas.parentNode.insertBefore(over, canvas.nextSibling);
      var bw = Math.round(W * dpr), bh = Math.round(H * dpr);
      if (over.width !== bw || over.height !== bh) {
        over.width = bw; over.height = bh;
        phLastX = -1;
      }
      if (ovW !== W || ovH !== H) {
        over.style.width = W + 'px'; over.style.height = H + 'px';
        ovW = W; ovH = H;
      }
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Repaint ONLY the play cursor. Clears the band the last one occupied rather
    // than the whole layer: a full-canvas clear is ~16MB of writes at retina scale,
    // which is exactly the memory bandwidth an older tablet does not have to spare.
    function drawPlayheadLayer() {
      if (W <= 0 || H <= 0) return;                 // pane hidden — nothing to draw on
      syncOverlay();
      var bot = H - SB;
      // Band spans the full height because the ruler triangle lives here too, and
      // is 13px wide to cover that triangle (x-4 .. x+4) plus antialiasing.
      if (phLastX >= 0) octx.clearRect(phLastX - 6, 0, 13, bot);
      phLastX = -1;
      if (playhead < 0) return;
      var x = tickToX(playhead);
      if (x < KEYS_W || x > gridRight()) return;
      var xr = Math.round(x) + 0.5;
      octx.save();
      // Clip to the grid column. render() used to draw the cursor BEFORE the
      // ruler, keyboard and scrollbars, so those overpainted any spill; on a layer
      // above them nothing does, and a cursor sitting exactly on gridRight() would
      // otherwise bleed ~1.3px onto the vertical scrollbar track. This clip is the
      // same x-range drawRuler clips its own contents to.
      octx.beginPath(); octx.rect(KEYS_W, 0, gridRight() - KEYS_W, bot); octx.clip();
      octx.strokeStyle = '#ffcf4d'; octx.lineWidth = 1.6;
      octx.beginPath(); octx.moveTo(xr, RULER_H); octx.lineTo(xr, bot); octx.stroke();
      octx.fillStyle = '#ffcf4d';
      octx.beginPath(); octx.moveTo(x, RULER_H); octx.lineTo(x - 4, RULER_H - 7); octx.lineTo(x + 4, RULER_H - 7);
      octx.closePath(); octx.fill();
      octx.restore();
      phLastX = xr;
    }

    function drawGrid() {
      ctx.save();
      ctx.beginPath(); ctx.rect(KEYS_W, RULER_H, gridViewW(), gridViewH()); ctx.clip();
      // two tones only: the backdrop IS the black-key colour, white-key rows paint over it
      ctx.fillStyle = '#080b11'; ctx.fillRect(KEYS_W, RULER_H, gridViewW(), gridViewH());
      // Everything below batches same-styled shapes into ONE path. Canvas2D charges
      // per submission, not per segment, so a screenful of rows and gridlines used to
      // cost several hundred beginPath/fill/stroke calls per repaint — paid again on
      // every drag, scroll and zoom. Same marks, a handful of submissions.
      //
      // Two pixels DO change, both for the better: accumulating the white-key rows
      // into one path sums their coverage instead of compositing each row's
      // antialiased edge separately, so the faint seam between adjacent white rows
      // (E|F, B|C) at fractional row heights disappears; and when the zoom is low
      // enough that a bar line and a neighbouring beat line round to the same x, the
      // bar now always wins instead of whichever came later in tick order.
      function strokeVLines(xs, style, width, y0, y1) {
        if (!xs.length) return;
        ctx.strokeStyle = style; ctx.lineWidth = width;
        ctx.beginPath();
        for (var i = 0; i < xs.length; i++) { ctx.moveTo(xs[i], y0); ctx.lineTo(xs[i], y1); }
        ctx.stroke();
      }

      // pitch rows
      var pTop = yToPitch(RULER_H), pBot = yToPitch(gridBottom() - 1);
      // white keys lighter, black keys the backdrop — same reading as the gutter
      var gw = gridViewW();
      ctx.fillStyle = '#0f1621';
      ctx.beginPath();
      for (var p = pTop; p >= pBot; p--) {
        if (WHITE[((p % 12) + 12) % 12]) ctx.rect(KEYS_W, pitchTopY(p), gw, view.rowH);
      }
      ctx.fill();
      // octave dividers on top of the fills: the BOTTOM edge of each C row is the B|C
      // boundary (its top edge would split C from the C# above). Stroking these inside
      // the fill loop would put them under the next row's paint.
      ctx.strokeStyle = '#222c3a'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (var p2 = pTop; p2 >= pBot; p2--) {
        if (p2 % 12 === 0) {
          var yo = Math.round(pitchTopY(p2) + view.rowH) + 0.5;
          ctx.moveTo(KEYS_W, yo); ctx.lineTo(gridRight(), yo);
        }
      }
      ctx.stroke();
      // vertical time lines — sub-divisions first, then beats and bars over them.
      // Beats/bars are counted off the bar grid itself, never off the sub-division, so
      // they land right even when the division doesn't divide a bar evenly (1/8T at
      // ppq 220) or the musical tempo scales the grid to fractional ticks.
      var ppt = pxPerTick(), off = grid.offset || 0, last = xToTick(gridRight());
      var step = stepT(), pxStep = step * ppt;
      var k, t, x;
      if (pxStep >= 7) {                                        // hide sub-beat lines when cramped
        var subs = [];
        for (k = Math.floor((xToTick(KEYS_W) - off) / step), t = off + k * step; t <= last; k++, t = off + k * step) {
          if (t < 0) continue;
          subs.push(Math.round(tickToX(t)) + 0.5);
        }
        strokeVLines(subs, '#171f2a', 1, RULER_H, gridBottom());
      }
      // A bar tick is always also a beat tick, so the two sets are disjoint in TIME.
      // They can still collide in rounded x once beats fall below ~1px apart, and
      // there the bar line now wins rather than whichever came later — see above.
      var bt = beatT(), perBar = P.timeSig.num || 4, bars = [], beats = [];
      for (k = Math.floor((xToTick(KEYS_W) - off) / bt), t = off + k * bt; t <= last; k++, t = off + k * bt) {
        if (t < 0) continue;
        x = Math.round(tickToX(t)) + 0.5;
        (k % perBar === 0 ? bars : beats).push(x);
      }
      strokeVLines(beats, '#26303f', 1, RULER_H, gridBottom());
      strokeVLines(bars, '#3a4658', 1.4, RULER_H, gridBottom());
      ctx.restore();
    }

    function noteColor(n, selected) {
      if (selected) return { fill: '#ffb454', stroke: '#ffd9a0', text: '#3a2606' };
      var v = clamp((n.velocity || 100) / 127, 0, 1), l = 36 + Math.round(v * 26);
      return { fill: 'hsl(212,72%,' + l + '%)', stroke: 'hsl(212,80%,' + (l + 16) + '%)', text: '#04122b' };
    }
    function drawNotes() {
      ctx.save();
      ctx.beginPath(); ctx.rect(KEYS_W, RULER_H, gridViewW(), gridViewH()); ctx.clip();
      ctx.font = '11px ui-monospace,Consolas,monospace'; ctx.textBaseline = 'middle';
      P.notes.forEach(function (n) {
        var x0 = tickToX(n.start), x1 = tickToX(n.end), y = pitchTopY(n.pitch);
        if (x1 < KEYS_W || x0 > gridRight() || y > gridBottom() || y + view.rowH < RULER_H) return;
        var w = Math.max(2, x1 - x0), h = view.rowH - 1, c = noteColor(n, sel.has(n.id));
        roundRect(x0, y, w, h, 2); ctx.fillStyle = c.fill; ctx.fill();
        ctx.strokeStyle = c.stroke; ctx.lineWidth = 1; ctx.stroke();
        if (w > 22 && view.rowH >= 11) { ctx.fillStyle = c.text; ctx.fillText(pitchName(n.pitch), x0 + 4, y + h / 2 + 0.5); }
      });
      ctx.restore();
    }

    function drawVelLane() {
      var top = gridBottom(), laneTop = top + VEL_HEAD, laneH = VEL_H - VEL_HEAD;
      ctx.fillStyle = '#0e141d'; ctx.fillRect(KEYS_W, top, gridViewW(), VEL_H);
      ctx.fillStyle = '#0b0f15'; ctx.fillRect(0, top, KEYS_W, VEL_H + SB);
      ctx.strokeStyle = '#2b3340'; line(KEYS_W, top + 0.5, gridRight(), top + 0.5);
      ctx.fillStyle = '#8b97a7'; ctx.font = '10px -apple-system,Segoe UI,sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText('VELOCITY', KEYS_W + 6, top + VEL_HEAD / 2);
      ctx.save();
      ctx.beginPath(); ctx.rect(KEYS_W, laneTop, gridViewW(), laneH); ctx.clip();
      var base = laneTop + laneH;
      P.notes.forEach(function (n) {
        var x = tickToX(n.start); if (x < KEYS_W - 2 || x > gridRight()) return;
        var hh = (clamp(n.velocity, 1, 127) / 127) * (laneH - 2), s = sel.has(n.id);
        ctx.strokeStyle = s ? '#ffb454' : '#4f9dff'; ctx.lineWidth = s ? 2 : 1.5;
        line(Math.round(x) + 0.5, base, Math.round(x) + 0.5, base - hh);
        ctx.fillStyle = s ? '#ffb454' : '#4f9dff';
        ctx.beginPath(); ctx.arc(Math.round(x) + 0.5, base - hh, s ? 2.6 : 2, 0, 7); ctx.fill();
      });
      ctx.restore();
    }

    function drawRuler() {
      ctx.lineWidth = 1;                 // don't inherit it — see drawKeyboard
      ctx.fillStyle = '#11161f'; ctx.fillRect(KEYS_W, 0, W - KEYS_W, RULER_H);
      ctx.strokeStyle = '#2b3340'; line(KEYS_W, RULER_H - 0.5, W, RULER_H - 0.5);
      ctx.save(); ctx.beginPath(); ctx.rect(KEYS_W, 0, gridViewW(), RULER_H); ctx.clip();
      var brt = barT(), bt = beatT(), off = grid.offset || 0;
      var firstBar = Math.floor((xToTick(KEYS_W) - off) / brt), lastTick = xToTick(gridRight());
      ctx.font = '11px ui-monospace,Consolas,monospace'; ctx.textBaseline = 'alphabetic';
      for (var b = Math.max(0, firstBar); ; b++) {
        var bt0 = off + b * brt; if (bt0 > lastTick) break;
        var x = tickToX(bt0);
        ctx.strokeStyle = '#46566b'; line(Math.round(x) + 0.5, RULER_H - 10, Math.round(x) + 0.5, RULER_H);
        ctx.fillStyle = '#9fb0c4'; ctx.fillText(String(b + 1), x + 3, 13);
        for (var k = 1; k < P.timeSig.num; k++) {
          var bx = tickToX(bt0 + k * bt); ctx.strokeStyle = '#2b3340'; line(Math.round(bx) + 0.5, RULER_H - 5, Math.round(bx) + 0.5, RULER_H);
        }
      }
      // The ruler's playhead triangle is NOT drawn here any more — it moved to the
      // overlay with the line it belongs to. Left on the base canvas it froze in
      // place the moment playback stopped repainting the base, leaving two yellow
      // markers on screen disagreeing about where the playhead is.
      ctx.restore();
    }

    function drawKeyboard() {
      // Set our own line width instead of inheriting whatever the previous pass
      // left. It used to inherit 1.6 from drawPlayhead — but only while the cursor
      // happened to be on screen, so the key separators silently thickened during
      // playback and thinned again afterwards. The cursor has moved to its own
      // layer, so nothing sets it here at all any more; pin it.
      ctx.lineWidth = 1;
      ctx.fillStyle = '#0b0f15'; ctx.fillRect(0, RULER_H, KEYS_W, gridBottom() - RULER_H);
      ctx.save(); ctx.beginPath(); ctx.rect(0, RULER_H, KEYS_W, gridViewH()); ctx.clip();
      var pTop = yToPitch(RULER_H), pBot = yToPitch(gridBottom() - 1);
      ctx.font = '9px ui-monospace,Consolas,monospace'; ctx.textBaseline = 'middle';
      for (var p = pTop; p >= pBot; p--) {
        var y = pitchTopY(p), white = WHITE[((p % 12) + 12) % 12];
        ctx.fillStyle = white ? '#cdd6e0' : '#1b2230'; ctx.fillRect(0, y, KEYS_W - 1, view.rowH - 0.5);
        ctx.strokeStyle = '#0b0f15'; line(0, y + 0.5, KEYS_W, y + 0.5);
        if (guides.markers[p]) { ctx.fillStyle = '#4f9dff'; ctx.fillRect(KEYS_W - 4, y, 4, view.rowH - 0.5); }
        if (p % 12 === 0 && view.rowH >= 9) { ctx.fillStyle = '#5b6878'; ctx.fillText(pitchName(p), 4, y + view.rowH / 2); }
      }
      ctx.restore();
      ctx.strokeStyle = '#2b3340'; line(KEYS_W - 0.5, RULER_H, KEYS_W - 0.5, H);
    }

    function drawScrollbars() {
      // horizontal
      var hx = KEYS_W, hw = gridViewW(), cw = contentW();
      ctx.fillStyle = '#11161f'; ctx.fillRect(hx, H - SB, hw, SB);
      if (cw > hw) {
        var tW = Math.max(24, hw * hw / cw), tX = hx + (view.scrollX / maxScrollX()) * (hw - tW);
        if (!isFinite(tX)) tX = hx;
        ctx.fillStyle = drag && drag.mode === 'scrollH' ? '#5b6878' : '#3a4658';
        roundRect(tX, H - SB + 2, tW, SB - 4, 3); ctx.fill();
      }
      // vertical
      var vy = RULER_H, vh = gridViewH(), ch = contentH();
      ctx.fillStyle = '#11161f'; ctx.fillRect(W - SB, vy, SB, vh);
      if (ch > vh) {
        var tH = Math.max(24, vh * vh / ch), tY = vy + (view.scrollY / maxScrollY()) * (vh - tH);
        if (!isFinite(tY)) tY = vy;
        ctx.fillStyle = drag && drag.mode === 'scrollV' ? '#5b6878' : '#3a4658';
        roundRect(W - SB + 2, tY, SB - 4, tH, 3); ctx.fill();
      }
      ctx.fillStyle = '#0e1117'; ctx.fillRect(W - SB, H - SB, SB, SB);
    }

    function drawMarquee() {
      var x0 = Math.min(drag.x0, drag.x), y0 = Math.min(drag.y0, drag.y);
      ctx.fillStyle = 'rgba(79,157,255,0.12)'; ctx.strokeStyle = '#4f9dff'; ctx.lineWidth = 1;
      ctx.fillRect(x0, y0, Math.abs(drag.x - drag.x0), Math.abs(drag.y - drag.y0));
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.abs(drag.x - drag.x0), Math.abs(drag.y - drag.y0));
    }

    function line(x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
    function roundRect(x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2); ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }

    // ====================================================================== //
    //  POINTER INTERACTION
    // ====================================================================== //
    function localXY(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    function onDown(e) {
      canvas.focus();
      var pt = localXY(e), x = pt.x, y = pt.y;
      // middle-button drag = pan the view (anywhere)
      if (e.button === 1) { e.preventDefault(); drag = { mode: 'pan', x0: x, y0: y, sx0: view.scrollX, sy0: view.scrollY }; canvas.style.cursor = 'grabbing'; return; }
      // scrollbars
      if (x >= W - SB && y >= RULER_H && y < gridBottom()) { drag = { mode: 'scrollV', y0: y, s0: view.scrollY }; return; }
      if (y >= H - SB && x >= KEYS_W && x < gridRight()) { drag = { mode: 'scrollH', x0: x, s0: view.scrollX }; return; }
      // ruler → seek
      if (inRuler(x, y)) { seekTo(snap(xToTick(x))); drag = { mode: 'seek' }; return; }
      // velocity lane
      if (inVel(x, y)) {
        var vn = velHit(x);
        if (vn) { if (!sel.has(vn.id)) { sel = new Set([vn.id]); if (opts.onSelection) opts.onSelection(1); }
          drag = { mode: 'velocity', before: snapshot(), note: vn }; setVelFromY(y); }
        return;
      }
      if (!inGrid(x, y)) return;
      var hit = noteHit(x, y);
      if (e.button === 2) {                                   // right-click erase
        if (hit) { pushHistory(snapshot()); P.notes = P.notes.filter(function (n) { return n !== hit.note; }); sel.delete(hit.note.id); changed(); }
        return;
      }
      if (hit) {
        if (e.shiftKey) { if (sel.has(hit.note.id)) sel.delete(hit.note.id); else sel.add(hit.note.id); }
        else if (!sel.has(hit.note.id)) sel = new Set([hit.note.id]);
        if (opts.onSelection) opts.onSelection(sel.size);
        var before = snapshot();
        // Alt wins over the edge handles: a narrow note is almost all "edge" (within
        // 5 px of its end), so testing edges first made alt-drag resize instead of
        // duplicate on exactly the notes you most want to copy. Matches the drum roll.
        // the note under the cursor is the one the ear follows while dragging
        var aud = { basePitch: hit.note.pitch, lastPitch: hit.note.pitch, vel: hit.note.velocity };
        if (e.altKey) {                                       // alt-drag = duplicate (copy) the selection, then drag the copies
          var clones = selectedNotes().map(function (n) { return addNote(n.start, n.end, n.pitch, n.velocity).id; });
          sel = new Set(clones); if (opts.onSelection) opts.onSelection(sel.size);
          drag = { mode: 'move', before: before, t0: xToTick(x), p0: yToPitch(y), orig: snapOrig(), aud: aud };
          changed();
        }
        else if (hit.edge === 'right') drag = { mode: 'resizeR', before: before, anchor: xToTick(x), orig: snapOrig() };
        else if (hit.edge === 'left') drag = { mode: 'resizeL', before: before, anchor: xToTick(x), orig: snapOrig() };
        else drag = { mode: 'move', before: before, t0: xToTick(x), p0: yToPitch(y), orig: snapOrig(), aud: aud };
        scheduleDraw(); return;
      }
      // empty grid
      if (tool === 'draw' || e.detail === 2) {
        var st = snap(xToTick(x)), pitch = yToPitch(y), len = Math.round(stepT());
        pushHistory(snapshot());
        var n = addNote(st, st + len, pitch, 100); sel = new Set([n.id]);
        audition(pitch, 100, len * 60 / ((P.timelineTempo || 120) * P.ppq));   // hear what you drew
        drag = { mode: 'resizeR', before: undo[undo.length - 1], anchor: xToTick(x), orig: [{ id: n.id, start: n.start, end: n.end, pitch: n.pitch }], fresh: true };
        changed(); return;
      }
      // touch: a one-finger drag on empty grid pans the view (marquee + middle-drag pan are mouse-only)
      if (e.pointerType === 'touch') { drag = { mode: 'pan', x0: x, y0: y, sx0: view.scrollX, sy0: view.scrollY }; canvas.style.cursor = 'grabbing'; return; }
      // marquee
      if (!e.shiftKey) sel = new Set();
      drag = { mode: 'marquee', x0: x, y0: y, x: x, y: y, add: e.shiftKey, base: new Set(sel) };
      scheduleDraw();
    }

    function snapOrig() { return selectedNotes().map(function (n) { return { id: n.id, start: n.start, end: n.end, pitch: n.pitch }; }); }
    // Play a note through the editor synth (drawing / dragging to a new pitch).
    function audition(pitch, vel, sec) { if (opts.onAudition) opts.onAudition(pitch, vel || 100, sec || 0.25); }

    function onMove(e) {
      var pt = localXY(e), x = pt.x, y = pt.y;
      if (!drag) { updateCursor(x, y, e.altKey); return; }
      var free = e.ctrlKey || e.metaKey;                     // hold Ctrl/Cmd while dragging = ignore snap (fine adjust)
      if (drag.mode === 'pan') { view.scrollX = clamp(drag.sx0 - (x - drag.x0), 0, maxScrollX()); view.scrollY = clamp(drag.sy0 - (y - drag.y0), 0, maxScrollY()); scheduleDraw(); return; }
      if (drag.mode === 'scrollH') { var r = (x - drag.x0) / Math.max(1, gridViewW() - 24); view.scrollX = clamp(drag.s0 + r * maxScrollX(), 0, maxScrollX()); scheduleDraw(); return; }
      if (drag.mode === 'scrollV') { var r2 = (y - drag.y0) / Math.max(1, gridViewH() - 24); view.scrollY = clamp(drag.s0 + r2 * maxScrollY(), 0, maxScrollY()); scheduleDraw(); return; }
      if (drag.mode === 'seek') { seekTo(snap(xToTick(x))); return; }
      if (drag.mode === 'velocity') { setVelFromY(y); return; }
      if (drag.mode === 'marquee') { drag.x = x; drag.y = y; applyMarquee(); scheduleDraw(); return; }
      var dT = (free ? Math.round(xToTick(x) - (drag.t0 != null ? drag.t0 : drag.anchor)) : snap(xToTick(x)) - snap(drag.t0 != null ? drag.t0 : drag.anchor));
      if (drag.mode === 'move') {
        var dP = drag.p0 != null ? (yToPitch(y) - drag.p0) : 0;
        if (drag.aud) {                                        // crossed onto another row → play it
          var np = clamp(drag.aud.basePitch + dP, 0, 127);
          if (np !== drag.aud.lastPitch) { drag.aud.lastPitch = np; audition(np, drag.aud.vel, 0.25); }
        }
        drag.orig.forEach(function (o) {
          var n = byId(o.id); if (!n) return;
          n.start = Math.max(0, o.start + dT); n.end = o.end + dT + 0; n.end = n.start + (o.end - o.start);
          n.pitch = clamp(o.pitch + dP, 0, 127);
        });
        scheduleDraw();
      } else if (drag.mode === 'resizeR') {
        drag.orig.forEach(function (o) { var n = byId(o.id); if (!n) return; n.end = Math.max(n.start + minLen(), (free ? Math.round(o.end + dT) : snap(o.end + dT))); });
        scheduleDraw();
      } else if (drag.mode === 'resizeL') {
        drag.orig.forEach(function (o) { var n = byId(o.id); if (!n) return; n.start = clamp(free ? Math.round(o.start + dT) : snap(o.start + dT), 0, o.end - minLen()); });
        scheduleDraw();
      }
    }

    function onUp() {
      if (!drag) return;
      if (drag.before && /move|resize|velocity/.test(drag.mode)) { if (changedSince(drag.before)) pushHistory(drag.before); }
      var wasEdit = /move|resize|velocity|marquee/.test(drag.mode), wasPan = drag.mode === 'pan';
      drag = null;
      if (wasPan) canvas.style.cursor = 'default';
      if (wasEdit) changed(); else scheduleDraw();
    }

    function changedSince(before) { return JSON.stringify(before.notes) !== JSON.stringify(P.notes); }
    function minLen() { return Math.max(1, Math.round(stepT() / 8)); }

    function setVelFromY(y) {
      var laneTop = gridBottom() + VEL_HEAD, laneH = VEL_H - VEL_HEAD, base = laneTop + laneH;
      var v = clamp(Math.round((base - y) / (laneH - 2) * 127), 1, 127);
      var targets = (sel.size > 1 && drag.note && sel.has(drag.note.id)) ? selectedNotes() : [drag.note];
      targets.forEach(function (n) { if (n) n.velocity = v; });
      if (opts.onVel) opts.onVel(v);
      scheduleDraw();
    }
    function applyMarquee() {
      var x0 = Math.min(drag.x0, drag.x), x1 = Math.max(drag.x0, drag.x);
      var y0 = Math.min(drag.y0, drag.y), y1 = Math.max(drag.y0, drag.y);
      var s = new Set(drag.base);
      P.notes.forEach(function (n) {
        var nx0 = tickToX(n.start), nx1 = tickToX(n.end), ny = pitchTopY(n.pitch);
        if (nx1 >= x0 && nx0 <= x1 && ny + view.rowH >= y0 && ny <= y1) s.add(n.id);
      });
      sel = s; if (opts.onSelection) opts.onSelection(sel.size);
    }
    function updateCursor(x, y, alt) {
      var c = 'default';
      if (inRuler(x, y)) c = 'pointer';
      else if (inGrid(x, y)) { var h = noteHit(x, y); c = h ? (alt ? 'copy' : h.edge === 'body' ? 'move' : 'ew-resize') : (tool === 'draw' ? 'crosshair' : 'default'); }
      else if (inVel(x, y)) c = 'ns-resize';
      canvas.style.cursor = c;
    }

    function onWheel(e) {
      var pt = localXY(e), f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.shiftKey) {                                      // vertical (pitch) zoom, anchored at pointer
          var yRel = pt.y - RULER_H, cY = view.scrollY + yRel, oldH = view.rowH;
          view.rowH = clamp(view.rowH * f, 5, 44);
          view.scrollY = clamp(cY / oldH * view.rowH - yRel, 0, maxScrollY());
        } else {                                               // horizontal (time) zoom, anchored at pointer
          var tAnchor = xToTick(pt.x);
          view.pxPerQuarter = clamp(view.pxPerQuarter * f, 2, 800);
          view.scrollX = clamp(tAnchor * pxPerTick() - (pt.x - KEYS_W), 0, maxScrollX());
        }
        scheduleDraw(); if (opts.onZoom) opts.onZoom(); return;
      }
      e.preventDefault();
      if (e.shiftKey) view.scrollX = clamp(view.scrollX + (e.deltaY || e.deltaX), 0, maxScrollX());   // shift+wheel = horizontal
      else { view.scrollY = clamp(view.scrollY + e.deltaY, 0, maxScrollY()); view.scrollX = clamp(view.scrollX + e.deltaX, 0, maxScrollX()); }
      scheduleDraw();
    }

    // ====================================================================== //
    //  COMMANDS (toolbar + shortcuts)
    // ====================================================================== //
    function selectAll() { sel = new Set(P.notes.map(function (n) { return n.id; })); if (opts.onSelection) opts.onSelection(sel.size); scheduleDraw(); }
    function clearSel() { sel = new Set(); if (opts.onSelection) opts.onSelection(0); scheduleDraw(); }
    function deleteSel() { if (!sel.size) return; pushHistory(snapshot()); P.notes = P.notes.filter(function (n) { return !sel.has(n.id); }); sel = new Set(); changed(); }
    function copy() { var s = selectedNotes(); if (!s.length) return; var t0 = Math.min.apply(null, s.map(function (n) { return n.start; })); clipboard = s.map(function (n) { return { start: n.start - t0, end: n.end - t0, pitch: n.pitch, velocity: n.velocity }; }); }
    function cut() { copy(); deleteSel(); }
    function paste() {
      if (!clipboard.length) return; pushHistory(snapshot());
      var at = snap(playhead); sel = new Set();
      clipboard.forEach(function (c) { var n = addNote(at + c.start, at + c.end, c.pitch, c.velocity); sel.add(n.id); });
      changed();
    }
    function duplicate() {
      var s = selectedNotes(); if (!s.length) return; pushHistory(snapshot());
      var span = Math.max.apply(null, s.map(function (n) { return n.end; })) - Math.min.apply(null, s.map(function (n) { return n.start; }));
      var shift = Math.round(Math.max(snap(span), stepT())); sel = new Set();
      s.forEach(function (n) { var d = addNote(n.start + shift, n.end + shift, n.pitch, n.velocity); sel.add(d.id); });
      changed();
    }
    function transpose(semis) { var s = sel.size ? selectedNotes() : P.notes; if (!s.length) return; pushHistory(snapshot()); s.forEach(function (n) { n.pitch = clamp(n.pitch + semis, 0, 127); }); changed(); }
    function nudge(dt) { dt = Math.round(dt); var s = selectedNotes(); if (!s.length) return; pushHistory(snapshot()); s.forEach(function (n) { var len = n.end - n.start; n.start = Math.max(0, n.start + dt); n.end = n.start + len; }); changed(); }
    function quantize(strength, lengths) {
      var s = sel.size ? selectedNotes() : P.notes; if (!s.length) return; pushHistory(snapshot());
      strength = strength == null ? 1 : strength;
      var o = grid.offset || 0, g = stepT();
      s.forEach(function (n) {
        var q = Math.round((n.start - o) / g) * g + o; n.start = Math.max(0, Math.round(n.start + (q - n.start) * strength));
        if (lengths) { var qe = Math.max(g, Math.round((n.end - n.start) / g) * g); n.end = n.start + Math.round(qe); }
      });
      changed();
    }
    // Advanced quantize (whole song) via QuantizeCore — swing / bias / strength,
    // optional length quantize. Operates on every note regardless of selection.
    function quantizeAdvanced(o) {
      if (!P.notes.length) return 0;
      pushHistory(snapshot());
      // quantize against the grid as drawn — shifted by the offset, spaced by the musical tempo
      var g = o.gridTicks * gridScale(), lengths = !!o.lengths, origin = grid.offset || 0;
      P.notes.forEach(function (n) {
        var len = n.end - n.start;
        var nt = Math.max(0, Math.round(QuantizeCore.snap(n.start - origin, g, o) + origin));
        n.start = nt;
        if (lengths) { var ql = Math.round(Math.max(g, Math.round(len / g) * g)); n.end = nt + ql; }
        else n.end = nt + len;
      });
      changed();
      return P.notes.length;
    }
    function setGridTicks(t) { grid.ticks = t; scheduleDraw(); }
    // Slide the grid (bar lines, beats, sub-divisions, snapping) in ticks — notes never move.
    function setGridOffset(t) { grid.offset = Math.round(+t || 0); scheduleDraw(); }
    function getGridOffset() { return grid.offset || 0; }
    function setSnap(on) { grid.snap = !!on; }
    function setTool(t) { tool = t; canvas.style.cursor = t === 'draw' ? 'crosshair' : 'default'; }
    function setGuides(g) {
      if (!g) return;
      if (g.markers) guides.markers = g.markers;
      if (g.centerPitch != null) guides.centerPitch = g.centerPitch;
      view.scrollY = clamp((MAX_PITCH - guides.centerPitch) * view.rowH - gridViewH() / 2, 0, maxScrollY());
      scheduleDraw();
    }
    function zoomTime(f) { view.pxPerQuarter = clamp(view.pxPerQuarter * f, 2, 800); scheduleDraw(); if (opts.onZoom) opts.onZoom(); }
    function zoomPitch(f) { view.rowH = clamp(view.rowH * f, 5, 44); scheduleDraw(); if (opts.onZoom) opts.onZoom(); }
    function fitTime() {                                        // fit the whole song to the visible width
      var quarters = P.lengthTicks / P.ppq; if (quarters <= 0) return;
      view.pxPerQuarter = clamp(gridViewW() / quarters, 2, 800); view.scrollX = 0;
      scheduleDraw(); if (opts.onZoom) opts.onZoom();
    }
    // Returns whether the view actually moved. It often doesn't: scrollX is clamped
    // to [0, maxScrollX], so through the whole opening and closing stretch of a song
    // the follow test keeps firing while the value never changes. Reporting that
    // lets setPlayhead skip a full repaint it would otherwise do on every frame.
    function scrollToTick(t) {
      var nx = clamp(t * pxPerTick() - gridViewW() * 0.35, 0, maxScrollX());
      if (nx === view.scrollX) return false;
      view.scrollX = nx; scheduleDraw(); return true;
    }
    // Called once per animation frame during playback. Only when the follow-scroll
    // actually fires (the cursor reaching ~30px from either edge, a few times a
    // song) has the grid moved and does the base canvas need repainting;
    // scrollToTick already queues that. Every other frame nothing but the cursor
    // moved, so only the overlay is touched — and synchronously, since it is a
    // couple of Canvas2D calls and going through the rAF queue would just add a
    // frame of lag to the one element the user is watching.
    function setPlayhead(t) {
      playhead = t;
      if (opts.follow && opts.follow()) {
        var x = tickToX(t);
        if (x < KEYS_W + 30 || x > gridRight() - 30) { if (scrollToTick(t)) return; }
      }
      drawPlayheadLayer();
    }
    function seekTo(t) { playhead = Math.max(0, t); if (opts.onSeek) opts.onSeek(playhead); scheduleDraw(); }

    // ---- project I/O --------------------------------------------------------
    function load(project) {
      P.ppq = project.ppq || 480; P.tempo = project.tempo || 120;
      // Callers pass the anchor explicitly; 120 (the SMF default every writer in this
      // pipeline uses) is the fallback. Never default to project.tempo — that is the
      // musical BPM the user dialled in, and using it as the anchor makes the grid
      // scale itself away to 1:1 the moment they change it.
      P.timelineTempo = project.timelineTempo || 120;
      P.timeSig = project.timeSig || { num: 4, den: 4 };
      idSeq = 1; sel = new Set(); undo = []; redo = []; playhead = 0;
      P.notes = (project.notes || []).map(function (n) { return { id: idSeq++, start: n.start, end: n.end, pitch: n.pitch, velocity: n.velocity || 100 }; });
      P.lengthTicks = Math.max(barTicks() * 8, 0); growLengthToFit();
      view.scrollX = 0; view.scrollY = clamp((MAX_PITCH - guides.centerPitch) * view.rowH - gridViewH() / 2, 0, maxScrollY());
      changed();
    }
    function getProject() { return { ppq: P.ppq, tempo: P.tempo, timelineTempo: P.timelineTempo, gridOffsetTicks: grid.offset || 0, timeSig: P.timeSig, lengthTicks: P.lengthTicks, notes: P.notes.map(function (n) { return { start: n.start, end: n.end, pitch: n.pitch, velocity: n.velocity }; }) }; }
    // The musical tempo: re-spaces the bar grid (and the metronome). Notes keep their
    // ticks, so the transcription still plays back locked to the song.
    function setTempo(b) { P.tempo = clamp(b, 20, 320); changed(); }
    function setTimeSig(num, den) { P.timeSig = { num: clamp(num, 1, 32), den: den }; changed(); }
    function setPPQ(q) { P.ppq = q; grid.ticks = q / 4; changed(); }

    // ---- keyboard -----------------------------------------------------------
    function onKey(e) {
      if (canvas.offsetParent === null) return;              // piano-roll isn't the active view — let that view own the keys
      if (opts.modalOpen && opts.modalOpen()) return;        // a dialog (help / library) is open — don't act behind it
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redoCmd() : undoCmd(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redoCmd(); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
      if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(); return; }
      if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); cut(); return; }
      if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return; }
      switch (e.key) {
        case 'Delete': case 'Backspace': e.preventDefault(); deleteSel(); break;
        case 'Escape': clearSel(); break;
        case 'ArrowLeft': e.preventDefault(); nudge(-(e.shiftKey ? barT() : stepT())); break;
        case 'ArrowRight': e.preventDefault(); nudge(e.shiftKey ? barT() : stepT()); break;
        case 'ArrowUp': e.preventDefault(); transpose(e.shiftKey ? 12 : 1); break;
        case 'ArrowDown': e.preventDefault(); transpose(e.shiftKey ? -12 : -1); break;
        case 'q': case 'Q': quantize(1, e.shiftKey); break;
        case 'b': case 'B': setTool('draw'); if (opts.onTool) opts.onTool('draw'); break;
        case 'v': case 'V': if (!mod) { setTool('select'); if (opts.onTool) opts.onTool('select'); } break;
      }
    }

    // ---- wire up ------------------------------------------------------------
    canvas.tabIndex = 0;
    // only the primary pointer drives a gesture — extra touch fingers are ignored so a
    // 2nd finger can neither clobber `drag` nor end the gesture early on its own lift.
    canvas.addEventListener('pointerdown', function (e) { if (!e.isPrimary) return; canvas.setPointerCapture(e.pointerId); onDown(e); });
    canvas.addEventListener('pointermove', function (e) { if (!e.isPrimary) return; onMove(e); });
    window.addEventListener('pointerup', function (e) { if (!e.isPrimary) return; onUp(e); });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });   // suppress middle-click autoscroll
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('dblclick', function (e) { e.preventDefault(); });
    document.addEventListener('keydown', onKey);
    var ro = new ResizeObserver(function () { scheduleDraw(); });
    ro.observe(canvas);
    scheduleDraw();

    return {
      load: load, getProject: getProject,
      setTempo: setTempo, setTimeSig: setTimeSig, setPPQ: setPPQ,
      setGridTicks: setGridTicks, setGridOffset: setGridOffset, getGridOffset: getGridOffset, setSnap: setSnap, setTool: setTool, getTool: function () { return tool; },
      setGuides: setGuides,
      selectAll: selectAll, clearSel: clearSel, deleteSel: deleteSel,
      copy: copy, cut: cut, paste: paste, duplicate: duplicate,
      transpose: transpose, quantize: quantize, quantizeAdvanced: quantizeAdvanced, undo: undoCmd, redo: redoCmd,
      zoomTime: zoomTime, zoomPitch: zoomPitch, fitTime: fitTime, scrollToTick: scrollToTick,
      setPlayhead: setPlayhead, getPlayhead: function () { return playhead; },
      stats: function () { return { notes: P.notes.length, sel: sel.size, tempo: P.tempo, ppq: P.ppq, ts: P.timeSig, lengthTicks: P.lengthTicks }; },
      redraw: scheduleDraw, pitchName: pitchName,
      debug: function () { return { scrollX: view.scrollX, scrollY: view.scrollY, gridOffset: grid.offset, gridTicks: grid.ticks, gridScale: gridScale(), tempo: P.tempo, timelineTempo: P.timelineTempo, pxPerQuarter: view.pxPerQuarter, rowH: view.rowH, maxScrollX: maxScrollX(), maxScrollY: maxScrollY(), gridViewW: gridViewW() }; }
    };
  }

  return { create: create };
})();
