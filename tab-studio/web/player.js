/* ============================================================================
 * player.js  —  Web Audio playback for the piano-roll editor.
 *
 * Adapted from the Bass Tab Creator's Player IIFE (index.html): a small
 * subtractive synth (saw+triangle through a lowpass pluck envelope), a single
 * constant tempo, an optional metronome, and a transport clock that reports the
 * play position back as a TICK so the roll can move its playhead + autoscroll.
 *
 *   EditorPlayer.configure({ getProject, setPlayhead, onState })
 *   EditorPlayer.play() / pause() / stop() / toggle() / seekTick(t)
 *   EditorPlayer.rebuild()          // re-read project after edits / tempo change
 *   EditorPlayer.setMetro(bool)
 *   EditorPlayer.isPlaying() / positionTick() / durationTick()
 * ========================================================================== */
var EditorPlayer = (function () {
  'use strict';
  var ctx = null, master = null, comp = null, sources = [];
  var sched = [], durationSec = 0;
  var playing = false, posSec = 0, clockBase = 0, startCtx = 0, audioStart = 0, raf = 0;
  var metro = false;
  // `timelineTempo` maps ticks to real seconds (the tempo the notes were written at,
  // so playback stays locked to the song); `tempo` is the musical tempo the user set —
  // it only spaces the metronome, which follows the editor's bar grid.
  var ppq = 480, tempo = 120, timelineTempo = 120, gridOffsetTicks = 0, tsNum = 4;
  var cfg = { getProject: null, setPlayhead: null, onState: null };
  var instrument = 'bass';                                   // 'bass' | 'piano' — voice timbre

  function configure(o) { cfg = Object.assign(cfg, o || {}); }
  function setInstrument(name) { instrument = name || 'bass'; }

  /* --- audio graph --- */
  function ensureCtx() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.9;
    comp = ctx.createDynamicsCompressor();
    master.connect(comp); comp.connect(ctx.destination);
    return ctx;
  }
  function freq(p) { return 440 * Math.pow(2, (p - 69) / 12); }
  function voice(pitch, at, dur, vel) {
    dur = Math.max(0.06, dur);
    var f = freq(pitch), amp = 0.10 + 0.28 * (Math.max(1, Math.min(127, vel || 100)) / 127);
    var g = ctx.createGain(), off = at + dur + 0.05;
    if (instrument === 'piano') {
      // brighter, struck-string timbre with a continuous decay (no sustain plateau)
      var p1 = ctx.createOscillator(); p1.type = 'triangle'; p1.frequency.value = f;
      var p2 = ctx.createOscillator(); p2.type = 'sine'; p2.frequency.value = f * 2;     // 2nd partial
      var p3 = ctx.createOscillator(); p3.type = 'sawtooth'; p3.frequency.value = f; p3.detune.value = 4; // shimmer
      var gp2 = ctx.createGain(); gp2.gain.value = 0.22;
      var gp3 = ctx.createGain(); gp3.gain.value = 0.10;
      var lpP = ctx.createBiquadFilter(); lpP.type = 'lowpass'; lpP.Q.value = 0.6;
      lpP.frequency.setValueAtTime(Math.min(9000, f * 6 + 1400), at);
      lpP.frequency.exponentialRampToValueAtTime(Math.max(500, f * 2.5), at + Math.min(0.7, dur));
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(amp, at + 0.003);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * 0.3), at + Math.min(dur, 0.35));
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      p1.connect(lpP); p2.connect(gp2); gp2.connect(lpP); p3.connect(gp3); gp3.connect(lpP); lpP.connect(g); g.connect(master);
      p1.start(at); p2.start(at); p3.start(at); p1.stop(off); p2.stop(off); p3.stop(off);
      sources.push(p1, p2, p3);
      return;
    }
    // bass: saw+triangle through a lowpass pluck
    var o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = f; o1.detune.value = -5;
    var o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f; o2.detune.value = 5;
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 7;
    lp.frequency.setValueAtTime(Math.min(4000, f * 8 + 300), at);
    lp.frequency.exponentialRampToValueAtTime(Math.max(160, f * 2.2), at + Math.min(0.3, dur));
    var atk = 0.006, rel = Math.min(0.09, dur * 0.5), holdEnd = Math.max(at + atk, at + dur - rel);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(amp, at + atk);
    g.gain.exponentialRampToValueAtTime(amp * 0.55, holdEnd);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
    o1.start(at); o2.start(at); o1.stop(off); o2.stop(off);
    sources.push(o1, o2);
  }
  // One-shot audition of a single note (drawing in the editor) — same voice as
  // playback, so what you hear is what the transcription will sound like.
  function previewNote(pitch, vel, dur) {
    var c = ensureCtx(); if (!c) return;
    if (c.state === 'suspended') c.resume();
    voice(pitch, c.currentTime + 0.01, Math.max(0.12, Math.min(1.2, dur || 0.3)), vel || 100);
  }
  function click(at, accent) {
    var o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = accent ? 2000 : 1300;
    var g = ctx.createGain(), peak = accent ? 0.2 : 0.12, dur = 0.03;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(master);
    o.start(at); o.stop(at + dur + 0.02);
    sources.push(o);
  }
  function clearSources() {
    sources.forEach(function (s) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} });
    sources = [];
  }

  /* --- tick <-> seconds (single constant tempo: the timeline's) --- */
  function secPerTick() { return (60 / timelineTempo) / ppq; }
  function tickToSec(t) { return t * secPerTick(); }
  function secToTick(s) { return s / secPerTick(); }

  /* --- (re)build schedule from the current project --- */
  function rebuild() {
    var pj = cfg.getProject ? cfg.getProject() : null;
    if (!pj) return;
    ppq = pj.ppq || 480; tempo = pj.tempo || 120; tsNum = (pj.timeSig && pj.timeSig.num) || 4;
    timelineTempo = pj.timelineTempo || pj.tempo || 120; gridOffsetTicks = pj.gridOffsetTicks || 0;
    sched = []; durationSec = 0;
    (pj.notes || []).forEach(function (n) {
      var s = tickToSec(n.start), e = tickToSec(n.end);
      if (e <= s) e = s + 0.05;
      sched.push({ sSec: s, eSec: e, pitch: n.pitch, vel: n.velocity });
      if (e > durationSec) durationSec = e;
    });
    if (pj.lengthTicks) durationSec = Math.max(durationSec, tickToSec(pj.lengthTicks));
    if (posSec > durationSec) posSec = durationSec;
    if (playing) { scheduleFrom(posSec); clockBase = posSec; startCtx = audioStart; }
  }

  function scheduleFrom(fromSec) {
    clearSources();
    audioStart = ctx.currentTime + 0.07;
    sched.forEach(function (ev) {
      if (ev.eSec <= fromSec + 0.005) return;
      var startAt = audioStart + Math.max(0, ev.sSec - fromSec);
      var len = ev.eSec - Math.max(ev.sSec, fromSec);
      if (len < 0.03) return;
      voice(ev.pitch, startAt, len, ev.vel);
    });
    if (metro && tempo > 0) {
      var bSec = 60 / tempo, origin = gridOffsetTicks * secPerTick();   // click on the editor's bar grid
      for (var k = 0, guard = 0; guard < 100000; k++, guard++) {
        var at = origin + k * bSec;
        if (at > durationSec + 0.001) break;
        if (at < -0.001) continue;
        if (at > fromSec - 0.001) click(audioStart + (at - fromSec), tsNum > 0 && (k % tsNum === 0));
      }
    }
  }

  /* --- transport clock + playhead --- */
  function currentSec() { return (playing && ctx) ? clamp(clockBase + (ctx.currentTime - startCtx), 0, durationSec) : posSec; }
  function emitState() { if (cfg.onState) cfg.onState({ playing: playing, posSec: currentSec(), durationSec: durationSec }); }
  function emitHead() { if (cfg.setPlayhead) cfg.setPlayhead(secToTick(currentSec())); }
  function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function loop() {
    emitHead(); emitState();
    if (playing && currentSec() >= durationSec - 0.005) {
      playing = false; posSec = durationSec; clearSources(); raf = 0; emitHead(); emitState(); return;
    }
    raf = playing ? requestAnimationFrame(loop) : 0;
  }

  function ready() { return sched.length > 0 || durationSec > 0; }
  function play() {
    var c = ensureCtx(); if (!c) return;
    if (c.state === 'suspended') c.resume();
    rebuild();
    if (posSec >= durationSec - 0.005) posSec = 0;
    scheduleFrom(posSec); clockBase = posSec; startCtx = audioStart;
    playing = true; stopLoop(); loop(); emitState();
  }
  function pause() {
    if (!playing) return;
    posSec = currentSec(); clearSources(); playing = false; stopLoop(); emitHead(); emitState();
  }
  function stop() {
    clearSources(); playing = false; posSec = 0; stopLoop(); emitHead(); emitState();
  }
  function toggle() { playing ? pause() : play(); }
  function seekTick(tick) {
    posSec = clamp(tickToSec(tick), 0, durationSec || tickToSec(tick));
    if (playing) { scheduleFrom(posSec); clockBase = posSec; startCtx = audioStart; }
    emitHead(); emitState();
  }
  function setMetro(on) {
    metro = !!on;
    if (playing) { var p = currentSec(); scheduleFrom(p); clockBase = p; startCtx = audioStart; }
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  return {
    configure: configure, play: play, pause: pause, stop: stop, toggle: toggle,
    seekTick: seekTick, rebuild: rebuild, setMetro: setMetro, setInstrument: setInstrument,
    previewNote: previewNote,
    isPlaying: function () { return playing; },
    positionTick: function () { return secToTick(currentSec()); },
    durationTick: function () { return secToTick(durationSec); },
    ready: ready
  };
})();
