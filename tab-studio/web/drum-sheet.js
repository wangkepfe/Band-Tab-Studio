/* ============================================================================
 * drum-sheet.js  —  traditional drum-set notation (SVG), rendered from the
 * same events the modern grid shows.
 *
 * A real staff can only be drawn from rhythm that sits ON a grid, so this view
 * quantizes a *display copy* of the events to the chosen subdivision (relative
 * to the drum bar-grid offset) — it never mutates the editable events. It then
 * lays the hits out as standard drum-kit notation:
 *
 *   • 5-line staff + unpitched percussion clef + time signature
 *   • two rhythmic voices: hands/cymbals (stems up) and kick (stems down)
 *   • x-noteheads for cymbals/hi-hat, filled heads for snare/toms/kick
 *   • beams within each beat, flags for isolated short notes, rests in the gaps
 *
 *   DrumSheet.render(container, { events, tempo, gridOffset, gridSub, tsNum,
 *                                 barsPerLine })
 * ========================================================================== */
var DrumSheet = (function () {
  'use strict';

  // Lane id → staff placement. `row` is in line-units from the TOP staff line
  // (0 = top line, 1 = 2nd line … 4 = bottom line; .5 values sit on spaces;
  // negatives sit above the staff on ledger space). `glyph`: x | xo | note.
  // `voice`: up = hands/cymbals, down = kick.
  var MAP = {
    crash:      { row: -1.0, glyph: 'x',  voice: 'up'   },
    ride:       { row:  0.0, glyph: 'x',  voice: 'up'   },
    hihat:      { row: -0.5, glyph: 'x',  voice: 'up'   },
    hihat_open: { row: -0.5, glyph: 'xo', voice: 'up'   },
    tom1:       { row:  0.5, glyph: 'note', voice: 'up' },
    tom2:       { row:  1.0, glyph: 'note', voice: 'up' },
    snare:      { row:  2.0, glyph: 'note', voice: 'up' },
    floor_tom:  { row:  3.0, glyph: 'note', voice: 'up' },
    kick:       { row:  4.0, glyph: 'note', voice: 'down' }
  };

  var GAP = 9;                 // px between staff lines
  var TOP = 30;                // y of the top staff line
  var BOT = TOP + 4 * GAP;     // y of the bottom staff line
  var UP_BEAM  = TOP - 1.7 * GAP;   // y of the up-voice beam / stem tops
  var DN_BEAM  = BOT + 1.7 * GAP;   // y of the down-voice (kick) beam / stem bottoms
  var INK = '#c9d4e2';
  var RINK = '#8b97a7';        // rest ink (dimmer)

  // Playback-sync state (mirrors the modern grid's auto-follow, but vertically:
  // the staff is a stack of systems, so we ride the playhead down line-by-line).
  var _host = null;     // container of the last render (scroll box for the playhead)
  var _layout = null;   // time → (system, x) mapping captured at render time
  var _lastT = -1;      // last playhead time in seconds (re-applied after re-renders)
  var _lastPhSys = -1;  // system the playhead was last on — its height only changes here

  function rowY(row) { return TOP + row * GAP; }

  // {beams, dotted} for a note that spans dCols grid columns; spq = columns per beat.
  function valOf(dCols, spq) {
    if (dCols >= spq)     return { beams: 0, dotted: false };
    if (dCols * 2 >= spq) return { beams: 1, dotted: dCols * 2 > spq };
    if (dCols * 4 >= spq) return { beams: 2, dotted: dCols * 4 > spq };
    return { beams: 3, dotted: false };
  }

  // Tile one voice's onsets into beat-capped notes + filler rests.
  // Returns [{col, beams, dotted, rest}] covering [0, endCol).
  function voiceRhythm(onsets, beatCols, endCol) {
    var items = [], pos = 0, pts = onsets.slice(); pts.push(endCol);
    function emitRests(from, to) {
      var p = from;
      while (p < to) {
        var be = (Math.floor(p / beatCols) + 1) * beatCols, len = Math.min(to, be) - p;
        if (len <= 0) break;
        var v = valOf(len, beatCols); items.push({ col: p, beams: v.beams, dotted: v.dotted, rest: true });
        p += len;
      }
    }
    for (var k = 0; k < onsets.length; k++) {
      var c = onsets[k], next = pts[k + 1];
      if (c < pos) continue;                       // de-dupe / overlap guard
      emitRests(pos, c);
      var beatEnd = (Math.floor(c / beatCols) + 1) * beatCols;
      var noteLen = Math.max(1, Math.min(next - c, beatEnd - c));
      var v = valOf(noteLen, beatCols);
      items.push({ col: c, beams: v.beams, dotted: v.dotted, rest: false });
      pos = c + noteLen;
    }
    emitRests(pos, endCol);
    return items;
  }

  // ---- glyph builders --------------------------------------------------------
  function headX(cx, cy) {
    var r = 3.4;
    return '<line x1="' + (cx - r) + '" y1="' + (cy - r) + '" x2="' + (cx + r) + '" y2="' + (cy + r) + '" stroke="' + INK + '" stroke-width="1.5"/>' +
           '<line x1="' + (cx - r) + '" y1="' + (cy + r) + '" x2="' + (cx + r) + '" y2="' + (cy - r) + '" stroke="' + INK + '" stroke-width="1.5"/>';
  }
  function headNote(cx, cy) {
    return '<ellipse cx="' + cx + '" cy="' + cy + '" rx="4.2" ry="3.1" fill="' + INK + '" transform="rotate(-18 ' + cx + ' ' + cy + ')"/>';
  }
  function openCircle(cx, cy) { return '<circle cx="' + cx + '" cy="' + (cy - 7) + '" r="2.6" fill="none" stroke="' + INK + '" stroke-width="1.2"/>'; }
  function dot(cx, cy) { return '<circle cx="' + (cx + 7) + '" cy="' + cy + '" r="1.5" fill="' + INK + '"/>'; }
  function accent(cx, cy) { return '<path d="M' + (cx - 4) + ' ' + (cy - 11) + ' l8 2.5 l-8 2.5" fill="none" stroke="' + INK + '" stroke-width="1.1"/>'; }

  // ledger lines for noteheads sitting above the staff (crash / hi-hat)
  function ledger(cx, row) {
    var g = '';
    for (var r = -1; r >= Math.floor(row); r--) {
      var y = rowY(r);
      g += '<line x1="' + (cx - 7) + '" y1="' + y + '" x2="' + (cx + 7) + '" y2="' + y + '" stroke="var(--string,#3a4452)" stroke-width="1"/>';
    }
    return g;
  }

  function restGlyph(cx, cy, beams) {
    if (beams <= 0)   // quarter rest
      return '<path d="M' + (cx - 2.5) + ' ' + (cy - 7) + ' q5 4 0 7 q-5 3 1 6 q-4 -1 -2 4" fill="none" stroke="' + RINK + '" stroke-width="1.6" stroke-linecap="round"/>';
    // eighth / sixteenth / thirty-second rests: a stroke with `beams` hooks
    var g = '<line x1="' + (cx + 2.4) + '" y1="' + (cy - 6) + '" x2="' + (cx - 2.6) + '" y2="' + (cy + 7) + '" stroke="' + RINK + '" stroke-width="1.4"/>';
    for (var i = 0; i < beams; i++) {
      var hy = cy - 6 + i * 4.6;
      g += '<circle cx="' + (cx + 2.2) + '" cy="' + hy + '" r="1.7" fill="' + RINK + '"/>' +
           '<line x1="' + (cx + 2.2) + '" y1="' + hy + '" x2="' + (cx - 1.4) + '" y2="' + (hy + 2.6) + '" stroke="' + RINK + '" stroke-width="1.1"/>';
    }
    return g;
  }

  function flags(x, yTip, beams, dir) {
    // hooks on an isolated note's stem (dir: -1 up, +1 down)
    var g = '';
    for (var i = 0; i < beams; i++) {
      var y = yTip + dir * i * 4.6;
      g += '<path d="M' + x + ' ' + y + ' q7 ' + (dir * 3) + ' 7 ' + (dir * 9) + '" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/>';
    }
    return g;
  }

  // ---- public render ---------------------------------------------------------
  function render(container, opts) {
    opts = opts || {};
    var events  = opts.events || [];
    var tempo   = opts.tempo || 120;
    var offset  = opts.gridOffset || 0;
    var gridSub = opts.gridSub || 16;
    var tsNum   = opts.tsNum || 4;
    var barsPerLine = opts.barsPerLine || 4;

    if (!events.length) {
      _host = container; _layout = null;
      container.innerHTML = '<div class="ds-empty">No drum hits yet — the staff appears once the track has notes.</div>';
      return;
    }

    var spq    = Math.max(1, Math.round(gridSub / 4));   // grid columns per beat
    var barCols = spq * tsNum;
    var stepSec = (60 / tempo) / spq;

    // quantize a display copy to grid columns relative to the bar-grid offset
    var colMap = {};   // col → { up:Set, down:Set, vel:{} }
    var maxCol = 0;
    events.forEach(function (e) {
      var m = MAP[e.type]; if (!m) return;
      var col = Math.round((e.time_sec - offset) / stepSec);
      if (col < 0) col = 0;
      if (!colMap[col]) colMap[col] = { up: {}, down: {}, vel: {} };
      colMap[col][m.voice === 'down' ? 'down' : 'up'][e.type] = true;
      colMap[col].vel[e.type] = Math.max(colMap[col].vel[e.type] || 0, e.velocity || 100);
      if (col > maxCol) maxCol = col;
    });

    var endCol  = Math.max(barCols, Math.ceil((maxCol + 1) / barCols) * barCols);
    var totalBars = endCol / barCols;
    var cols = Object.keys(colMap).map(Number);
    var upOnsets   = cols.filter(function (c) { return Object.keys(colMap[c].up).length; }).sort(function (a, b) { return a - b; });
    var downOnsets = cols.filter(function (c) { return Object.keys(colMap[c].down).length; }).sort(function (a, b) { return a - b; });

    var upItems   = voiceRhythm(upOnsets, spq, endCol);
    var downItems = voiceRhythm(downOnsets, spq, endCol).filter(function (it) { return !it.rest; });   // kick: heads only

    var colW   = Math.max(7, Math.round(46 / spq));
    var leftPad = 40, rightPad = 10;

    var html = '', systems = [];
    for (var b0 = 0; b0 < totalBars; b0 += barsPerLine) {
      var b1 = Math.min(b0 + barsPerLine, totalBars);
      var startCol = b0 * barCols, stopCol = b1 * barCols;
      systems.push({ startCol: startCol, stopCol: stopCol });
      var W = leftPad + (stopCol - startCol) * colW + rightPad;
      var H = DN_BEAM + 12;
      var X = (function (sc) { return function (col) { return leftPad + (col - sc) * colW; }; })(startCol);

      var svg = '<svg class="ds-system" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';

      // staff lines
      for (var ln = 0; ln < 5; ln++) {
        var y = TOP + ln * GAP;
        svg += '<line x1="' + (leftPad - 30) + '" y1="' + y + '" x2="' + (W - 4) + '" y2="' + y + '" stroke="var(--string,#3a4452)" stroke-width="1"/>';
      }
      // percussion clef (two thick vertical bars) just left of the notes
      svg += '<rect x="' + (leftPad - 26) + '" y="' + (rowY(1)) + '" width="3.2" height="' + (2 * GAP) + '" fill="' + INK + '"/>' +
             '<rect x="' + (leftPad - 20) + '" y="' + (rowY(1)) + '" width="3.2" height="' + (2 * GAP) + '" fill="' + INK + '"/>';
      // time signature (first system only)
      if (b0 === 0) {
        svg += '<text x="' + (leftPad - 13) + '" y="' + (rowY(1) + 3) + '" fill="' + INK + '" font-family="serif" font-size="14" font-weight="700" text-anchor="middle">' + tsNum + '</text>' +
               '<text x="' + (leftPad - 13) + '" y="' + (rowY(3) + 3) + '" fill="' + INK + '" font-family="serif" font-size="14" font-weight="700" text-anchor="middle">4</text>';
      }
      // bar lines + bar numbers
      for (var bb = b0; bb <= b1; bb++) {
        var bx = X(bb * barCols);
        svg += '<line x1="' + bx + '" y1="' + TOP + '" x2="' + bx + '" y2="' + BOT + '" stroke="#48566a" stroke-width="' + (bb === totalBars ? 2 : 1.2) + '"/>';
        if (bb < b1) svg += '<text x="' + (bx + 3) + '" y="' + (TOP - 6) + '" fill="#7d8aa0" font-size="10" font-family="monospace">' + (bb + 1) + '</text>';
      }

      // ---- voices ----
      svg += renderVoice(upItems, colMap, 'up', startCol, stopCol, X, colW, spq);
      svg += renderVoice(downItems, colMap, 'down', startCol, stopCol, X, colW, spq);

      svg += '</svg>';
      html += svg;
    }
    container.innerHTML = html;

    // Capture the time→position mapping so the playhead can ride along with
    // playback, then re-place it (a render wipes the overlay div). Measure each
    // system's content-box geometry ONCE here (batched reads — no per-frame
    // re-measure / layout thrash) since SVG elements don't expose offsetTop. Don't
    // scroll here — only playback (setPlayhead with playing=true) drives auto-follow.
    _host = container;
    var hr = container.getBoundingClientRect();
    var svgEls = container.querySelectorAll('svg.ds-system');
    var sTop = container.scrollTop, sLeft = container.scrollLeft;
    for (var s = 0; s < systems.length; s++) {
      var el = svgEls[s]; if (!el) continue;
      var sr = el.getBoundingClientRect();
      systems[s].top  = (sr.top  - hr.top)  + sTop;   // content-box coords (scroll-independent)
      systems[s].left = (sr.left - hr.left) + sLeft;
      systems[s].h    = sr.height;
    }
    _layout = {
      stepSec: stepSec, offset: offset, colW: colW, leftPad: leftPad,
      barCols: barCols, barsPerLine: barsPerLine, endCol: endCol, systems: systems
    };
    _lastPhSys = -1;          // fresh systems (and a fresh <div>) — re-apply the height
    applyPlayhead(false);
  }

  // ---- playback sync ---------------------------------------------------------
  // Place (and optionally auto-scroll to) a vertical playhead at song time `t`
  // seconds. Mirrors the modern grid: only follows while `playing`, otherwise it
  // just marks the spot so a seek/edit leaves the scroll position put.
  function setPlayhead(t, playing) {
    _lastT = (typeof t === 'number') ? t : -1;
    applyPlayhead(!!playing);
  }

  function applyPlayhead(playing) {
    if (!_host || !_layout) return;
    var ph = _host.querySelector('.ds-playhead');
    var t = _lastT, L = _layout;
    function hide() { if (ph) ph.style.display = 'none'; }
    if (t < 0) { hide(); return; }

    var col = (t - L.offset) / L.stepSec;                 // fractional grid columns from the grid origin
    if (col < 0 || col >= L.endCol) { hide(); return; }   // endCol is exclusive (cols 0..endCol-1)
    var si = Math.floor(col / (L.barCols * L.barsPerLine));
    var sys = L.systems[si];
    if (!sys) { hide(); return; }

    // Geometry was cached at render time. Fall back to a live bounding-rect measure
    // if the staff was rendered while hidden (zero-size) so positions stay correct.
    var sysTop = sys.top, sysLeft = sys.left, sysH = sys.h;
    if (!sysH) {
      var svg = _host.querySelectorAll('svg.ds-system')[si];
      if (!svg) { hide(); return; }
      var hr = _host.getBoundingClientRect(), sr = svg.getBoundingClientRect();
      sysTop  = (sr.top  - hr.top)  + _host.scrollTop;
      sysLeft = (sr.left - hr.left) + _host.scrollLeft;
      sysH    = sr.height;
    }
    var x = L.leftPad + (col - sys.startCol) * L.colW;

    if (!ph) { ph = document.createElement('div'); ph.className = 'ds-playhead'; _host.appendChild(ph); }
    ph.style.display = 'block';
    // Move it with a transform, not left/top. Those are layout properties, so the
    // old version dirtied layout and then immediately read clientHeight and
    // scrollHeight below — a forced synchronous layout of the whole staff on every
    // frame of playback. A transform on a promoted layer dirties nothing, so the
    // reads that follow are free. Height is the one layout write left, and it only
    // changes when the playhead moves to a different system.
    //
    // `sysH &&` guards the latch against a FAILED measurement: the block above
    // falls back to a live getBoundingClientRect when the staff was rendered while
    // hidden, and if it is still hidden that reads 0 too. Latching a 0 would pin
    // the playhead at zero height until it crossed into another system, because
    // only a fresh render() clears _lastPhSys. Not latching a zero keeps the old
    // code's self-healing on the first visible frame.
    if (sysH && si !== _lastPhSys) { ph.style.height = sysH + 'px'; _lastPhSys = si; }
    ph.style.transform = 'translate3d(' + (sysLeft + x) + 'px,' + sysTop + 'px,0)';

    if (playing) {
      // Follow the playhead with a ~40% lead, but always keep the whole current
      // system in view (it would otherwise clip when the pane is only a line tall).
      var frac = (col - sys.startCol) / (sys.stopCol - sys.startCol);
      var phY  = sysTop + frac * sysH;
      var clientH = _host.clientHeight;
      var desired = phY - clientH * 0.4;
      if (sysH < clientH) {
        desired = Math.min(desired, sysTop);                   // don't clip the top
        desired = Math.max(desired, sysTop + sysH - clientH);  // don't clip the bottom
      } else {
        desired = sysTop;
      }
      _host.scrollTop = Math.max(0, Math.min(desired, _host.scrollHeight - clientH));
    }
  }

  // Render one voice (notes + beams/flags + stems + rests) within a system.
  function renderVoice(items, colMap, voice, startCol, stopCol, X, colW, spq) {
    var up = voice === 'up', dir = up ? -1 : 1;
    var stemEnd = up ? UP_BEAM : DN_BEAM;
    var g = '';

    // noteheads + stems + rests for items inside this system
    var inSys = items.filter(function (it) { return it.col >= startCol && it.col < stopCol; });
    inSys.forEach(function (it) {
      var x = X(it.col);
      if (it.rest) {
        if (up) g += restGlyph(x + colW * 0.3, rowY(1.4), it.beams);
        return;
      }
      var heads = colMap[it.col] ? colMap[it.col][up ? 'up' : 'down'] : null;
      if (!heads) return;
      var rows = [];
      for (var id in heads) {
        if (!heads.hasOwnProperty(id)) continue;
        var m = MAP[id]; if (!m) continue;
        var cy = rowY(m.row);
        rows.push(m.row);
        if (m.row < -0.01) g += ledger(x, m.row);
        g += (m.glyph === 'note') ? headNote(x, cy) : headX(x, cy);
        if (m.glyph === 'xo') g += openCircle(x, cy);
        if ((colMap[it.col].vel[id] || 0) >= 112) g += accent(x, cy);
      }
      // stem: from the extreme notehead to the beam line
      var stemX = x + (up ? 4.0 : -4.0);
      var headYs = rows.map(rowY);
      var anchorY = up ? Math.max.apply(null, headYs) : Math.min.apply(null, headYs);
      g += '<line x1="' + stemX + '" y1="' + anchorY + '" x2="' + stemX + '" y2="' + stemEnd + '" stroke="' + INK + '" stroke-width="1.4"/>';
      if (it.dotted) g += dot(x + 4, rowY(up ? 1.5 : 4));
      it._stemX = stemX;          // stash for beaming
    });

    // beams / flags per beat
    var notes = inSys.filter(function (it) { return !it.rest; });
    var byBeat = {};
    inSys.forEach(function (it) { var bi = Math.floor(it.col / spq); (byBeat[bi] = byBeat[bi] || []).push(it); });
    Object.keys(byBeat).forEach(function (bi) {
      var seq = byBeat[bi].sort(function (a, b) { return a.col - b.col; });
      // split into runs of consecutive notes with beams≥1 (rests / plain notes break a run)
      var run = [];
      function flush() {
        if (!run.length) return;
        if (run.length === 1) {
          var n = run[0];
          if (n.beams >= 1) g += flags(n._stemX, stemEnd, n.beams, -dir);   // flag points back into the staff
        } else {
          g += beamRun(run, stemEnd, dir, colW);
        }
        run = [];
      }
      seq.forEach(function (it) {
        if (it.rest || it.beams < 1) { flush(); return; }
        run.push(it);
      });
      flush();
    });

    return g;
  }

  // Draw primary + secondary beams across a run of ≥2 notes.
  function beamRun(run, beamY, dir, colW) {
    var g = '', n = run.length;
    var x0 = run[0]._stemX, x1 = run[n - 1]._stemX;
    var th = 2.4;
    // primary beam spans the whole run
    g += '<rect x="' + x0 + '" y="' + (beamY + (dir < 0 ? 0 : -th)) + '" width="' + Math.max(2, x1 - x0) + '" height="' + th + '" fill="' + INK + '"/>';
    // secondary beams (16th = level 2, 32nd = level 3) between adjacent notes that both reach the level
    for (var L = 2; L <= 3; L++) {
      var yy = beamY - dir * (L - 1) * 3.4;
      for (var i = 0; i < n; i++) {
        var a = run[i], b = run[i + 1];
        if (a.beams < L) continue;
        if (b && b.beams >= L) {
          g += '<rect x="' + a._stemX + '" y="' + (yy + (dir < 0 ? 0 : -th)) + '" width="' + Math.max(2, b._stemX - a._stemX) + '" height="' + th + '" fill="' + INK + '"/>';
        } else if ((!b || b.beams < L) && (i === 0 || run[i - 1].beams < L)) {
          // isolated high-level note → fractional-beam stub: the FIRST note of a run
          // points right (into the group); otherwise it points left (toward the prior note).
          var stubX = (i === 0) ? a._stemX : a._stemX - 5;
          g += '<rect x="' + stubX + '" y="' + (yy + (dir < 0 ? 0 : -th)) + '" width="5" height="' + th + '" fill="' + INK + '"/>';
        }
      }
    }
    return g;
  }

  return { render: render, setPlayhead: setPlayhead };
})();
