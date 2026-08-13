/* ============================================================================
 * ear-session.js  —  the trial state machine and scoring engine for /learn.
 *
 * The pure brain of the ear trainer. It owns the shape of a practice session —
 * what to ask next, when the key has to be re-established, when the session is
 * over — and every number the end screen reports. There is NO DOM and NO audio
 * in here: learn.js drives it and plays whatever it is told to play, so the
 * whole file can be exercised head-less from tab-studio/test-ear.js.
 *
 * Three things earn their complexity here:
 *
 *   • The cadence taper (design §6). Replaying the context every N questions is
 *     not a convenience, it IS the memory drill — holding a tonal centre across
 *     intervening material. So "is the context due?" lives in the state machine
 *     where it is testable, not in the UI where it would quietly drift.
 *   • Commit-before-replay (design §4). "Hear it again" is deliberately NOT
 *     locked out — locking it makes a mis-heard trial unanswerable — it is
 *     *counted* instead, per trial and per session. assist() is that counter,
 *     and it refuses to count a replay in REVEAL, because study-phase replay is
 *     free and charging for it would train the user to avoid studying.
 *   • The confusion table (design §8). "You call ♭7 the 6 half the time" is the
 *     single most actionable output of the app, so every wrong answer is kept
 *     as an ORDERED (target → answered) pair, not merely as a miss.
 *
 * Two words are overloaded in this app and the collision is worth stating once:
 * `settings.mode` is the DRILL mode ('identify' | 'produce'), while a level's
 * mode and a question's mode are the TONALITY ('major' | 'minor'). The record
 * field `mode` is the drill mode (design §13); the tonality is never persisted
 * because it is implied by the level.
 *
 * All persisted times are unix SECONDS (house rule — store.js notes that ms
 * would render as year 57000). The millisecond clock is used only inside a live
 * trial and never leaves finish().
 *
 *   EarSession.create(settings, rnd)   — a session; `rnd` is INJECTED, always
 *     s.next()             — next question + whether to (re)establish the key
 *     s.ready()            — trial is answerable; STARTS the response clock
 *     s.answer(deg)        — commit a degree → {correct, target, ms}
 *     s.assist()           — count one "hear it again" → {trial, total}
 *     s.singResult(cents)  — record one mic trial's signed cents deviation
 *     s.pause() / s.resume() / s.paused()
 *     s.elapsed()          — training seconds so far, paused time excluded
 *     s.done()             — has the length target been reached?
 *     s.stats()            — live HUD numbers
 *     s.current() / s.trials() / s.settings()
 *     s.finish()           — seal and return the design §13 session record
 *   EarSession.verdict(accuracy, level)  — the 70/90 training band + its line
 *   EarSession.autoAdvance(record)       — the stricter 60/90 promote rule
 *   EarSession.summarize(record)         — end-screen numbers out of a record
 * ========================================================================== */
var EarSession = (function () {
  'use strict';

  // ---- EarTheory resolution -------------------------------------------------
  // In the browser ear-theory.js is a plain <script> loaded before this one
  // (contract §E), so the global is simply there. Under node (test-ear.js) it
  // has to be require()d — and lazily, because requiring at module-eval time
  // would make the load order of two dual-exported files significant. `typeof`
  // on an undeclared identifier is the one lookup that is legal under strict
  // mode, which is why the global probe is written this way.
  var THEORY = null;
  function tryTheory() {                       // never throws; null when absent
    if (THEORY) return THEORY;
    if (typeof EarTheory !== 'undefined' && EarTheory) { THEORY = EarTheory; return THEORY; }
    if (typeof require === 'function') {
      try { THEORY = require('./ear-theory.js'); } catch (e) { THEORY = null; }
    }
    return THEORY;
  }
  function theory() {
    var T = tryTheory();
    if (!T) throw new Error('EarSession: EarTheory is not loaded (contract §E script order)');
    return T;
  }

  var DEFAULT_VOICE_LO   = 43;    // baritone 43–67, design §9 default preset
  var DEFAULT_VOICE_HI   = 67;
  var MIN_VOICE_SPAN     = 12;    // design §9 clamps the calibrated range to
  var MAX_VOICE_SPAN     = 36;    // 12–36 semitones; guarded again here so the
                                  // play band can never come out empty.
  var DEFAULT_TIME_SEC   = 600;   // 10 minutes, design §8
  var DEFAULT_QUESTIONS  = 20;
  var AUTO_MIN_QUESTIONS = 15;    // design §8: shorter sessions are not evidence
  var MAX_CONFUSIONS     = 24;    // stored cap — see detailShape() below
  var MAX_LEVEL_FALLBACK = 7;     // design §3 ladder length, if LEVELS is absent

  // ---- small numeric helpers ------------------------------------------------
  function nowMs() { return Date.now(); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pc12(v) { var n = Math.round(num(v)) % 12; return n < 0 ? n + 12 : n; }
  function clampInt(v, lo, hi, dflt) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    return n < lo ? lo : (n > hi ? hi : n);
  }
  function zeros(n) { var a = [], i; for (i = 0; i < n; i++) a.push(0); return a; }
  function maxLevel() {
    var T = tryTheory();                       // verdict/autoAdvance are static
    return (T && T.LEVELS && T.LEVELS.length) ? T.LEVELS.length : MAX_LEVEL_FALLBACK;
  }
  function levelDef(LEVELS, level) {
    var i;                                     // match on `n` rather than index
    for (i = 0; i < LEVELS.length; i++) if (LEVELS[i] && LEVELS[i].n === level) return LEVELS[i];
    return LEVELS[level - 1] || {};
  }
  function median(list) {
    if (!list.length) return null;
    var a = list.slice().sort(function (x, y) { return x - y; });
    var h = a.length >> 1;
    return Math.round(a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2);
  }

  // ---- settings normalisation ----------------------------------------------
  // Everything below survives a half-filled settings object, because ear-store
  // hands us whatever localStorage happened to hold and a stale key from an
  // older build must degrade to the level default rather than break the session.

  // design §13 persists taper as 1|2|4|8|0 where 0 means "once per session";
  // the settings UI spells that last value 'session' (design §6).
  function normTaper(t, level, def) {
    if (t === 'session' || t === 0 || t === '0') return 0;
    var n = Math.round(Number(t));
    if (n === 1 || n === 2 || n === 4 || n === 8) return n;
    if (def && def.taper != null) return normTaper(def.taper, level, null);
    return level <= 2 ? 1 : (level <= 4 ? 4 : 8);        // design §6 fallback
  }

  function normLength(len) {
    len = len || {};
    var kind = (len.kind === 'questions' || len.kind === 'endless') ? len.kind : 'time';
    var value = Number(len.value);
    if (!(value > 0)) value = (kind === 'questions' ? DEFAULT_QUESTIONS : DEFAULT_TIME_SEC);
    // A 'time' length is SECONDS, like every other duration in this app. But the
    // presets read "10 min" / "20 min" and a sub-minute session is not a thing,
    // so a small value is taken as minutes instead of ending the session on the
    // first question. This keeps {kind:'time',value:10} honest either way.
    if (kind === 'time' && value <= 60) value = value * 60;
    return { kind: kind, value: Math.round(value) };
  }

  function normLabelStyle(s) {
    return (s === 'solfege' || s === 'both') ? s : 'numbers';
  }

  // ==========================================================================
  // create — one practice session
  // ==========================================================================
  function create(settings, rnd) {
    // rnd is injected so every test is reproducible; a module that reached for
    // Math.random() would make the question stream untestable (contract §F).
    if (typeof rnd !== 'function')
      throw new Error('EarSession.create: rnd must be an injected function () -> [0,1)');
    settings = settings || {};

    // settings.theory / settings.clock are test seams only — the browser never
    // passes them and gets the ear-theory.js global plus the wall clock.
    var T = settings.theory || theory();
    var clock = (typeof settings.clock === 'function') ? settings.clock : nowMs;

    var LEVELS   = T.LEVELS || [];
    var maxL     = LEVELS.length || MAX_LEVEL_FALLBACK;
    var level    = clampInt(settings.level, 1, maxL, 1);
    var def      = levelDef(LEVELS, level);
    var degrees  = (def.degrees || []).slice();   // copy: the UI gets this array
    var tonality = (def.mode === 'minor') ? 'minor' : 'major';
    var drill    = (settings.mode === 'produce') ? 'produce' : 'identify';
    var context  = (settings.context === 'ii-V-I' || settings.context === 'drone' ||
                    settings.context === 'cadence')
                 ? settings.context
                 : (level >= 4 ? 'ii-V-I' : 'cadence');           // design §6
    var taper    = normTaper(settings.taper, level, def);
    var spread   = clampInt(settings.spread, 1, 2,
                            (def.spread != null ? def.spread : (level >= 4 ? 2 : 1)));
    var singGate = !!settings.singGate;
    var voice    = settings.voice || 'random';
    var labelStyle = normLabelStyle(settings.labelStyle);
    var length   = normLength(settings.length);

    var voiceLo = clampInt(settings.voiceLo, 0, 127, DEFAULT_VOICE_LO);
    var voiceHi = clampInt(settings.voiceHi, 0, 127, DEFAULT_VOICE_HI);
    if (voiceHi < voiceLo) { var sw = voiceLo; voiceLo = voiceHi; voiceHi = sw; }
    if (voiceHi - voiceLo < MIN_VOICE_SPAN) voiceHi = voiceLo + MIN_VOICE_SPAN;
    if (voiceHi - voiceLo > MAX_VOICE_SPAN) voiceHi = voiceLo + MAX_VOICE_SPAN;

    var band = (typeof T.playBand === 'function') ? T.playBand(voiceLo, voiceHi, spread) : null;

    // The state object handed to EarTheory.nextQuestion (contract §F). Field
    // names are the contract's own vocabulary; `mode` here is the TONALITY, to
    // match what nextQuestion returns and what keyName/cadence/noteName take —
    // the drill mode is deliberately NOT in this object so it cannot be read by
    // mistake. `recent` is newest-LAST; lastDegree/prevDegree are supplied as
    // unambiguous scalars so the "never the same degree three times in a row"
    // rule (design §7) never depends on guessing the array's direction.
    var qstate = {
      level: level, degrees: degrees, mode: tonality, spread: spread,
      voice: voice, voiceLo: voiceLo, voiceHi: voiceHi, band: band,
      context: context,
      // ear-theory.js:428 derives "is a new key due" from the taper ALONE, so a
      // drone — established exactly once and explicitly never re-tapered
      // (design §6) — has to reach it as the 'session' taper 0, or the tonic
      // slides out from under a held drone. The `taper` closure variable is
      // deliberately left alone: it is what settingsOut() and the record report.
      taper: (context === 'drone' ? 0 : taper),
      index: 0, tonicPc: null, prevTonicPc: null, newKey: true,
      recent: [], lastDegree: null, prevDegree: null,
      // ear-theory.js:396-416 documents the state nextQuestion() actually reads
      // and the names are NOT this module's internal ones. next() maintains them
      // alongside their local twins; they are declared here so the object has
      // one complete shape rather than sprouting fields on first use.
      questionIndex: 0, lastKey: null, lastDegrees: []
    };

    var startedMs = clock();
    var endedMs   = null;
    var pauseAt   = null, pauseAcc = 0;

    var trials = [], cur = null, index = 0;
    var answered = 0, correctN = 0, assists = 0;
    var centsSum = 0, centsN = 0;
    var times    = [];                       // response ms, one per answered trial
    var askedBy  = zeros(12), rightBy = zeros(12);
    var conf     = zeros(144);               // conf[target * 12 + answered]
    var record   = null;

    function pausedTotal() { return pauseAcc + (pauseAt === null ? 0 : clock() - pauseAt); }
    function elapsedMs() {
      return (endedMs === null ? clock() : endedMs) - startedMs - pausedTotal();
    }

    // Is the key due to be (re)established before question `i`? The taper is the
    // whole point of the exercise (design §6), so this is the one place it lives.
    function contextDue(i) {
      // A drone is a sustained tonic under everything and is established exactly
      // once; the taper explicitly does not apply to it (design §6). Since the
      // key is only ever re-drawn when the context is re-established (design §7),
      // a drone session therefore stays in one key — which is the point of the
      // modality: no tonal-memory decay, pure colour against a fixed root.
      if (context === 'drone') return i === 0;
      if (taper === 0) return i === 0;                 // 'session' — establish once
      return (i % taper) === 0;
    }

    function next() {
      if (record) throw new Error('EarSession.next: this session is already finished');

      var due = contextDue(index);
      qstate.index       = index;
      qstate.prevTonicPc = qstate.tonicPc;
      qstate.newKey      = due;              // only ask for a fresh key when due

      // The three fields ear-theory.js:417-449 reads for itself. Leaving them
      // undefined was not a soft failure: nextQuestion() then saw question 0
      // with no history on EVERY call, so it re-drew the key every question —
      // the taper silently dead (design §6) — and neither the
      // no-key-twice-in-a-row nor the no-degree-three-times-running rule
      // (design §7) could ever fire. `lastDegrees` is newest-FIRST over there,
      // the opposite of `recent` below, so it is built from the two unambiguous
      // scalars rather than by slicing an array in a direction one of us would
      // eventually get backwards.
      qstate.questionIndex = index;
      qstate.lastKey       = qstate.tonicPc;
      qstate.lastDegrees   = (qstate.lastDegree === null) ? []
                           : (qstate.prevDegree === null
                                ? [qstate.lastDegree]
                                : [qstate.lastDegree, qstate.prevDegree]);

      var q = T.nextQuestion(qstate, rnd);
      if (!q) throw new Error('EarSession.next: EarTheory.nextQuestion returned nothing');

      var tonicPc = pc12(q.tonicPc);
      // Self-correcting: if the key moved for any reason we must re-establish it,
      // even when the taper said otherwise. A silently changed tonic would make
      // the trial unanswerable and would poison the confusion table with misses
      // that are the app's fault, not the ear's.
      var moved = (qstate.prevTonicPc === null || tonicPc !== qstate.prevTonicPc);

      var trial = {
        n: index + 1,
        tonicPc: tonicPc,
        mode: (q.mode === 'minor' ? 'minor' : tonality),   // TONALITY, not drill
        degree: pc12(q.degree),
        midi: Math.round(num(q.midi)),
        // A fixed timbre setting is authoritative; only 'random' defers to the
        // per-question draw (design §7).
        voice: (voice === 'random' ? (q.voice || 'organ') : voice),
        newKey: moved,
        playContext: (due || moved),
        context: context,
        drill: drill, level: level, spread: spread, degrees: degrees,
        labelStyle: labelStyle, singGate: singGate,
        assists: 0, cents: null,
        answered: null, correct: null, ms: null, result: null,
        askedAt: clock(), readyAt: null, answeredAt: null,
        pausedAtAsk: pausedTotal(), pausedAtReady: 0
      };

      qstate.tonicPc    = tonicPc;
      qstate.prevDegree = qstate.lastDegree;
      qstate.lastDegree = trial.degree;
      qstate.recent.push(trial.degree);
      if (qstate.recent.length > 8) qstate.recent.shift();
      index++;
      trials.push(trial);
      cur = trial;
      return trial;
    }

    // LISTEN → ANSWERABLE (design §4). The response clock starts HERE, not at
    // next(), because design §8 measures note-end → commit: counting the cadence
    // and the test note would make every median a measure of playback length.
    // First call wins — a post-assist replay does not reset the clock, the
    // assist counter is what flags that trial.
    function ready() {
      if (!cur || cur.result) return;
      if (cur.readyAt === null) { cur.readyAt = clock(); cur.pausedAtReady = pausedTotal(); }
      return cur;
    }

    function answer(deg) {
      if (!cur) return null;
      // Idempotent: a keydown and a click can both fire for one commit, and
      // double-counting would corrupt both the accuracy and the confusion table.
      if (cur.result) return cur.result;

      var t = clock();
      var a = pc12(deg);
      var target = cur.degree;
      var correct = (a === target);
      // Answers are pitch classes because degrees are octave-invariant (design
      // §1) — the caller in produce mode passes the SUNG degree, so both drill
      // modes score through this one path.
      var base       = (cur.readyAt !== null ? cur.readyAt : cur.askedAt);
      var basePaused = (cur.readyAt !== null ? cur.pausedAtReady : cur.pausedAtAsk);
      var ms = Math.max(0, Math.round((t - base) - (pausedTotal() - basePaused)));

      cur.answeredAt = t;
      cur.answered   = a;
      cur.correct    = correct;
      cur.ms         = ms;
      cur.result     = { correct: correct, target: target, ms: ms };

      answered++;
      askedBy[target]++;
      if (correct) { correctN++; rightBy[target]++; }
      else conf[target * 12 + a]++;          // ordered pair: heard X, called it Y
      times.push(ms);
      return cur.result;
    }

    // design §4: replay before the commit is the escape hatch and is counted;
    // replay in REVEAL is the study phase and is free, so an already-answered
    // trial charges nothing.
    function assist() {
      if (!cur || cur.result) return { trial: cur ? cur.assists : 0, total: assists };
      cur.assists++;
      assists++;
      return { trial: cur.assists, total: assists };
    }

    // One mic trial's SIGNED deviation (design §11 reports the sign to the user);
    // the session stat accumulates |cents|. Re-singing while still holding
    // replaces the previous reading rather than adding a second sample.
    function singResult(cents) {
      if (!cur) return null;
      var c = Number(cents);
      if (!isFinite(c)) return null;
      if (cur.cents !== null) centsSum -= Math.abs(cur.cents);
      else centsN++;
      cur.cents = c;
      centsSum += Math.abs(c);
      return { cents: c, centsN: centsN, meanCents: centsSum / centsN };
    }

    function pause()  { if (pauseAt === null) pauseAt = clock(); }
    function resume() { if (pauseAt !== null) { pauseAcc += clock() - pauseAt; pauseAt = null; } }
    function paused() { return pauseAt !== null; }

    function elapsed() { var ms = elapsedMs(); return ms > 0 ? ms / 1000 : 0; }

    // Advisory: the UI decides when to stop (typically after REVEAL), which is
    // why next() still serves a question past the target — a trial in flight is
    // allowed to finish.
    function done() {
      if (record) return true;
      if (length.kind === 'questions') return answered >= length.value;
      if (length.kind === 'time') return elapsed() >= length.value;
      return false;                          // endless — the user decides
    }

    function stats() {
      return {
        questions: answered,
        correct: correctN,
        accuracy: answered ? correctN / answered : 0,
        assists: assists,
        centsN: centsN,
        meanCents: centsN ? centsSum / centsN : null,
        elapsed: elapsed(),
        done: done(),
        paused: paused(),
        targetSec: (length.kind === 'time' ? length.value : null),
        targetQuestions: (length.kind === 'questions' ? length.value : null),
        level: level,
        tonicPc: qstate.tonicPc,
        tonality: tonality
      };
    }

    function settingsOut() {
      return {
        level: level, mode: drill, context: context, taper: taper,
        singGate: singGate, spread: spread, voice: voice,
        voiceLo: voiceLo, voiceHi: voiceHi, labelStyle: labelStyle,
        length: { kind: length.kind, value: length.value },
        degrees: degrees, tonality: tonality, band: band
      };
    }

    // The design §13 record, exactly. Idempotent, because the end screen may
    // render before the cloud POST resolves and both read this.
    function finish() {
      if (record) return record;
      resume();                              // seal an open pause before stamping
      endedMs = clock();
      record = {
        started:     Math.floor(startedMs / 1000),   // unix SECONDS, never ms
        durationSec: Math.max(0, Math.round(elapsedMs() / 1000)),
        level:       level,
        mode:        drill,                          // 'identify' | 'produce'
        context:     context,
        taper:       taper,                          // 1|2|4|8|0
        singGate:    singGate ? 1 : 0,
        questions:   answered,
        correct:     correctN,
        assists:     assists,
        centsSum:    Math.round(centsSum),
        centsN:      centsN,
        detail:      JSON.stringify(detailShape(askedBy, rightBy, conf, median(times)))
      };
      return record;
    }

    return {
      next: next, ready: ready, answer: answer, assist: assist,
      singResult: singResult, pause: pause, resume: resume, paused: paused,
      elapsed: elapsed, done: done, stats: stats, finish: finish,
      current: function () { return cur; },
      trials:  function () { return trials; },       // read-only, for a review strip
      settings: settingsOut
    };
  }

  // ==========================================================================
  // detail — the compact JSON blob carried in the record
  // ==========================================================================
  // Shape (design §13 calls for "compact JSON", and this is a D1 TEXT column
  // written once per session, so it is stored short rather than pretty):
  //
  //   {"d":{"<deg>":[asked,correct], ...},
  //    "c":[[target,answered,n], ...],
  //    "m":<median response ms | null>}
  //
  // `m` lives here because design §13's column list has no room for it and the
  // raw per-trial times would triple the row for one reported number (design §8
  // reports only the median). It is computed while the times still exist.
  //
  // `c` is capped at MAX_CONFUSIONS after sorting, so an endless session cannot
  // grow the row without bound; the cap is applied to a descending sort, so the
  // pairs that survive are exactly the ones the end screen would show.
  function detailShape(askedBy, rightBy, conf, medianMs) {
    var d = {}, k, t, a, n, c = [];
    for (k = 0; k < 12; k++) if (askedBy[k]) d[String(k)] = [askedBy[k], rightBy[k]];
    for (t = 0; t < 12; t++) for (a = 0; a < 12; a++) {
      n = conf[t * 12 + a];
      if (n) c.push([t, a, n]);
    }
    c.sort(cmpConf);
    if (c.length > MAX_CONFUSIONS) c = c.slice(0, MAX_CONFUSIONS);
    return { d: d, c: c, m: medianMs };
  }

  // Descending by count, then ascending by target and by answer. The tie-break
  // is not cosmetic: Array#sort is not required to be stable in ES5, so without
  // it the same session could serialise differently on two engines and the unit
  // tests would be flaky.
  function cmpConf(x, y) {
    if (y[2] !== x[2]) return y[2] - x[2];
    if (x[0] !== y[0]) return x[0] - y[0];
    return x[1] - y[1];
  }

  // Tolerant reader: `detail` arrives as a string from localStorage and from D1,
  // and possibly as an already-parsed object from a JSON API response.
  function parseDetail(detail) {
    if (!detail) return {};
    if (typeof detail === 'string') {
      try { return JSON.parse(detail) || {}; } catch (e) { return {}; }
    }
    return (typeof detail === 'object') ? detail : {};
  }

  // ==========================================================================
  // verdict — the ~80% training band (design §8)
  // ==========================================================================
  // `level` is optional: with it the low/high lines can name the level to move
  // to and suggestLevel is a number, without it the text stays generic and
  // suggestLevel is null. Accuracy may be given as 0..1 or as 0..100.
  function verdict(accuracy, level) {
    var a = Number(accuracy);
    if (!isFinite(a)) a = 0;
    if (a > 1) a = a / 100;
    var lv = (level == null ? null : clampInt(level, 1, maxLevel(), 1));
    var band, text, suggest;

    if (a < 0.70) {
      band = 'low';
      suggest = (lv === null ? null : Math.max(1, lv - 1));
      if (lv === null) text = 'Below the training band. Drop a level.';
      else if (suggest === lv) text = 'Below the training band. Level 1 is the floor — ' +
                                      'slow down and lean on the context.';
      else text = 'Below the training band. Drop to level ' + suggest + '.';
    } else if (a <= 0.90) {
      band = 'in';
      suggest = lv;
      text = 'Right where you should be.';
    } else {
      band = 'high';
      suggest = (lv === null ? null : Math.min(maxLevel(), lv + 1));
      if (lv === null) text = 'Too easy. Level up.';
      else if (suggest === lv) text = 'Too easy — but this is the top level. ' +
                                      'Try produce mode or a wider taper.';
      else text = 'Too easy. Level up.';
    }
    return { band: band, text: text, suggestLevel: suggest };
  }

  // The auto-advance rule is deliberately STRICTER than the verdict band
  // (design §8): the band is advice on one screen, this moves the user's saved
  // level, so it demands a session long enough to mean something. Never past
  // the top level, never below 1.
  function autoAdvance(rec) {
    rec = rec || {};
    var top = maxLevel();
    var level = clampInt(rec.level, 1, top, 1);
    var q = num(rec.questions), c = num(rec.correct);
    var out = { level: level, moved: null, accuracy: (q ? c / q : 0) };
    if (q < AUTO_MIN_QUESTIONS) return out;
    if (out.accuracy >= 0.90 && level < top) { out.level = level + 1; out.moved = 'up'; }
    else if (out.accuracy < 0.60 && level > 1) { out.level = level - 1; out.moved = 'down'; }
    return out;
  }

  // ==========================================================================
  // summarize — everything the end screen shows, from a stored record
  // ==========================================================================
  // Works on any record: the one finish() just produced, one read back out of
  // localStorage, or one pulled from /api/learn/sessions. meanCents is null when
  // the mic was never used, so the UI can hide that row instead of printing 0.
  function summarize(rec) {
    rec = rec || {};
    var questions = num(rec.questions), correct = num(rec.correct);
    var centsN = num(rec.centsN), centsSum = num(rec.centsSum);
    var det = parseDetail(rec.detail);

    var perDegree = [], k, e, askedN, rightN;
    var dd = det.d || det.deg || {};
    for (k = 0; k < 12; k++) {                       // ascending degree = keyboard order
      e = dd[String(k)];
      if (!e) continue;
      // Array form is what this module writes; the object form is tolerated so a
      // hand-written or re-encoded record still summarises.
      askedN = num(e.length ? e[0] : e.asked);
      rightN = num(e.length ? e[1] : e.correct);
      if (askedN <= 0) continue;
      perDegree.push({ deg: k, asked: askedN, correct: rightN, accuracy: rightN / askedN });
    }

    var confusions = [], i, row, t, a, n;
    var cc = det.c || det.conf || [];
    for (i = 0; i < cc.length; i++) {
      row = cc[i];
      if (!row) continue;
      t = num(row.length ? row[0] : (row.target != null ? row.target : row.t));
      a = num(row.length ? row[1] : (row.answered != null ? row.answered : row.a));
      n = num(row.length ? row[2] : row.n);
      if (n > 0) confusions.push({ target: pc12(t), answered: pc12(a), n: n });
    }
    // Re-sorted rather than trusted: a record may have been assembled elsewhere,
    // and "the top confusions" is only useful if the order is really the order.
    confusions.sort(function (x, y) {
      if (y.n !== x.n) return y.n - x.n;
      if (x.target !== y.target) return x.target - y.target;
      return x.answered - y.answered;
    });

    var m = (det.m != null ? det.m : det.medianMs);
    return {
      accuracy:   questions ? correct / questions : 0,
      meanCents:  centsN ? centsSum / centsN : null,
      medianMs:   (m == null ? null : num(m)),
      perDegree:  perDegree,
      confusions: confusions
    };
  }

  var api = {
    create: create,
    verdict: verdict,
    autoAdvance: autoAdvance,
    summarize: summarize,
    MAX_CONFUSIONS: MAX_CONFUSIONS,
    AUTO_MIN_QUESTIONS: AUTO_MIN_QUESTIONS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
