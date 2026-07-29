/* ============================================================================
 * guitar-chord.js  —  Guitar Chords view (TAB TYPE 1).
 *
 * Renders a chord progression (detected from the shared piano-roll notes via
 * ChordCore) as a bar-by-bar chord ribbon with a playhead + click-to-seek, plus
 * a palette of chord-diagram (fingering) charts for each chord used.
 *
 * Public API mirrors BassTabView:
 *   GuitarChordView.create(container, { getProject, onSeekSeconds, onStatus?, onChange? })
 *     -> { render, setPlayheadTick, getChords, getOptions, setOptions, clear }
 * ========================================================================== */
var GuitarChordView = (function () {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var STR = ['E', 'A', 'D', 'G', 'B', 'e'];   // low -> high (diagram draws high->low)

  var STYLE_ID = 'guitar-chord-view-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.gc-view{overflow:auto;background:#0b0f15;border:1px solid var(--line);border-radius:10px;padding:12px;-webkit-user-select:none;user-select:none}' +
      '.gc-ribbon{display:block;margin-bottom:14px;cursor:crosshair}' +
      '.gc-head{color:var(--muted,#8b97a7);font-size:12px;margin:4px 2px 8px;font-weight:600;letter-spacing:.02em}' +
      '.gc-pal{display:flex;flex-wrap:wrap;gap:10px}' +
      '.gc-chip{background:#121823;border:1px solid var(--line,#26303c);border-radius:8px;padding:6px 6px 2px;text-align:center}' +
      '.gc-chip.active{border-color:var(--accent2,#7c5cff);box-shadow:0 0 0 1px var(--accent2,#7c5cff)}' +
      '.gc-chip .nm{color:#e6edf5;font:600 13px/1.2 monospace;margin-bottom:2px}' +
      '.gc-empty{color:var(--muted,#8b97a7);text-align:center;padding:48px 20px;font-size:13px}' +
      '.gc-block{cursor:pointer}.gc-block:hover rect{filter:brightness(1.3)}' +
      '.gc-ribbon line.gc-play{stroke:var(--play,#ffcf4d);stroke-width:1.8;pointer-events:none}';
    var el = document.createElement('style'); el.id = STYLE_ID; el.textContent = css;
    document.head.appendChild(el);
  }

  // One chord-diagram SVG (fixed 64x86). shape: {frets:[6 low->high], baseFret, label, barreFret}.
  function diagram(shape) {
    var W = 64, H = 78, x0 = 12, y0 = 18, cw = 8, rows = 5, rh = 11;
    var strW = cw * 5;
    var s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
    var base = shape.baseFret || 1;
    // nut (thick) when starting at fret 1, else a base-fret label
    if (base <= 1) s += '<rect x="' + x0 + '" y="' + (y0 - 3) + '" width="' + strW + '" height="3" fill="#9aa6b5"/>';
    else s += '<text x="' + (x0 + strW + 4) + '" y="' + (y0 + rh) + '" fill="#8b97a7" font-size="9" font-family="monospace">' + base + 'fr</text>';
    // grid: 6 strings (vertical), `rows` frets (horizontal)
    for (var i = 0; i < 6; i++) s += '<line x1="' + (x0 + i * cw) + '" y1="' + y0 + '" x2="' + (x0 + i * cw) + '" y2="' + (y0 + rows * rh) + '" stroke="#3a4452" stroke-width="1"/>';
    for (var r = 0; r <= rows; r++) s += '<line x1="' + x0 + '" y1="' + (y0 + r * rh) + '" x2="' + (x0 + strW) + '" y2="' + (y0 + r * rh) + '" stroke="#2a3340" stroke-width="1"/>';
    // open/mute markers above the nut + dots
    for (var st = 0; st < 6; st++) {
      var f = shape.frets[st];                 // absolute fret (-1 mute, 0 open)
      var xx = x0 + st * cw;
      if (f < 0) s += '<text x="' + xx + '" y="' + (y0 - 5) + '" text-anchor="middle" fill="#f85149" font-size="8" font-family="monospace">×</text>';
      else if (f === 0) s += '<circle cx="' + xx + '" cy="' + (y0 - 7) + '" r="2.6" fill="none" stroke="#9ff0ad" stroke-width="1"/>';
      else {
        var rel = f - base + 1;                // 1-based row within the window
        if (rel < 1 || rel > rows) continue;
        var cy = y0 + (rel - 0.5) * rh;
        s += '<circle cx="' + xx + '" cy="' + cy + '" r="3.2" fill="#7c5cff"/>';
      }
    }
    s += '</svg>';
    return s;
  }

  function create(container, opts) {
    opts = opts || {};
    injectStyle();
    if (container && container.classList) container.classList.add('gc-view');
    var getProject = opts.getProject || function () { return null; };
    var onSeekSeconds = opts.onSeekSeconds || function () {};
    var onStatus = opts.onStatus || null;
    var options = { barsPerLine: 4, offsetTicks: 0 };

    var segs = [], geom = { ppq: 480, tempo: 120, beatTicks: 480, spb: 4, rows: [], colW: 60, leftPad: 8 };
    var ph = null, phSvg = null;

    function render() {
      var p = getProject() || {};
      var notes = (p.notes || []);
      // Bars are measured on the musical tempo while the note ticks sit on the
      // timeline's, so the ppq the ribbon works in scales by their ratio (same rule as
      // the piano-roll grid and the fretted tabs). Seek reads back real seconds because
      // tick × 60/(tempo × ppq) collapses to the timeline tempo again.
      geom.tempo = p.tempo || 120;
      geom.ppq = (p.ppq || 480) * ((p.timelineTempo || geom.tempo) / geom.tempo);
      var ts = (p.timeSig) || { num: 4, den: 4 };
      geom.beatTicks = geom.ppq * 4 / ts.den;
      geom.spb = ts.num;
      if (!notes.length) {
        container.innerHTML = '<div class="gc-empty">No notes yet — transcribe a guitar part or add notes to see its chords.</div>';
        segs = []; if (onStatus) onStatus(null); detachPlayhead(); return;
      }
      // shift notes by offset (align bar 1), then detect
      var off = +options.offsetTicks || 0;
      var shifted = off ? notes.map(function (n) { return { start: n.start + off, end: n.end + off, pitch: n.pitch, velocity: n.velocity }; }).filter(function (n) { return n.end > 0; }) : notes;
      segs = ChordCore.detect(shifted, geom.ppq, ts, {});
      container.innerHTML = renderRibbon() + renderPalette();
      cacheRows();
      if (onStatus) onStatus({ count: segs.length, unique: uniqueLabels().length });
    }

    function uniqueLabels() {
      var seen = {}, out = []; segs.forEach(function (s) { if (!seen[s.label]) { seen[s.label] = 1; out.push(s.label); } }); return out;
    }

    function renderRibbon() {
      var beatTicks = geom.beatTicks, spb = geom.spb, barTicks = beatTicks * spb;
      var totalBars = Math.max(1, Math.ceil(segs[segs.length - 1].endTick / barTicks));
      var barsPerSys = +options.barsPerLine || 4;
      var colW = 64, barW = colW, leftPad = 8, rowH = 56, labY = 20, barY = 30, barH = 22;
      geom.colW = barW / spb; geom.leftPad = leftPad; geom.barW = barW; geom.barTicks = barTicks;
      var html = '<div class="gc-head">Progression</div>';
      for (var b0 = 0; b0 < totalBars; b0 += barsPerSys) {
        var b1 = Math.min(b0 + barsPerSys, totalBars);
        var W = leftPad + (b1 - b0) * barW + 8;
        var svg = '<svg class="gc-ribbon" width="' + W + '" height="' + rowH + '" viewBox="0 0 ' + W + ' ' + rowH + '" data-firstbar="' + b0 + '" data-barw="' + barW + '" data-leftpad="' + leftPad + '" data-w="' + W + '">';
        // bar cells + numbers
        for (var b = b0; b < b1; b++) {
          var bx = leftPad + (b - b0) * barW;
          svg += '<line x1="' + bx + '" y1="' + barY + '" x2="' + bx + '" y2="' + (barY + barH) + '" stroke="#48566a" stroke-width="1.2"/>';
          svg += '<text x="' + (bx + 2) + '" y="14" fill="#7d8aa0" font-size="10" font-family="monospace">' + (b + 1) + '</text>';
        }
        svg += '<line x1="' + (leftPad + (b1 - b0) * barW) + '" y1="' + barY + '" x2="' + (leftPad + (b1 - b0) * barW) + '" y2="' + (barY + barH) + '" stroke="#48566a" stroke-width="1.2"/>';
        // chord blocks intersecting this row
        segs.forEach(function (sg, i) {
          var s0 = sg.startTick / barTicks, s1 = sg.endTick / barTicks;
          if (s1 <= b0 || s0 >= b1) return;
          var a = Math.max(s0, b0), z = Math.min(s1, b1);
          var x = leftPad + (a - b0) * barW, w = Math.max(14, (z - a) * barW - 2);
          svg += '<g class="gc-block" data-seg="' + i + '"><title>' + sg.label + '</title>';
          svg += '<rect class="gc-fill" x="' + x + '" y="' + barY + '" width="' + w + '" height="' + barH + '" rx="4" fill="#1b2a3f" stroke="#3b6ea5" stroke-width="1.2"/>';
          svg += '<text x="' + (x + w / 2) + '" y="' + (barY + 15) + '" text-anchor="middle" fill="#cfe3ff" font-family="monospace" font-size="12" font-weight="700">' + sg.label + '</text>';
          svg += '</g>';
        });
        svg += '</svg>';
        html += svg;
      }
      return html;
    }

    function renderPalette() {
      var labels = uniqueLabels();
      if (!labels.length) return '';
      var html = '<div class="gc-head">Chords used (' + labels.length + ')</div><div class="gc-pal">';
      labels.forEach(function (l) {
        var sh = ChordCore.shapeForLabel(l);
        html += '<div class="gc-chip" data-chord="' + l + '"><div class="nm">' + l + '</div>' + (sh ? diagram(sh) : '<div style="height:78px"></div>') + '</div>';
      });
      return html + '</div>';
    }

    function cacheRows() {
      var els = container.querySelectorAll('svg.gc-ribbon');
      geom.rows = Array.prototype.map.call(els, function (el) {
        return { el: el, firstBar: +el.dataset.firstbar, barW: +el.dataset.barw, leftPad: +el.dataset.leftpad, W: +el.dataset.w };
      });
    }

    function detachPlayhead() { if (ph && ph.parentNode) ph.parentNode.removeChild(ph); phSvg = null; }
    function setPlayheadTick(tick) {
      var rows = geom.rows, barTicks = geom.barTicks || (geom.beatTicks * geom.spb);
      if (tick == null || tick < 0 || !rows.length || !barTicks) { detachPlayhead(); return; }
      var off = +options.offsetTicks || 0; var bar = (tick + off) / barTicks;
      var idx = -1, barsPerSys = +options.barsPerLine || 4;
      for (var i = 0; i < rows.length; i++) { if (bar >= rows[i].firstBar && bar < rows[i].firstBar + barsPerSys) { idx = i; break; } }
      if (idx < 0) { detachPlayhead(); return; }
      var m = rows[idx], x = m.leftPad + (bar - m.firstBar) * m.barW;
      if (!ph) { ph = document.createElementNS(SVGNS, 'line'); ph.setAttribute('class', 'gc-play'); }
      if (phSvg !== m.el) { m.el.appendChild(ph); phSvg = m.el; }
      ph.setAttribute('x1', x.toFixed(1)); ph.setAttribute('x2', x.toFixed(1));
      ph.setAttribute('y1', '26'); ph.setAttribute('y2', '54');
      // highlight active chord chip
      var activeLabel = null;
      for (var k = 0; k < segs.length; k++) { var s = segs[k]; if ((tick + off) >= s.startTick && (tick + off) < s.endTick) { activeLabel = s.label; break; } }
      container.querySelectorAll('.gc-chip').forEach(function (c) { c.classList.toggle('active', c.dataset.chord === activeLabel); });
    }

    function seekToBarX(svg, clientX) {
      var W = +svg.dataset.w, firstBar = +svg.dataset.firstbar, leftPad = +svg.dataset.leftpad, barW = +svg.dataset.barw;
      var rect = svg.getBoundingClientRect(), xView = (clientX - rect.left) / rect.width * W;
      var bar = firstBar + (xView - leftPad) / barW;
      var barTicks = geom.barTicks || (geom.beatTicks * geom.spb);
      var tick = bar * barTicks - (+options.offsetTicks || 0);
      var sec = Math.max(0, tick * 60 / (geom.tempo * geom.ppq));
      onSeekSeconds(sec);
    }
    container.addEventListener('click', function (e) {
      var block = e.target.closest && e.target.closest('g.gc-block');
      var svg = e.target.closest && e.target.closest('svg.gc-ribbon');
      if (svg) {
        if (block) { var sg = segs[+block.getAttribute('data-seg')]; if (sg) { var t = sg.startTick - (+options.offsetTicks || 0); onSeekSeconds(Math.max(0, t * 60 / (geom.tempo * geom.ppq))); return; } }
        seekToBarX(svg, e.clientX);
      }
    });

    function getChords() { return segs.map(function (s) { return { startTick: s.startTick, endTick: s.endTick, label: s.label }; }); }
    function getAscii() {
      if (!segs.length) return '';
      return segs.map(function (s) { return s.label; }).join('  ');
    }
    function setOptions(p) { if (p) for (var k in p) if (p.hasOwnProperty(k)) options[k] = p[k]; render(); }
    function getOptions() { var o = {}; for (var k in options) if (options.hasOwnProperty(k)) o[k] = options[k]; return o; }
    function clear() { detachPlayhead(); container.innerHTML = ''; segs = []; geom.rows = []; }

    return { render: render, setPlayheadTick: setPlayheadTick, getChords: getChords, getAscii: getAscii,
             getOptions: getOptions, setOptions: setOptions, clear: clear };
  }

  return { create: create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GuitarChordView;
