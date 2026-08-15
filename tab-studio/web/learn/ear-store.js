/* ============================================================================
 * ear-store.js  —  persistence for the ear trainer: settings + session history.
 *
 * LOCAL FIRST, CLOUD ADDITIVE (design Part I §13). The drill has to be fully
 * usable with no backend at all — mode 'web' / 'desktop', or 'cloud' while signed
 * out — so a completed session lands in localStorage the moment it finishes and
 * the cloud POST happens afterwards, as a bonus. A failed POST is NOT an error
 * the user ever sees: the local record already exists, it is flagged unsynced,
 * and the next sync() retries it. Nothing in this module rejects for that reason.
 *
 * WHY localStorage AND NOT store.js. store.js is IndexedDB and returns an inert
 * stub outside cloud mode (store.js:56), which is exactly the majority case here;
 * and giving it a new object store means bumping DB_VERSION, which fires
 * onversionchange and drops any open main-app tab to a memory shim. A few hundred
 * rows of small integers do not need a database. Every access goes through
 * lsGet/lsSet, the same shape as store.js:520-526, because localStorage THROWS
 * rather than returning null in Firefox private browsing and under a Chrome
 * cookie block — the in-memory fallback keeps the running session honest even
 * when the disk is refusing.
 *
 * ALL PERSISTED TIMESTAMPS ARE UNIX SECONDS. store.js:41 states the house rule:
 * timestamps are rendered with new Date(t * 1000), so a millisecond value shows
 * up as the year 57000. Response times inside a trial are milliseconds, but
 * nothing millisecond-valued is stored here — secs() below tolerates a caller who
 * hands over ms and folds it back.
 *
 *   EarStore.settings()          — stored settings, defaults merged + validated
 *   EarStore.saveSettings(s)     — validate, persist, return what was stored
 *   EarStore.defaults()          — a fresh copy of the default settings
 *   EarStore.records()           — local session records, newest `started` first
 *   EarStore.add(record)         — local write + background best-effort cloud POST
 *   EarStore.sync()              — Promise: pull cloud, merge, drain the backlog
 *   EarStore.stats()             — {streak, todayMin, todaySessions, byLevel, …}
 *   EarStore.setUser(user)       — tell the module who is signed in (skips a /me)
 *   EarStore.signedIn()          — true | false | null (not yet known)
 *   EarStore.cloud()             — is the cloud half armed at all
 *
 * Accuracy is DERIVED and never stored (design Part I §13): correct/questions is
 * the single truth, so a record can never disagree with itself.
 * ========================================================================== */
var EarStore = (function () {
  'use strict';

  /* ====================== mode ====================== */
  // The same gate app.js:1379-1380 and store.js:55 use. UNLIKE store.js this
  // module deliberately does NOT go inert outside cloud: the local half IS the
  // product, and only the network half is gated.
  var MODE  = (window.STUDIO_CONFIG && window.STUDIO_CONFIG.mode) || 'desktop';
  var CLOUD = (MODE === 'cloud');

  var PREFIX     = 'studio.learn.';
  var K_SETTINGS = PREFIX + 'settings';
  var K_RECORDS  = PREFIX + 'records';

  // 500 records at ~190 bytes of JSON each is ~95 KB — comfortably inside the ~5 MB
  // localStorage origin quota this shares with store.js's view stamps, and at the
  // design's one 10-minute session a day it is 500 days of history. The cap exists
  // because nothing ever deletes a session: without it the key grows forever.
  var MAX_RECORDS = 500;
  /* ---- ceilings that MUST NOT be looser than the Worker's validator ----
   * The reasoning is api.js:32's, applied to a route whose failures are quieter:
   * a value that passes here and is refused there dies as a 400, and push() is
   * silent BY DESIGN (Part I §13), so the session would simply never sync and
   * nothing would ever say why. Clamping at this boundary instead means the local
   * record and the wire record are the SAME clamped record. Mirrors, with sources:
   *   routes.js:83   started   <= 4102444800 (2100-01-01)
   *   routes.js:108  durationSec <= 86400
   *   routes.js:109  questions <= 10000, and routes.js:1267/1274 correct and
   *                  centsN each <= questions
   *   routes.js:110  assists   <= 100000  (NOT bounded by questions)
   *   routes.js:112  centsSum  <= centsN × 1200, one octave per mic trial
   *   db.js:101      detail    <= 2000 characters
   */
  var MAX_STARTED      = 4102444800;
  var MAX_DURATION_SEC = 86400;
  var MAX_QUESTIONS    = 10000;
  var MAX_ASSISTS      = 100000;
  var MAX_ABS_CENTS    = 1200;
  // `detail` ends up in a TEXT column. The real thing (12 degree tallies plus a
  // handful of confusion pairs) is a few hundred bytes; anything near this is
  // corrupt. A TRUNCATED JSON string is not JSON, so an over-long one is dropped
  // whole rather than cut — the counters that drive every headline number are
  // separate fields and survive regardless.
  var MAX_DETAIL_CHARS = 2000;
  // Part I §8: a day counts toward the streak at five minutes of practice.
  var STREAK_MIN_SEC = 300;
  var MAX_LEVEL = 7;                        // the L1–L7 ladder, Part I §3
  // One sync must not become a burst. The backend's per-user guard is 10/min
  // (Part I §14) and a laptop opened after a fortnight offline can hold more
  // unsynced records than that. Five per sync drains a backlog across a few
  // visits without ever approaching the limiter.
  var PUSH_PER_SYNC = 5;
  // Asked of the GET. clampLearnLimit (routes.js:1177) caps it at 100, so the real
  // answer is 100 rows — asking high is how this says "your maximum, please"
  // without hard-coding a number that goes stale the day the cap moves. Under-
  // asking would truncate the streak walk on a device returning after a break.
  var PULL_LIMIT = 200;

  // true / false / null-for-unknown. Kept because the difference between "signed
  // out" and "not asked yet" decides whether add() spends a doomed request.
  var signedInState = null;

  /* ====================== localStorage ====================== */
  var mem = {};                              // survives a throwing localStorage

  function lsGet(k) {
    try { var v = window.localStorage.getItem(k); return v == null ? mem[k] : v; } catch (e) { return mem[k]; }
  }
  // Returns whether the DURABLE write landed. store.js:523 has no use for that,
  // but writeRecords() does: a false here is the only signal that the quota is
  // full, and it is what triggers the shed-and-retry below.
  function lsSet(k, v) {
    mem[k] = v;
    try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; }
  }
  function readJson(k, dflt) {
    var raw = lsGet(k);
    if (raw == null || raw === '') return dflt;
    // Hand-edited or half-written JSON must degrade to the default, never throw
    // during page boot — this is called before anything is on screen.
    try { return JSON.parse(raw); } catch (e) { return dflt; }
  }
  function writeJson(k, v) {
    var s;
    try { s = JSON.stringify(v); } catch (e) { return false; }
    return lsSet(k, s);
  }

  /* ====================== small helpers ====================== */
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function nowSec() { return Math.floor(Date.now() / 1000); }
  // Accepts seconds, tolerates a caller who handed us milliseconds, rejects junk.
  // Lifted from store.js:115 so both stores agree on what a timestamp is.
  function secs(t) {
    var n = Number(t);
    if (!isFinite(n) || n <= 0) return 0;
    if (n > 1e11) n = n / 1000;              // 1e11 s is the year 5138 — that was ms
    return Math.floor(n);
  }
  function oneOf(v, allowed, dflt) {
    for (var i = 0; i < allowed.length; i++) if (v === allowed[i]) return v;
    return dflt;
  }
  function intIn(v, lo, hi, dflt) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return dflt;
    return n < lo ? lo : (n > hi ? hi : n);
  }
  function bool01(v) { return (v === true || v === 1 || v === '1') ? 1 : 0; }
  // Local calendar day as an integer. Date.UTC() of the LOCAL y/m/d is DST-proof;
  // the obvious Math.floor(sec / 86400) is not — it buckets by UTC, so an evening
  // session in UTC+2 lands on tomorrow and silently breaks the streak.
  function dayIndex(sec) {
    var d = new Date(sec * 1000);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }
  // Resolved per call rather than captured at load: script order (Part II §E) does
  // put api.js first, but a lazily-loaded or reordered page must degrade to
  // local-only instead of throwing on a missing global.
  function api() { return window.StudioApi || window.Api || null; }

  /* ====================== settings ====================== */
  // Defaults are the level-1 first-run configuration described across Part I §2,
  // §3, §5, §6, §8, §9 and §12.
  //
  // `taper` and `spread` are the USER's chosen values, not the level's. Each level
  // carries its own defaults in EarTheory.LEVELS (Part II §F); copying one in when
  // the level changes is learn.js's job. This module deliberately never reads
  // EarTheory — a storage layer that depends on the theory layer could not be
  // loaded or tested without it.
  var DEFAULTS = {
    level:        1,            // "Do Re Mi" — the bottom of the ladder, Part I §3
    autoAdvance:  true,         // Part I §3: promotion on ≥90%, demotion on <60%
    mode:         'identify',   // Part I §5, the core drill; 'produce' needs a mic
    context:      'cadence',    // Part I §6, the L1–L3 default; L4+ prefers ii-V-I
    taper:        1,            // re-establish the key every question at L1–L2
    singGate:     0,            // mic is optional throughout (Part I §11)
    spread:       1,            // octaves of register spread; L1–L3 use one
    timbre:       'random',     // Part I §7: the test note's voice varies per question
    // Part I §9 as amended by the sing-back change spec §4. The default is the
    // UNISEX octave, not a voice type: male and female comfortable ranges overlap
    // in about an octave and F3–F4 is that overlap, so a first-run user of any
    // voice can sing the target back without touching a setting. The preset table
    // itself lives in EarTheory.VOICE_RANGES; these three are the only place the
    // numbers are repeated, and they are repeated on purpose — see the note above
    // about this module never reading EarTheory.
    //
    // Changing a DEFAULT does not touch anybody's stored choice: validateSettings()
    // only fills keys that are absent (see the `s[k] === undefined` fill below), so
    // a user who already picked 'baritone' keeps baritone 43–67 forever. That is
    // deliberate — a stored voiceRange is a real decision, quite possibly the
    // output of a calibration, and silently rewriting it would be a lie.
    voiceRange:   'unisex',     // EarTheory.VOICE_RANGES[0].id
    voiceLo:      53,           // unisex 53–65 (MIDI) = F3–F4
    voiceHi:      65,
    sessionLimit: 'time',       // Part I §8: 'time' | 'count' | 'endless'
    sessionSec:   600,          // the 10-minute box that serves the 8–12 min/day goal
    sessionQ:     20,
    labels:       'numbers'     // Part I §2: 'numbers' | 'solfege' | 'both'
  };

  function validateSettings(raw) {
    var s = {}, k;
    // Unknown keys are KEPT, not stripped. This module owns the blob but not its
    // whole schema — learn.js grows the settings panel — and quietly dropping a key
    // a newer UI wrote looks exactly like a setting that refuses to stick.
    if (raw && typeof raw === 'object') for (k in raw) if (has(raw, k)) s[k] = raw[k];
    for (k in DEFAULTS) if (has(DEFAULTS, k) && s[k] === undefined) s[k] = DEFAULTS[k];

    // Part I §6 spells the longest taper 'session' while the record shape in §13
    // stores it as 0. Fold the word into the number here so exactly one of the two
    // spellings ever reaches storage or the wire.
    if (s.taper === 'session') s.taper = 0;

    s.level        = intIn(s.level, 1, MAX_LEVEL, DEFAULTS.level);
    s.autoAdvance  = !!s.autoAdvance;
    s.mode         = oneOf(s.mode, ['identify', 'produce'], DEFAULTS.mode);
    s.context      = oneOf(s.context, ['tonic', 'cadence', 'ii-V-I', 'drone'], DEFAULTS.context);
    s.taper        = oneOf(intIn(s.taper, 0, 8, DEFAULTS.taper), [0, 1, 2, 4, 8], DEFAULTS.taper);
    s.singGate     = bool01(s.singGate);
    s.spread       = intIn(s.spread, 1, 2, DEFAULTS.spread);
    s.labels       = oneOf(s.labels, ['numbers', 'solfege', 'both'], DEFAULTS.labels);
    s.sessionLimit = oneOf(s.sessionLimit, ['time', 'count', 'endless'], DEFAULTS.sessionLimit);
    s.sessionSec   = intIn(s.sessionSec, 60, 3600, DEFAULTS.sessionSec);
    s.sessionQ     = intIn(s.sessionQ, 5, 200, DEFAULTS.sessionQ);
    // Only the TYPE is checked for the two name-valued settings. The authoritative
    // voice list is EarAudio.VOICES and the range presets are EarTheory.VOICE_RANGES;
    // copying either table here would give it a second place to drift from. An
    // unrecognised name resolves to a voice EarAudio does not have and falls back
    // there. 'custom' is a legal voiceRange and is in neither table — it means the
    // lo/hi below came from calibration rather than from a preset.
    s.timbre     = (typeof s.timbre === 'string' && s.timbre) ? s.timbre : DEFAULTS.timbre;
    s.voiceRange = (typeof s.voiceRange === 'string' && s.voiceRange) ? s.voiceRange : DEFAULTS.voiceRange;
    // Voice range in MIDI, span clamped to Part I §9's sane 12–36 semitones so a
    // failed calibration — two readings of the same octave-halved note, say —
    // cannot leave the test-note band empty or absurd. The fallback span is two
    // octaves, which is a legal answer for ANY low note (a fixed 67 would not be).
    //
    // BOTH BOUNDS ARE INCLUSIVE and the LOW one has to stay that way: intIn()
    // clamps with `n < lo ? lo : ...`, so a span of exactly 12 passes through
    // untouched, and since the change spec §4 default IS exactly one octave
    // (53 → 65) an exclusive minimum here would silently widen every fresh
    // install's range to 53–77 and quietly contradict the preset it is named after.
    s.voiceLo = intIn(s.voiceLo, 24, 84, DEFAULTS.voiceLo);
    s.voiceHi = intIn(s.voiceHi, s.voiceLo + 12, s.voiceLo + 36, s.voiceLo + 24);
    return s;
  }

  // Re-read and re-validated on every call rather than cached: it is one small
  // JSON.parse, and it means a change made in another tab is picked up instead of
  // being overwritten by a stale copy on the next save.
  function settings() { return validateSettings(readJson(K_SETTINGS, null)); }

  function saveSettings(s) {
    var v = validateSettings(s);
    writeJson(K_SETTINGS, v);
    return v;
  }
  function defaults() { return validateSettings(null); }

  /* ====================== records ====================== */
  // The Part I §13 session record, plus one local-only field:
  //   synced  0|1  — is this session known to be on the server. Never sent.
  //
  // Field names are read in BOTH camelCase and snake_case: these objects arrive
  // from the app (camelCase, per §13) and from the GET route's row serializer,
  // whose casing is worker/routes.js's business and not ours to assume. Accepting
  // both here is a couple of lines; guessing wrong would silently zero every
  // duration and cents figure that came back from the cloud.
  function pick(o, camel, snake) { return o[camel] == null ? o[snake] : o[camel]; }

  function normRecord(r) {
    if (!r || typeof r !== 'object') return null;
    var started = secs(r.started);
    if (!started) return null;               // undatable: cannot merge it, cannot chart it
    if (started > MAX_STARTED) started = MAX_STARTED;   // a clock set past 2100
    var questions = intIn(r.questions, 0, MAX_QUESTIONS, 0);
    // Mic trials are a SUBSET of the questions asked and each contributes at most
    // one octave of |deviation|, so both cents fields are bounded by arithmetic
    // rather than by a rule of their own — the same derivation routes.js:1271-1275
    // makes server-side.
    var centsN = intIn(pick(r, 'centsN', 'cents_n'), 0, questions, 0);
    var taper = r.taper === 'session' ? 0 : r.taper;
    return {
      started:     started,
      durationSec: intIn(pick(r, 'durationSec', 'duration_sec'), 0, MAX_DURATION_SEC, 0),
      level:       intIn(r.level, 1, MAX_LEVEL, 1),
      mode:        oneOf(r.mode, ['identify', 'produce'], 'identify'),
      context:     oneOf(r.context, ['tonic', 'cadence', 'ii-V-I', 'drone'], 'cadence'),
      taper:       oneOf(intIn(taper, 0, 8, 0), [0, 1, 2, 4, 8], 0),
      singGate:    bool01(pick(r, 'singGate', 'sing_gate')),
      questions:   questions,
      // Clamped to `questions` because accuracy is derived from these two: a
      // correct count above the question count would render as >100%.
      correct:     intIn(r.correct, 0, questions, 0),
      // NOT bounded by questions: one trial can burn several assists (Part I §4).
      assists:     intIn(r.assists, 0, MAX_ASSISTS, 0),
      centsSum:    intIn(pick(r, 'centsSum', 'cents_sum'), 0, centsN * MAX_ABS_CENTS, 0),
      centsN:      centsN,
      detail:      detailString(r.detail),
      synced:      bool01(r.synced)
    };
  }

  // `detail` is stored and transmitted as a JSON STRING. The column at the far end
  // is TEXT, and a string survives a tolerant server either way, whereas an object
  // sent to a server that length-checks a string is a 400 — and a 400 here is
  // invisible (push() is silent), so that session would simply never sync.
  function detailString(d) {
    var s;
    if (d == null) return '';
    if (typeof d === 'string') s = d;
    else { try { s = JSON.stringify(d); } catch (e) { return ''; } }
    return s.length > MAX_DETAIL_CHARS ? '' : s;
  }
  // Exactly the Part I §13 wire shape — `synced` is local bookkeeping and is not
  // part of the contract in Part II §G.
  function wireRecord(r) {
    return {
      started: r.started, durationSec: r.durationSec, level: r.level, mode: r.mode,
      context: r.context, taper: r.taper, singGate: r.singGate,
      questions: r.questions, correct: r.correct, assists: r.assists,
      centsSum: r.centsSum, centsN: r.centsN, detail: r.detail
    };
  }
  function sortRecords(list) { list.sort(function (a, b) { return b.started - a.started; }); }
  function findByStarted(list, started) {
    for (var i = 0; i < list.length; i++) if (list[i].started === started) return i;
    return -1;
  }

  function readRecords() {
    var raw = readJson(K_RECORDS, null), out = [], i, r;
    if (!raw || typeof raw.length !== 'number') return out;
    for (i = 0; i < raw.length; i++) {
      r = normRecord(raw[i]);
      if (r) out.push(r);                    // a corrupt entry is skipped, not fatal
    }
    sortRecords(out);
    return out;
  }
  // Takes ownership of `list` (callers always hand over a freshly built array).
  function writeRecords(list) {
    if (list.length > MAX_RECORDS) list.length = MAX_RECORDS;   // sorted newest-first: the tail is the oldest
    if (writeJson(K_RECORDS, list)) return true;
    // The one failure worth reacting to is a full quota. `mem` keeps THIS page
    // honest, but the history would be gone on reload — so shed to a fifth and try
    // once more. A short history beats none, and this is the only path that can
    // ever shrink the key.
    if (list.length > 100) { list.length = 100; return writeJson(K_RECORDS, list); }
    return false;
  }

  function records() { return readRecords(); }

  function add(rec) {
    var src = {}, k, r, list, tries = 0;
    if (rec && typeof rec === 'object') for (k in rec) if (has(rec, k)) src[k] = rec[k];
    // A caller that forgot `started` still gets a datable record instead of a
    // dropped one — normRecord() refuses anything it cannot place on a day.
    if (!secs(src.started)) src.started = nowSec();
    src.synced = 0;
    r = normRecord(src);
    if (!r) return null;

    list = readRecords();
    // Two tabs finishing inside the same second collide on `started`, which is the
    // merge key here AND the primary key server-side. Bumping mirrors the backend's
    // own resolution (Part II §G: db.js walks `started` forward one second per
    // attempt) so the two never disagree about which row is which; INSERT OR
    // REPLACE semantics would silently destroy one of two genuine sessions.
    //
    // The window is a full minute of slots because a session is MINUTES long: real
    // practice cannot fill it. Exhausting it means a loop or a corrupted store, and
    // then the new record is refused rather than written over an existing one —
    // uniqueness is what `started` is for here, and no arriving record is worth
    // deleting one already on disk.
    while (tries++ < 60 && findByStarted(list, r.started) >= 0) r.started++;
    if (findByStarted(list, r.started) >= 0) return null;
    list.push(r);
    sortRecords(list);
    writeRecords(list);                      // DURABLE BEFORE THE NETWORK — Part I §13

    push(r);                                 // background; never throws, never rejects
    return r;
  }

  /* ====================== cloud (additive) ====================== */
  // Best effort and DELIBERATELY silent (design Part I §13). The record is already
  // durable; a failure here only means `synced` stays 0 and the next sync() tries
  // again. Nothing may reject: an unhandled rejection from a purely additive
  // feature would fill the console of a user whose only sin is being signed out.
  function push(r) {
    var A = api();
    if (!CLOUD || !A || !A.learnSaveSession) return Promise.resolve(false);
    if (signedInState === false) return Promise.resolve(false);   // known signed out — spend nothing
    return A.learnSaveSession(wireRecord(r)).then(function (j) {
      signedInState = true;                                       // a 200 proves it
      reconcilePush(r.started, j && j.session);
      return true;
    }, function (e) {
      // A 401 is not worth retrying blind, so remember it and stop issuing doomed
      // requests for the rest of the page. 'not_cloud' cannot reach here (CLOUD is
      // false in that build) but costs nothing to treat identically.
      var code = (e && e.code) || '';
      if (code === 'unauthenticated' || code === 'not_cloud') signedInState = false;
      return false;
    });
  }

  // Adopt whatever key the server actually stored under. Part II §G has it retry a
  // duplicate (user_id, started) at started + 1, so the row it wrote may not be the
  // one we sent — without this the next sync() pulls that session back down as a
  // second, near-identical record one second apart.
  function reconcilePush(sent, echo) {
    var list = readRecords(), at = findByStarted(list, sent), srv;
    if (at < 0) return;                      // pruned by the cap while in flight
    srv = secs(echo && echo.started);
    if (srv && srv !== list[at].started && findByStarted(list, srv) < 0) list[at].started = srv;
    list[at].synced = 1;
    sortRecords(list);
    writeRecords(list);
  }

  // Fold the server's rows into the local set, keyed on `started` per Part I §13.
  // Returns how many were genuinely new (i.e. came from another device).
  function mergeServer(rows) {
    var list = readRecords(), byStart = {}, added = 0, i, r, at;
    for (i = 0; i < list.length; i++) byStart[list[i].started] = i;
    for (i = 0; i < rows.length; i++) {
      r = normRecord(rows[i]);
      if (!r) continue;
      r.synced = 1;                          // it is on the server by definition
      at = byStart[r.started];
      // Already present: the SAME session, round-tripped through the server's
      // clamps. Keep the local original — it carries the untruncated detail — and
      // record only that it is safe. Overwriting every field would rewrite the
      // whole key on every sync for no observable gain.
      if (at !== undefined) { list[at].synced = 1; continue; }
      byStart[r.started] = list.length;
      list.push(r);
      added++;
    }
    sortRecords(list);
    writeRecords(list);
    return added;
  }

  // Drain unsynced records oldest-first, SEQUENTIALLY, stopping at the first
  // refusal: if the server is rate-limiting or the network is down, the remaining
  // requests fail for exactly the same reason and only deepen the hole.
  function pushBacklog(out) {
    var list = readRecords(), pending = [], i, chain;
    for (i = list.length - 1; i >= 0; i--) if (!list[i].synced) pending.push(list[i]);
    if (pending.length > PUSH_PER_SYNC) pending.length = PUSH_PER_SYNC;
    chain = Promise.resolve(true);
    pending.forEach(function (r) {
      chain = chain.then(function (okSoFar) {
        if (!okSoFar) return false;
        return push(r).then(function (sent) { if (sent) out.pushed++; return sent; });
      });
    });
    return chain.then(function () { return out; });
  }

  function resolveUser() {
    var A = api();
    if (signedInState !== null) return Promise.resolve(signedInState);
    if (!A || !A.me) return Promise.resolve(false);
    // api.js:302 me() resolves {user:null} and never rejects, so the catch is
    // belt-and-braces against a future shape change rather than a live path.
    return A.me().then(function (j) {
      signedInState = !!(j && j.user);
      return signedInState;
    }, function () { return false; });
  }

  // NEVER rejects. It is called at page boot for a feature that is additive by
  // design, and an unhandled rejection there is noise the user cannot act on; the
  // reason a sync did nothing travels in the resolved value instead.
  //   -> {cloud, signedIn, pulled, pushed, serverStats, error}
  function sync() {
    var out = { cloud: CLOUD, signedIn: false, pulled: 0, pushed: 0, serverStats: null, error: '' };
    var A = api();
    if (!CLOUD || !A || !A.learnListSessions) return Promise.resolve(out);
    return resolveUser().then(function (isIn) {
      out.signedIn = isIn;
      if (!isIn) return out;
      return A.learnListSessions(PULL_LIMIT).then(function (j) {
        out.serverStats = (j && j.stats) || null;
        out.pulled = mergeServer((j && j.sessions) || []);
        return pushBacklog(out);
      }, function (e) {
        out.error = (e && e.code) || 'offline';
        // The pull and the push fail independently. Still try to drain the
        // backlog: a POST that lands is a session that stops being one cleared
        // browser profile away from gone.
        return pushBacklog(out);
      });
    });
  }

  // learn.js already calls Api.me() to render the header's auth slot (Part II §E);
  // handing the answer over here saves a second /me round trip, and is the
  // difference between a signed-out cloud user spending one doomed POST per
  // session and spending none.
  function setUser(u) {
    if (u && typeof u === 'object' && has(u, 'user')) u = u.user;   // tolerate api.js:307's {user} envelope
    signedInState = !!u;
  }
  function signedIn() { return signedInState; }

  /* ====================== stats ====================== */
  // Derived from the LOCAL set — which after a sync() is a superset of this
  // device's own history — so every number here is available offline and outside
  // cloud mode. The server's own aggregate is a separate thing, returned by
  // sync() as `serverStats`, and is never needed to draw the HUD.
  //
  //   -> { streak, todayMin, todaySec, todaySessions, totalSessions, totalMin,
  //        byLevel: [{level, sessions, questions, correct, accuracy, sec}] x7 }
  function stats() {
    var list = readRecords(), byDaySec = {}, byLevel = [], i, r, d;
    var today = dayIndex(nowSec()), totalSec = 0, todaySessions = 0, streak = 0;

    // All seven rungs are always present so a renderer can map straight over them
    // without holes; Part I §3 fixes the ladder at seven.
    for (i = 0; i < MAX_LEVEL; i++) {
      byLevel.push({ level: i + 1, sessions: 0, questions: 0, correct: 0, accuracy: 0, sec: 0 });
    }
    for (i = 0; i < list.length; i++) {
      r = list[i];
      d = dayIndex(r.started);
      byDaySec[d] = (byDaySec[d] || 0) + r.durationSec;
      if (d === today) todaySessions++;
      totalSec += r.durationSec;
      var b = byLevel[r.level - 1];
      b.sessions++; b.questions += r.questions; b.correct += r.correct; b.sec += r.durationSec;
    }
    for (i = 0; i < byLevel.length; i++) {
      byLevel[i].accuracy = byLevel[i].questions ? (byLevel[i].correct / byLevel[i].questions) : 0;
    }

    // Walk back a day at a time; a day counts at five practised minutes (Part I
    // §8). The walk STARTS at yesterday when today is still short, so a streak is
    // not destroyed at 00:00 by the mere fact that the user has not practised
    // *yet* — only a whole day going by unpractised breaks it. Compared on
    // SECONDS, never on the rounded todayMin, so 4:59 cannot count as five.
    d = today;
    if ((byDaySec[today] || 0) < STREAK_MIN_SEC) d = today - 1;
    while ((byDaySec[d] || 0) >= STREAK_MIN_SEC) { streak++; d--; }

    var todaySec = byDaySec[today] || 0;
    return {
      streak: streak,
      // Floored, not rounded: against the 10-minute goal in Part I §8, rounding
      // 9:40 up to "10 min" would tell the user they were done when they were not.
      todayMin: Math.floor(todaySec / 60),
      todaySec: todaySec,
      todaySessions: todaySessions,
      totalSessions: list.length,
      totalMin: Math.floor(totalSec / 60),
      byLevel: byLevel
    };
  }

  return {
    settings: settings, saveSettings: saveSettings, defaults: defaults,
    records: records, add: add, sync: sync, stats: stats,
    setUser: setUser, signedIn: signedIn,
    cloud: function () { return CLOUD; }
  };
})();
