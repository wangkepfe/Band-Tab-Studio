/* ============================================================================
 * ear-audio.js  —  the ear trainer's synthesizer: six pitched voices, absolute-
 * time scheduling, and a tonic drone that sustains indefinitely.
 *
 * Why not player.js? Its previewNote() hard-clamps `dur` to [0.12, 1.2] s
 * (player.js:85), takes no `when` argument so a *timed* cadence is impossible,
 * offers two timbres switched by module-global state (player.js:26), and pushes
 * every voice onto a `sources[]` that the preview path never clears
 * (player.js:62,78) — an unbounded leak over a ten-minute drill. This drill
 * needs 1.5–3 s notes, four chords scheduled to the beat, six timbres drawn per
 * question, and a drone with no end time at all. None of that fits.
 *
 * This module owns a PRIVATE AudioContext. The repo already runs three
 * (player.js:33, drum-synth.js:29, metronome.js:29) and never shares one — that
 * is the established pattern rather than an accident, and here it also means a
 * panic stopAll() cannot silence the editor's transport.
 *
 * Node lifetime copies drum-synth.js:38 `reap()`: every source registers an
 * onended that splices itself out of `nodes`, so the live-node list tracks what
 * is actually sounding instead of growing for the life of the page.
 *
 * Two rules run through every voice below:
 *   • Each one SUSTAINS for the full requested duration. A voice that dies at
 *     400 ms would silently shorten the drill and teach the wrong thing.
 *   • Every gain envelope starts and ends at an epsilon, never at exactly 0,
 *     because exponentialRampToValueAtTime is undefined through zero and a ramp
 *     that touches it turns into a step — i.e. a click on every single note.
 *
 * Browser-only (Web Audio); no Node dual-export tail.
 *
 *   EarAudio.unlock()          -> bool     create/resume the ctx, in a gesture
 *   EarAudio.ready()           -> bool     ctx exists and is running
 *   EarAudio.now()             -> seconds on the private ctx clock
 *   EarAudio.VOICES            -> ['rhodes','pluck','reed','flute','bass','organ']
 *   EarAudio.note(midi, voice, when, dur, gain)          absolute `when`
 *   EarAudio.chord(midis, voice, when, dur, gain)
 *   EarAudio.playCadence(chords, voice, bpm) -> Promise  [{midis,beats}]
 *   EarAudio.startDrone(midi) / EarAudio.stopDrone(fade)
 *   EarAudio.stopAll()
 * ========================================================================== */
var EarAudio = (function () {
  'use strict';

  var VOICES = ['rhodes', 'pluck', 'reed', 'flute', 'bass', 'organ'];

  var EPS    = 0.0001;   // -80 dB: inaudible, and legal for exponential ramps
  var MASTER = 0.9;
  var SAFE   = 0.02;     // never schedule closer than this to the playback head
  var DUCK   = 0.03;     // master fade-out used by stopAll()
  var CAD_BPM = 88;      // cadence tempo when the caller does not name one

  var ac = null, master = null, comp = null;
  var nodes   = [];      // live source nodes, reaped on onended
  var drone   = null;    // {midi, out, srcs} — no end time, so never reaped
  var pending = [];      // in-flight playCadence completions
  var duckSeq = 0;       // so an old stopAll timer cannot undo a newer duck
  var primed  = false;

  /* --- context ------------------------------------------------------------ */

  function ensure() {
    if (ac) return ac;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;                      // no Web Audio: every entry point
    ac = new AC();                             // below degrades to a silent no-op
    master = ac.createGain(); master.gain.value = MASTER;
    // The threshold sits above a single note's peak, so solo drill notes pass
    // through completely untouched and only stacked cadence chords get reined
    // in. An always-working compressor would rewrite the loudness relationships
    // the user is being trained on.
    comp = ac.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 6;
    comp.attack.value = 0.004; comp.release.value = 0.16;
    master.connect(comp); comp.connect(ac.destination);
    return ac;
  }

  // Autoplay policy suspends a context created outside a gesture, and Chrome can
  // re-suspend one after a stretch of silence — which is exactly what a paused
  // ear-training session looks like. Same opportunistic resume as player.js:84
  // and metronome.js:65: cheap, idempotent, nothing to await.
  function wake() { if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) {} } }

  function freq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  // Clamp a requested time into the future. An envelope whose first
  // setValueAtTime has already elapsed jumps straight to the ramp target — the
  // click this whole file is arranged to avoid. drum-synth.js:79 guards the same
  // way. The SAFE margin is generous enough (20 ms) that a time computed once
  // and reused across a chord loop stays valid for every note in it.
  function at(when) {
    var floor = ac.currentTime + SAFE;
    return (typeof when === 'number' && isFinite(when) && when >= floor) ? when : floor;
  }

  function reap(n) {
    n.onended = function () { var i = nodes.indexOf(n); if (i >= 0) nodes.splice(i, 1); };
    nodes.push(n);
  }

  /* --- shared amplitude contour ------------------------------------------- */

  // `sag` is the fraction of peak the note settles to just after the attack (the
  // punch); `tail` is the fraction it STILL HAS when `dur` runs out — never 0,
  // because the note has to be present for the whole window the drill gave it.
  // Returns the time the note is fully silent, which is when the sources stop.
  function ampEnv(p, t, dur, peak, atk, sag, sagAt, tail, rel) {
    if (dur < atk + 0.02) dur = atk + 0.02;    // keeps the ramps in time order
    peak = Math.max(EPS, peak);                // ramping to 0 throws a RangeError
    var end = t + dur;
    p.setValueAtTime(EPS, t);
    p.exponentialRampToValueAtTime(peak, t + atk);
    if (sagAt > atk && sagAt < dur - 0.01) {
      p.exponentialRampToValueAtTime(Math.max(EPS, peak * sag), t + sagAt);
    }
    p.exponentialRampToValueAtTime(Math.max(EPS, peak * tail), end);
    p.exponentialRampToValueAtTime(EPS, end + rel);
    return end + rel;
  }

  /* --- Karplus–Strong render ---------------------------------------------- */

  var KS_REL  = 0.08;    // buffer tail rendered past `dur` for the release
  var KS_END  = 0.18;    // string amplitude still left when `dur` expires
  var KS_DAMP = 1.1;     // how much of the decay the loop filter (not fb) does
  var KS_MAX  = 48;      // cached buffers
  var KS_CACHE_SEC = 6;  // longer than this is not worth holding on to
  var ksCache = {}, ksKeys = [];

  // A noise burst driven into a feedback delay one period long, so the loop
  // rings at f. Rendered into an AudioBuffer in JS rather than looped through a
  // live DelayNode: one pass over ~100k samples costs well under a millisecond,
  // is exactly repeatable, and gives us something cacheable. The drill re-draws
  // from a small pool of pitches, so the same (midi, dur) pairs recur constantly.
  //
  // The two departures from textbook Karplus–Strong below are both there because
  // this is a PITCH-TRAINING app, and both were measured, not guessed:
  //   • an allpass tunes the loop, because a rounded integer delay was 27 cents
  //     flat at midi 74;
  //   • the loop filter's damping is scheduled by duration, because the fixed
  //     averager left midi 84 down 50 dB less than a second into a 3 s note.
  function ksBuffer(midi, f, dur) {
    // 20 ms buckets rounded UP, so a cache hit is never SHORTER than asked for.
    var qd = Math.ceil(dur * 50) / 50;
    var key = midi + '|' + qd;
    if (ksCache[key]) return ksCache[key];

    var fs = ac.sampleRate;
    var P  = fs / f;                    // the loop delay we must hit, in samples

    // Loop filter is (1-s)·x[n] + s·x[n-1]; s = 0.5 is the textbook averager.
    // Its loss compounds once per PERIOD, so a high note traverses the loop far
    // more often per second and dies far sooner than a low one — measured, midi
    // 84 fell to 0.3 % of its onset level by the end of a 3 s note while midi 40
    // was still at 20 %. Scheduling s ∝ fs²/(dur·f³) equalises the filter's
    // contribution over the note's LENGTH instead of over its pass count, which
    // is what "sustains for its full duration" actually requires.
    //
    // The floor is deliberately tiny: it only binds for high, long notes, and
    // that is exactly where forcing extra damping pushes fb past 1 into the cap
    // below and costs the note its sustain (measured: a 0.08 floor halved midi
    // 84 over 3 s, a 0.02 floor still clipped midi 90 over 4 s). Small s does
    // not make the string buzz, because the filter's loss grows with (1 - cos kw)
    // and so bites the upper partials orders of magnitude harder than the
    // fundamental — at midi 90 the 5th partial is still gone inside a pass or
    // two. That frequency-dependence IS the plucked-string character.
    var s = KS_DAMP * fs * fs / (2 * Math.PI * Math.PI * qd * f * f * f);
    if (s > 0.5) s = 0.5; else if (s < 0.01) s = 0.01;

    // That filter is itself a delay of s samples, so the delay line supplies the
    // rest. Split so the fractional part lands in [0.5, 1.5), where a first-order
    // allpass is best conditioned (its pole heads for the unit circle as the
    // fractional delay approaches 0).
    var want = P - s;
    var Ni = Math.floor(want - 0.5); if (Ni < 2) Ni = 2;
    var dfr = want - Ni;
    // Allpass fractional delay, NOT linear interpolation. Rounding the delay to
    // a whole sample detunes the string by up to half a sample — measured at
    // -27 cents around midi 74, and half a semitone is only 50, so that is a
    // third of the way to the wrong answer in a drill about naming pitches.
    // Linear interpolation would tune it but is itself a lowpass, as lossy at
    // frac ≈ 0.5 as the damping filter; an allpass is unity-magnitude at every
    // frequency, so it buys the tuning for nothing.
    var apA = (1 - dfr) / (1 + dfr);

    var total = Math.ceil(fs * (qd + KS_REL)) + Ni + 4;
    var buf = ac.createBuffer(1, total, fs);
    var d = buf.getChannelData(0);
    var i, prev = 0, peak = 0, sum = 0;

    // Excitation: one period of noise, one-pole smoothed. Raw white noise makes
    // the onset a spark of hiss; smoothing tilts its energy toward the low
    // partials so the attack reads as a finger on a string. The mean is then
    // removed — DC sees the loop filter's unity gain, so any offset would sit
    // there decaying at fb alone and thump on the way out.
    for (i = 0; i <= Ni; i++) {
      prev = 0.5 * (prev + (Math.random() * 2 - 1));
      d[i] = prev; sum += prev;
    }
    var mean = sum / (Ni + 1);
    for (i = 0; i <= Ni; i++) {
      d[i] -= mean;
      if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
    }
    if (peak > 0) for (i = 0; i <= Ni; i++) d[i] /= peak;

    // Solve the feedback gain for the note's LENGTH: the loop is traversed dur*f
    // times, and the filter already removes lf per pass, so fb makes up exactly
    // the difference and the string is at KS_END when the note ends — the same
    // audible decay at every pitch. |H(w)| = sqrt(1 - 2s(1-s)(1 - cos w)).
    var w  = 2 * Math.PI * f / fs;
    var lf = Math.sqrt(Math.max(1e-9, 1 - 2 * s * (1 - s) * (1 - Math.cos(w))));
    var fb = Math.pow(KS_END, 1 / Math.max(1, qd * f)) / lf;
    // fb >= 1 would grow DC without bound (the filter passes DC at unity). The
    // cap only ever binds for implausibly long notes, which then simply decay
    // further than KS_END rather than becoming unstable.
    if (fb > 0.99995) fb = 0.99995;

    var apX = 0, apY = 0, apPrev = 0, x, ap;
    for (i = Ni + 1; i < total; i++) {
      x  = d[i - Ni];                          // integer part of the delay
      ap = apA * x + apX - apA * apY;          // + allpass fractional delay dfr
      apX = x; apY = ap;
      d[i] = fb * ((1 - s) * ap + s * apPrev); // + filter's own s = P delay total
      apPrev = ap;
    }

    // Bounded, FIFO. An unbounded map of multi-second Float32Arrays is precisely
    // the unbounded growth we rejected player.js:62 over.
    if (qd <= KS_CACHE_SEC) {
      ksCache[key] = buf; ksKeys.push(key);
      while (ksKeys.length > KS_MAX) delete ksCache[ksKeys.shift()];
    }
    return buf;
  }

  /* --- the six voices ------------------------------------------------------
   * Every builder takes (f, t, dur, amp, midi) and connects itself to `master`.
   * `midi` is only used by `pluck`, for its buffer cache key.
   * ---------------------------------------------------------------------- */

  var VOICE = {

    // 2-op FM. The 2:1 modulator:carrier ratio is the load-bearing choice, not
    // the index: with fmod = 2f every sideband lands at f ± k·2f, i.e. on an ODD
    // HARMONIC of f, and the negative-frequency images fold back onto those same
    // harmonics. The spectrum is therefore perfectly harmonic and the perceived
    // pitch is unambiguous. An inharmonic ratio at this index would sound
    // bell-like, and a bell's ambiguous pitch would corrupt the training signal
    // (design Part I §10). Index 3 is the ceiling we allow: at ratio 2 it leaves
    // the fundamental the strongest partial, and pushing higher would not.
    rhodes: function (f, t, dur, amp) {
      var g = ac.createGain(); g.connect(master);
      var off = ampEnv(g.gain, t, dur, amp * 0.26, 0.006, 0.55, 0.12, 0.30, 0.10);
      var car = ac.createOscillator(); car.type = 'sine'; car.frequency.value = f;
      var mod = ac.createOscillator(); mod.type = 'sine'; mod.frequency.value = f * 2;
      var mg = ac.createGain();
      // Peak deviation = index × modulator frequency = 3 × 2f. It collapses over
      // ~200 ms, which is the tine's bark decaying into a near-pure sine.
      mg.gain.setValueAtTime(6 * f, t);
      mg.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.05), t + 0.2);
      mod.connect(mg); mg.connect(car.frequency);
      car.connect(g);
      car.start(t); mod.start(t);
      car.stop(off + 0.02); mod.stop(off + 0.02);
      reap(car); reap(mod);
    },

    // Karplus–Strong, replayed from a pre-rendered buffer (see ksBuffer above).
    // The gain envelope here is almost flat — `tail` 0.85, no sag — because the
    // string's own decay already lives in the samples; a second aggressive decay
    // on top would cut the note short.
    pluck: function (f, t, dur, amp, midi) {
      var g = ac.createGain(); g.connect(master);
      var off = ampEnv(g.gain, t, dur, amp * 0.34, 0.004, 1, 0, 0.85, 0.05);
      var s = ac.createBufferSource();
      s.buffer = ksBuffer(midi, f, dur);
      s.connect(g);
      s.start(t); s.stop(off + 0.02); reap(s);
    },

    // Sawtooth pair through a lowpass whose cutoff both TRACKS the pitch and has
    // an envelope of its own — that opening sweep is what reads as a blown reed
    // rather than a static buzz. Tracking matters beyond timbre: a fixed cutoff
    // would make high notes thin and low notes muddy, and a brightness that
    // changed with register would hand the user a spurious octave cue.
    reed: function (f, t, dur, amp) {
      var g = ac.createGain(); g.connect(master);
      var off = ampEnv(g.gain, t, dur, amp * 0.17, 0.03, 0.78, 0.14, 0.68, 0.09);
      var lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
      lp.frequency.setValueAtTime(Math.min(9000, f * 2 + 180), t);
      lp.frequency.exponentialRampToValueAtTime(Math.min(11000, f * 7 + 900), t + 0.07);
      lp.frequency.exponentialRampToValueAtTime(Math.max(220, f * 3.2),
                                                t + Math.max(0.1, Math.min(dur, 0.55)));
      // Two saws a few cents apart: one alone is a buzzer, the beating between
      // them is what makes it sound blown.
      var o1 = ac.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = f; o1.detune.value = -4;
      var o2 = ac.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = f; o2.detune.value = 5;
      var g2 = ac.createGain(); g2.gain.value = 0.5;
      o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g);
      o1.start(t); o2.start(t); o1.stop(off + 0.02); o2.stop(off + 0.02);
      reap(o1); reap(o2);
    },

    // Sine plus a whisper of triangle for a little third-harmonic breath, a slow
    // ~80 ms attack, and a 5 Hz ±8-cent vibrato. The vibrato is ramped IN rather
    // than started at depth: a wobble on the onset would smear the first instant
    // of the note, and that instant is where the ear does most of its pitch work.
    flute: function (f, t, dur, amp) {
      var g = ac.createGain(); g.connect(master);
      var off = ampEnv(g.gain, t, dur, amp * 0.30, 0.08, 1, 0, 0.88, 0.12);
      var o1 = ac.createOscillator(); o1.type = 'sine';     o1.frequency.value = f;
      var o2 = ac.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f;
      var g2 = ac.createGain(); g2.gain.value = 0.10;
      var lfo = ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 5;
      var lg = ac.createGain();
      // Linear ramps MAY start at exactly 0 — only exponential ones may not.
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(8, t + Math.min(0.4, dur * 0.6));   // ±8 cents
      lfo.connect(lg); lg.connect(o1.detune); lg.connect(o2.detune);
      o1.connect(g); o2.connect(g2); g2.connect(g);
      o1.start(t); o2.start(t); lfo.start(t);
      o1.stop(off + 0.02); o2.stop(off + 0.02); lfo.stop(off + 0.02);
      reap(o1); reap(o2); reap(lfo);
    },

    // Sine fundamental plus a quiet square for edge, both through a lowpass that
    // tracks the pitch. Punchy attack, but it sags to a PLATEAU rather than
    // decaying away — the note still has to be there when the user replays it in
    // their head at the end of a 3 s window. Preferred in the low register,
    // where the other five voices thin out (the caller picks the voice).
    bass: function (f, t, dur, amp) {
      var g = ac.createGain(); g.connect(master);
      var off = ampEnv(g.gain, t, dur, amp * 0.32, 0.005, 0.58, 0.09, 0.45, 0.07);
      var lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
      lp.frequency.setValueAtTime(Math.min(6000, f * 6 + 260), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(160, f * 2.4),
                                                t + Math.max(0.1, Math.min(dur, 0.4)));
      var o1 = ac.createOscillator(); o1.type = 'sine';   o1.frequency.value = f;
      var o2 = ac.createOscillator(); o2.type = 'square'; o2.frequency.value = f;
      var g2 = ac.createGain(); g2.gain.value = 0.12;
      o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g);
      o1.start(t); o2.start(t); o1.stop(off + 0.02); o2.stop(off + 0.02);
      reap(o1); reap(o2);
    },

    // Additive drawbars: sines at 1×–4× with falling amplitude, a near-flat
    // envelope and short attack/release. It has the least character of the six,
    // which is exactly why it is also the FIXED cadence voice (design Part I §7)
    // — the cadence's job is to establish the key, and randomising its timbre
    // would add noise to the one part of each trial that must stay constant.
    organ: function (f, t, dur, amp) {
      var g = ac.createGain(); g.connect(master);
      var off = ampEnv(g.gain, t, dur, amp * 0.13, 0.015, 1, 0, 0.95, 0.06);
      var bars = [1, 0.5, 0.32, 0.2];
      for (var k = 0; k < bars.length; k++) {
        var o = ac.createOscillator(); o.type = 'sine';
        o.frequency.value = f * (k + 1);
        var pg = ac.createGain(); pg.gain.value = bars[k];
        o.connect(pg); pg.connect(g);
        o.start(t); o.stop(off + 0.02); reap(o);
      }
    }
  };

  /* --- scheduling --------------------------------------------------------- */

  function amountOf(gain) {
    return (typeof gain === 'number' && isFinite(gain) && gain >= 0) ? gain : 1;
  }

  function note(midi, voice, when, dur, gain) {
    var c = ensure(); if (!c) return;
    wake();
    // A sanity guard, NOT a musical clamp: player.js:85's 1.2 s ceiling is the
    // single biggest reason this module exists. 30 s is far past any drill note
    // and only stops a bad caller asking ksBuffer() for half a gigabyte.
    var d = Math.max(0.08, Math.min(30, (dur > 0 ? dur : 1)));
    (VOICE[voice] || VOICE.organ)(freq(midi), at(when), d, amountOf(gain), midi);
  }

  function chord(midis, voice, when, dur, gain) {
    if (!midis || !midis.length) return;
    var c = ensure(); if (!c) return;
    // Resolve the onset ONCE so every note in the chord lands on the same
    // instant; at()'s SAFE margin keeps it valid for the whole loop.
    var t = at(when);
    // n simultaneous notes would otherwise be roughly n× as loud as one, and the
    // cadence must never blast relative to the test note it is setting up.
    var a = amountOf(gain) / Math.sqrt(midis.length);
    for (var i = 0; i < midis.length; i++) note(midis[i], voice, t, dur, a);
  }

  function drop(entry) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = 0; }
    var i = pending.indexOf(entry); if (i >= 0) pending.splice(i, 1);
  }

  // stopAll() must UNWEDGE the trial state machine, not freeze it: anything
  // awaiting a cadence gets resolved rather than left hanging forever.
  function flushPending() {
    var list = pending; pending = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].timer) clearTimeout(list[i].timer);
      list[i].resolve();
    }
  }

  // `chords` is EarTheory.cadence() output: [{midis:[...], beats}]. Four chords
  // is four events, so they all go in upfront at absolute times — drum-synth.js
  // needs a rolling lookahead (drum-synth.js:21) because a whole song floods
  // Chrome's realtime thread, and a cadence never will.
  function playCadence(chords, voice, bpm) {
    return new Promise(function (resolve) {
      var c = ensure();
      // Resolve, never reject, when there is nothing to play: a browser without
      // Web Audio must still run the (silent, useless, but not stuck) app.
      if (!c || !chords || !chords.length) { resolve(); return; }
      wake();
      var spb = 60 / (bpm > 0 ? bpm : CAD_BPM);
      var t = at(), i, ch, span;
      for (i = 0; i < chords.length; i++) {
        ch = chords[i] || {};
        span = ((ch.beats > 0 ? ch.beats : 1)) * spb;
        // 4 % of each span left silent so consecutive chords ARTICULATE. The
        // cadence establishes the key through its changes; full legato smears
        // them into one sustained cluster and the key stops being obvious.
        chord(ch.midis, voice || 'organ', t, span * 0.96, 0.85);
        t += span;
      }
      // Resolve off the ctx clock, not a bare duration: `t` is already in
      // AudioContext time, which is the clock the notes are actually on.
      var entry = { resolve: resolve, timer: 0 };
      entry.timer = setTimeout(function () { drop(entry); resolve(); },
                               Math.max(0, (t - c.currentTime) * 1000 + 40));
      pending.push(entry);
    });
  }

  /* --- drone ---------------------------------------------------------------
   * Deliberately not built out of note(): it has NO end time, so it cannot use
   * ampEnv's stop plumbing and must not be reaped (nothing would ever fire
   * onended). Design Part I §6 makes this a first-class context mode — a tonic
   * that never decays, so the user judges each degree's colour against a
   * reference that is present rather than remembered.
   * ---------------------------------------------------------------------- */

  var DRONE_GAIN = 0.11, DRONE_FADE = 0.28;

  function startDrone(midi) {
    var c = ensure(); if (!c) return;
    wake();
    if (drone && drone.midi === midi) return;   // retriggering the same tonic
    if (drone) stopDrone();                     // would only produce a click
    var f = freq(midi), t = at();
    var g = ac.createGain(); g.connect(master);
    g.gain.setValueAtTime(EPS, t);
    g.gain.exponentialRampToValueAtTime(DRONE_GAIN, t + DRONE_FADE);
    var lp = ac.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = Math.min(4200, f * 8 + 500);
    lp.connect(g);
    // [harmonic, amplitude, detune cents]. The doubled fundamental at +5 cents
    // gives a slow beat that keeps a bare sine from sounding like a hearing
    // test; the quiet 2× and 3× give it enough body to stay audible under a
    // melody without having to be loud enough to mask one.
    var spec = [[1, 1, 0], [1, 0.55, 5], [2, 0.30, 0], [3, 0.10, 0]];
    var srcs = [], i, o, pg;
    for (i = 0; i < spec.length; i++) {
      o = ac.createOscillator(); o.type = 'sine';
      o.frequency.value = f * spec[i][0];
      o.detune.value = spec[i][2];
      pg = ac.createGain(); pg.gain.value = spec[i][1];
      o.connect(pg); pg.connect(lp);
      o.start(t); srcs.push(o);
    }
    // Detach the whole subtree from master once the oscillators finish, so a
    // session that switches tonics repeatedly does not accumulate dead branches.
    srcs[0].onended = function () { try { g.disconnect(); } catch (e) {} };
    drone = { midi: midi, out: g, srcs: srcs };
  }

  // `fade` (seconds, optional) shortens the release — stopAll() uses it to fade
  // the drone inside its own duck window.
  function stopDrone(fade) {
    if (!drone || !ac) return;
    var d = drone; drone = null;
    var t = ac.currentTime, f = (fade > 0 ? fade : DRONE_FADE), i;
    try {
      // cancelScheduledValues first: the fade-in may still be running, and
      // ramping from a stale scheduled value would jump the level audibly.
      d.out.gain.cancelScheduledValues(t);
      d.out.gain.setValueAtTime(Math.max(EPS, d.out.gain.value), t);
      d.out.gain.exponentialRampToValueAtTime(EPS, t + f);
    } catch (e) {}
    for (i = 0; i < d.srcs.length; i++) { try { d.srcs[i].stop(t + f + 0.03); } catch (e) {} }
  }

  /* --- teardown ----------------------------------------------------------- */

  // Panic stop: everything, drone included. Use stopDrone() alone when the drone
  // is meant to survive.
  function stopAll() {
    if (!ac) return;
    var t = ac.currentTime, seq = ++duckSeq;
    // Hard-stopping an oscillator mid-cycle leaves a step discontinuity — a
    // click. So duck the master to silence over 30 ms first (short enough that
    // the stop still feels instant), kill the nodes after the duck, and put the
    // master back for the next note. drum-synth.js:66 clears nodes the same way
    // but without the duck; it only ever plays percussion, where a click hides.
    try {
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(Math.max(EPS, master.gain.value), t);
      master.gain.exponentialRampToValueAtTime(EPS, t + DUCK);
    } catch (e) {}
    stopDrone(DUCK);
    flushPending();
    // Detach the list before walking it: reap()'s onended fires during stop()
    // and would splice the very array being iterated.
    var doomed = nodes; nodes = [];
    setTimeout(function () {
      for (var i = 0; i < doomed.length; i++) {
        doomed[i].onended = null;
        try { doomed[i].stop(0); } catch (e) {}
        try { doomed[i].disconnect(); } catch (e) {}
      }
      // Only the newest stopAll restores the master. An older timer landing
      // afterwards would cancel a duck that is still in progress.
      if (!ac || seq !== duckSeq) return;
      try {
        master.gain.cancelScheduledValues(ac.currentTime);
        master.gain.setValueAtTime(MASTER, ac.currentTime);
      } catch (e) {}
    }, DUCK * 1000 + 25);
  }

  /* --- lifecycle ---------------------------------------------------------- */

  // Call from inside a user gesture. Returns whether the context is running
  // *already*; resume() is asynchronous, so a false on the very first gesture is
  // not necessarily a failure — re-check ready() on a later frame.
  function unlock() {
    var c = ensure(); if (!c) return false;
    wake();
    if (!primed) {
      primed = true;
      // iOS reports a context as running while still routing it nowhere until an
      // actual source has been started from inside a gesture. One silent sample
      // is the cheapest way to satisfy that.
      try {
        var b = ac.createBuffer(1, 1, ac.sampleRate);
        var s = ac.createBufferSource(); s.buffer = b;
        s.connect(ac.destination); s.start(0);
      } catch (e) {}
    }
    return c.state === 'running';
  }

  return {
    VOICES: VOICES,
    unlock: unlock,
    ready: function () { return !!(ac && ac.state === 'running'); },
    now: function () { return ac ? ac.currentTime : 0; },
    note: note,
    chord: chord,
    playCadence: playCadence,
    startDrone: startDrone,
    stopDrone: stopDrone,
    stopAll: stopAll
  };
})();
