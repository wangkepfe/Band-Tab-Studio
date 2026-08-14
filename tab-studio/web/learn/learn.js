/* ============================================================================
 * learn.js  —  the /learn page controller: trial state machine, degree keyboard,
 * push-to-sing wiring, settings, calibration and the end-of-session card.
 *
 * This is the ONLY file on the page that touches the DOM. Everything it drives is
 * already written and already tested head-less: ear-theory.js draws the question,
 * ear-session.js owns the state and the scoring, ear-audio.js makes the sound,
 * ear-pitch.js hears the voice, ear-store.js persists. The job here is to be the
 * wiring between them and the user, and to be honest about what is unavailable.
 *
 * Six decisions in here are load-bearing rather than incidental:
 *
 *   • COMMIT BEFORE REPLAY (design §4). The keyboard is the only way out of a
 *     trial, and "Hear it again" is deliberately NOT locked — locking it makes a
 *     mis-heard trial unanswerable — it is COUNTED. ear-session.js:326 does the
 *     counting and refuses to charge for a replay in REVEAL, so replay() can
 *     simply call assist() in every phase and let the model decide.
 *   • sess.ready() IS NOT OPTIONAL. It starts the response clock, and design §8
 *     measures note-end → commit. It is called at the exact instant the trial
 *     becomes answerable — after the note, or after the sing gate — never at
 *     next(), which would make every median a measure of playback length.
 *   • THE MIC IS OPTIONAL EVERYWHERE and the hold control is disabled while
 *     ear-audio.js is playing. ear-pitch.js cannot enforce that itself (it owns a
 *     different AudioContext and cannot see the drill's), so `audioBusy` here is
 *     the guard that makes "the app cannot hear its own tone" structural rather
 *     than hopeful.
 *   • THE TUNER NEVER NAMES A PITCH BEFORE THE COMMIT. The stage header shows the
 *     key, so a sung note's NAME is the degree by arithmetic with no ear involved
 *     (change spec §0) — the readout is therefore DIRECTION only, ▲ higher /
 *     ▼ lower / ✓ that's it, in BOTH drill modes, and the name comes back at
 *     REVEAL where the answer is already committed. That is also what makes it
 *     safe for the sing gate to demand a real match: "you are on the note" says
 *     nothing about that note's FUNCTION in the key, which is the one thing this
 *     app drills.
 *   • EVERY PLAYBACK IS SEQUENCED. `playSeq` is bumped by anything that
 *     invalidates a scheduled continuation — a replay, a pause, ending the
 *     session, a new trial — so a setTimeout that survives cannot advance a state
 *     machine that has moved on. Without it, ending a session during a cadence
 *     re-enters the next trial a second later.
 *   • app.js DOES NOT RUN HERE. The mode-web / mode-cloud body classes, the auth
 *     slot and flash() are all re-established below, per contract §D and §E;
 *     flash() is copied rather than imported because app.js:17 is private to that
 *     module's IIFE.
 *
 * Timestamps: nothing millisecond-valued is persisted. ear-session.js stamps the
 * record in unix SECONDS and ear-store.js writes it; the ms clocks in here never
 * leave the page.
 * ========================================================================== */
(function () {
  'use strict';

  /* ====================== §1 helpers + mode ====================== */

  var $ = function (id) { return document.getElementById(id); };
  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }
  function fmt(sec) {
    sec = Math.max(0, sec || 0);
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  // Copied from app.js:17 rather than imported — it lives inside that file's IIFE
  // and is not exported. Same #toast element, same 3 s dwell, same .show class.
  function flash(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { t.classList.remove('show'); }, 3000);
  }
  // Every dynamic node on this page is built with createElement + textContent.
  // clear() exists so nothing is ever tempted to reach for innerHTML.
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function norm12(n) { return ((Math.round(n) % 12) + 12) % 12; }

  // Contract §D, verbatim. app.js:1379-1380 is where the main app does this; it
  // does not run on /learn/, so the classes that gate .desktop-only / .cloud-only
  // (studio.css:62,67) have to be set here or the cloud sign-in slot never shows.
  var MODE  = (window.STUDIO_CONFIG && window.STUDIO_CONFIG.mode) || 'desktop';
  var CLOUD = (MODE === 'cloud');
  var WEB   = (MODE !== 'desktop');          // "there is no local FastAPI backend"
  if (WEB)   document.body.classList.add('mode-web');
  if (CLOUD) document.body.classList.add('mode-cloud');

  /* ====================== §2 constants + tables ====================== */

  var NOTE_SEC     = 1.6;   // test note length — long enough to sing back at
  var REVEAL_SEC   = 1.8;   // the corrective replay in REVEAL, deliberately longer
  var GAP_SEC      = 0.40;  // silence between the context and the test note
  var LEAD_SEC     = 0.08;  // scheduling lead for a bare replay (no context first)
  var DRONE_SETTLE = 0.85;  // let a fresh drone establish before the note lands
  var CAD_BPM      = 88;    // design §6's reference cadence tempo
  var CAD_VOICE    = 'organ';   // design §7: the CADENCE voice is fixed. Randomising
                                // it would add noise to the one part of a trial that
                                // must stay constant.
  var TICK_MS      = 400;   // HUD refresh; the ring must move smoothly, the clock
                            // only has to look alive.

  // change spec §2's direction bands, in cents from the target pitch class.
  // MATCH_CENTS is also the GRADING threshold: design §1 matches on the nearest
  // semitone, so anything further out than half of one is a different note, not a
  // flat one, and the gate must not accept it (change spec §3).
  var MATCH_CENTS   = 50;   // |cents| <= this → '✓ that's it', .ok, gate satisfied
  var NEAR_CENTS    = 150;  // |cents| <= this → .near, the right neighbourhood
  // change spec §3's escape hatch. A drill that can trap a user who cannot match a
  // pitch is worse than one that lets them through, so the answer unlocks after
  // this many unmatched holds on ONE trial. It costs an assist, which is what
  // keeps the end screen honest about how that trial was really answered.
  var MAX_SING_MISS = 3;

  // design §12's DAW-standard virtual-keyboard mapping, plus the digit aliases.
  // Values are PITCH CLASSES above the tonic, which is what every answer path,
  // the CSS's .key[data-deg] positions and EarTheory.DEGREES all agree on.
  var KEY_TO_DEG = {
    a: 0, s: 2, d: 4, f: 5, g: 7, h: 9, j: 11,
    w: 1, e: 3, t: 6, y: 8, u: 10,
    '1': 0, '2': 2, '3': 4, '4': 5, '5': 7, '6': 9, '7': 11
  };
  // The same mapping inverted, for the per-key tooltip. Built once from the table
  // above so the two can never drift apart.
  var DEG_TO_KEY = (function () {
    var m = {}, k;
    for (k in KEY_TO_DEG) if (has(KEY_TO_DEG, k) && k.length === 1 && k >= 'a') m[KEY_TO_DEG[k]] = k.toUpperCase();
    return m;
  })();

  var WHITE = [0, 2, 4, 5, 7, 9, 11];
  var BLACK = [1, 3, 6, 8, 10];
  var IS_BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };

  // design §9 + change spec §4. The preset TABLE lives in ear-theory.js, not here,
  // so the default (`unisex`, F3–F4) has exactly one home: ear-store.js's DEFAULTS
  // and EarTheory.playBand()'s fallback quote the same pair of numbers, and a
  // preset added there shows up in this panel without an edit.
  //
  // `custom` is deliberately NOT in that table — it is not a range, it is the
  // calibration flow — so it is appended here, last, where a "…" entry belongs.
  var CUSTOM_RANGE = { id: 'custom', name: 'Custom — calibrate…', lo: 0, hi: 0 };
  function voiceRanges() {
    var src = EarTheory.VOICE_RANGES || [], out = [], i;
    for (i = 0; i < src.length; i++) out.push(src[i]);
    out.push(CUSTOM_RANGE);
    return out;
  }
  // The human label is the table's own — change spec §4 wants "Everyone (F3–F4)",
  // something a singer recognises, not an id. Both spellings are accepted so the
  // panel cannot end up rendering an id, or an empty option, over a field name.
  function rangeLabel(r) { return r.label || r.name || r.id; }

  var MIN_SPAN = 12, MAX_SPAN = 36;          // design §9's sane clamp. The unisex
                                             // preset is exactly one octave, so
                                             // MIN_SPAN must stay INCLUSIVE here
                                             // and in ear-store.js:245 or the
                                             // default range fails its own
                                             // validation (change spec §4).

  /* ====================== §3 state ====================== */

  var settings = EarStore.settings();
  var sess  = null;      // the live EarSession, or null
  var trial = null;      // the live trial object from sess.next()
  // 'idle' | 'armed' | 'listen' | 'answer' | 'reveal' | 'paused'
  // ARMED covers both halves of the playback (design §4's "context due? → play
  // test note"); `armedStage` says which half so the card can name it.
  var phase = 'idle', armedStage = 'context', resumePhase = 'answer';

  var playSeq = 0, playTimer = 0, audioBusy = false;
  var droneMidi = null;              // the tonic the drone is (or was) holding
  var ctxLabel = '';                 // "B♭ · E♭ · F · B♭", for the ARMED sub-line
  var ticker = 0;
  var singing = false, shiftDown = false;
  // change spec §3: the sing gate opens on a MATCH now, so the trial has to
  // remember whether it was ever cleared (`gatePassed`) and how many holds have
  // missed (`singMiss`, the escape hatch's counter). Both are per-trial and both
  // are reset in beginTrial() — a miss count that survived into the next question
  // would unlock it before the user had sung a note.
  var singMiss = 0, gatePassed = false;
  var levelMoveMsg = '';             // set by auto-advance, shown on the end card
  var keyEls = {};                   // degree pc -> the <button class="key">
  var authUser = null;

  /* ====================== §4 settings <-> controls ====================== */

  // ear-store.js owns the key names and PRESERVES unknown keys, which is what lets
  // `introSeen` live in the same blob instead of needing a second localStorage key.
  function copySettings(s) {
    var o = {}, k;
    for (k in s) if (has(s, k)) o[k] = s[k];
    return o;
  }

  // EarStore's vocabulary is not EarSession's: sessionLimit 'count' is EarSession's
  // length.kind 'questions', `timbre` is `voice`, `labels` is `labelStyle`. The
  // translation lives here, once, rather than being guessed at either end.
  function lengthOf(s) {
    if (s.sessionLimit === 'endless') return { kind: 'endless', value: 0 };
    if (s.sessionLimit === 'count')   return { kind: 'questions', value: s.sessionQ };
    return { kind: 'time', value: s.sessionSec };
  }
  function sessionSettings(s) {
    return {
      level: s.level, mode: s.mode, context: s.context, taper: s.taper,
      singGate: !!s.singGate, spread: s.spread, voice: s.timbre,
      voiceLo: s.voiceLo, voiceHi: s.voiceHi,
      labelStyle: s.labels, length: lengthOf(s)
    };
  }

  // Live reads. During a session the SESSION's normalised values are authoritative,
  // so editing a setting mid-drill can never change the drill under the user; the
  // label style is the one exception because it is pure display.
  function drillMode()   { return sess ? sess.settings().mode : settings.mode; }
  function singGateOn()  { return sess ? !!sess.settings().singGate : !!settings.singGate; }
  function labelStyle()  { return settings.labels; }
  // The voice range the SING TARGET is folded into (change spec §1). Session-first
  // for the same reason as the rest: recalibrating mid-drill must not move the
  // target of a question already on screen.
  function voiceLo()     { return sess ? sess.settings().voiceLo : settings.voiceLo; }
  function voiceHi()     { return sess ? sess.settings().voiceHi : settings.voiceHi; }
  function levelDegrees() {
    var list = sess ? sess.settings().degrees : EarTheory.levelFor(settings.level).degrees;
    var m = {}, i;
    for (i = 0; i < list.length; i++) m[list[i]] = 1;
    return m;
  }

  function fillSelect(sel, items) {
    clear(sel);
    for (var i = 0; i < items.length; i++) {
      var o = document.createElement('option');
      o.value = items[i].value; o.textContent = items[i].label;
      // Optional per-option tooltip. change spec §4 wants the unisex preset to
      // explain itself — that it is the span most people of any voice type can
      // sing, and that Calibrate will fit it to them — and ear-theory.js's table
      // carries that sentence as `hint`.
      if (items[i].title) o.title = items[i].title;
      sel.appendChild(o);
    }
  }

  function buildSettingsOptions() {
    var i, lv, items = [], ranges;
    for (i = 0; i < EarTheory.LEVELS.length; i++) {
      lv = EarTheory.LEVELS[i];
      items.push({ value: String(lv.n), label: 'L' + lv.n + ' · ' + lv.name + ' — ' + lv.degrees.length + ' degrees' });
    }
    fillSelect($('setLevel'), items);

    items = [{ value: 'random', label: 'Random — a different voice each question' }];
    for (i = 0; i < EarAudio.VOICES.length; i++) items.push({ value: EarAudio.VOICES[i], label: EarAudio.VOICES[i] });
    fillSelect($('setTimbre'), items);

    ranges = voiceRanges();
    items = [];
    for (i = 0; i < ranges.length; i++) {
      items.push({ value: ranges[i].id, label: rangeLabel(ranges[i]), title: ranges[i].hint || '' });
    }
    fillSelect($('setRange'), items);
  }

  function lenValue(s) {
    if (s.sessionLimit === 'endless') return 'endless';
    if (s.sessionLimit === 'count')   return 'q' + s.sessionQ;
    return 't' + s.sessionSec;
  }
  // A stored value the <select> has no option for (a hand-edited blob, or a preset
  // we retired) must not leave the control blank — fall back to the 10-minute box.
  function setSelect(sel, value, fallback) {
    sel.value = value;
    if (sel.selectedIndex < 0) sel.value = fallback;
  }

  function fillControls() {
    setSelect($('setLevel'), String(settings.level), '1');
    $('setAuto').checked = !!settings.autoAdvance;
    setSelect($('setMode'), settings.mode, 'identify');
    setSelect($('setContext'), settings.context, 'cadence');
    setSelect($('setTaper'), settings.taper === 0 ? 'session' : String(settings.taper), '4');
    $('setGate').checked = !!settings.singGate;
    setSelect($('setSpread'), String(settings.spread), '1');
    setSelect($('setTimbre'), settings.timbre, 'random');
    setSelect($('setRange'), settings.voiceRange, 'custom');
    setSelect($('setLen'), lenValue(settings), 't600');
    setSelect($('setLabels'), settings.labels, 'numbers');
  }

  function readControls() {
    var s = copySettings(settings), L = $('setLen').value;
    s.level       = parseInt($('setLevel').value, 10);
    s.autoAdvance = $('setAuto').checked;
    s.mode        = $('setMode').value;
    s.context     = $('setContext').value;
    s.taper       = ($('setTaper').value === 'session') ? 0 : parseInt($('setTaper').value, 10);
    s.singGate    = $('setGate').checked ? 1 : 0;
    s.spread      = parseInt($('setSpread').value, 10);
    s.timbre      = $('setTimbre').value;
    s.labels      = $('setLabels').value;
    if (L === 'endless') s.sessionLimit = 'endless';
    else if (L.charAt(0) === 'q') { s.sessionLimit = 'count'; s.sessionQ = parseInt(L.slice(1), 10); }
    else { s.sessionLimit = 'time'; s.sessionSec = parseInt(L.slice(1), 10); }
    return s;
  }

  // The single write path. saveSettings() validates and returns what it actually
  // stored, so `settings` is always the durable truth rather than what we asked for.
  function applySettings(s) {
    settings = EarStore.saveSettings(s);
    fillControls();
    syncMicUi();
    renderAll();
  }

  function wireSettings() {
    // Level owns taper and spread. EarTheory.LEVELS carries the per-level defaults
    // (design §3, §6) and ear-store.js deliberately never reads EarTheory, so
    // copying one in when the level changes is this file's job.
    $('setLevel').onchange = function () {
      var s = readControls(), lv = EarTheory.levelFor(s.level);
      s.taper = lv.taper; s.spread = lv.spread;
      applySettings(s);
      flash('Level ' + lv.n + ' · ' + lv.name);
    };
    $('setRange').onchange = function () {
      var id = $('setRange').value, list = voiceRanges(), r = null, i;
      for (i = 0; i < list.length; i++) if (list[i].id === id) r = list[i];
      if (!r || id === 'custom') { openCal(); return; }   // 'custom' means "measure me"
      var s = readControls();
      s.voiceRange = r.id; s.voiceLo = r.lo; s.voiceHi = r.hi;
      applySettings(s);
    };
    var plain = ['setAuto', 'setMode', 'setContext', 'setTaper', 'setGate',
                 'setSpread', 'setTimbre', 'setLen', 'setLabels'];
    for (var i = 0; i < plain.length; i++) $(plain[i]).onchange = function () { applySettings(readControls()); };

    $('btnCalibrate').onclick = openCal;
    $('btnMic').onclick = function () { requireMic().then(null, function () {}); };
    $('btnSettings').onclick = function () { toggleSettings(); };
  }

  function settingsOpen() { return $('settingsPanel').style.display !== 'none'; }
  function toggleSettings(force) {
    var on = (force == null) ? !settingsOpen() : !!force;
    show($('settingsPanel'), on);
    $('btnSettings').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('btnSettings').classList.toggle('on', on);
  }

  /* ---- microphone availability -------------------------------------------
   * design §11: mic-dependent controls are disabled with a VISIBLE reason, never
   * silently broken. Three distinct states matter and they read differently:
   * unsupported (nothing to try), supported-but-not-granted (a click away), and
   * refused (the reason is worth printing — ear-pitch.js:278 turns the DOMException
   * into a sentence).
   * ---------------------------------------------------------------------- */
  function syncMicUi() {
    var sup = EarPitch.supported(), on = EarPitch.enabled(), err = EarPitch.lastError();
    var btn = $('btnMic');
    btn.disabled = !sup || on;
    btn.textContent = on ? '🎤 Microphone ready' : '🎤 Enable microphone';
    btn.title = sup ? 'Asks once. The stream is kept but stays shut between holds.'
                    : 'This browser has no microphone API.';
    $('micState').textContent = on ? 'push-to-sing armed' : (sup ? 'off' : 'unavailable');

    $('micNote').textContent = !sup
      ? 'This browser has no microphone API, so Produce mode and the sing gate are unavailable. Everything else works.'
      : (err ? err + ' Produce mode and the sing gate need it — Identify mode does not.'
             : (on ? 'Armed. It opens only while you hold the sing control and shuts the moment you let go.'
                   : 'Optional. Needed only for Produce mode, the sing gate and voice-range calibration.'));

    // Disable the option rather than the whole <select>: disabling the control
    // would trap a user who had already chosen Produce with no way back.
    var prod = $('setMode').options[1];
    prod.disabled = !sup;
    prod.title = sup ? '' : 'No microphone API in this browser.';
    $('setGate').disabled = !sup;
    $('setGate').title = sup ? '' : 'No microphone API in this browser.';
    $('btnCalibrate').disabled = !sup;

    // A stored setting that this browser cannot honour is corrected rather than
    // left to fail at the first question — and it says so out loud.
    if (!sup && (settings.mode === 'produce' || settings.singGate)) {
      var s = copySettings(settings);
      s.mode = 'identify'; s.singGate = 0;
      settings = EarStore.saveSettings(s);
      fillControls();
      flash('No microphone in this browser — switched to Identify mode.');
    }
  }

  // Always call from inside a user gesture: getUserMedia and the AudioContext both
  // depend on one (ear-pitch.js:301 builds its context synchronously for exactly
  // this reason). Rejects with the raw error; every caller handles it.
  function requireMic() {
    if (EarPitch.enabled()) return Promise.resolve(true);
    if (!EarPitch.supported()) { syncMicUi(); return Promise.reject(new Error('unsupported')); }
    return EarPitch.enable().then(function () {
      syncMicUi(); renderActions();
      flash('Microphone ready — it opens only while you hold the sing control.');
      return true;
    }, function (err) {
      syncMicUi(); renderActions();
      flash(EarPitch.lastError() || 'The microphone could not be opened.');
      throw err;
    });
  }

  /* ====================== §5 the degree keyboard ====================== */

  // Built once. Whites are flex children of .kb; blacks are absolutely positioned
  // by learn.css off their data-deg, so DOM order between the two groups is free —
  // blacks go last only so they paint over the whites' rounded corners.
  function buildKeys() {
    var kb = $('kb'), i;
    clear(kb); keyEls = {};
    for (i = 0; i < WHITE.length; i++) kb.appendChild(makeKey(WHITE[i], 'white'));
    for (i = 0; i < BLACK.length; i++) kb.appendChild(makeKey(BLACK[i], 'black'));
  }
  function makeKey(deg, kind) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'key ' + kind;
    // MUST be the pitch class: learn.css keys the five black-key positions off the
    // literal values 1 3 6 8 10, and any other encoding stacks all five together.
    b.setAttribute('data-deg', String(deg));
    b.onclick = function () { commit(deg); };
    keyEls[deg] = b;
    return b;
  }

  // One pass paints labels, the lit/dim level ladder, the enabled state and the
  // reveal marks together, because they are all functions of (phase, trial, level)
  // and splitting them is how a stale .picked survives into the next question.
  function renderKeys() {
    var live = levelDegrees(), produce = (drillMode() === 'produce');
    var answering = (phase === 'answer'), d, b, cls;
    for (d = 0; d < 12; d++) {
      b = keyEls[d]; if (!b) continue;
      b.textContent = EarTheory.label(d, labelStyle());
      cls = 'key ' + (IS_BLACK[d] ? 'black' : 'white') + (live[d] ? ' lit' : ' dim');
      if (trial && d === trial.degree) {
        // In REVEAL the ring is the answer. In produce mode it is the PROMPT —
        // the same "this one" signal, one phase earlier, because there the user
        // is being asked to sing it rather than to find it.
        if (phase === 'reveal' || (answering && produce)) cls += ' target';
      }
      if (trial && phase === 'reveal' && trial.answered === d) {
        cls += ' picked ' + (trial.correct ? 'correct' : 'wrong');
      }
      b.className = cls;
      // Produce mode commits with the voice, so the keyboard there is a display,
      // not a control.
      b.disabled = !(live[d] && answering && !produce);
      b.title = EarTheory.label(d, 'both') + (DEG_TO_KEY[d] ? '  ·  key ' + DEG_TO_KEY[d] : '') +
                (live[d] ? '' : '  ·  not in level ' + (sess ? sess.settings().level : settings.level));
    }
  }

  /* ====================== §6 rendering ====================== */

  function setStage(line, sub) {
    $('stateLine').textContent = line;
    $('stateSub').textContent = sub || '';
  }

  function renderStageKey() {
    $('keyLabel').textContent = trial ? EarTheory.keyLabel(trial.tonicPc, trial.mode) : '—';
  }

  function renderStage() {
    var lv, cents;
    if (!sess || !trial) {
      lv = EarTheory.levelFor(settings.level);
      setStage('Name the note against the key.',
               'Level ' + lv.n + ' · ' + lv.name + ' — ' + degreeList(lv.degrees) +
               '. Press Start, or open ⚙ to change the drill.');
      return;
    }
    if (phase === 'paused') {
      setStage('Paused', 'Press Esc or Resume to carry on. The clock is stopped.');
      return;
    }
    if (phase === 'armed') {
      if (armedStage === 'context') {
        setStage(trial.context === 'drone' ? 'Tonic drone…' : 'Setting the key…',
                 ctxLabel ? ctxLabel + '  in ' + EarTheory.keyLabel(trial.tonicPc, trial.mode) : '');
      } else {
        setStage('Listen…', 'Question ' + trial.n + ' — hold the tonic in your head.');
      }
      return;
    }
    if (phase === 'listen') {
      // change spec §5: an instruction, not an invitation, and it no longer
      // promises that any steady pitch unlocks the keyboard — since change spec §3
      // the gate wants the RIGHT pitch, and copy that says otherwise reads as a
      // bug the first time a wrong note is refused. index.html:105's legend still
      // teaches the Shift equivalent, so the sub-line does not repeat it.
      setStage('Sing that note.',
               'Hold the sing control and match the pitch you just heard.');
      return;
    }
    if (phase === 'answer') {
      if (drillMode() === 'produce') {
        setStage('Sing the ' + EarTheory.label(trial.degree, labelStyle()),
                 'of ' + EarTheory.keyLabel(trial.tonicPc, trial.mode) +
                 ' — hold the sing control and let go when the needle settles.');
      } else {
        setStage('Which degree?', 'Tap a key, or use the keyboard. Committing is what makes this work — guess rather than replay.');
      }
      return;
    }
    if (phase === 'reveal') {
      var sub = EarTheory.noteName(trial.midi, trial.tonicPc, trial.mode) +
                ' · ' + EarTheory.keyLabel(trial.tonicPc, trial.mode);
      if (!trial.correct && trial.answered != null) {
        sub += ' — you said ' + EarTheory.label(trial.answered, labelStyle());
      }
      cents = trial.cents;
      if (cents != null) sub += ' · sung ' + (cents > 0 ? '+' : '') + cents + '¢';
      setStage(EarTheory.label(trial.degree, labelStyle()) + (trial.correct ? '  ✓' : '  ✗'), sub);
    }
  }

  function degreeList(degs) {
    var out = [], i;
    for (i = 0; i < degs.length; i++) out.push(EarTheory.label(degs[i], 'numbers'));
    return out.join(' ');
  }

  // Three roles for one control, because a mic button that is simply disabled when
  // permission has not been asked for yet is a dead end the user cannot see past.
  function singRole() {
    if (!EarPitch.supported()) return 'none';
    if (!EarPitch.enabled())   return 'enable';
    return 'sing';
  }

  function renderActions() {
    var running = !!sess, role = singRole();
    var live = (phase === 'listen' || phase === 'answer');
    var canSing = (role === 'sing') && live && !audioBusy;

    show($('btnStart'), !running);
    $('btnStart').disabled = false;

    show($('btnAgain'), running);
    $('btnAgain').disabled = !running || audioBusy || phase === 'paused' || phase === 'armed';
    $('btnAgain').textContent = (trial && trial.assists) ? '♪ Hear it again (' + trial.assists + ')' : '♪ Hear it again';

    var sing = $('btnSing');
    show(sing, true);
    sing.disabled = (role === 'none') || (role === 'sing' && !canSing);
    sing.textContent = role === 'sing'
      ? (singing ? 'Listening…' : '🎤 Hold to sing')
      : '🎤 Enable microphone';
    sing.title = role === 'none' ? 'This browser has no microphone API.'
      : role === 'enable' ? 'Turn the microphone on — it stays shut between holds.'
      : audioBusy ? 'Wait for the tone to finish — the mic never opens while the app is playing.'
      : live ? 'Hold and sing. Let go to lock the pitch in.'
      : 'Available while a question is on screen.';
    if (!singing) sing.classList.remove('holding');

    show($('btnNext'), running);
    $('btnNext').disabled = (phase !== 'reveal');
    $('btnNext').textContent = (sess && sess.done()) ? 'Finish ▸' : 'Next ▸';

    show($('btnPause'), running);
    $('btnPause').textContent = (phase === 'paused') ? '▶ Resume' : '❚❚ Pause';

    show($('btnEnd'), running);
  }

  function renderHud() {
    var st = sess ? sess.stats() : null;
    var pct = 0;
    $('hudTime').textContent = fmt(st ? st.elapsed : 0);
    $('hudQ').textContent = st ? (st.questions + (st.targetQuestions ? '/' + st.targetQuestions : '')) : '0';
    $('hudAcc').textContent = (st && st.questions) ? Math.round(st.accuracy * 100) + '%' : '—';
    $('hudAssist').textContent = st ? st.assists : 0;
    if (st) {
      if (st.targetSec) pct = st.elapsed / st.targetSec;
      else if (st.targetQuestions) pct = st.questions / st.targetQuestions;
    }
    // Same inline --p idiom as studio.css:93 .jobbar, so the product has one
    // progress convention rather than two.
    $('ring').style.setProperty('--p', Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%');
  }

  function renderStreak() {
    var st = EarStore.stats();
    $('hudStreak').textContent = st.streak;
    $('ring').title = 'Session progress · ' + st.todayMin + ' min today · ' + st.streak + ' day streak';
  }

  function renderAll() {
    renderStageKey(); renderStage(); renderActions(); renderKeys(); renderHud();
  }

  /* ====================== §7 playback ====================== */

  // Anything that invalidates a scheduled continuation bumps playSeq, so a
  // setTimeout that survives cannot drive a state machine that has moved on.
  function bumpSeq() {
    playSeq++;
    if (playTimer) { clearTimeout(playTimer); playTimer = 0; }
  }
  function beginPlayback() { bumpSeq(); audioBusy = true; return playSeq; }

  // Stop whatever tone is sounding but KEEP the drone. EarAudio has no partial
  // stop — stopAll() takes the drone with it (ear-audio.js:515) — so the drone is
  // re-established afterwards, and only when something was actually playing. That
  // condition is the point: in a drone session every trial would otherwise fade
  // the tonic out and back in, and the whole modality is a reference that never
  // goes away.
  function haltPlayback() {
    bumpSeq();
    if (!audioBusy) return;
    EarAudio.stopAll();
    audioBusy = false;
    ensureDrone();
  }
  // Full stop, drone included. Used when the drill itself is stopping.
  function cancelPlayback() {
    bumpSeq();
    EarAudio.stopAll();
    audioBusy = false;
  }
  // startDrone() is a no-op when the same tonic is already sounding (ear-audio.js:453),
  // so this is safe to call on every trial and after every stopAll().
  function ensureDrone() { if (droneMidi != null) EarAudio.startDrone(droneMidi); }

  function playContextNow(t, seq, done) {
    var chords = EarTheory.cadence(t.context, t.tonicPc, t.mode);
    if (t.context === 'drone') {
      // cadence('drone') returns exactly one entry with a SINGLE midi, so this
      // goes straight to startDrone rather than through playCadence.
      droneMidi = chords[0].midis[0];
      ctxLabel = 'drone on ' + chords[0].name;
      EarAudio.startDrone(droneMidi);
      renderStage();
      playTimer = setTimeout(function () { if (seq === playSeq) done(); }, DRONE_SETTLE * 1000);
      return;
    }
    var names = [], i;
    for (i = 0; i < chords.length; i++) names.push(chords[i].name);
    ctxLabel = names.join(' · ');
    renderStage();
    // playCadence ALWAYS resolves — including with no Web Audio at all and when
    // stopAll() interrupts it — so there is no hang path here to defend against.
    EarAudio.playCadence(chords, CAD_VOICE, CAD_BPM).then(function () {
      if (seq === playSeq) done();
    });
  }

  function playNoteNow(midi, voice, dur, lead, seq, done) {
    EarAudio.note(midi, voice, EarAudio.now() + lead, dur, 1);
    playTimer = setTimeout(function () { if (seq === playSeq) done(); }, (lead + dur) * 1000);
  }

  /* ====================== §8 the trial state machine ====================== */
  /* design §4:
   *   IDLE ─start→ ARMED ─(context due?)→ ─test note→ LISTEN
   *   LISTEN ─(gate satisfied, or gate off)→ ANSWERABLE ─commit→ REVEAL ─next→ ARMED
   */

  function startSession() {
    EarAudio.unlock();                  // MUST be inside the gesture that got us here
    var needMic = (settings.mode === 'produce') || !!settings.singGate;
    if (needMic && !EarPitch.enabled()) {
      requireMic().then(openSession, function () {
        flash('This drill needs the microphone. Set the drill to Identify and turn the sing gate off to practise without it.');
        toggleSettings(true);
      });
      return;
    }
    openSession();
  }

  function openSession() {
    // Re-read rather than trusting the in-memory copy: another tab may have saved
    // settings since this page loaded, and ear-store.js re-validates on every read.
    settings = EarStore.settings();
    try {
      // Math.random is injected rather than reached for inside the modules, which
      // is what makes a whole session reproducible from a seeded test harness.
      sess = EarSession.create(sessionSettings(settings), Math.random);
    } catch (e) {
      flash('Could not start the session: ' + (e && e.message ? e.message : 'unknown error'));
      return;
    }
    trial = null; droneMidi = null; ctxLabel = ''; levelMoveMsg = '';
    toggleSettings(false);
    startTicker();
    beginTrial();
  }

  function beginTrial() {
    haltPlayback();
    showTuner(false);
    try { trial = sess.next(); }
    catch (e) { flash('The question generator failed — ending the session.'); finishSession(); return; }
    // change spec §3: both gate counters are per-TRIAL. Resetting them here, at
    // the one place a new question is drawn, is what keeps the escape hatch from
    // carrying three old misses into a question the user has not heard yet.
    singMiss = 0; gatePassed = false;
    phase = 'armed'; armedStage = 'context';
    if (!trial.playContext) ctxLabel = '';
    renderAll();
    presentTrial();
  }

  // Plays the current trial from the top. Split out from beginTrial() because
  // resuming from a pause has to replay it WITHOUT drawing a new question.
  function presentTrial() {
    var seq = beginPlayback(), t = trial;
    renderActions();

    var afterContext = function () {
      if (seq !== playSeq) return;
      // Produce mode names the degree instead of playing it, so there is no test
      // note at all — playing one would hand over the answer.
      if (drillMode() === 'produce') { audioBusy = false; toAnswerable(); return; }
      armedStage = 'note';
      renderStage();
      playNoteNow(t.midi, t.voice, NOTE_SEC, GAP_SEC, seq, function () {
        audioBusy = false;
        toAnswerable();
      });
    };

    if (t.playContext) playContextNow(t, seq, afterContext);
    else { ensureDrone(); afterContext(); }     // a drone survives between trials
  }

  function toAnswerable() {
    // The gate is skipped when the mic is not actually available: a stored
    // singGate must never be able to make a trial unanswerable.
    //
    // The "already sung" test is `gatePassed`, NOT `trial.cents != null` as it was
    // before change spec §3. Those two came apart the moment a match was required:
    // an unmatched hold still records its signed deviation on the trial (the
    // intonation stat wants every error, handleSung() below), so cents alone would
    // now hand the keyboard to a user who sang the wrong note.
    if (drillMode() === 'identify' && singGateOn() && EarPitch.enabled() && !gatePassed) {
      phase = 'listen';
    } else {
      phase = 'answer';
      sess.ready();          // design §8's response clock starts HERE, not at next()
    }
    renderAll();
  }

  function commit(deg) {
    if (!sess || !trial || phase !== 'answer') return;
    if (drillMode() === 'produce') return;      // the voice is the commit there
    var res = sess.answer(deg);                 // idempotent (ear-session.js:296)
    if (res) enterReveal(res);
  }

  function enterReveal(res) {
    endSing();
    haltPlayback();                // cuts a replay the user answered through
    phase = 'reveal';
    renderAll();
    showTuner(false);
    // A corrective replay, not a habit: after a MISS the note has to be heard
    // again against the key or the trial taught nothing, and in produce mode this
    // is the first time the target is ever sounded. A correct identify answer gets
    // silence — the user just heard it and does not need telling twice.
    if (!res.correct || drillMode() === 'produce') {
      var seq = beginPlayback();
      playNoteNow(trial.midi, trial.voice, REVEAL_SEC, LEAD_SEC, seq, function () {
        audioBusy = false; renderActions();
      });
      renderActions();
    }
  }

  function nextTrial() {
    if (!sess || phase !== 'reveal') return;
    if (sess.done()) { finishSession(); return; }
    beginTrial();
  }

  // design §4: the escape hatch is available but COUNTED. ear-session.js:326 makes
  // it free once the trial is answered, so this can call assist() unconditionally.
  function replay() {
    if (!sess || !trial || audioBusy) return;
    if (phase !== 'listen' && phase !== 'answer' && phase !== 'reveal') return;
    endSing();
    sess.assist();
    var seq = beginPlayback();
    if (drillMode() === 'produce' && phase !== 'reveal') {
      // Replaying the target in produce mode would BE the answer, so the escape
      // hatch there re-establishes the key instead.
      playContextNow(trial, seq, function () { audioBusy = false; renderActions(); });
    } else {
      playNoteNow(trial.midi, trial.voice, NOTE_SEC, LEAD_SEC, seq, function () {
        audioBusy = false; renderActions();
      });
    }
    renderActions();
    renderHud();
  }

  function togglePause() {
    if (!sess) return;
    if (phase === 'paused') {
      sess.resume();
      phase = resumePhase;
      bumpSeq();
      // Resuming mid-ARMED replays the trial from the top rather than picking up
      // half a cadence: presentTrial() does not draw a new question, and ready()
      // is first-call-wins, so the response clock still starts in the right place.
      if (phase === 'armed') { renderAll(); presentTrial(); return; }
      ensureDrone();
      renderAll();
      return;
    }
    // endSing() BEFORE the phase is captured: releasing the hold can commit an
    // answer in produce mode, and resumePhase must record where that left us,
    // not where we were a moment earlier.
    endSing();
    resumePhase = phase;
    sess.pause();
    cancelPlayback();
    showTuner(false);
    phase = 'paused';
    renderAll();
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(function () {
      if (!sess) { stopTicker(); return; }
      renderHud();
      // The Next button turns into Finish the moment the box is full, so the user
      // is never surprised by the summary appearing.
      if (phase === 'reveal') $('btnNext').textContent = sess.done() ? 'Finish ▸' : 'Next ▸';
    }, TICK_MS);
  }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = 0; } }

  /* ====================== §9 push-to-sing ====================== */
  /* design §11: the mic is live ONLY while the control is held, and the control is
   * disabled while ear-audio.js is playing — that is what makes the feedback loop
   * structurally impossible rather than merely defended against. ear-pitch.js owns
   * the latch guards on blur / pagehide / pointercancel / visibilitychange; this
   * layer only has to keep the UI in step with them.
   */

  function showTuner(on) {
    show($('tuner'), on);
    if (!on) tunerClass('');
  }

  // .ok and .near are mutually exclusive and learn.css hangs both off #tuner, so
  // they are always written together — a stale .near left under a fresh .ok is the
  // one combination that would paint the readout two colours at once. Note that
  // .ok has CHANGED MEANING with change spec §2: it used to be ear-pitch.js's
  // stability lock, and it is now "you are on the note". The lock itself did not
  // go anywhere — it is still what endHold() hands back — but the state worth
  // colouring is the one the gate turns on.
  function tunerClass(cls) {
    var t = $('tuner');
    t.classList.toggle('ok', cls === 'ok');
    t.classList.toggle('near', cls === 'near');
  }

  function startSing() {
    if (singing) return;
    if (singRole() !== 'sing') return;
    if (audioBusy) return;
    if (phase !== 'listen' && phase !== 'answer') return;
    if (!EarPitch.beginHold(onSingFrame)) return;
    singing = true;
    $('btnSing').classList.add('holding');
    $('tunerNote').textContent = '—';
    $('tunerCents').textContent = 'sing…';     // change spec §5: unchanged wording
    $('tunerNeedle').style.left = '50%';
    tunerClass('');                            // a match from the PREVIOUS hold must
                                               // not still be lit when this one opens
    showTuner(true);
    renderActions();
  }

  function endSing() {
    if (!singing) return;
    singing = false;
    $('btnSing').classList.remove('holding');
    // endHold() is idempotent and returns the same value twice, which is what lets
    // pointerup, lostpointercapture, keyup and window blur all be wired straight
    // to it without coordinating.
    handleSung(EarPitch.endHold());
    renderActions();
  }

  function onSingFrame(f) {
    if (f.midi == null) {
      // Nothing to point at, so the direction slot holds the same em dash
      // startSing() opens with rather than a stale instruction (change spec §2).
      $('tunerNote').textContent = '—';
      $('tunerCents').textContent = f.rms < EarPitch.RMS_MIN ? 'louder' : 'steady…';
      $('tunerNeedle').style.left = '50%';
      tunerClass('');
      return;
    }
    renderDirection(centsToTarget(f));
  }

  /* ---- the direction readout ----------------------------------------------
   * change spec §0 and §2. What used to be here was EarTheory.noteName() of the
   * pitch the user had just sung — and the stage header shows the key, so a name
   * plus one subtraction IS the degree, with no ear involved anywhere. That is
   * the leak this readout replaces, and it is why nothing below ever renders a
   * note name, a solfège syllable or a degree. The name comes back at REVEAL
   * (renderStage() above), where the answer is already committed and naming it is
   * the whole point of the study phase.
   *
   * Telling the user they are ON the note leaks nothing: matching a pitch by ear
   * says nothing about that pitch's FUNCTION in the key, and the function is the
   * only thing being drilled.
   *
   * SIGN CONVENTION — an inverted needle is the single most noticeable bug this
   * file could ship, so it is spelled out here rather than left to be re-derived:
   *
   *     cents > 0  →  the singer is SHARP, above the target  →  "▼ lower"
   *     cents < 0  →  the singer is FLAT,  below the target  →  "▲ higher"
   *
   * centsFromPc() produces exactly that sign (a voice a quarter-tone above the
   * target reads +50), and the needle inherits it: 50 + cents puts a sharp singer
   * to the RIGHT of centre, like every hardware tuner ever built.
   * ---------------------------------------------------------------------- */
  function renderDirection(cents) {
    var mag = Math.abs(cents), sharp = (cents > 0), word, coach, cls;
    if (mag <= MATCH_CENTS) {
      word = '✓ that\'s it'; coach = 'hold it';   cls = 'ok';
    } else if (mag <= NEAR_CENTS) {
      word = sharp ? '▼ lower' : '▲ higher'; coach = 'almost';     cls = 'near';
    } else {
      word = sharp ? '▼ lower' : '▲ higher'; coach = 'keep going'; cls = '';
    }
    $('tunerNote').textContent  = word;
    $('tunerCents').textContent = coach;
    // Unchanged geometry: learn.css translateX(-50%) makes this percentage the
    // needle's CENTRE, so 50% is matched and ±50 cents reaches the ends of the
    // bar. Cents now run to ±600 (a tritone away is the worst case), so the clamp
    // that used to be belt-and-braces is what pins the needle to an end.
    $('tunerNeedle').style.left = Math.max(0, Math.min(100, 50 + cents)) + '%';
    tunerClass(cls);
  }

  // The pitch class the user is being asked to SING. The PLAYED note keeps its
  // random register — that is level 4+'s whole point — while the sung target is
  // that note's pitch class folded into the singer's own range (change spec §1),
  // because male and female comfortable ranges sit about an octave apart.
  //
  // Every comparison in this file is mod 12 (design §1: degrees are
  // octave-invariant, so an octave displacement must be ACCEPTED, not punished),
  // which is what makes the fallback exact rather than approximate: an
  // ear-theory.js without singTarget() leaves the played note itself, and the
  // played note is already an instance of the right pitch class.
  function singTargetPc() {
    if (!trial) return 0;
    if (typeof EarTheory.singTarget === 'function') {
      return norm12(EarTheory.singTarget(trial.midi, voiceLo(), voiceHi()));
    }
    return norm12(trial.midi);
  }

  // The ONE cents path: both the live readout and the gate grade through this, so
  // there is no second convention to get out of step with the first. `got` is any
  // {midi, cents} — an onSingFrame frame or endHold()'s accepted pitch.
  function centsToTarget(got) {
    return centsFromPc(got.midi + got.cents / 100, singTargetPc());
  }

  // Signed cents from the NEAREST instance of pitch class `pc`, folded to ±600 —
  // which is exactly what change spec §2 wants the direction computed against, an
  // octave displacement reading as zero error rather than 1200.
  //
  // design §11 asks for the deviation from the TARGET, reported "regardless" of
  // whether the pitch class came out right, so a wrong note honestly contributes
  // its whole error to the intonation stat instead of a flattering near-zero.
  function centsFromPc(contMidi, pc) {
    var d = (contMidi - pc) % 12;
    if (d < 0) d += 12;
    if (d > 6) d -= 12;
    return Math.round(d * 100);
  }

  function handleSung(got) {
    if (!sess || !trial) { showTuner(false); return; }
    if (!got) {
      // A hold that produced no usable pitch is not an ATTEMPT — the user never
      // offered a note to match — so it deliberately does not spend one of the
      // escape hatch's three. It also cannot trap anyone the old gate would not
      // have trapped: that one needed a steady pitch too.
      $('tunerCents').textContent = 'no pitch';
      tunerClass('');
      flash('No steady pitch caught — hold a little longer and sing straight through.');
      return;
    }
    var cents = centsToTarget(got);
    // ALWAYS, and with the sign and the full magnitude intact, matched or not
    // (change spec §3): clamping a miss towards zero would flatter the intonation
    // stat with an error the singer never actually sang.
    sess.singResult(cents);
    // Repaint from the ACCEPTED pitch rather than leaving whatever the last rAF
    // frame happened to catch on screen — that is the reading the gate just judged.
    renderDirection(cents);

    if (drillMode() === 'produce') {
      // Degrees are octave-invariant (design §1), so the sung OCTAVE is free and
      // only the pitch class decides the answer.
      var res = sess.answer(norm12(got.pc - trial.tonicPc));
      if (res) { enterReveal(res); return; }
    }
    if (phase === 'listen') {
      // THE GATE NEEDS A MATCH (change spec §3). It used to open on any steady
      // pitch, and the comment here used to explain that a correct pitch must not
      // be required "or the gate becomes the answer". That reasoning was sound
      // while the tuner NAMED what was sung — the readout would have spelled the
      // degree out. It is gone with the name (change spec §0): the readout now
      // says only higher/lower/that's it, which tells the user nothing about the
      // note's function in the key, so demanding a real match costs no secret and
      // buys the thing the gate was for — that the note was actually heard.
      if (Math.abs(cents) <= MATCH_CENTS) { openGate(); return; }
      singMiss++;
      if (singMiss >= MAX_SING_MISS) {
        // The escape hatch. Charged as one assist, exactly like "Hear it again",
        // so a session that was ground through this way still reads as one on the
        // end card instead of looking like clean work.
        sess.assist();
        flash('Moving on — that one is hard to match.');
        openGate();
        return;
      }
      flash('Not that one — listen again and match the pitch.');
      return;
    }
    renderStage();
  }

  // The one way out of LISTEN. renderAll() rather than renderStage() because the
  // keyboard has just become live, ▸ Next has not, and the escape hatch may have
  // moved the assist count on the HUD.
  function openGate() {
    gatePassed = true;
    phase = 'answer';
    sess.ready();          // design §8's response clock, at the instant the trial
                           // actually became answerable
    renderAll();
  }

  function wireSing() {
    var b = $('btnSing');
    b.addEventListener('pointerdown', function (e) {
      if (b.disabled || singRole() !== 'sing') return;
      // Capture the pointer so a release that drifts off the button still lands
      // here. ear-pitch.js deliberately installs no global pointerup — a Shift
      // hold has to survive a click elsewhere — so this is ours to get right.
      try { b.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
      startSing();
    });
    b.addEventListener('pointerup', endSing);
    b.addEventListener('pointercancel', endSing);
    b.addEventListener('lostpointercapture', endSing);
    b.addEventListener('click', function () {
      if (singRole() === 'enable') requireMic().then(null, function () {});
    });
    // ear-pitch.js already shuts the mic on blur; this only re-syncs the UI, and
    // both firing is harmless because endHold() is idempotent.
    window.addEventListener('blur', function () { shiftDown = false; endSing(); calEnd(); });
  }

  /* ====================== §10 end of session ====================== */

  function finishSession() {
    if (!sess) return;
    endSing();
    cancelPlayback();
    stopTicker();
    droneMidi = null;
    var rec = sess.finish();
    // Durable BEFORE the network (design §13). add() returns the record actually
    // stored — read `started` back from it, it may have been bumped past a
    // same-second collision — and fires the cloud POST in the background.
    //
    // A session with no answered question is not practice: it is a Start the user
    // immediately backed out of. Storing it would put a 0/0 row in the history and
    // a row on the server for nothing, so the summary is still shown (they asked
    // for it) but nothing is written.
    var stored = (rec.questions > 0) ? (EarStore.add(rec) || rec) : rec;
    sess = null; trial = null; phase = 'idle';
    applyAutoAdvance(stored);
    renderAll(); renderStreak();
    showEnd(stored);
  }

  // design §8's promotion rule is deliberately STRICTER than the on-screen verdict
  // band, because this one moves the user's saved level. EarSession.autoAdvance()
  // owns it, including the ≥15-question floor and the L1/L7 clamps.
  function applyAutoAdvance(rec) {
    levelMoveMsg = '';
    if (!settings.autoAdvance) return;
    var a = EarSession.autoAdvance(rec);
    if (!a.moved) return;
    var lv = EarTheory.levelFor(a.level), s = copySettings(settings);
    s.level = a.level; s.taper = lv.taper; s.spread = lv.spread;
    settings = EarStore.saveSettings(s);
    fillControls();
    levelMoveMsg = (a.moved === 'up' ? 'Level up → ' : 'Dropped to ') +
                   'L' + lv.n + ' · ' + lv.name + '. Change it any time under ⚙.';
  }

  function statTile(value, label) {
    var d = mk('div', 'end-stat');
    d.appendChild(mk('b', null, value));
    d.appendChild(mk('span', null, label));
    return d;
  }
  function band(acc) { return acc < 0.70 ? ' low' : (acc <= 0.90 ? ' med' : ' good'); }

  function showEnd(rec) {
    var sum = EarSession.summarize(rec);
    var v = EarSession.verdict(sum.accuracy, rec.level);
    var pct = Math.round(sum.accuracy * 100);

    var vEl = $('endVerdict');
    // low | in | high are EarSession.verdict's own band names and learn.css styles
    // all three; `high` is --med, not --good, because "too easy" is a correction.
    // With nothing answered there is no band to be in — an unclassified line is
    // honest, "below the training band" would not be.
    vEl.className = 'end-verdict' + (rec.questions ? ' ' + v.band : '');
    vEl.textContent = rec.questions ? pct + '% — ' + v.text
                                    : 'No questions answered — nothing recorded.';

    show($('endLevelMove'), !!levelMoveMsg);
    $('endLevelMove').textContent = levelMoveMsg;

    var stats = $('endStats');
    clear(stats);
    stats.appendChild(statTile(rec.correct + '/' + rec.questions, 'correct'));
    stats.appendChild(statTile(fmt(rec.durationSec), 'practised'));
    stats.appendChild(statTile('L' + rec.level, rec.mode));
    stats.appendChild(statTile(String(rec.assists), 'assists'));
    if (sum.medianMs != null) stats.appendChild(statTile((sum.medianMs / 1000).toFixed(1) + 's', 'median reply'));
    // Only when the mic was actually used — summarize() returns null otherwise, so
    // the row is hidden rather than printing a meaningless 0.
    if (sum.meanCents != null) stats.appendChild(statTile('±' + Math.round(sum.meanCents) + '¢', 'mean pitch error'));

    var degs = $('endDegrees'), i, p, row, bar;
    clear(degs);
    for (i = 0; i < sum.perDegree.length; i++) {
      p = sum.perDegree[i];
      row = mk('div', 'deg-row' + band(p.accuracy));
      row.appendChild(mk('span', 'deg-name', EarTheory.label(p.deg, labelStyle())));
      bar = mk('div', 'deg-bar');
      bar.style.setProperty('--p', Math.round(p.accuracy * 100) + '%');
      bar.appendChild(document.createElement('i'));
      row.appendChild(bar);
      row.appendChild(mk('span', null, p.correct + '/' + p.asked));
      degs.appendChild(row);
    }
    show($('endDegHead'), sum.perDegree.length > 0);
    show(degs, sum.perDegree.length > 0);

    // design §8: "♭7 called 6 — 4 times" is the single most actionable output of
    // the app, which is why ear-session keeps ORDERED pairs rather than misses.
    var conf = $('endConfusions'), c, li;
    clear(conf);
    for (i = 0; i < sum.confusions.length && i < 6; i++) {
      c = sum.confusions[i];
      li = document.createElement('li');
      li.appendChild(mk('b', null, EarTheory.label(c.target, labelStyle())));
      li.appendChild(document.createTextNode(' heard as '));
      li.appendChild(mk('b', null, EarTheory.label(c.answered, labelStyle())));
      li.appendChild(document.createTextNode(' — ' + c.n + (c.n === 1 ? ' time' : ' times')));
      conf.appendChild(li);
    }
    show($('endConfHead'), sum.confusions.length > 0);
    show(conf, sum.confusions.length > 0);

    // design §8's daily encouragement: one line, no gamified noise. todayMin is
    // floored by ear-store.js:536 on purpose — 9:40 rounded up to "10 min" would
    // tell the user they were finished when they were not.
    var st = EarStore.stats();
    $('endStreak').textContent =
      st.todayMin + ' min today' + (st.todayMin >= 10 ? ' — the daily goal is met.' : ' of a 10-minute goal.') +
      '  Day streak ' + st.streak + (st.streak === 1 ? ' day.' : ' days.') +
      '  ' + st.totalSessions + (st.totalSessions === 1 ? ' session' : ' sessions') + ' all told.';

    show($('endOverlay'), true);
  }

  function closeEnd() { show($('endOverlay'), false); renderAll(); }

  /* ====================== §11 voice-range calibration ====================== */
  /* design §9: "sing your lowest comfortable note" → hold → "sing your highest" →
   * store, clamped to a sane 12–36 semitone span, with a retry when detection
   * fails. A failed reading here is usually an octave error on a very low note, and
   * a 3-semitone "range" would leave the play band nonsense, so it is rejected
   * rather than clamped up.
   */
  var cal = { step: 0, lo: null, hi: null, holding: false };

  function calOpen()  { return $('calOverlay').style.display !== 'none'; }

  /* Calibration PAUSES a running drill first, for two independent reasons.
   *
   * The behavioural one: calibrating rewrites settings.voiceLo/voiceHi, and
   * EarTheory.singTarget() folds every sung target into that band — so
   * re-measuring mid-session would move the targets under a session already
   * scoring against the old ones, and the intonation stat would silently mix
   * two different drills.
   *
   * The integrity one: this overlay is the ONE place that still names a sung
   * pitch (learn.js:1299, and naming is its whole job — you cannot report a
   * measured range without note names). Left reachable mid-trial it would be a
   * lookup table for the very leak change spec §0 closed: sing the test note,
   * open Calibrate, sing it again, read the name, subtract the displayed tonic.
   * Pausing shuts that path without crippling calibration itself. */
  function openCal() {
    if (!EarPitch.supported()) {
      flash('No microphone API in this browser, so the range cannot be measured. Pick a preset instead.');
      fillControls();
      return;
    }
    if (sess && phase !== 'paused') togglePause();
    requireMic().then(function () {
      cal.step = 1; cal.lo = null; cal.hi = null;
      renderCal('');
      show($('calOverlay'), true);
    }, function () {
      fillControls();                 // the select snaps back to the stored preset
    });
  }

  function closeCal() {
    calEnd();
    show($('calOverlay'), false);
    fillControls();
    renderAll();
  }

  function renderCal(result) {
    $('calLine').textContent = cal.step === 1 ? 'Sing your lowest comfortable note'
                                              : 'Now sing your highest comfortable note';
    $('calSub').textContent = cal.step === 1
      ? 'Hold the button and sing — an easy note you could hold all day, not the lowest you can force.'
      : 'Same again at the top. Comfortable, not strained: this only decides where the test notes sit.';
    $('calResult').textContent = result || '';
    $('calNote').textContent = '—';
    $('calCents').textContent = 'hold and sing';
    $('calNeedle').style.left = '50%';
    $('calTuner').classList.remove('ok');
  }

  function calStart() {
    if (cal.holding || !calOpen()) return;
    if (!EarPitch.beginHold(onCalFrame)) return;
    cal.holding = true;
    $('calHold').classList.add('holding');
    $('calCents').textContent = 'sing…';
  }

  function calEnd() {
    if (!cal.holding) return;
    cal.holding = false;
    $('calHold').classList.remove('holding');
    var got = EarPitch.endHold();
    if (!got) { renderCal('No steady pitch caught — hold a little longer and try again.'); return; }
    if (cal.step === 1) {
      cal.lo = got.midi;
      cal.step = 2;
      renderCal('Low note: ' + EarTheory.noteName(got.midi, 0, 'major'));
      return;
    }
    cal.hi = got.midi;
    finishCal();
  }

  function finishCal() {
    var lo = Math.min(cal.lo, cal.hi), hi = Math.max(cal.lo, cal.hi);
    if (hi - lo < MIN_SPAN) {
      // Two readings inside an octave almost always mean one of them octave-halved
      // or the same note was sung twice. Storing it would leave EarTheory.playBand
      // widening a nonsense range, so start over instead.
      cal.step = 1; cal.lo = null; cal.hi = null;
      renderCal('Those two are less than an octave apart — that is usually a mis-read. Start over.');
      return;
    }
    if (hi - lo > MAX_SPAN) hi = lo + MAX_SPAN;
    var s = copySettings(settings);
    s.voiceRange = 'custom'; s.voiceLo = lo; s.voiceHi = hi;
    applySettings(s);                       // saveSettings clamps 24–84 again
    show($('calOverlay'), false);
    flash('Voice range set: ' + EarTheory.noteName(settings.voiceLo, 0, 'major') +
          ' – ' + EarTheory.noteName(settings.voiceHi, 0, 'major'));
  }

  function onCalFrame(f) {
    if (f.midi == null) {
      $('calNote').textContent = '—';
      $('calCents').textContent = f.rms < EarPitch.RMS_MIN ? 'louder' : 'steady…';
      $('calNeedle').style.left = '50%';
    } else {
      $('calNote').textContent = EarTheory.noteName(f.midi, 0, 'major');
      $('calCents').textContent = (f.cents > 0 ? '+' : '') + f.cents + '¢';
      $('calNeedle').style.left = Math.max(0, Math.min(100, 50 + f.cents)) + '%';
    }
    $('calTuner').classList.toggle('ok', !!f.stable);
  }

  function wireCal() {
    var b = $('calHold');
    b.addEventListener('pointerdown', function (e) {
      try { b.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
      calStart();
    });
    b.addEventListener('pointerup', calEnd);
    b.addEventListener('pointercancel', calEnd);
    b.addEventListener('lostpointercapture', calEnd);
    $('calClose').onclick = closeCal;
    $('calRetry').onclick = function () { cal.step = 1; cal.lo = null; cal.hi = null; renderCal(''); };
  }

  /* ====================== §12 intro + modals ====================== */

  // ear-store.js keeps unknown settings keys verbatim, so first-run state rides in
  // the settings blob rather than needing a second localStorage key of its own.
  function firstRun() { return settings.introSeen !== 1; }
  function markIntroSeen() {
    if (!firstRun()) return;
    var s = copySettings(settings);
    s.introSeen = 1;
    settings = EarStore.saveSettings(s);
  }

  function modalOpen() {
    return $('introOverlay').style.display !== 'none' || calOpen() ||
           $('endOverlay').style.display !== 'none';
  }
  function closeTopModal() {
    if (calOpen()) { closeCal(); return; }
    if ($('endOverlay').style.display !== 'none') { closeEnd(); return; }
    if ($('introOverlay').style.display !== 'none') { show($('introOverlay'), false); markIntroSeen(); }
  }

  function wireModals() {
    $('introStart').onclick = function () {
      show($('introOverlay'), false); markIntroSeen();
      startSession();                     // still inside the click: unlock() is valid
    };
    $('introSettings').onclick = function () {
      show($('introOverlay'), false); markIntroSeen();
      EarAudio.unlock();                  // spend the gesture we have anyway
      toggleSettings(true);
    };
    $('endClose').onclick = closeEnd;
    $('endDone').onclick  = closeEnd;
    $('endAgain').onclick = function () { closeEnd(); startSession(); };
  }

  /* ====================== §13 key bindings ====================== */
  /* design §12. Everything is ignored while a modal is open or while focus sits in
   * a form control, so the settings panel's own selects keep their arrow keys.
   */

  function typing(e) {
    var t = e.target;
    if (!t || !t.tagName) return false;
    var n = t.tagName.toLowerCase();
    return n === 'input' || n === 'select' || n === 'textarea' || t.isContentEditable === true;
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Shift is the keyboard equivalent of the hold control and is handled BEFORE
    // the modal gate, because the calibration dialog wants it too.
    if (e.key === 'Shift') {
      if (!shiftDown) { shiftDown = true; if (calOpen()) calStart(); else if (!modalOpen()) startSing(); }
      return;
    }
    if (typing(e)) return;
    if (modalOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); closeTopModal(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); togglePause(); return; }
    if (e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space') {
      // preventDefault before anything else: it stops the page scrolling AND stops
      // Space from re-activating whichever button still holds focus.
      e.preventDefault();
      if (phase === 'reveal') nextTrial();
      else if (phase === 'listen' || phase === 'answer') replay();
      else if (!sess) startSession();
      return;
    }
    var k = (typeof e.key === 'string' && e.key.length === 1) ? e.key.toLowerCase() : '';
    if (k && has(KEY_TO_DEG, k)) { e.preventDefault(); commit(KEY_TO_DEG[k]); }
  }

  // Deliberately unguarded — no modal test, no typing test. Ending a hold must
  // never be blocked by where focus happens to be; both handlers are no-ops when
  // nothing is being held.
  function onKeyUp(e) {
    if (e.key !== 'Shift') return;
    shiftDown = false;
    endSing(); calEnd();
  }

  /* ====================== §14 cloud auth slot ====================== */
  /* Contract §E: sync.js is not loaded here, so the slot is rendered from
   * StudioApi.me() directly. Shape follows app.js:809-837 — textContent only, and
   * 'not_cloud' is treated as "feature absent", never as a failure.
   */
  function renderAuthUI(u) {
    if (!CLOUD) return;
    var slot = $('authSlot'); if (!slot) return;
    clear(slot);
    if (u) {
      if (u.image) {
        var img = document.createElement('img');
        img.className = 'avatar'; img.src = u.image; img.alt = ''; img.width = 20; img.height = 20;
        slot.appendChild(img);
      }
      var who = mk('span', 'who', u.name || 'signed in');
      if (u.isAdmin) who.title = 'admin';
      slot.appendChild(who);
      var out = mk('button', 'btn sm', 'Sign out');
      out.type = 'button';
      out.onclick = function () {
        StudioApi.signOut().then(function () {
          authUser = null; EarStore.setUser(null); renderAuthUI(null);
        }, function () { flash('Could not sign out.'); });
      };
      slot.appendChild(out);
    } else {
      var inb = mk('button', 'btn sm', 'Sign in with GitHub');
      inb.type = 'button';
      inb.title = 'Optional — it syncs your practice history across devices. The drill itself works signed out.';
      inb.onclick = function () {
        // '/learn/' WITH the trailing slash: that is the canonical URL (contract
        // §B) and the bare /learn would come back through a 307.
        StudioApi.signInGithub('/learn/').then(null, function (e) {
          if (e && e.code === 'not_cloud') return;      // feature absent, not an error
          flash('Sign-in failed: ' + ((e && e.message) || 'unknown error'));
        });
      };
      slot.appendChild(inb);
    }
  }

  /* ====================== §15 boot ====================== */

  buildSettingsOptions();
  fillControls();
  wireSettings();
  buildKeys();
  wireSing();
  wireCal();
  wireModals();
  syncMicUi();

  $('btnStart').onclick = function () { startSession(); this.blur(); };
  $('btnAgain').onclick = function () { replay(); this.blur(); };
  $('btnNext').onclick  = function () { nextTrial(); this.blur(); };
  $('btnPause').onclick = function () { togglePause(); this.blur(); };
  $('btnEnd').onclick   = function () { finishSession(); this.blur(); };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  // Mirrors app.js:1376. A session in flight is not written anywhere until
  // finish(), so leaving mid-drill really does throw the questions away.
  window.addEventListener('beforeunload', function (e) {
    if (sess && sess.stats().questions > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  renderAll();
  renderStreak();

  if (firstRun()) { show($('introOverlay'), true); toggleSettings(true); }

  /* ---- cloud boot ----------------------------------------------------------
   * Additive and never fatal. me() resolves {user:null} rather than rejecting
   * (api.js:303) and sync() resolves its own failure reason instead of throwing
   * (ear-store.js:461), so neither half can break a page whose whole product runs
   * out of localStorage. Handing the user straight to EarStore.setUser saves it a
   * second /me round trip.
   * ------------------------------------------------------------------------ */
  if (CLOUD && window.StudioApi) {
    StudioApi.me().then(function (j) {
      authUser = (j && j.user) || null;
      EarStore.setUser(j);
      renderAuthUI(authUser);
      return EarStore.sync();
    }).then(function () { renderStreak(); }, function () { /* additive: stay quiet */ });
  }

  // Debug/automation handle, in the shape app.js:1419 uses.
  window.Learn = {
    settings: function () { return settings; },
    session:  function () { return sess; },
    trial:    function () { return trial; },
    phase:    function () { return phase; },
    start:    startSession,
    answer:   commit,
    finish:   finishSession
  };
})();
