/* ============================================================================
 * transport.js  —  one transport shared by every view.
 *
 * Sources:  synth | original | stem.  The "synth" source is the melodic
 * EditorPlayer for the Piano-Roll / Bass-Tab views and the DrumSynth for the
 * Drum-Tab view; original/stem are the two <audio> elements. A single rAF loop
 * reads the active engine's position (in seconds) and pushes the playhead into
 * the active view — melodic views in ticks, the drum view in seconds — so the
 * transcription can be A/B'd against the source audio under one playhead.
 *
 *   Transport.init({ getProject, melodicSynth, drumSynth, audios, views,
 *                    getDrumDuration, onUpdate, onNotice })
 *   Transport.setView('pianoroll'|'basstab'|'drumtab')
 *   Transport.setSource('synth'|'original'|'stem')
 *   Transport.play()/pause()/stop()/toggle()/seekSeconds(t)/seekTick(t)
 *   Transport.setMetro(bool) · setDrumEvents(events) · rebuildMelodic()
 *   Transport.sourceAvailable(name) · getSource() · getView()
 * ========================================================================== */
var Transport = (function () {
  'use strict';
  var cfg = null;
  var source = 'synth';          // 'synth' | 'original' | 'stem'
  var view = 'pianoroll';        // 'pianoroll' | 'basstab' | 'drumtab'
  var running = false;
  var raf = 0;
  var metroOn = false;
  var drumDuration = 0;
  var drumTempo = 120;        // drum track tempo (drums don't share the roll's tempo)
  var drumGridOffset = 0;     // drum bar-grid shift (seconds) — the metronome follows it
  var ytOffsetSec = 0;        // YouTube "Song" sync: + delays the YouTube audio vs the tab

  function init(o) {
    cfg = o || {};
    drumDuration = 0; drumTempo = 120; drumGridOffset = 0; ytOffsetSec = 0;
    // keep the play button / clock in sync when audio elements end on their own
    ['original', 'stem'].forEach(function (k) {
      var el = cfg.audios && cfg.audios[k];
      if (el) el.addEventListener('ended', function () { if (source === k) finalize(); });
    });
    // The YouTube player is the one engine that can start and stop WITHOUT this
    // transport asking — the user presses ▶ inside the video. On an iPad that is
    // not a curiosity, it is the only way playback ever begins: Safari refuses a
    // scripted playVideo() into a cross-origin iframe, so the transport's own ▶
    // is blocked and a tap on the player is the whole remedy (see youtube.js).
    // Adopting it here is what makes the tab follow; without it the video plays
    // to an audience of a frozen playhead.
    if (cfg.youtube && cfg.youtube.setOnState) cfg.youtube.setOnState(onYtState);
  }

  function onYtState(playing) {
    if (!isYt()) return;                       // another source owns the transport
    if (playing && !running) {
      if (metroOn) Metronome.prime();
      Metronome.reset();
      running = true; stopRaf(); frame();
    } else if (!playing && running) {
      // Deliberately no enginePause(): the player has ALREADY stopped, and
      // pausing it again from inside its own state callback is how feedback
      // loops start. Just take the transport down with it.
      running = false; stopRaf(); Metronome.stop(); emit();
    }
  }

  function isMelodic() { return view !== 'drumtab'; }
  // project() is NOT a cheap getter: the piano roll builds a fresh object and maps
  // its whole note array on every call. One frame reaches it nine times over
  // (posSeconds, pushPlayhead, three metronome readers — metroTsNum twice in a
  // single expression — emit's own posSeconds+durSeconds, and durSeconds), all to
  // read a ppq and a tempo, so a 295-note track churned ~2,700 throwaway objects
  // per frame. That is invisible on a desktop and it is GC pressure an older iPad
  // pays for in dropped frames.
  //
  // So: memoise, but only for the span of one frame() — nothing can edit the
  // project mid-frame, and outside a frame the old call-through behaviour is kept
  // exactly, so a seek or a tempo change still sees the change immediately.
  var projCache = null, inFrame = false;
  function project() {
    if (inFrame && projCache) return projCache;
    var p = (cfg.getProject && cfg.getProject()) || { ppq: 480, tempo: 120 };
    if (inFrame) projCache = p;
    return p;
  }
  // Ticks per second — off the TIMELINE tempo (the tempo the notes were written at),
  // never the musical BPM: ticks are positions on the recording, so the playhead has
  // to walk them at the rate the transcription was made, whatever grid is drawn over it.
  function tps() { var p = project(); return ((p.timelineTempo || p.tempo || 120) / 60) * (p.ppq || 480); }
  function audioEl() { return source === 'original' ? cfg.audios.original : source === 'stem' ? cfg.audios.stem : null; }
  // The melodic view that owns the playhead right now. Every non-drum view
  // (pianoroll / basstab / guitartab / guitarchords) registers a setPlayheadTick,
  // so route to the active one by name — falling back to the piano roll.
  function activeMelodicView() { return cfg.views[view] || cfg.views.pianoroll; }

  // The "original" (song) source plays a downloaded <audio> file when one is
  // loaded; otherwise a YouTube video (the web app has no audio to download).
  function yt() { return cfg.youtube; }
  function origHasAudio() { var el = cfg.audios && cfg.audios.original; return !!(el && el.getAttribute && el.getAttribute('src')); }
  function isYt() { return source === 'original' && !origHasAudio() && yt() && yt().hasVideo(); }

  // ---- engine abstraction --------------------------------------------------
  function enginePlay(fromExisting) {
    if (source === 'synth') {
      if (isMelodic()) { cfg.melodicSynth.rebuild(); cfg.melodicSynth.play(); }
      else cfg.drumSynth.play();
    } else if (isYt()) { yt().play(); }
    else { var el = audioEl(); if (el) { var p = el.play(); if (p && p.catch) p.catch(function () {}); } }
  }

  // ---- metronome (transport-driven, works for every view + source) ---------
  function metroTempo()  { return isMelodic() ? (project().tempo || 120) : (drumTempo || 120); }
  function metroTsNum()  { return isMelodic() ? ((project().timeSig && project().timeSig.num) || 4) : 4; }
  // Melodic: the click follows the editor's bar grid, so its offset (in timeline
  // ticks) becomes the origin in seconds. Drums: the bar-grid shift is already seconds.
  function metroOrigin() {
    if (!isMelodic()) return drumGridOffset || 0;
    var p = project(), ppq = p.ppq || 480, tl = p.timelineTempo || p.tempo || 120;
    return (p.gridOffsetTicks || 0) * (60 / tl) / ppq;
  }
  function enginePause() {
    if (source === 'synth') { isMelodic() ? cfg.melodicSynth.pause() : cfg.drumSynth.pause(); }
    else if (isYt()) { yt().pause(); }
    else { var el = audioEl(); if (el) el.pause(); }
  }
  function engineStop() {
    if (source === 'synth') { isMelodic() ? cfg.melodicSynth.stop() : cfg.drumSynth.stop(); }
    else if (isYt()) { yt().stop(); }
    else { var el = audioEl(); if (el) { el.pause(); try { el.currentTime = 0; } catch (e) {} } }
  }
  function engineSeek(sec) {
    sec = Math.max(0, sec);
    if (source === 'synth') { isMelodic() ? cfg.melodicSynth.seekTick(Math.round(sec * tps())) : cfg.drumSynth.seekSeconds(sec); }
    else if (isYt()) { yt().seek(Math.max(0, sec - ytOffsetSec)); }
    else { var el = audioEl(); if (el) { try { el.currentTime = sec; } catch (e) {} } }
  }
  function enginePlaying() {
    if (source === 'synth') return isMelodic() ? cfg.melodicSynth.isPlaying() : cfg.drumSynth.isPlaying();
    if (isYt()) return yt().isPlaying();
    var el = audioEl(); return !!(el && !el.paused && !el.ended);
  }
  function posSeconds() {
    if (source === 'synth') return isMelodic() ? cfg.melodicSynth.positionTick() / tps() : cfg.drumSynth.currentTime();
    if (isYt()) return Math.max(0, yt().currentTime() + ytOffsetSec);
    var el = audioEl(); return el ? el.currentTime : 0;
  }
  function durSeconds() {
    if (source === 'synth') return isMelodic() ? cfg.melodicSynth.durationTick() / tps() : drumDuration;
    // YouTube reports 0 until the video's metadata lands (normally a beat after
    // play()). Offsetting THAT would make durSeconds() equal posSeconds() on the
    // first frame of any project with a positive offset, and frame()'s
    // completion test would finalize playback instantly. Unknown stays 0.
    if (isYt()) { var yd = yt().duration(); return yd > 0 ? Math.max(0, yd + ytOffsetSec) : 0; }
    var el = audioEl(); return (el && isFinite(el.duration)) ? el.duration : 0;
  }

  // ---- playhead + UI fan-out ----------------------------------------------
  function pushPlayhead(sec) {
    if (isMelodic()) { var t = Math.round(sec * tps()); var v = activeMelodicView(); if (v && v.setPlayheadTick) v.setPlayheadTick(t); }
    else { if (cfg.views.drumtab && cfg.views.drumtab.setPlayheadSeconds) cfg.views.drumtab.setPlayheadSeconds(sec); }
  }
  function hidePlayhead() {
    if (cfg.views.pianoroll && cfg.views.pianoroll.setPlayheadTick) cfg.views.pianoroll.setPlayheadTick(0);
    if (cfg.views.basstab && cfg.views.basstab.setPlayheadTick) cfg.views.basstab.setPlayheadTick(-1);
    if (cfg.views.guitartab && cfg.views.guitartab.setPlayheadTick) cfg.views.guitartab.setPlayheadTick(-1);
    if (cfg.views.guitarchords && cfg.views.guitarchords.setPlayheadTick) cfg.views.guitarchords.setPlayheadTick(-1);
    if (cfg.views.drumtab && cfg.views.drumtab.setPlayheadSeconds) cfg.views.drumtab.setPlayheadSeconds(-1);
  }
  function emit() {
    if (cfg.onUpdate) cfg.onUpdate({ playing: running, posSec: posSeconds(), durationSec: durSeconds(), source: source, view: view });
  }
  // The transport owns no DOM, so when it has to refuse an action it hands one
  // line of text back up (app.js wires flash()). Optional — silent if unwired.
  function notify(msg) { if (cfg && typeof cfg.onNotice === 'function') cfg.onNotice(msg); }
  function frame() {
    inFrame = true; projCache = null;         // one project() read for the whole frame
    try {
      var sec = posSeconds();
      pushPlayhead(sec);
      if (metroOn) Metronome.sync(sec, metroTempo(), metroTsNum(), metroOrigin());
      emit();
      var dur = durSeconds();
      var done = !enginePlaying() || (dur > 0 && sec >= dur - 0.02);
      if (done) { finalize(); return; }
      raf = requestAnimationFrame(frame);
    } finally { inFrame = false; projCache = null; }
  }
  function stopRaf() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function finalize() { running = false; stopRaf(); enginePause(); Metronome.stop(); emit(); }

  // ---- public transport ----------------------------------------------------
  function play() {
    if (running) return;
    // The selected source can die between refreshes (a YouTube video that fails
    // to load, an <audio> that loses its src). Falling back to the synth without
    // a word is how that reads to the user as "the play button does nothing".
    if (!sourceAvailable(source)) {
      var was = source;
      setSource('synth');
      if (was !== 'synth') notify((was === 'original' ? 'Song' : 'Stem') + ' isn’t available — playing the transcription instead.');
    }
    // YouTube is the one engine that isn't playable the instant it's selected:
    // the iframe API download + the player handshake take a beat, and a
    // playVideo() issued before that lands is silently dropped. Starting the rAF
    // loop anyway is what produced the frozen transport — pause glyph showing,
    // playhead loop spinning, clock stuck at 0:00. Refusing the start also keeps
    // playback inside the user's click: the old path left wantPlay set for
    // onReady to act on later, outside any gesture, where autoplay policy kills
    // it just as silently.
    if (isYt() && !yt().isReady()) {
      notify('Song is still loading — give YouTube a second, then press play.');
      emit();                       // resync the button/clock; running stays false
      return;
    }
    if (metroOn) Metronome.prime();
    Metronome.reset();
    enginePlay();
    running = true; stopRaf(); frame();
  }
  function pause() { if (!running) return; running = false; stopRaf(); enginePause(); Metronome.stop(); emit(); }
  function stop() { running = false; stopRaf(); engineStop(); Metronome.stop(); pushPlayhead(0); emit(); }
  function toggle() { running ? pause() : play(); }

  function seekSeconds(t) {
    engineSeek(t);
    pushPlayhead(Math.max(0, t));
    // stop() (reset + kill) so clicks already queued in the lookahead for the old
    // position don't fire after the jump; the next frame re-seeds at the new spot.
    Metronome.stop();
    if (!running) emit();
  }
  function seekTick(t) { seekSeconds(Math.max(0, t) / tps()); }

  function setView(name) {
    if (name === view) return;
    if (running) stop();
    view = name;
    emit();
  }
  function setSource(name) {
    if (name === source) return;
    if (running) stop();
    source = name;
    emit();
  }
  function setMetro(on) { metroOn = !!on; if (metroOn) { Metronome.prime(); Metronome.setEnabled(true); } else Metronome.setEnabled(false); }
  function rebuildMelodic() { cfg.melodicSynth.rebuild(); if (!running) emit(); }
  function setDrumEvents(events) { cfg.drumSynth.setEvents(events); }
  function setDrumDuration(d) { drumDuration = d || 0; }
  function setDrumTempo(t) { drumTempo = t || 120; }
  function setDrumGridOffset(s) { drumGridOffset = s || 0; }
  function setYoutubeOffset(s) { ytOffsetSec = +s || 0; }

  function sourceAvailable(name) {
    if (name === 'synth') {
      if (isMelodic()) { var p = project(); return !!(p.notes && p.notes.length) || true; }   // synth always selectable for melodic
      return drumDuration > 0;
    }
    if (name === 'original') {
      var oel = cfg.audios.original;
      return !!(oel && oel.getAttribute && oel.getAttribute('src')) || !!(cfg.youtube && cfg.youtube.hasVideo());
    }
    var el = cfg.audios.stem;
    return !!(el && el.getAttribute && el.getAttribute('src'));
  }

  return {
    init: init, setView: setView, setSource: setSource, getSource: function () { return source; },
    getView: function () { return view; }, play: play, pause: pause, stop: stop, toggle: toggle,
    seekSeconds: seekSeconds, seekTick: seekTick, setMetro: setMetro, rebuildMelodic: rebuildMelodic,
    setDrumEvents: setDrumEvents, setDrumDuration: setDrumDuration,
    setDrumTempo: setDrumTempo, setDrumGridOffset: setDrumGridOffset, setYoutubeOffset: setYoutubeOffset,
    sourceAvailable: sourceAvailable,
    isRunning: function () { return running; }, hidePlayhead: hidePlayhead
  };
})();
