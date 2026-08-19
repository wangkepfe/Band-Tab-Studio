/* ============================================================================
 * perf.js — opt-in on-device frame profiler.
 *
 * WHY THIS EXISTS: the rendering problems that matter here only show up on the
 * hardware that has them — an older iPad — and that is exactly the machine you
 * cannot put a Safari inspector on without a Mac and a cable. So the measurement
 * has to ship inside the app. Open any page with ?perf=1 and a small overlay
 * reports what the user actually feels: how long frames take while the transport
 * is running, and how much DOM the active view is asking the device to draw.
 *
 *   http://…/?perf=1        overlay on (and latched for the rest of the tab session)
 *   http://…/?perf=0        off again
 *   Perf.bench()            one-shot console benchmark of the active tab view
 *
 * WHEN THE FLAG IS ABSENT THIS MODULE DOES NOTHING AT ALL — no overlay, no rAF
 * loop, no wrappers, no timers. That is deliberate: a profiler that costs a
 * little on every session would be measuring itself.
 *
 * It deliberately hooks nothing in the render path. Frame time is sampled from
 * its own requestAnimationFrame loop, which is the same clock the transport's
 * loop rides, so a stalled main thread shows up here exactly as the user sees it
 * (a playhead that jumps instead of glides). The per-call breakdown is obtained
 * by WRAPPING the view's public setPlayheadTick, so no shipped module carries a
 * measurement branch for a feature almost nobody turns on.
 * ========================================================================== */
var Perf = (function () {
  'use strict';

  // The cloud build rewrites the URL to `?p=<id>` when a project opens, which
  // would drop `?perf=1` — and a reload is the first thing anyone does when
  // chasing a stall. Latch it per tab so the flag survives that rewrite.
  var ON = (function () {
    var q = location.search;
    try {
      if (/[?&]perf=0\b/.test(q)) { sessionStorage.removeItem('studioPerf'); return false; }
      if (/[?&]perf=1\b/.test(q)) { sessionStorage.setItem('studioPerf', '1'); return true; }
      return sessionStorage.getItem('studioPerf') === '1';
    } catch (e) { return /[?&]perf=1\b/.test(q); }   // private mode: no storage, no latch
  })();

  var el = null, samples = [], phTimes = [], phCount = 0, wrapped = false;
  var last = 0, lastFrameAt = 0;
  var benching = false;            // suppress self-measurement while bench() runs
  var WINDOW = 120;                // frames kept for the rolling stats (~2 s at 60 fps)
  var LONG_MS = 50;                // a frame this slow is visible as a stutter, so count them
  var STALL_MS = 500;              // no rAF for this long = wedged or backgrounded
  var VIEW_OF = { basstab: 'bassTab', guitartab: 'guitarTab', guitarchords: 'guitarChords' };

  function pct(sorted, p) {
    if (!sorted.length) return 0;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[i];
  }

  // The visible view pane. NOT a `[style*="display:none"]` attribute match: the
  // app shows a pane with `el.style.display = ''`, and a hidden one serialises as
  // "display: none" WITH a space, so a substring test silently picks the wrong
  // pane (it returned the hidden piano-roll canvas). Ask the style system.
  function activePane() {
    var panes = document.querySelectorAll('.viewpane');
    for (var i = 0; i < panes.length; i++)
      if (getComputedStyle(panes[i]).display !== 'none') return panes[i];
    return document.body;
  }

  function countDrawables(root) { return (root || activePane()).querySelectorAll('svg *, canvas').length; }

  // The DOM the active view is asking the device to rasterise. NEVER counted while
  // the transport is running: this is a subtree walk over ~10k nodes in the tab
  // views, and running it on the readout timer would stall the main thread for
  // milliseconds, land in `samples` as an inflated frame, and show up as a ~1 Hz
  // spike in the very numbers being read. A profiler must not manufacture its own
  // jank, so during playback the last idle count is shown instead.
  var domCount = 0, domAt = 0;
  function countDom(now) {
    if (running()) return domCount;
    if (domAt && now - domAt < 1000) return domCount;
    domAt = now;
    domCount = countDrawables();
    return domCount;
  }

  function running() {
    return !!(window.Studio && Studio.transport && Studio.transport.isRunning && Studio.transport.isRunning());
  }

  // The rAF loop ONLY samples — it must stay as close to free as a frame can be.
  // Rebuilding the readout here would have meant an innerHTML write per frame,
  // i.e. the profiler manufacturing the jank it is supposed to be measuring.
  // Painting is on its own slow timer below.
  function frame(now) {
    if (last) {
      samples.push(now - last);
      if (samples.length > WINDOW) samples.shift();
    }
    last = now;
    lastFrameAt = now;
    requestAnimationFrame(frame);
  }

  function paint() {
    if (!el) return;
    var now = performance.now();
    // rAF has stopped: the main thread is wedged, or the tab is in the background
    // (iOS does that on every app switch). Report it rather than leaving the last
    // window frozen on screen looking like a live reading.
    if (!samples.length || now - lastFrameAt > STALL_MS) {
      el.innerHTML = '<b>— fps</b><span>' +
        (samples.length ? 'no frames for ' + ((now - lastFrameAt) / 1000).toFixed(1) + 's' : 'no frames yet') +
        '</span>';
      return;
    }
    var s = samples.slice().sort(function (a, b) { return a - b; });
    var longs = 0, i;
    for (i = 0; i < samples.length; i++) if (samples[i] > LONG_MS) longs++;
    var p50 = pct(s, 50), p95 = pct(s, 95), max = s[s.length - 1];
    // MEAN, not median, for the playhead: old iOS Safari clamps performance.now()
    // to ~1 ms, so per-call medians collapse to 0.000 and say nothing. A mean over
    // the window still resolves sub-millisecond work through the clamp.
    var phSum = 0;
    for (i = 0; i < phTimes.length; i++) phSum += phTimes[i];
    el.innerHTML =
      '<b>' + (p50 ? (1000 / p50).toFixed(0) : '—') + ' fps</b>' +
      '<span>frame p50 ' + p50.toFixed(1) + ' · p95 ' + p95.toFixed(1) + ' · max ' + max.toFixed(1) + ' ms</span>' +
      '<span>janky (&gt;' + LONG_MS + 'ms) ' + longs + '/' + samples.length + '</span>' +
      '<span>playhead ' + (phTimes.length
        ? (phSum / phTimes.length).toFixed(3) + ' ms avg · ' + phTimes.length + ' of ' + phCount
        : 'idle') + '</span>' +
      '<span>drawables ' + countDom(now) + (running() ? ' (idle count)' : '') + '</span>';
  }

  // Wrap the active tab view's setPlayheadTick so the overlay can separate "the
  // playhead update is slow" from "something else on the page is slow". Done here
  // rather than inside bass-tab.js so the shipped hot path stays untouched.
  //
  // This intercepts real playback traffic: transport.js resolves the view through
  // cfg.views[...], whose adapter calls `bassTab.setPlayheadTick(t)` — a property
  // lookup on the same module object exposed as window.Studio.bassTab — at call
  // time, not a captured reference.
  var origPlayhead = {};
  function wrap() {
    if (wrapped || !window.Studio) return;
    var got = 0;
    ['bassTab', 'guitarTab', 'guitarChords'].forEach(function (k) {
      var v = window.Studio[k];
      if (!v || typeof v.setPlayheadTick !== 'function' || origPlayhead[k]) return;
      var orig = v.setPlayheadTick;
      origPlayhead[k] = orig;
      got++;
      v.setPlayheadTick = function (t) {
        if (benching) return orig.call(v, t);      // don't measure the benchmark's own calls
        var t0 = performance.now();
        var r = orig.call(v, t);
        phTimes.push(performance.now() - t0); phCount++;
        if (phTimes.length > WINDOW) phTimes.shift();
        return r;
      };
    });
    if (got) wrapped = true;      // nothing wrapped => Studio isn't ready, keep polling
  }

  function mount() {
    el = document.createElement('div');
    el.id = 'perfHud';
    el.style.cssText =
      'position:fixed;left:10px;bottom:10px;z-index:9999;pointer-events:none;' +
      'background:rgba(11,15,21,.92);color:#e6edf3;border:1px solid #2a3140;border-radius:8px;' +
      'padding:7px 10px;font:11px/1.45 ui-monospace,Consolas,monospace;white-space:pre;' +
      'display:flex;flex-direction:column';
    document.body.appendChild(el);
    var st = document.createElement('style');
    st.textContent = '#perfHud b{color:#ffcf4d;font-size:13px}#perfHud span{color:#8b97a7}';
    document.head.appendChild(st);
  }

  // One-shot synthetic benchmark, callable from the console on the device itself:
  // times N playhead moves and one full re-render of the CURRENT tab view.
  // Answers "is the tab view the cost, or is it everything else?" without a profiler.
  //
  // Only the tab views are benchable — the piano roll and drum grid are canvases
  // with a different playhead path — and it refuses rather than silently timing a
  // hidden bassTab whose geometry cache is empty, which would report ~0 ms and read
  // as "the playhead is free". Note it calls render(), which rebuilds the staff from
  // scratch: the scroll position and the on-screen playhead are reset.
  function bench(n) {
    n = n || 200;
    var S = window.Studio;
    if (!S) return 'Studio not ready';
    var name = (S.transport && S.transport.getView && S.transport.getView()) || '';
    var key = VIEW_OF[name];
    if (!key) return 'bench needs a tab view (bass/guitar tab); current view is "' + name + '"';
    var v = S[key];
    if (!v || !v.setPlayheadTick || !v.render) return 'view "' + name + '" is not benchable';
    var p = S.roll.getProject();
    var lastTick = p.notes.reduce(function (m, x) { return Math.max(m, x.end); }, 0) || 1;
    var i, t0, move, render;
    benching = true;
    try {
      v.setPlayheadTick(0);
      t0 = performance.now();
      for (i = 0; i < n; i++) v.setPlayheadTick(Math.round((i / n) * lastTick));
      move = (performance.now() - t0) / n;
      t0 = performance.now(); v.render(); render = performance.now() - t0;
    } finally { benching = false; }
    var out = {
      view: name,
      notes: p.notes.length,
      drawables: countDrawables(activePane()),
      msPerPlayheadMove: +move.toFixed(4),
      msPerFullRender: +render.toFixed(1)
    };
    if (window.console) console.log('[Perf]', out);
    return out;
  }

  function init() {
    if (!ON) return;
    mount();
    requestAnimationFrame(frame);
    setInterval(paint, 250);        // readout refresh, decoupled from the sampling loop
    paint();
    // A backgrounded tab stops firing rAF; the first callback on return would
    // otherwise book the entire hidden stretch as one enormous "frame" and poison
    // max / janky for the next window. Drop that one sample across the gap.
    document.addEventListener('visibilitychange', function () { last = 0; });
    // Studio builds its views during its own IIFE; poll briefly rather than
    // depend on a load-order guarantee this module has no business relying on.
    var tries = 0, t = setInterval(function () {
      wrap();
      if (wrapped || ++tries > 40) clearInterval(t);
    }, 250);
  }

  if (ON) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  return { enabled: function () { return ON; }, bench: bench };
})();
