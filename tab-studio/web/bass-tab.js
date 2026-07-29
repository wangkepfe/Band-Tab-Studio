/* ============================================================================
 * bass-tab.js  —  Bass Tab view module for Bass Studio.
 *
 * A self-contained, drop-in "Bass Tab" view. It renders an interactive SVG bass
 * tablature driven by a shared MIDI *project* (the piano-roll editor's model)
 * and the global `BassTab` engine (bass-tab-core.js, loaded separately).
 *
 * Ported from the standalone Bass Tab Creator (index.html):
 *   • renderVisual()  — the SVG staff + duration-block fret boxes + rhythm lane
 *   • cycleNote / resetNote / validOverride — click-to-cycle fingering overrides
 *   • Player.anchor / seekToClient / reanchor — playhead + click-to-seek mapping
 *
 * Project model (ticks at project PPQ):
 *   { ppq, tempo, timeSig:{num,den}, notes:[{start,end,pitch,velocity}] }
 * BassTab.convert() wants a song with tempo / time-sig MAPS, so projectToSong()
 * adapts the project into that shape.
 *
 * Public API (the host app depends on this verbatim):
 *   BassTabView.create(container, opts) -> controller
 *     opts: { getProject, onSeekSeconds, onStatus?, onChange? }
 *     controller: render(), setOptions(partial), getOptions(),
 *                 setPlayheadTick(tick), clear()
 * ========================================================================== */
var BassTabView = (function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  // difficulty palette (matches the Bass Tab Creator's DIFF map)
  var DIFF = {
    easy: { fill: '#16331f', stroke: '#3fb950', text: '#9ff0ad' },
    med:  { fill: '#332a12', stroke: '#d4a72c', text: '#f3d795' },
    hard: { fill: '#3a161a', stroke: '#f85149', text: '#ffb0ad' }
  };

  // Colour palettes for renderVisual. SCREEN is the app's dark theme (keeps the
  // CSS-var hooks so studio.css theming still applies); PRINT is a light, ink-on-
  // white theme used to export a printable PDF (see getPrintable()). renderVisual
  // reads settings.palette, defaulting to SCREEN so on-screen output is unchanged.
  var PAL_SCREEN = {
    pageBg: '#0b0f15', barLine: '#48566a', beatLine: '#222a36', rhythmRef: '#1d2430',
    string: 'var(--string,#3a4452)', stringName: '#9aa6b5', barNum: '#7d8aa0',
    rhythmInk: '#c2ccda', finger: '#9fb0c4', accent: 'var(--accent2,#7c5cff)', diff: DIFF
  };
  // PRINT is pure black-on-white for printing: no difficulty colours (all three
  // levels render identical white boxes with a black border + black fret number),
  // black staff/strings, light-grey beat gridlines. Fingering is suppressed for
  // print via settings.showFingers (see getPrintable), so `finger` is unused here.
  var PAL_PRINT = {
    pageBg: '#ffffff', barLine: '#000000', beatLine: '#c8c8c8', rhythmRef: '#dcdcdc',
    string: '#111111', stringName: '#000000', barNum: '#000000',
    rhythmInk: '#000000', finger: '#000000', accent: '#000000',
    diff: {
      easy: { fill: '#ffffff', stroke: '#000000', text: '#000000' },
      med:  { fill: '#ffffff', stroke: '#000000', text: '#000000' },
      hard: { fill: '#ffffff', stroke: '#000000', text: '#000000' }
    }
  };

  // grid select value (note fraction) -> ticks, resolved against the project ppq.
  // 1/4=ppq, 1/8=ppq/2, 1/8T=ppq/3, 1/16=ppq/4, 1/16T=ppq/6, 1/32=ppq/8.
  function gridDivToTicks(div, ppq) {
    switch (String(div)) {
      case '4':   return ppq;
      case '8':   return Math.round(ppq / 2);
      case '8t':  return Math.round(ppq / 3);
      case '16':  return Math.round(ppq / 4);
      case '16t': return Math.round(ppq / 6);
      case '32':  return Math.round(ppq / 8);
      default:    return Math.round(ppq / 4);   // fall back to 1/16
    }
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Adapt a piano-roll project into the song shape BassTab.convert expects.
  function projectToSong(p) {
    p = p || {};
    return {
      ppq: p.ppq || 480,
      notes: p.notes || [],
      tempos: [{ tick: 0, usPerQuarter: Math.round(60000000 / (p.tempo || 120)), bpm: p.tempo || 120 }],
      timeSigs: [{ tick: 0, num: (p.timeSig && p.timeSig.num) || 4, den: (p.timeSig && p.timeSig.den) || 4 }]
    };
  }

  // ---- one-time stylesheet injection (so this module is drop-in, no CSS file) -
  // Relevant rules ported from index.html's <style>. Uses studio.css tokens
  // (--string, --play) where they exist; difficulty colours live inline per-rect.
  var STYLE_ID = 'bass-tab-view-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.bt-view{overflow-x:auto;overflow-y:auto;background:#0b0f15;border:1px solid var(--line);' +
        'border-radius:10px;padding:10px;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
      '.bt-view svg.system{display:block;margin-bottom:6px;touch-action:pan-x pan-y}' +
      '.bt-view.seekable svg.system{cursor:crosshair}' +
      '.bt-view g.note{cursor:pointer}' +
      '.bt-view g.note:hover path{filter:brightness(1.4)}' +
      '.bt-view g.note:active path{filter:brightness(1.7)}' +
      '.bt-view line.playhead{stroke:var(--play,#ffcf4d);stroke-width:1.8;pointer-events:none}' +
      '.bt-empty{color:var(--muted,#8b97a7);text-align:center;padding:48px 20px;font-size:13px}';
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  function create(container, opts) {
    opts = opts || {};
    injectStyle();
    if (container && container.classList) container.classList.add('bt-view');

    var getProject   = opts.getProject   || function () { return null; };
    var onSeekSeconds = opts.onSeekSeconds || function () {};
    var onStatus     = opts.onStatus     || null;
    var onChange     = opts.onChange     || null;
    var onZoom       = opts.onZoom       || function () {};
    // Fretboard tuning — defaults to 4-string bass, but a 6-string guitar tuning
    // (BassTab.GUITAR_TUNING) can be passed; the renderer draws tuning.length string lines.
    var tuning       = opts.tuning       || BassTab.STD_TUNING;

    // internal options (exact keys + defaults required by the host)
    var options = {
      avoidOpen: false,
      maxFret: 24,
      octaveShift: 0,
      semitoneShift: 0,
      gridDiv: '16',
      barsPerLine: 4,
      showFingers: true,
      monophonic: true,
      offsetTicks: 0
    };

    // manual fingering overrides, keyed by BassTab.noteKeys() (survives transforms)
    var overrides = {};

    // last convert() result + derived geometry, kept so setPlayheadTick() and
    // click-to-seek can map a tick <-> system + x without re-deriving the layout.
    var lastResult = null;
    var lastSong = null;
    var lastSettings = null;
    var geom = { systems: [], grid: 1, spb: 1, ppq: 480, tempo: 120 };
    var zoomFactor = 1;   // render scale: each system <svg> is sized W*zoom × H*zoom (vector-crisp)
    var follow = opts.follow || function () { return true; };  // () => auto-scroll? (only while playing)
    var lastFollowIdx = -1;   // page-flip only when the playhead enters a NEW row (no per-frame reflow)

    // playhead overlay (a single <line> moved between system <svg>s)
    var ph = null, phSvg = null;

    // ---- rendering ---------------------------------------------------------
    function render() {
      var project = getProject();
      lastSong = null; lastSettings = null; lastResult = null;
      detachPlayhead();

      var rawNotes = (project && project.notes) || [];
      if (!rawNotes.length) {
        container.innerHTML = '<div class="bt-empty">No notes yet — add some in the piano roll to see the tab.</div>';
        geom.systems = [];
        if (onStatus) onStatus(null);
        return;
      }

      var song = projectToSong(project);
      var ppq = song.ppq;

      // monophonic clean-up for polyphonic transcriptions (basic-pitch output)
      if (options.monophonic) {
        song = projectToSong(project);   // rebuild (defensive: don't mutate caller notes)
        song.notes = BassTab.monophonicReduce(rawNotes, ppq, { pick: 'low' });
      }

      var ts = {
        num: (project && project.timeSig && project.timeSig.num) || 4,
        den: (project && project.timeSig && project.timeSig.den) || 4
      };

      // Note ticks sit on the timeline's tempo (what the transcription was written at),
      // while the BPM box holds the song's musical tempo. A bar therefore covers
      // ppq × timelineTempo/musicalTempo ticks, so hand the layout a scaled ppq — bars,
      // beats, grid columns and rhythm values all stretch by the same factor and the
      // barlines land where the music's bars are, exactly like the piano roll's grid.
      var musicalTempo = (project && project.tempo) || 120;
      var timelineTempo = (project && project.timelineTempo) || musicalTempo;
      var layoutPpq = ppq * (timelineTempo / musicalTempo);
      song.ppq = layoutPpq;
      // Snap the division to one that fits the bar a whole number of times — at ppq 220
      // a rounded 1/32 (28 ticks) would walk the columns off the barlines.
      var ticksPerBar = layoutPpq * 4 * ts.num / ts.den;
      var steps = Math.max(1, Math.round(ticksPerBar / gridDivToTicks(options.gridDiv, layoutPpq)));

      var settings = {
        tuning: tuning,
        maxFret: +options.maxFret || 24,
        timeSig: ts,
        octaveShift: +options.octaveShift || 0,    // OCTAVES (core multiplies by 12)
        semitoneShift: +options.semitoneShift || 0, // semitones
        tickShift: +options.offsetTicks || 0,       // nudge tab in time (pickup/bar-1 align)
        gridTicks: ticksPerBar / steps,
        originTick: 0,
        barsPerLine: +options.barsPerLine || 4,
        bpmOverride: musicalTempo,                  // with layoutPpq this reads back real seconds
        avoidOpen: !!options.avoidOpen,
        overrides: overrides
      };

      var r = BassTab.convert(song, settings);
      lastResult = r;
      lastSong = song;
      lastSettings = settings;
      geom.ppq = layoutPpq;                         // seek maps click → tick → seconds with these two
      geom.tempo = musicalTempo;

      container.innerHTML = renderVisual(r, settings, song) ||
        '<div class="bt-empty">No notes to display.</div>';
      geom.grid = settings.gridTicks;
      geom.tickShift = settings.tickShift || 0;   // tab is drawn shifted by this; playhead + seek must match
      geom.spb = r.layout.stepsPerBar;
      cacheSystems();
      applyZoom();

      if (onStatus) onStatus(r.ergo);
    }

    // The SVG builder — ported from index.html renderVisual(). Returns an HTML
    // string of one <svg class="system"> per row. Carries data-* attrs the
    // playhead + seek logic read back.
    function renderVisual(r, settings, song) {
      var ts = settings.timeSig, tuning = r.tuning;
      var pal = (settings && settings.palette) || PAL_SCREEN;
      var DIFF = pal.diff;
      var cols = r.layout.columns, spb = r.layout.stepsPerBar;
      var totalBars = cols.length ? cols[cols.length - 1].bar + 1 : 0;
      var grid = settings.gridTicks;

      // per-note start column + end column. End is the note's real end, capped at
      // the next onset on the SAME string so duration boxes never overlap.
      var noteCol = {}, noteEndCol = {};
      cols.forEach(function (c) { c.noteIdx.forEach(function (i) { noteCol[i] = c.col; }); });
      var onsetByStr = {};
      r.notes.forEach(function (n, i) {
        var p = r.fingering.positions[i]; if (!p) return;
        (onsetByStr[p.string] = onsetByStr[p.string] || []).push(noteCol[i]);
      });
      Object.keys(onsetByStr).forEach(function (k) { onsetByStr[k].sort(function (a, b) { return a - b; }); });
      r.notes.forEach(function (n, i) {
        var p = r.fingering.positions[i], scol = noteCol[i] || 0, raw = Math.round(n.end / grid), cap = Infinity;
        if (p) { var arr = onsetByStr[p.string] || []; for (var k = 0; k < arr.length; k++) { if (arr[k] > scol) { cap = arr[k]; break; } } }
        noteEndCol[i] = Math.min(Math.max(scol + 1, raw), cap);
      });

      var colsPerBeat = Math.max(1, Math.round((song.ppq * 4 / ts.den) / grid));
      var colW = Math.max(13, Math.round(58 / colsPerBeat));
      var rowH = 28, topPad = 30, leftPad = 26, badgeH = 18, nS = tuning.length;
      var barsPerSys = settings.barsPerLine;
      // print passes settings.showFingers:false to force fingering off regardless
      // of the on-screen toggle; on screen settings.showFingers is undefined → use the option.
      var showFing = (settings.showFingers != null) ? !!settings.showFingers : !!options.showFingers;
      var diffArr = r.ergo.perNoteDifficulty;

      // per-note: how many fretboard positions sound this pitch, and is it pinned?
      var altCount = {}, isOverridden = {};
      r.notes.forEach(function (n, i) {
        altCount[i] = BassTab.fretChoices(n.pitch, tuning, settings.maxFret).length;
        isOverridden[i] = !!overrides[r.noteKeys[i]];
      });

      function yOf(strIdx) { return topPad + (nS - 1 - strIdx) * rowH + rowH / 2; }
      var eLineY = yOf(0);                       // bottom string line
      var rhyHeadY = topPad + nS * rowH + 14;    // notehead row of the rhythm lane
      var stemBottom = rhyHeadY + 16;
      var H = stemBottom + 12;
      var RINK = pal.rhythmInk;                  // rhythm ink (from palette)

      // --- rhythm glyph builders (x = column centre) ---
      function noteGlyph(x, val) {
        var d = val.d, g = '', filled = d >= 4, flags = (d === 8 ? 1 : d === 16 ? 2 : d === 32 ? 3 : 0);
        if (d >= 2) g += '<line x1="' + x + '" y1="' + rhyHeadY + '" x2="' + x + '" y2="' + stemBottom + '" stroke="' + RINK + '" stroke-width="1.5"/>';
        for (var f = 0; f < flags; f++) { var yb = stemBottom - f * 5;
          g += '<line x1="' + x + '" y1="' + yb + '" x2="' + (x + 8) + '" y2="' + (yb - 3) + '" stroke="' + RINK + '" stroke-width="2.3" stroke-linecap="round"/>'; }
        g += '<ellipse cx="' + x + '" cy="' + rhyHeadY + '" rx="4.3" ry="3.1" fill="' + (filled ? RINK : pal.pageBg) + '" stroke="' + RINK + '" stroke-width="1.4"/>';
        if (val.dotted) g += '<circle cx="' + (x + 8) + '" cy="' + rhyHeadY + '" r="1.5" fill="' + RINK + '"/>';
        return g;
      }
      function restGlyph(cx, val) {
        var d = val.d, g = '', y = rhyHeadY;
        if (d === 1)      g += '<rect x="' + (cx - 5) + '" y="' + y + '" width="10" height="4" fill="' + RINK + '"/>';        // whole: hangs
        else if (d === 2) g += '<rect x="' + (cx - 5) + '" y="' + (y - 4) + '" width="10" height="4" fill="' + RINK + '"/>'; // half: sits
        else if (d === 4) g += '<path d="M' + (cx - 3) + ' ' + (y - 7) + ' l5 6 l-5 5 l5 6" fill="none" stroke="' + RINK + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>'; // quarter zigzag
        else {                                                                                                              // 8th/16th/32nd
          var flags = (d === 8 ? 1 : d === 16 ? 2 : 3);
          g += '<line x1="' + (cx + 3) + '" y1="' + (y - 6) + '" x2="' + (cx - 3) + '" y2="' + (y + 9) + '" stroke="' + RINK + '" stroke-width="1.5"/>';
          for (var k = 0; k < flags; k++) { var by = y - 5 + k * 5;
            g += '<circle cx="' + (cx + 2) + '" cy="' + by + '" r="2.1" fill="' + RINK + '"/>';
            g += '<line x1="' + (cx + 2) + '" y1="' + by + '" x2="' + (cx - 2) + '" y2="' + (by + 3) + '" stroke="' + RINK + '" stroke-width="1.3"/>'; }
        }
        if (val.dotted) g += '<circle cx="' + (cx + 8) + '" cy="' + y + '" r="1.5" fill="' + RINK + '"/>';
        return g;
      }

      // rounded-rect path with independent left/right corner rounding. A flat
      // (square) edge marks the side where a note crosses a row break — the "open"
      // half of a carried-over pill.
      function pillPath(x, y, w, h, roundL, roundR) {
        var r = Math.min(4, w / 2, h / 2);
        var rl = roundL ? r : 0, rr = roundR ? r : 0;
        var x2 = x + w, y2 = y + h;
        var d = 'M' + (x + rl) + ',' + y + 'H' + (x2 - rr);
        if (rr) d += 'A' + rr + ',' + rr + ' 0 0 1 ' + x2 + ',' + (y + rr);
        d += 'V' + (y2 - rr);
        if (rr) d += 'A' + rr + ',' + rr + ' 0 0 1 ' + (x2 - rr) + ',' + y2;
        d += 'H' + (x + rl);
        if (rl) d += 'A' + rl + ',' + rl + ' 0 0 1 ' + x + ',' + (y2 - rl);
        d += 'V' + (y + rl);
        if (rl) d += 'A' + rl + ',' + rl + ' 0 0 1 ' + (x + rl) + ',' + y;
        return d + 'Z';
      }

      var html = '';
      for (var b0 = 0; b0 < totalBars; b0 += barsPerSys) {
        var b1 = Math.min(b0 + barsPerSys, totalBars);
        var startCol = b0 * spb, endCol = b1 * spb;
        var W = leftPad + (endCol - startCol) * colW + 12;
        var X = (function (sCol, lPad, cW) { return function (col) { return lPad + (col - sCol) * cW; }; })(startCol, leftPad, colW);

        // viewBox in unscaled units (crisp vector). data-* lets the playhead +
        // click-to-seek map a tick to an x without re-deriving layout.
        var svg = '<svg class="system" width="' + W.toFixed(1) + '" height="' + H.toFixed(1) + '" viewBox="0 0 ' + W + ' ' + H + '"' +
                  ' data-startcol="' + startCol + '" data-endcol="' + endCol + '" data-colw="' + colW + '" data-leftpad="' + leftPad + '"' +
                  ' data-w="' + W + '" data-h="' + H + '" data-firstbar="' + b0 + '">';

        // gridlines: bar lines run through the rhythm lane, beat lines stop at the staff
        for (var c = startCol; c <= endCol; c++) {
          if (c % colsPerBeat === 0) {
            var isBar = (c % spb === 0);
            svg += '<line x1="' + X(c) + '" y1="' + (topPad - (isBar ? 14 : 6)) + '" x2="' + X(c) + '" y2="' + (isBar ? stemBottom + 2 : eLineY) +
                   '" stroke="' + (isBar ? pal.barLine : pal.beatLine) + '" stroke-width="' + (isBar ? 1.4 : 1) + '"/>';
          }
        }
        // faint rhythm reference line (rest positioning)
        svg += '<line x1="' + leftPad + '" y1="' + rhyHeadY + '" x2="' + (W - 6) + '" y2="' + rhyHeadY + '" stroke="' + pal.rhythmRef + '" stroke-width="1"/>';
        // string lines + names
        for (var si = nS - 1; si >= 0; si--) {
          var y = yOf(si);
          svg += '<line x1="' + leftPad + '" y1="' + y + '" x2="' + (W - 6) + '" y2="' + y + '" stroke="' + pal.string + '" stroke-width="1"/>';
          svg += '<text x="6" y="' + (y + 4) + '" fill="' + pal.stringName + '" font-family="monospace" font-size="12">' + tuning[si].name + '</text>';
        }
        // bar numbers
        for (var bb = b0; bb < b1; bb++)
          svg += '<text x="' + (X(bb * spb) + 3) + '" y="14" fill="' + pal.barNum + '" font-size="11" font-family="monospace">' + (bb + 1) + '</text>';

        // duration "pills" — LEFT edge = note start, RIGHT edge = note end. A note
        // that sustains past the row gets an open (flat) right edge and is carried
        // onto the next row(s) as a left-open continuation pill (no fret number), so a
        // held note never leaves the following row blank.
        (function (X2, startC, endC) {
          r.notes.forEach(function (n, i) {
            var a = noteCol[i]; if (a == null) return;
            var z = noteEndCol[i];
            if (a >= endC || z <= startC) return;          // note doesn't reach this row
            var p = r.fingering.positions[i]; if (!p) return;
            var onset = a >= startC;                        // this row holds the attack
            var openL = !onset, openR = z > endC;           // flat edge where it crosses a row break
            var d = DIFF[diffArr[i] || 'easy'], yy = yOf(p.string), yTop = yy - badgeH / 2;
            var x0 = X2(onset ? a : startC), x1;
            if (openR) x1 = W - 6;                          // run off the row's right edge
            else if (onset) x1 = Math.max(X2(z), x0 + (p.fret >= 10 ? 17 : 13));  // floor width so the number stays legible
            else x1 = X2(z);
            if (x1 > W - 6) x1 = W - 6;
            if (x1 < x0 + 4) x1 = x0 + 4;
            var cyc = altCount[i] > 1, ov = isOverridden[i];
            var tip = BassTab.pitchName(n.pitch) + (onset ? (cyc ? ' · ' + altCount[i] + ' positions — click to cycle' : ' · only position') + (ov ? ' · manual (right-click to reset)' : '') : ' · held');
            svg += '<g data-note="' + i + '"' + (cyc ? ' class="note"' : '') + '><title>' + tip + '</title>';
            svg += '<path d="' + pillPath(x0, yTop, x1 - x0, badgeH, !openL, !openR) + '" fill="' + d.fill + '"' + (onset ? '' : ' fill-opacity="0.8"') + ' stroke="' + (ov ? pal.accent : d.stroke) + '" stroke-width="' + (ov ? 1.8 : 1.3) + '"/>';
            if (onset) {
              var numX = openR ? (x0 + (p.fret >= 10 ? 11 : 9)) : (x0 + (x1 - x0) / 2);
              svg += '<text x="' + numX + '" y="' + (yy + 4) + '" text-anchor="middle" fill="' + d.text + '" font-family="monospace" font-size="12" font-weight="700">' + p.fret + '</text>';
              if (showFing && p.finger > 0)
                svg += '<text x="' + (x0 + 2) + '" y="' + (yTop - 2) + '" fill="' + pal.finger + '" font-size="9" font-family="monospace">' + p.finger + '</text>';
              if (ov) {
                // keep the override dot next to the fret number; for a note that runs
                // off the row, x1 is at the far margin, so anchor near numX instead.
                var ovX = openR ? (numX + (p.fret >= 10 ? 9 : 7)) : (x1 - 2.6);
                svg += '<circle cx="' + ovX + '" cy="' + (yTop + 2.6) + '" r="2.6" fill="' + pal.accent + '" stroke="' + pal.pageBg + '" stroke-width="0.8"/>';
              }
            }
            svg += '</g>';
          });
        })(X, startCol, endCol);

        // rhythm lane: note stems/flags + rests, nudged a few px right of the grid
        // line so an onset glyph sits just inside its bar instead of on the bar line.
        var GX = Math.min(6, colW * 0.4);
        (function (X3, startC, endC) {
          r.rhythm.forEach(function (e) {
            if (e.startCol < startC || e.startCol >= endC) return;
            if (e.kind === 'note') svg += noteGlyph(X3(e.startCol) + GX, e.value);
            else svg += restGlyph(X3(e.startCol) + GX + (e.steps - 1) * colW / 2, e.value);
          });
        })(X, startCol, endCol);

        svg += '</svg>';
        html += svg;
      }
      return html;
    }

    // ---- geometry cache (shared by playhead + click-to-seek) ---------------
    function cacheSystems() {
      var els = container.querySelectorAll('svg.system');
      geom.systems = Array.prototype.map.call(els, function (el) {
        return {
          el: el,
          startCol: +el.dataset.startcol, endCol: +el.dataset.endcol,
          colW: +el.dataset.colw, leftPad: +el.dataset.leftpad,
          W: +el.dataset.w, H: +el.dataset.h, firstBar: +el.dataset.firstbar
        };
      });
    }

    // ---- zoom (scale the SVG systems; vector text stays crisp) --------------
    function applyZoom() {
      geom.systems.forEach(function (m) {
        m.el.style.width = (m.W * zoomFactor) + 'px';
        m.el.style.height = (m.H * zoomFactor) + 'px';
      });
    }
    function setZoom(z) { zoomFactor = Math.max(0.4, Math.min(3, +z || 1)); applyZoom(); onZoom(zoomFactor); }
    function getZoom() { return zoomFactor; }
    // ctrl/cmd + wheel zooms the tab; a plain wheel scrolls the staff as usual
    function onWheel(e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(zoomFactor * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }
    // page-flip follow: if the playhead's row isn't fully visible, jump the scroll
    // window so the row sits near the top of the next "page" (browser clamps at the end).
    function keepRowVisible(el) {
      if (!container || !el) return;
      var hostRect = container.getBoundingClientRect(), r = el.getBoundingClientRect();
      var topIn = r.top - hostRect.top;
      if (topIn < 0 || r.bottom - hostRect.top > container.clientHeight) container.scrollTop += topIn - 8;
    }

    // ---- playhead ----------------------------------------------------------
    function detachPlayhead() {
      if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
      phSvg = null; lastFollowIdx = -1;
    }
    // Position the playhead overlay at a project tick (tick<0 hides it). Maps the
    // tick -> system + x via the cached geometry. Does NOT re-render.
    function setPlayheadTick(tick) {
      var sys = geom.systems, grid = geom.grid || 1;
      if (tick == null || tick < 0 || !sys.length) { detachPlayhead(); return; }
      var col = (tick + (geom.tickShift || 0)) / grid, idx = -1;
      for (var i = 0; i < sys.length; i++) { if (col >= sys[i].startCol && col < sys[i].endCol) { idx = i; break; } }
      if (idx < 0) idx = (col < sys[0].startCol) ? 0 : sys.length - 1;
      var m = sys[idx], c = clamp(col, m.startCol, m.endCol), x = m.leftPad + (c - m.startCol) * m.colW;
      if (!ph) { ph = document.createElementNS(SVGNS, 'line'); ph.setAttribute('class', 'playhead'); }
      if (phSvg !== m.el) { m.el.appendChild(ph); phSvg = m.el; }
      ph.setAttribute('x1', x.toFixed(1)); ph.setAttribute('x2', x.toFixed(1));
      ph.setAttribute('y1', '8'); ph.setAttribute('y2', (m.H - 6).toFixed(1));
      // page-flip when the playhead enters a new row, only while actually playing
      if (idx !== lastFollowIdx && follow()) { lastFollowIdx = idx; keepRowVisible(m.el); }
    }

    // ---- fingering overrides ----------------------------------------------
    // Left-click a note: cycle to the next playable (string,fret) for its pitch.
    function cycleNote(i) {
      var r = lastResult; if (!r || !r.notes[i]) return;
      var choices = BassTab.fretChoices(r.notes[i].pitch, r.tuning, (+options.maxFret || 24));
      if (choices.length < 2) return;                  // nothing to loop through
      var cur = r.fingering.positions[i], curIdx = 0;
      for (var k = 0; k < choices.length; k++)
        if (cur && choices[k].string === cur.string && choices[k].fret === cur.fret) { curIdx = k; break; }
      var nx = choices[(curIdx + 1) % choices.length];
      overrides[r.noteKeys[i]] = { string: nx.string, fret: nx.fret };
      render();
      if (onChange) onChange();
    }
    // Right-click / long-press a note: drop its override, back to auto fingering.
    function resetNote(i) {
      var r = lastResult; if (!r) return;
      var key = r.noteKeys[i];
      if (overrides[key]) { delete overrides[key]; render(); if (onChange) onChange(); }
    }

    // Return a deep copy of the internal overrides map (never the live object),
    // so project save can snapshot the manual fingerings.
    function getOverrides() {
      var copy = {};
      for (var k in overrides) {
        if (overrides.hasOwnProperty(k)) {
          var ov = overrides[k];
          copy[k] = { string: ov.string, fret: ov.fret };
        }
      }
      return copy;
    }
    // Replace the internal overrides map with a shallow-cloned copy of `obj`
    // (or {} if falsy), then redraw. Safe to call before the first render().
    function setOverrides(obj) {
      var next = {};
      if (obj) for (var k in obj) if (obj.hasOwnProperty(k)) next[k] = obj[k];
      overrides = next;
      render();
    }

    // ---- click-to-seek -----------------------------------------------------
    // Port of Player.seekToClient: map a click x on a system to a tick, then to
    // seconds via the project tempo, and hand it to the host.
    function seekToClient(svg, clientX) {
      var W = +svg.dataset.w, startCol = +svg.dataset.startcol, leftPad = +svg.dataset.leftpad, colW = +svg.dataset.colw;
      var rect = svg.getBoundingClientRect(), xView = (clientX - rect.left) / rect.width * W;
      var col = Math.max(startCol, (startCol + (xView - leftPad) / colW));
      var tick = col * (geom.grid || 1) - (geom.tickShift || 0);
      var tempo = geom.tempo || 120, ppq = geom.ppq || 480;
      var sec = tick * 60 / (tempo * ppq);
      onSeekSeconds(sec < 0 ? 0 : sec);
    }

    // ---- interaction (event delegation on the container) -------------------
    function onClick(e) {
      if (longPressFired) { longPressFired = false; e.stopPropagation(); e.preventDefault(); return; }
      if (!e.target.closest) return;
      var g = e.target.closest('g[data-note]');
      if (g) { cycleNote(+g.getAttribute('data-note')); return; }
      var svg = e.target.closest('svg.system');   // empty spot on the staff -> seek
      if (svg) seekToClient(svg, e.clientX);
    }
    function onContextMenu(e) {
      var g = e.target.closest && e.target.closest('g[data-note]'); if (!g) return;
      e.preventDefault(); resetNote(+g.getAttribute('data-note'));
    }

    // touch long-press = reset (mirrors contextmenu, which touch can't fire)
    var lpTimer = null, lpX = 0, lpY = 0, longPressFired = false;
    function lpCancel() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
    function onTouchStart(e) {
      if (e.touches.length > 1) { lpCancel(); return; }     // pinch, not a press
      var g = e.target.closest && e.target.closest('g[data-note]'); if (!g) { lpCancel(); return; }
      var t = e.touches[0]; lpX = t.clientX; lpY = t.clientY; longPressFired = false;
      var i = +g.getAttribute('data-note');
      lpCancel(); lpTimer = setTimeout(function () { longPressFired = true; resetNote(i); }, 550);
    }
    function onTouchMove(e) {
      if (!lpTimer) return; var t = e.touches[0];
      if (Math.abs(t.clientX - lpX) > 10 || Math.abs(t.clientY - lpY) > 10) lpCancel();  // it's a scroll
    }

    container.addEventListener('click', onClick);
    container.addEventListener('contextmenu', onContextMenu);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', lpCancel, { passive: true });
    container.addEventListener('touchcancel', lpCancel, { passive: true });

    // ---- options -----------------------------------------------------------
    function setOptions(partial) {
      if (partial) for (var k in partial) if (partial.hasOwnProperty(k)) options[k] = partial[k];
      render();
    }
    function getOptions() {
      var copy = {};
      for (var k in options) if (options.hasOwnProperty(k)) copy[k] = options[k];
      return copy;
    }

    function clear() {
      detachPlayhead();
      container.innerHTML = '';
      geom.systems = [];
      lastResult = null; lastSong = null; lastSettings = null;
    }

    // Build a print-ready (light-theme) copy of the current tab for PDF export.
    // Re-renders the cached last result with the PRINT palette so the on-screen
    // (dark) tab is left untouched, and returns the light SVG systems plus the
    // header facts (tuning/tempo/meter/ergo). Null when there's no tab yet.
    function getPrintable() {
      if (!lastResult || !lastSong || !lastSettings) return null;
      var pset = Object.assign({}, lastSettings, { palette: PAL_PRINT, showFingers: false });
      var systemsHtml = renderVisual(lastResult, pset, lastSong);
      if (!systemsHtml) return null;
      var tun = (lastResult.tuning || tuning).map(function (t) { return t.name; }).join(' ');
      return {
        systemsHtml: systemsHtml,
        tuning: tun,
        tempo: Math.round(geom.tempo || 120),
        timeSig: lastSettings.timeSig || { num: 4, den: 4 },
        ergo: lastResult.ergo || null,
        pal: PAL_PRINT
      };
    }

    return {
      render: render,
      setOptions: setOptions,
      getOptions: getOptions,
      setPlayheadTick: setPlayheadTick,
      setZoom: setZoom,
      getZoom: getZoom,
      getAscii: function () { return lastResult ? lastResult.ascii : ''; },
      getPrintable: getPrintable,
      getOverrides: getOverrides,
      setOverrides: setOverrides,
      clear: clear
    };
  }

  return { create: create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BassTabView;
