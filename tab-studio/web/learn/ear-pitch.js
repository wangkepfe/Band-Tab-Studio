/* ============================================================================
 * ear-pitch.js  —  push-to-sing microphone input + MPM pitch detection.
 *
 * PUSH-TO-SING. The mic is never open on its own. The user holds a control to
 * sing and the stream is live only while it is held. That is the design, not
 * an optimisation: it makes the acoustic feedback loop STRUCTURALLY
 * IMPOSSIBLE rather than defended-against — the app cannot hear its own tone
 * because the mic is shut while ear-audio.js is the one making noise — and it
 * makes "the mic is off" genuinely true rather than a flag that some analysis
 * loop chooses to respect. Between holds `track.enabled = false`, which
 * really does stop audio flowing; permission is asked for ONCE and the
 * MediaStream is kept, because re-acquiring per trial is slow and re-prompts
 * on some browsers.
 *
 * The constraints {echoCancellation:false, noiseSuppression:false,
 * autoGainControl:false} are non-negotiable. All three destroy pitch
 * detection; autoGainControl in particular pumps sustained tones, so a held
 * note drifts in level and the RMS gate flaps. We never silently retry with
 * plain {audio:true}: that would re-enable the processors and quietly
 * corrupt every reading, which is worse than failing loudly.
 *
 * DETECTION IS MPM (McLeod Pitch Method) — the normalised square difference
 * function — NOT plain autocorrelation. Autocorrelation octave-halves on the
 * human voice, and for a training tool that is the worst possible failure:
 * the user sings the right degree and is silently told they are wrong.
 *
 * PERFORMANCE BUDGET. A naive O(n^2) NSDF over 4096 samples is ~16M
 * multiply-adds per frame and will not hold 60 fps. Two bounds fix it:
 *   • W = 2048 samples — the NEWEST half of the AnalyserNode's fftSize-4096
 *     window. (getFloatTimeDomainData() fills from the oldest sample forward,
 *     so handing it a short array would give us the OLDEST half: ~43 ms of
 *     stale audio.)
 *   • lags bounded to 70 Hz … 1000 Hz — at 48 kHz that is lags 48…686.
 *   Cost = Σ(W − lag) over those 639 lags ≈ 639 × ~1681 ≈ 1.1M multiply-adds,
 *   plus a short pre-scan for the first zero crossing (see PASS 1 below) that
 *   pushes the 70 Hz worst case to ~1.17M. Measured ≈ 0.9 ms per frame on
 *   V8 — comfortably inside a 16.7 ms budget. The bounds are derived from the
 *   real sampleRate, never hardcoded (44.1 kHz gives lags 45…630).
 *
 * ACCEPTANCE is deliberately conservative — a wrong lock is worse than a slow
 * one: RMS > 0.01 (rejects room noise), NSDF clarity >= 0.9, then 8
 * consecutive frames spanning >= 100 ms whose pitches lie within 40 cents of
 * each other; the reported pitch is their median.
 *
 *   EarPitch.supported()           -> bool     getUserMedia + AudioContext
 *   EarPitch.enable()              -> Promise  ONE getUserMedia, stream kept
 *   EarPitch.enabled()             -> bool
 *   EarPitch.disable()                         release stream + context
 *   EarPitch.beginHold(onFrame)    -> bool     mic on, rAF loop; onFrame gets
 *        {hz,midi,pc,cents,clarity,rms,stable,accepted} once per frame
 *   EarPitch.endHold()             -> {hz,midi,pc,cents} | null
 *   EarPitch.holding()             -> bool
 *   EarPitch.lastError()           -> string   why the mic is unavailable
 *   EarPitch.detect(x, sampleRate) -> {hz,clarity,rms}   PURE, dual-exported
 *   EarPitch.hzToNote(hz)          -> {hz,midi,pc,cents} | null   PURE
 * ========================================================================== */
var EarPitch = (function () {
  'use strict';

  // ---- detection tuning -----------------------------------------------------
  var FMIN = 70;            // Hz — under a low bass voice; sets the lag ceiling
  var FMAX = 1000;          // Hz — over a soprano's top; sets the lag floor.
                            // Content above it aliases down an octave, which is
                            // why the band is drawn around the human voice and
                            // not around whistles.
  var W = 2048;             // analysis window in samples (see budget above)
  var FFT = 4096;           // AnalyserNode.fftSize; we analyse its newest half
  var K_PEAK = 0.9;         // key-maximum threshold as a fraction of the tallest
  var MAX_PEAKS = 256;      // NSDF positive regions we bother to record

  // ---- acceptance tuning ----------------------------------------------------
  var RMS_MIN = 0.01;       // below this it is room noise, not a sung note
  var CLARITY_MIN = 0.9;    // interpolated NSDF height at the chosen peak
  var STABLE_N = 8;         // consecutive passing frames required
  var STABLE_MS = 100;      // ...which must also span this long in wall time
  var STABLE_CENTS = 40;    // max spread across those frames
  var ATTACK_MS = 80;       // dead time after press: click transient + breath

  var CONSTRAINTS = { echoCancellation: false, noiseSuppression: false,
                      autoGainControl: false };

  // Node dual-export: nothing at load time may touch window/navigator/document,
  // so every DOM reference below is behind this flag.
  var HAS_DOM = (typeof window !== 'undefined');

  /* == pure detection ====================================================== */

  // Scratch buffers, reused across frames. detect() is pure in the sense that
  // matters — same input, same output, no observable state, safe to unit-test
  // from Node — but allocating ~10 KB of typed arrays 60 times a second would
  // hand the GC a job it does not need.
  var centreBuf = null, nsdfBuf = null;
  var peakLag = null, peakVal = null;

  // Copy x with its mean removed. This is not cosmetic: any DC offset on the
  // input drags every NSDF term toward +1, and the peak picker then sees a
  // plateau where it needs a peak.
  function centre(x, n) {
    var i, sum = 0;
    if (!centreBuf || centreBuf.length < n) centreBuf = new Float32Array(n);
    for (i = 0; i < n; i++) sum += x[i];
    var mean = sum / n;
    for (i = 0; i < n; i++) centreBuf[i] = x[i] - mean;
    return centreBuf;
  }

  // `n` bounds the scan because the scratch buffer is grown, never shrunk, and
  // so is usually longer than the window we were handed.
  function rmsOf(x, n) {
    var i, s = 0;
    if (n == null) n = x.length;
    if (!n) return 0;
    for (i = 0; i < n; i++) s += x[i] * x[i];
    return Math.sqrt(s / n);
  }

  // One NSDF bin: n(tau) = 2*r(tau) / m(tau), McLeod eq. (9). The single inner
  // loop accumulates both the autocorrelation r and the square sum m, because
  // walking the window twice would double the only expensive part of the app.
  function nsdfAt(c, n, tau) {
    var j, a, b, acf = 0, div = 0, lim = n - tau;
    for (j = 0; j < lim; j++) {
      a = c[j]; b = c[j + tau];
      acf += a * b;
      div += a * a + b * b;
    }
    return div > 0 ? (2 * acf / div) : 0;
  }

  // MPM / NSDF pitch detection over one window.
  // Returns {hz, clarity, rms}; hz is 0 when no periodicity was found. `rms` is
  // measured after DC removal and is returned so a caller polling every frame
  // need not re-scan the window just to run its noise gate.
  function detect(x, sampleRate) {
    var out = { hz: 0, clarity: 0, rms: 0 };
    var n = x ? x.length : 0;
    if (!n || !(sampleRate > 0)) return out;

    var c = centre(x, n);
    out.rms = rmsOf(c, n);

    var minLag = Math.max(2, Math.floor(sampleRate / FMAX));
    // Two ceilings on the lag: the 70 Hz musical floor, and W/2 — below half a
    // window of overlap the NSDF is computed from too few samples to trust, so
    // a 96 kHz device simply gets a slightly higher pitch floor (~94 Hz).
    var maxLag = Math.min(Math.floor(sampleRate / FMIN), Math.floor(n / 2));
    if (maxLag <= minLag + 2) return out;

    if (!nsdfBuf || nsdfBuf.length < maxLag + 2) nsdfBuf = new Float32Array(maxLag + 2);
    if (!peakLag) { peakLag = new Int32Array(MAX_PEAKS); peakVal = new Float32Array(MAX_PEAKS); }
    var nsdf = nsdfBuf;
    var tau, v;

    // PASS 1 — find the first negative zero crossing, walking up from lag 1.
    // n(0) is always 1 and the curve decays away from it, so the lobe around
    // lag 0 is not evidence of anything; McLeod's rule is to start looking only
    // after the curve has gone negative once. Skipping this is not a subtlety:
    // at 70 Hz / 48 kHz that trivial lobe is still at 0.90 when it reaches the
    // lag-48 search floor, so the peak picker "finds" a 1000 Hz peak and a low
    // sung note is graded as a note two and a half octaves up.
    // The lags below minLag are computed for this reason ALONE and are never
    // reported; the scan stops the moment it crosses, so the extra cost is a
    // quarter period (~170 lags at 70 Hz, ~12 at 1 kHz) and the worst case is
    // the ~9% quoted in the banner.
    var start = 0;
    for (tau = 1; tau <= maxLag; tau++) {
      if (nsdfAt(c, n, tau) <= 0) { start = tau; break; }
    }
    if (!start) return out;             // never crosses: no period in range
    if (start < minLag) start = minLag; // ...and never report above FMAX

    // PASS 2 — the real NSDF over the reportable lags.
    for (tau = start; tau <= maxLag; tau++) nsdf[tau] = nsdfAt(c, n, tau);

    // Key maxima: the highest point of each positive region of the NSDF. The
    // region tracker is driven by the sign of the curve rather than by fixed
    // lag boundaries, because where the regions fall depends entirely on the
    // pitch being sung.
    var cnt = 0, inPos = false, bestLag = 0, bestVal = 0;
    for (tau = start; tau <= maxLag; tau++) {
      v = nsdf[tau];
      if (v > 0) {
        if (!inPos) { inPos = true; bestLag = tau; bestVal = v; }
        else if (v > bestVal) { bestLag = tau; bestVal = v; }
      } else if (inPos) {
        inPos = false;
        if (cnt < MAX_PEAKS) { peakLag[cnt] = bestLag; peakVal[cnt] = bestVal; cnt++; }
      }
    }
    // A peak sitting at the very end of the search range never gets closed by a
    // sign change; the lowest notes land exactly there, so keep it.
    if (inPos && cnt < MAX_PEAKS) { peakLag[cnt] = bestLag; peakVal[cnt] = bestVal; cnt++; }
    if (!cnt) return out;

    // THE OCTAVE FIX. Pick the FIRST key maximum that reaches K_PEAK of the
    // tallest one — not the tallest. The peak at twice the period is very
    // nearly as tall, so a plain argmax reports f/2 about half the time; taking
    // the earliest (shortest lag) peak above the threshold is what keeps a sung
    // "5" from being graded as the "5" an octave down.
    var i, top = 0;
    for (i = 0; i < cnt; i++) if (peakVal[i] > top) top = peakVal[i];
    if (top <= 0) return out;
    var thresh = top * K_PEAK, chosen = -1;
    for (i = 0; i < cnt; i++) if (peakVal[i] >= thresh) { chosen = peakLag[i]; break; }
    if (chosen < 0) return out;

    // Parabolic interpolation through the three bins around the peak. Without
    // it the lag is an integer, so at 48 kHz a note near 440 Hz resolves to
    // ~4 cents steps at best — far too coarse to drive a cents needle.
    var lag = chosen, val = nsdf[chosen];
    if (chosen > start && chosen < maxLag) {
      var y0 = nsdf[chosen - 1], y1 = nsdf[chosen], y2 = nsdf[chosen + 1];
      var den = y0 + y2 - 2 * y1;                 // negative at a true maximum
      if (den < 0) {
        var d = 0.5 * (y0 - y2) / den;            // vertex offset, |d| < 1 bin
        if (d > -1 && d < 1) { lag = chosen + d; val = y1 - 0.25 * (y0 - y2) * d; }
      }
    }
    if (!(lag > 0)) return out;

    out.hz = sampleRate / lag;
    out.clarity = val < 0 ? 0 : (val > 1 ? 1 : val);
    return out;
  }

  // Continuous MIDI number for a frequency (A4 = 69 = 440 Hz). Math.log2 is
  // ES6; the repo is ES5, hence log/LN2.
  function midiOf(hz) { return 69 + 12 * Math.log(hz / 440) / Math.LN2; }
  function hzOfMidi(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // {hz, midi, pc, cents} for a frequency, or null. `cents` is the signed
  // deviation from the nearest semitone (−50…+50) — the tuner needle — and `pc`
  // is the pitch class, which is all the drill ever grades against because
  // scale degrees are octave-invariant.
  function hzToNote(hz) {
    if (!(hz > 0)) return null;
    var mf = midiOf(hz), midi = Math.round(mf);
    return { hz: hz, midi: midi, pc: ((midi % 12) + 12) % 12,
             cents: Math.round((mf - midi) * 100) };
  }

  /* == microphone ========================================================== */

  var stream = null, track = null, ac = null;
  var srcNode = null, analyser = null, sink = null;
  var full = null, win = null;        // fftSize buffer + view on its newest half
  var pending = null;                 // in-flight enable() promise
  var isOn = false;                   // permission granted, graph built
  var isHolding = false;
  var holdSeq = 0;                    // bumped on every begin/end: stale rAF bail
  var rafId = 0, timerId = 0;
  var frameCb = null;
  var holdStartMs = 0;
  var runMidi = [], runAt = [];       // the current run of accepted-frame pitches
  var accepted = null;
  var errText = '';

  // Wall-clock helper. These are MILLISECONDS and they never leave this module:
  // anything persisted is unix seconds (see ear-store.js).
  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  function supported() {
    if (!HAS_DOM) return false;
    var md = navigator && navigator.mediaDevices;
    var AC = window.AudioContext || window.webkitAudioContext;
    return !!(md && md.getUserMedia && AC);
  }
  function enabled() { return isOn; }
  function holding() { return isHolding; }
  function lastError() { return errText; }

  // Turn a getUserMedia rejection into something we can show the user. The mic
  // is optional everywhere in this app, so a failure here is a disabled control
  // with a reason attached — never an exception and never a silent no-op.
  function describe(err) {
    var name = (err && (err.name || err.code)) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
      return 'Microphone permission was denied.';
    if (name === 'SecurityError')
      return 'The microphone needs a secure page (https, or localhost).';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
      return 'No microphone was found.';
    if (name === 'NotReadableError' || name === 'TrackStartError')
      return 'The microphone is busy in another app.';
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError')
      return 'This microphone will not switch off its own processing, ' +
             'which would corrupt every reading.';
    return 'The microphone could not be opened.';
  }

  function enable() {
    if (isOn) return Promise.resolve(true);
    if (pending) return pending;                 // concurrent callers share one prompt
    if (!supported()) {
      errText = 'This browser has no microphone API.';
      return Promise.reject(new Error(errText));
    }
    // The AudioContext is built SYNCHRONOUSLY, before the getUserMedia promise,
    // because enable() is called from a click handler and the autoplay policy
    // only blesses a context constructed while that gesture is still live.
    // Constructing it in the .then() lands after the gesture has expired and
    // the context comes up 'suspended' on Safari.
    try {
      if (!ac) {
        var AC = window.AudioContext || window.webkitAudioContext;
        ac = new AC();
      }
    } catch (e) {
      errText = 'Audio is unavailable in this browser.';
      return Promise.reject(e);
    }

    pending = navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS })
      .then(function (s) {
        stream = s;
        track = (s.getAudioTracks && s.getAudioTracks()[0]) || null;
        if (track) {
          // OFF the instant we own it. The very first state of the mic after
          // permission is granted is "not listening"; only beginHold() ever
          // turns it on.
          track.enabled = false;
          // The device was unplugged or the permission was revoked mid-session.
          track.onended = function () { disable(); };
        }
        srcNode = ac.createMediaStreamSource(s);
        analyser = ac.createAnalyser();
        analyser.fftSize = FFT;
        srcNode.connect(analyser);
        // analyser → zero gain → destination. Some engines only "actively
        // process" nodes with a path to the destination and a dangling analyser
        // then reads pure silence. The gain is a hard 0, so nothing is ever
        // audible; together with track.enabled=false between holds there is no
        // route at all from the mic back to the speakers.
        sink = ac.createGain();
        sink.gain.value = 0;
        analyser.connect(sink);
        sink.connect(ac.destination);

        full = new Float32Array(FFT);
        win = full.subarray(FFT - W);        // the newest W samples, no copy

        // Not fatal, but say it out loud: a browser that kept a processor we
        // asked it to switch off will make sustained notes drift in level.
        if (track && track.getSettings) {
          var st = track.getSettings();
          if (st && (st.autoGainControl || st.echoCancellation || st.noiseSuppression) &&
              window.console && console.warn) {
            console.warn('EarPitch: browser kept mic processing enabled', st);
          }
        }
        isOn = true; pending = null; errText = '';
        return true;
      }, function (err) {
        // Leave the module fully usable in its disabled state: supported() is
        // still true, enable() can be retried, and the rest of the app (which
        // never needs the mic) is untouched.
        pending = null;
        errText = describe(err);
        throw err;
      });
    return pending;
  }

  function disable() {
    release();
    if (track) { try { track.enabled = false; } catch (e) {} try { track.onended = null; } catch (e2) {} }
    if (stream && stream.getTracks) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    try { if (srcNode) srcNode.disconnect(); } catch (e) {}
    try { if (analyser) analyser.disconnect(); } catch (e) {}
    try { if (sink) sink.disconnect(); } catch (e) {}
    try { if (ac && ac.close) ac.close(); } catch (e) {}
    stream = null; track = null; srcNode = null; analyser = null; sink = null;
    ac = null; full = null; win = null;
    accepted = null; frameCb = null; isOn = false; pending = null;
  }

  /* == the hold ============================================================ */

  function schedule(seq) {
    if (HAS_DOM && window.requestAnimationFrame) {
      rafId = window.requestAnimationFrame(function () { frame(seq); });
    } else {
      // Fallback for an environment with no rAF at all. A BACKGROUNDED tab is a
      // different case and does not need one: rAF stops firing there, but the
      // visibilitychange latch guard below has already ended the hold and shut
      // the mic, which is the property that must hold whatever the scheduler
      // does.
      timerId = setTimeout(function () { frame(seq); }, 16);
    }
  }

  // Reset the stability run. "Consecutive" is the whole point of the criterion,
  // so a single failing frame starts the count over.
  function resetRun() { runMidi.length = 0; runAt.length = 0; }

  function frame(seq) {
    rafId = 0; timerId = 0;
    if (!isHolding || seq !== holdSeq || !analyser || !win) return;

    analyser.getFloatTimeDomainData(full);
    var t = nowMs(), res;

    if (t - holdStartMs < ATTACK_MS) {
      // Attack guard: the press click and the breath onset are not a pitch.
      // We still report the level so the meter is live from the first frame.
      res = { hz: 0, clarity: 0, rms: rmsOf(win) };
      resetRun();
    } else {
      var lvl = rmsOf(win);
      // Silence costs one cheap pass instead of 1.1M multiply-adds: there is no
      // point running the NSDF over room tone.
      res = (lvl < RMS_MIN) ? { hz: 0, clarity: 0, rms: lvl } : detect(win, ac.sampleRate);
    }

    var pass = (res.hz > 0 && res.rms >= RMS_MIN && res.clarity >= CLARITY_MIN);
    if (pass) {
      runMidi.push(midiOf(res.hz)); runAt.push(t);
      if (runMidi.length > STABLE_N) { runMidi.shift(); runAt.shift(); }
    } else {
      resetRun();
    }

    // Acceptance is live: the moment the run is long enough, has lasted long
    // enough and is tight enough, the pitch locks in. Keeping the hold going
    // re-sings and replaces it, and on release the last accepted value stands.
    // The STABLE_MS floor exists because STABLE_N alone assumes a 60 Hz
    // display — on a 120 Hz panel eight frames is 67 ms, which locks onto the
    // scoop at the start of a sung note instead of the note.
    var stable = false;
    if (runMidi.length === STABLE_N && (runAt[STABLE_N - 1] - runAt[0]) >= STABLE_MS) {
      var i, lo = runMidi[0], hi = runMidi[0];
      for (i = 1; i < STABLE_N; i++) {
        if (runMidi[i] < lo) lo = runMidi[i];
        if (runMidi[i] > hi) hi = runMidi[i];
      }
      if ((hi - lo) * 100 <= STABLE_CENTS) {
        stable = true;
        accepted = hzToNote(hzOfMidi(median(runMidi)));
      }
    }

    if (frameCb) {
      var note = hzToNote(res.hz);        // null when this frame has no pitch
      frameCb({
        hz: res.hz,
        midi: note ? note.midi : null,
        pc: note ? note.pc : null,
        cents: note ? note.cents : null,
        clarity: res.clarity,
        rms: res.rms,
        stable: stable,
        accepted: accepted
      });
    }
    schedule(seq);
  }

  function median(a) {
    var s = a.slice().sort(function (x, y) { return x - y; });
    var n = s.length, h = n >> 1;
    return (n % 2) ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  // Start listening. onFrame is called once per animation frame with
  // {hz,midi,pc,cents,clarity,rms,stable,accepted}: hz is 0 and midi/pc/cents
  // are null on a frame with no usable pitch (draw a blank needle, not a note
  // name). Flash the confirmation on the rising edge of `stable`; `accepted`
  // keeps tracking the voice for as long as it stays steady.
  // Idempotent — a second press while already holding only re-arms the
  // callback, it does not restart the attack guard or discard the run.
  // Returns false when the mic is not enabled; learn.js must also keep the hold
  // control disabled while ear-audio.js is playing.
  function beginHold(onFrame) {
    if (!isOn || !analyser) return false;
    frameCb = (typeof onFrame === 'function') ? onFrame : null;
    if (isHolding) return true;
    isHolding = true;
    holdSeq++;
    accepted = null;                     // each hold starts from nothing
    resetRun();
    holdStartMs = nowMs();
    if (track) track.enabled = true;     // ...and this is the only line that
                                         // ever opens the mic
    if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    schedule(holdSeq);
    return true;
  }

  // Stop listening and hand back the last accepted pitch of this hold, or null.
  // Idempotent: calling it twice returns the same answer and leaves the mic off
  // both times, which is what lets the UI wire pointerup, pointercancel, keyup
  // and blur to it without coordinating between them.
  function endHold() {
    if (isHolding) {
      isHolding = false;
      holdSeq++;                         // any queued rAF callback is now stale
      if (rafId && HAS_DOM && window.cancelAnimationFrame) window.cancelAnimationFrame(rafId);
      if (timerId) clearTimeout(timerId);
      rafId = 0; timerId = 0;
      if (track) track.enabled = false;  // the real off switch, not a flag
      resetRun();
      frameCb = null;                    // don't retain the UI's closure
    }
    return accepted;
  }

  function release() { if (isHolding) endHold(); }

  // Latch guards. The mic must NEVER be able to stay on because a pointer or a
  // key release went somewhere we were not listening: alt-tab, a phone call
  // stealing the pointer, a swipe that cancels the gesture, the tab going to
  // the background. Each of these unambiguously means "the hold is over", and
  // endHold() being idempotent means firing alongside the UI's own handler is
  // harmless. pointerup is deliberately NOT here — it is the UI's to own,
  // because the keyboard (Shift) hold must survive a click elsewhere.
  if (HAS_DOM) {
    window.addEventListener('blur', release);
    window.addEventListener('pagehide', release);
    window.addEventListener('pointercancel', release, true);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) release();
      });
    }
  }

  var api = {
    supported: supported,
    enable: enable,
    enabled: enabled,
    disable: disable,
    beginHold: beginHold,
    endHold: endHold,
    holding: holding,
    lastError: lastError,
    detect: detect,
    hzToNote: hzToNote,
    // Exported so the UI can draw the gates it is being judged against (a
    // clarity meter with an unmarked threshold teaches nothing) and so
    // test-ear.js asserts against the same numbers the loop uses.
    RMS_MIN: RMS_MIN,
    CLARITY_MIN: CLARITY_MIN,
    STABLE_N: STABLE_N,
    STABLE_CENTS: STABLE_CENTS,
    ATTACK_MS: ATTACK_MS,
    FMIN: FMIN,
    FMAX: FMAX
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EarPitch = api;
  return api;
})();
