/* ============================================================================
 * test-ear.js  —  Node harness for the three PURE modules of /learn.
 *
 * ear-theory.js, ear-session.js and ear-pitch.js#detect carry the dual-export
 * tail (contract §A) precisely so they can be exercised head-less, with no DOM,
 * no AudioContext and no microphone. Everything they own is either arithmetic
 * or a state machine, which means every claim the design makes about them is
 * checkable here rather than by ear at 1 a.m.
 *
 * Three of the assertions below are load-bearing rather than decorative:
 *
 *   • KEY SPELLING. keyName() saying 'D♯ major' instead of 'E♭ major' is the
 *     kind of bug that ships silently — the app still works, it is merely
 *     wrong in a way only a musician notices, and then it teaches the wrong
 *     thing. Every flat key and the one sharp key are pinned by name.
 *   • THE TAPER. Holding a tonal centre across intervening questions IS the
 *     memory drill (design §6). If the key quietly changes every question the
 *     app still looks fine and the exercise is gone, so the question stream is
 *     driven for twelve questions and the key transitions are asserted.
 *   • OCTAVE HALVING. MPM exists instead of plain autocorrelation for exactly
 *     one reason: autocorrelation reports f/2 on a harmonic-rich voice, and a
 *     trainer that marks a correct answer wrong is worse than no trainer. The
 *     sawtooth cases are the single most important thing in this file.
 *
 * Style follows test-core.js: a flat script, '== section ==' banners, one
 * one-line ok(), inline fixtures, process.exit(failures ? 1 : 0). Randomness is
 * always a seeded rnd() — the modules take it injected (contract §F) so that
 * these runs are byte-identical every time and a failure is never "flaky".
 *
 *   run:  node tab-studio/test-ear.js       (or `npm test`, which runs both)
 * ========================================================================== */
var path = require('path');

var LEARN   = path.join(__dirname, 'web', 'learn');
var Theory  = require(path.join(LEARN, 'ear-theory.js'));
var Session = require(path.join(LEARN, 'ear-session.js'));
var Pitch   = require(path.join(LEARN, 'ear-pitch.js'));

var failures = 0;
function ok(cond, msg) { console.log((cond ? '  ok  ' : ' FAIL ') + msg); if (!cond) failures++; }

var FLAT = Theory.FLAT, SHARP = Theory.SHARP;

// ---- helpers ---------------------------------------------------------------

// xorshift32. Any seeded generator would do; what matters is that it is OURS,
// so the question stream in this file never depends on Math.random() and a
// failure can always be reproduced from the seed printed beside it.
function rndFrom(seed) {
  var s = (seed >>> 0) || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

function zeros(n) { var a = [], i; for (i = 0; i < n; i++) a.push(0); return a; }
function med(list) {
  var a = list.slice().sort(function (x, y) { return x - y; }), h = a.length >> 1;
  return Math.round(a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2);
}
function centsBetween(a, b) { return 1200 * Math.log(a / b) / Math.LN2; }
function f2(n) { return Math.round(n * 100) / 100; }

// Signal fixtures. `phase` is deliberately non-zero everywhere: a buffer that
// starts exactly at a period boundary is the one case a periodicity detector
// finds easiest, and testing only that would flatter the algorithm.
function sineBuf(hz, sr, n, amp, phase) {
  var x = new Float32Array(n), i;
  for (i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * (hz * i / sr + phase));
  return x;
}
// Naive (aliasing) sawtooth — on purpose. Every harmonic is present at full
// strength, which is the worst case for octave errors and nothing like the
// polite band-limited saw a synth would produce.
function sawBuf(hz, sr, n, amp, phase) {
  var x = new Float32Array(n), i, p;
  for (i = 0; i < n; i++) { p = ((hz * i / sr) + phase) % 1; x[i] = amp * (2 * p - 1); }
  return x;
}
// A harmonic stack with an arbitrary phase per partial. amps[0] is the
// fundamental, so amps[0] === 0 builds a MISSING-fundamental tone — which is
// what a sung vowel through a small speaker or a phone mic actually looks like.
function harmBuf(hz, sr, n, amps) {
  var x = new Float32Array(n), i, h, v;
  for (i = 0; i < n; i++) {
    v = 0;
    for (h = 0; h < amps.length; h++) {
      v += amps[h] * Math.sin(2 * Math.PI * hz * (h + 1) * i / sr + h * 0.7);
    }
    x[i] = 0.2 * v;
  }
  return x;
}
function noiseBuf(n, amp, rnd) {
  var x = new Float32Array(n), i;
  for (i = 0; i < n; i++) x[i] = (rnd() * 2 - 1) * amp;
  return x;
}

var W  = 2048;      // ear-pitch.js:66 analysis window
var SR = 48000;

/* ==========================================================================
 * ear-theory
 * ======================================================================== */

console.log('== ear-theory: the twelve degrees ==');
ok(Theory.DEGREES.length === 12, 'DEGREES has 12 entries (' + Theory.DEGREES.length + ')');
var blackN = 0, whiteN = 0, pcIndexed = true, labelled = true, i, d;
for (i = 0; i < Theory.DEGREES.length; i++) {
  d = Theory.DEGREES[i];
  if (d.black) blackN++; else whiteN++;
  if (d.pc !== i) pcIndexed = false;
  if (!d.num || !d.solfege) labelled = false;
}
ok(blackN === 5 && whiteN === 7, '5 black / 7 white degrees (' + blackN + '/' + whiteN + ')');
// The answer keyboard indexes straight into DEGREES by pitch class, so this is
// a structural requirement and not merely tidy.
ok(pcIndexed, 'DEGREES[i].pc === i — the table doubles as the answer index');
ok(labelled, 'every degree carries both a number and a solfège syllable');
ok(Theory.DEGREES[3].num === FLAT + '3' && Theory.DEGREES[3].solfege === 'me',
   'do-based minor: pc 3 is ' + FLAT + '3 / me, not the 2nd of a relative major');
ok(Theory.label(3, 'numbers') === FLAT + '3' && Theory.label(3, 'solfege') === 'me' &&
   Theory.label(3, 'both') === FLAT + '3 · me' && Theory.label(3) === FLAT + '3',
   'label() honours numbers | solfege | both, and defaults to numbers');

console.log('\n== ear-theory: the level ladder ==');
ok(Theory.LEVELS.length === 7, 'seven levels (' + Theory.LEVELS.length + ')');
var lvBad = [], lv, j;
for (i = 0; i < Theory.LEVELS.length; i++) {
  lv = Theory.LEVELS[i];
  if (lv.n !== i + 1) lvBad.push('L' + lv.n + ' out of order');
  if (!lv.degrees || !lv.degrees.length) lvBad.push('L' + lv.n + ' has no degrees');
  for (j = 0; j < lv.degrees.length; j++) {
    if (!(lv.degrees[j] >= 0 && lv.degrees[j] <= 11 && lv.degrees[j] === Math.round(lv.degrees[j])))
      lvBad.push('L' + lv.n + ' degree ' + lv.degrees[j] + ' outside 0..11');
    if (lv.degrees.indexOf(lv.degrees[j]) !== j) lvBad.push('L' + lv.n + ' repeats ' + lv.degrees[j]);
  }
  if (lv.mode !== 'major' && lv.mode !== 'minor') lvBad.push('L' + lv.n + ' bad mode');
  if (lv.spread !== 1 && lv.spread !== 2) lvBad.push('L' + lv.n + ' bad spread');
}
ok(lvBad.length === 0, 'every level: non-empty, unique degrees inside 0..11, sane mode/spread' +
   (lvBad.length ? ' — ' + lvBad.join('; ') : ''));
ok(Theory.LEVELS[0].degrees.join(',') === '0,2,4', 'L1 is exactly [0,2,4] — do re mi (' +
   Theory.LEVELS[0].degrees.join(',') + ')');
ok(Theory.LEVELS[6].degrees.length === 12, 'L7 is all twelve');
// L4 exists only to isolate register from vocabulary (design §3); if its degree
// set ever drifted from L3's the level would stop being that experiment.
ok(Theory.LEVELS[3].degrees.join(',') === Theory.LEVELS[2].degrees.join(',') &&
   Theory.LEVELS[3].spread === 2 && Theory.LEVELS[2].spread === 1,
   'L4 differs from L3 by register spread ALONE');
ok(Theory.levelFor(0).n === 1 && Theory.levelFor(99).n === 7 && Theory.levelFor(5).n === 5,
   'levelFor() clamps to 1..7');

console.log('\n== ear-theory: key spelling (flat keys as flats, sharp keys as sharps) ==');
// The four the design calls out by name (Part I §12 / contract §F). A sharp-only
// NAMES table would print D♯ / A♯ / G♯ / G♭ here and nothing else would break.
ok(Theory.keyName(10, 'major') === 'B' + FLAT,  'pc 10 major is B' + FLAT + ', not A' + SHARP + ' (' + Theory.keyName(10, 'major') + ')');
ok(Theory.keyName(3,  'major') === 'E' + FLAT,  'pc 3 major is E' + FLAT + ', not D' + SHARP + ' (' + Theory.keyName(3, 'major') + ')');
ok(Theory.keyName(8,  'major') === 'A' + FLAT,  'pc 8 major is A' + FLAT + ', not G' + SHARP + ' (' + Theory.keyName(8, 'major') + ')');
ok(Theory.keyName(6,  'major') === 'F' + SHARP, 'pc 6 major is F' + SHARP + ' (' + Theory.keyName(6, 'major') + ')');
// The whole circle, both directions. F/B♭/E♭/A♭/D♭ flat, G/D/A/E/B/F♯ sharp.
var MAJ = { 0: 'C', 1: 'D' + FLAT, 2: 'D', 3: 'E' + FLAT, 4: 'E', 5: 'F',
            6: 'F' + SHARP, 7: 'G', 8: 'A' + FLAT, 9: 'A', 10: 'B' + FLAT, 11: 'B' };
var MIN = { 0: 'C', 1: 'C' + SHARP, 2: 'D', 3: 'E' + FLAT, 4: 'E', 5: 'F',
            6: 'F' + SHARP, 7: 'G', 8: 'G' + SHARP, 9: 'A', 10: 'B' + FLAT, 11: 'B' };
var keyBad = [], nm;
for (i = 0; i < 12; i++) {
  if (Theory.keyName(i, 'major') !== MAJ[i]) keyBad.push('major ' + i + '=' + Theory.keyName(i, 'major'));
  if (Theory.keyName(i, 'minor') !== MIN[i]) keyBad.push('minor ' + i + '=' + Theory.keyName(i, 'minor'));
}
ok(keyBad.length === 0, 'all 24 key names spelled off the circle of fifths' +
   (keyBad.length ? ' — ' + keyBad.join(', ') : ''));
// The minor circle sits three fifths flatter, so it is NOT the major list: pc 1
// is C♯ minor (4♯) but D♭ major (5♭), and pc 8 is G♯ minor but A♭ major.
ok(Theory.keyName(1, 'minor') !== Theory.keyName(1, 'major') &&
   Theory.keyName(8, 'minor') !== Theory.keyName(8, 'major'),
   'minor keys are not the major names reused (C' + SHARP + ' minor vs D' + FLAT + ' major)');
var asciiBad = [];
for (i = 0; i < 12; i++) {
  nm = Theory.keyName(i, 'major') + Theory.keyName(i, 'minor');
  if (nm.indexOf('b') >= 0 || nm.indexOf('#') >= 0) asciiBad.push(String(i));
}
ok(asciiBad.length === 0, 'accidentals are the real ' + FLAT + '/' + SHARP +
   ' glyphs, never ASCII b/#' + (asciiBad.length ? ' — pc ' + asciiBad.join(',') : ''));
ok(Theory.keyLabel(3, 'major') === 'E' + FLAT + ' major' &&
   Theory.keyLabel(3, 'minor') === 'E' + FLAT + ' minor',
   'keyLabel() appends the mode');

console.log('\n== ear-theory: note spelling follows the key ==');
// The example the contract gives: the ♭7 of E♭ major is D♭. C♯ would be the same
// key on the piano and the wrong letter on the page.
ok(Theory.spellDegree(10, 3, 'major') === 'D' + FLAT,
   FLAT + '7 of E' + FLAT + ' major is D' + FLAT + ', not C' + SHARP + ' (' + Theory.spellDegree(10, 3, 'major') + ')');
ok(Theory.noteName(61, 3, 'major') === 'D' + FLAT + '4',
   'MIDI 61 in E' + FLAT + ' major is D' + FLAT + '4 (' + Theory.noteName(61, 3, 'major') + ')');
ok(Theory.spellDegree(4, 9, 'major') === 'C' + SHARP,
   '3 of A major is C' + SHARP + ' — a sharp key really does get sharps (' + Theory.spellDegree(4, 9, 'major') + ')');
ok(Theory.spellDegree(5, 5, 'major') === 'B' + FLAT, '4 of F major is B' + FLAT);
ok(Theory.spellDegree(11, 10, 'major') === 'A', '7 of B' + FLAT + ' major is a plain A');
// E♭ minor carries six flats, so its ♭6 is C♭ — and C♭5 SOUNDS as B4. The octave
// number has to follow the letter, not the sounding pitch (ear-theory.js:201-204).
ok(Theory.spellDegree(8, 3, 'minor') === 'C' + FLAT,
   FLAT + '6 of E' + FLAT + ' minor is C' + FLAT + ' (' + Theory.spellDegree(8, 3, 'minor') + ')');
ok(Theory.noteName(71, 3, 'minor') === 'C' + FLAT + '5',
   'MIDI 71 there is C' + FLAT + '5, not B4 — the octave belongs to the letter (' +
   Theory.noteName(71, 3, 'minor') + ')');
ok(Theory.noteName(60, 0, 'major') === 'C4', 'middle C is C4 (' + Theory.noteName(60, 0, 'major') + ')');
// ear-theory.js:141-143 claims no key × degree ever needs a double accidental.
// That is a claim about 24 × 12 cases, so check all 288 of them.
var fat = [], nameLen = {};
for (i = 0; i < 12; i++) {
  for (j = 0; j < 12; j++) {
    nm = Theory.spellDegree(j, i, 'major');
    if (nm.length > 2) fat.push(Theory.keyName(i, 'major') + ' major deg ' + j + ' = ' + nm);
    nm = Theory.spellDegree(j, i, 'minor');
    if (nm.length > 2) fat.push(Theory.keyName(i, 'minor') + ' minor deg ' + j + ' = ' + nm);
  }
}
ok(fat.length === 0, 'no double accidentals over all 24 keys x 12 degrees' +
   (fat.length ? ' — ' + fat.slice(0, 4).join('; ') : ''));

console.log('\n== ear-theory: degreeOf / midiForDegree round-trip ==');
var tries = 0, rtBad = [], tonics = [0, 3, 6, 7, 10, 11], octs = [2, 3, 4, 5], m;
for (i = 0; i < tonics.length; i++) {
  for (j = 0; j < octs.length; j++) {
    for (var deg = 0; deg < 12; deg++) {
      m = Theory.midiForDegree(deg, tonics[i], octs[j]);
      tries++;
      if (Theory.degreeOf(m, tonics[i]) !== deg)
        rtBad.push('tonic ' + tonics[i] + ' oct ' + octs[j] + ' deg ' + deg + ' -> ' + m);
      // Octave-invariance is the whole premise (design §1): the same degree an
      // octave away must still read as that degree.
      if (Theory.degreeOf(m + 12, tonics[i]) !== deg) rtBad.push('deg ' + deg + ' not octave-invariant');
    }
  }
}
ok(rtBad.length === 0, 'all ' + tries + ' degree round-trips, octave-invariant' +
   (rtBad.length ? ' — ' + rtBad.slice(0, 3).join('; ') : ''));
ok(Theory.midiForDegree(0, 0, 4) === 60, 'the tonic of C at octave 4 is middle C');
ok(Theory.midiForDegree(11, 10, 3) === 69, 'the 7 of B' + FLAT + ' at octave 3 is A4 = MIDI 69');

console.log('\n== ear-theory: play band ==');
// A voice range already wider than the level needs comes back untouched — this
// is the "stays inside the given voice range" property.
var b = Theory.playBand(43, 67, 1);
ok(b.lo === 43 && b.hi === 67, 'baritone 43-67, one octave: band is the voice range exactly (' +
   b.lo + '-' + b.hi + ')');
b = Theory.playBand(40, 64, 1);
ok(b.lo === 40 && b.hi === 64, 'bass 40-64, one octave: band is the voice range exactly');
// Every preset in design §9, both spreads. The band must always be legal, must
// never leave 40..88, and must be wide enough to seat a tonic anywhere in its
// bottom octave plus the level's spread above it (ear-theory.js:356-362).
var PRESETS = [[40, 64], [43, 67], [48, 69], [53, 74], [60, 81]];
var bandBad = [], need, sp, p;
for (i = 0; i < PRESETS.length; i++) {
  for (sp = 1; sp <= 2; sp++) {
    p = PRESETS[i];
    b = Theory.playBand(p[0], p[1], sp);
    need = 12 * sp + 10;
    if (!(b.lo >= 40 && b.hi <= 88)) bandBad.push(p.join('-') + '/' + sp + ' leaves 40..88');
    if (b.hi - b.lo < need) bandBad.push(p.join('-') + '/' + sp + ' only ' + (b.hi - b.lo) + ' wide');
    if (b.lo !== Math.round(b.lo) || b.hi !== Math.round(b.hi)) bandBad.push('non-integer band');
  }
}
ok(bandBad.length === 0, 'all five voice presets x both spreads give a legal band' +
   (bandBad.length ? ' — ' + bandBad.join('; ') : ''));
b = Theory.playBand(60, 62, 2);
ok(b.hi - b.lo >= 34 && b.lo >= 40 && b.hi <= 88,
   'an absurdly narrow range is widened, not left unplayable (' + b.lo + '-' + b.hi + ')');
b = Theory.playBand(70, 50, 1);
ok(b.lo >= 40 && b.hi > b.lo, 'a reversed/garbage range falls back to something playable (' +
   b.lo + '-' + b.hi + ')');

console.log('\n== ear-theory: cadences ==');
// The chord each step must sound, as pitch classes above the tonic. Written out
// rather than derived, so a change to PROG or QUAL has to be defended here.
var EXPECT = {
  'cadence|major': [[0, 4, 7], [5, 9, 0], [7, 11, 2], [0, 4, 7]],
  'cadence|minor': [[0, 3, 7], [5, 8, 0], [7, 11, 2], [0, 3, 7]],
  'ii-V-I|major': [[2, 5, 9, 0], [7, 11, 2, 5], [0, 4, 7, 11]],
  'ii-V-I|minor': [[2, 5, 8, 0], [7, 11, 2, 5], [0, 3, 7]]
};
function pcSet(midis, tonicPc) {
  var seen = {}, out = [], k, v;
  for (k = 0; k < midis.length; k++) {
    v = ((midis[k] - tonicPc) % 12 + 12) % 12;
    if (!seen[v]) { seen[v] = 1; out.push(v); }
  }
  return out.sort(function (x, y) { return x - y; }).join(',');
}
var cadBad = [], KINDS = ['cadence', 'ii-V-I'], MODES = ['major', 'minor'];
var TONICS = [0, 3, 6, 10], ch, chs, k, want;
for (i = 0; i < KINDS.length; i++) {
  for (j = 0; j < MODES.length; j++) {
    want = EXPECT[KINDS[i] + '|' + MODES[j]];
    for (var ti = 0; ti < TONICS.length; ti++) {
      chs = Theory.cadence(KINDS[i], TONICS[ti], MODES[j]);
      var tag = KINDS[i] + '/' + MODES[j] + '/' + Theory.keyName(TONICS[ti], MODES[j]);
      if (chs.length !== want.length) { cadBad.push(tag + ' has ' + chs.length + ' chords'); continue; }
      for (k = 0; k < chs.length; k++) {
        ch = chs[k];
        if (pcSet(ch.midis, TONICS[ti]) !== want[k].slice().sort(function (x, y) { return x - y; }).join(','))
          cadBad.push(tag + ' chord ' + (k + 1) + ' = {' + pcSet(ch.midis, TONICS[ti]) + '}');
        if (!(ch.beats > 0)) cadBad.push(tag + ' chord ' + (k + 1) + ' has no duration');
        if (!ch.roman || !ch.name) cadBad.push(tag + ' chord ' + (k + 1) + ' is unlabelled');
        // The bass sits in C3..B3 and the three upper voices in G3..G5
        // (ear-theory.js:265-267) — a cadence that wandered out of that window
        // would fight the test note for register.
        if (!(ch.midis[0] >= 48 && ch.midis[0] <= 59)) cadBad.push(tag + ' bass ' + ch.midis[0]);
        for (var vi = 1; vi < ch.midis.length; vi++) {
          if (!(ch.midis[vi] >= 55 && ch.midis[vi] <= 79)) cadBad.push(tag + ' upper voice ' + ch.midis[vi]);
          if (ch.midis[vi] < ch.midis[vi - 1]) cadBad.push(tag + ' voicing not ascending');
        }
      }
    }
  }
}
ok(cadBad.length === 0, 'I-IV-V-I and ii-V-I, both modes, four keys: right chords, sane voicing' +
   (cadBad.length ? ' — ' + cadBad.slice(0, 4).join('; ') : ''));
// The raised leading tone is what makes the ear hear a MINOR TONIC rather than
// the relative major's vi, so the V of a minor cadence must stay major.
var minorV = Theory.cadence('cadence', 0, 'minor')[2];
ok(pcSet(minorV.midis, 0) === '2,7,11', 'the V of a minor cadence keeps its major third (' +
   pcSet(minorV.midis, 0) + ')');
var dr = Theory.cadence('drone', 3, 'major');
ok(dr.length === 1 && dr[0].midis.length === 1 && dr[0].midis[0] % 12 === 3 &&
   dr[0].midis[0] >= 48 && dr[0].midis[0] <= 59,
   'drone is one sustained tonic in the bass octave (MIDI ' + dr[0].midis[0] + ')');
ok(Theory.cadence('nonsense', 0, 'major').length === 4, 'an unknown kind falls back to I-IV-V-I');

console.log('\n== ear-theory: nextQuestion, seeded ==');
// Drive the documented state (ear-theory.js:396-416) by hand, exactly as a
// caller must. taper 1 forces a fresh key EVERY question, which is what makes
// the "never the same key back-to-back" rule observable at all.
var rnd = rndFrom(20260813);
var N = 400, st = { level: 7, questionIndex: 0, taper: 1, lastKey: null, lastDegrees: [],
                    voiceLo: 43, voiceHi: 67, voice: 'random' };
var band7 = Theory.playBand(43, 67, 2);
var repeatKeys = 0, run = 1, maxRun = 1, offLevel = 0, offBand = 0, badVoice = 0;
var seenDeg = {}, prevKey = null, prevDeg = null, q;
for (i = 0; i < N; i++) {
  st.questionIndex = i;
  q = Theory.nextQuestion(st, rnd);
  if (prevKey !== null && q.tonicPc === prevKey) repeatKeys++;
  if (Theory.LEVELS[6].degrees.indexOf(q.degree) < 0) offLevel++;
  if (q.midi < band7.lo || q.midi > band7.hi) offBand++;
  if (Theory.VOICES.indexOf(q.voice) < 0) badVoice++;
  seenDeg[q.degree] = 1;
  if (q.degree === prevDeg) { run++; if (run > maxRun) maxRun = run; } else run = 1;
  prevDeg = q.degree; prevKey = q.tonicPc;
  st.lastKey = q.tonicPc;
  st.lastDegrees = [q.degree].concat(st.lastDegrees).slice(0, 2);   // newest FIRST
}
ok(repeatKeys === 0, 'over ' + N + ' draws the key never repeats back-to-back (' + repeatKeys + ' repeats)');
ok(maxRun <= 2, 'no degree is ever asked three times running (longest run ' + maxRun + ')');
var seenN = 0;
for (k in seenDeg) if (seenDeg.hasOwnProperty(k)) seenN++;
ok(offLevel === 0, 'every degree drawn belongs to L7 (' + offLevel + ' strays)');
ok(seenN === 12, 'and all twelve of them get asked (' + seenN + '/12)');
ok(offBand === 0, 'every test note lands inside playBand ' + band7.lo + '-' + band7.hi +
   ' (' + offBand + ' strays)');
ok(badVoice === 0, 'every timbre drawn is one of the six voices');
// Every level, not just L7 — a level whose pool leaked would be silently harder.
var poolBad = [];
for (var L = 1; L <= 7; L++) {
  var lvl = Theory.levelFor(L), r2 = rndFrom(1000 + L);
  var s2 = { level: L, questionIndex: 0, taper: 1, lastKey: null, lastDegrees: [],
             voiceLo: 43, voiceHi: 67, voice: 'random' };
  var bandL = Theory.playBand(43, 67, lvl.spread);
  for (i = 0; i < 120; i++) {
    s2.questionIndex = i;
    q = Theory.nextQuestion(s2, r2);
    if (lvl.degrees.indexOf(q.degree) < 0) poolBad.push('L' + L + ' drew ' + q.degree);
    if (q.mode !== lvl.mode) poolBad.push('L' + L + ' mode ' + q.mode);
    if (q.midi < bandL.lo || q.midi > bandL.hi) poolBad.push('L' + L + ' midi ' + q.midi);
    s2.lastKey = q.tonicPc;
    s2.lastDegrees = [q.degree].concat(s2.lastDegrees).slice(0, 2);
  }
}
ok(poolBad.length === 0, 'L1..L7: 120 draws each stay in the level set, mode and band' +
   (poolBad.length ? ' — ' + poolBad.slice(0, 3).join('; ') : ''));
// Register spread is a settings control in its own right (design §12), not just
// a level default — so an explicit spread has to change what is actually drawn,
// the way an explicit taper does. Measured as the span of notes a level-1 pool
// (do re mi, three degrees) covers over 300 draws.
function spanFor(level, spread, seed) {
  var s = { level: level, questionIndex: 0, taper: 1, lastKey: null, lastDegrees: [],
            voiceLo: 43, voiceHi: 67, spread: spread }, rr = rndFrom(seed);
  var lo = 999, hi = -999, n, x;
  for (n = 0; n < 300; n++) {
    s.questionIndex = n;
    x = Theory.nextQuestion(s, rr);
    if (x.midi < lo) lo = x.midi;
    if (x.midi > hi) hi = x.midi;
    s.lastKey = x.tonicPc;
    s.lastDegrees = [x.degree].concat(s.lastDegrees).slice(0, 2);
  }
  return hi - lo;
}
var span1 = spanFor(1, 1, 21), span2 = spanFor(1, 2, 21);
ok(span2 > span1 + 8, 'an explicit spread overrides the level default: L1 covers ' + span1 +
   ' semitones at spread 1 and ' + span2 + ' at spread 2');
ok(spanFor(4, 1, 21) < spanFor(4, 2, 21), '...and narrows a wide level too (L4 at spread 1 vs 2: ' +
   spanFor(4, 1, 21) + ' vs ' + spanFor(4, 2, 21) + ')');

// A pinned timbre must never be overridden, including by the low-register rule.
var fixedBad = 0, s3 = { level: 7, questionIndex: 0, taper: 1, lastKey: null, lastDegrees: [],
                         voiceLo: 40, voiceHi: 52, voice: 'flute' }, r3 = rndFrom(77);
for (i = 0; i < 60; i++) { s3.questionIndex = i; if (Theory.nextQuestion(s3, r3).voice !== 'flute') fixedBad++; }
ok(fixedBad === 0, 'a pinned timbre survives even in the low register (' + fixedBad + ' overrides)');
// Determinism is the reason rnd is injected at all (contract §F).
function stream(seed) {
  var r = rndFrom(seed), s = { level: 6, questionIndex: 0, taper: 2, lastKey: null,
                               lastDegrees: [], voiceLo: 43, voiceHi: 67 }, out = [], x;
  for (var n = 0; n < 40; n++) {
    s.questionIndex = n;
    x = Theory.nextQuestion(s, r);
    out.push(x.tonicPc + ':' + x.degree + ':' + x.midi + ':' + (x.newKey ? 1 : 0));
    s.lastKey = x.tonicPc;
    s.lastDegrees = [x.degree].concat(s.lastDegrees).slice(0, 2);
  }
  return out.join(' ');
}
ok(stream(4242) === stream(4242) && stream(4242) !== stream(4243),
   'the same seed gives the same session, a different seed a different one');

/* ==========================================================================
 * ear-session
 * ======================================================================== */

console.log('\n== ear-session: a fully scripted session ==');
// A fake clock is a documented test seam (ear-session.js:157). Every advance
// below is milliseconds; the record must come back in unix SECONDS.
var CLOCK = 1755000000000;
function clock() { return CLOCK; }

var L5 = Theory.levelFor(5).degrees;            // [0,2,3,5,7,8,10], natural minor
var START = CLOCK;
var sess = Session.create({
  level: 5, mode: 'identify', context: 'cadence', taper: 2,
  length: { kind: 'questions', value: 16 },
  voiceLo: 43, voiceHi: 67, singGate: false, voice: 'random',
  labelStyle: 'numbers', clock: clock
}, rndFrom(20260813));

// The wrong answer is always "the tonic" (or the 5 when the tonic IS the
// target) — the classic beginner miss, and deterministic, so the confusion
// table this produces can be predicted exactly.
function wrongFor(deg) { return deg === 0 ? 7 : 0; }
var DELTAS = [300, 420, 260, 900, 350, 610, 480, 240, 770, 330, 520, 410, 290, 680, 450, 360];
var PAUSE_MS = 5000;

var expAsked = zeros(12), expRight = zeros(12), expConf = [], expMs = [];
var expCorrect = 0, expAssists = 0, res, ans, wrongQ, trial;
function bumpConf(t, a) {
  var n;
  for (n = 0; n < expConf.length; n++)
    if (expConf[n].target === t && expConf[n].answered === a) { expConf[n].n++; return; }
  expConf.push({ target: t, answered: a, n: 1 });
}

var midQ = null;
for (i = 0; i < 16; i++) {
  trial = sess.next();
  // "Hear it again" BEFORE the commit is the counted escape hatch (design §4).
  if (i === 0) { sess.assist(); sess.assist(); expAssists += 2; }
  if (i === 5) { sess.assist(); expAssists += 1; }
  sess.ready();
  // A pause in the middle of a trial must fall out of both the response time
  // and the session duration, or every stat becomes a measure of coffee breaks.
  if (i === 9) { sess.pause(); CLOCK += PAUSE_MS; sess.resume(); }
  CLOCK += DELTAS[i];
  wrongQ = (i % 4 === 3);
  ans = wrongQ ? wrongFor(trial.degree) : trial.degree;
  res = sess.answer(ans);
  if (res.correct !== !wrongQ || res.target !== trial.degree) midQ = 'answer() verdict wrong at q' + i;
  if (res.ms !== DELTAS[i]) midQ = 'q' + i + ' ms ' + res.ms + ' != ' + DELTAS[i];
  expAsked[trial.degree]++;
  if (wrongQ) bumpConf(trial.degree, ans); else { expRight[trial.degree]++; expCorrect++; }
  expMs.push(DELTAS[i]);
  // Replay in REVEAL is the study phase and is free (design §4) — this must not
  // move the counter.
  if (i === 0) sess.assist();
  // A keydown and a click can both fire for one commit; the second must be a
  // no-op rather than a second row in the confusion table.
  if (i === 1) sess.answer(wrongFor(trial.degree));
  if (i === 2) sess.singResult(14);
  if (i === 6) { sess.singResult(-32); sess.singResult(25); }   // re-sing REPLACES
  if (i === 10) sess.singResult(-7);
  CLOCK += 120;                                  // the reveal / study gap
}
ok(midQ === null, 'answer() reports the right verdict, target and response time on all 16' +
   (midQ ? ' — ' + midQ : ''));
ok(sess.done(), 'a 16-question session is done() after 16 answers');

var rec = sess.finish();
ok(rec.questions === 16 && rec.correct === expCorrect && expCorrect === 12,
   'record counts 16 asked / ' + rec.correct + ' correct (expected 12)');
ok(rec.assists === expAssists && expAssists === 3,
   rec.assists + ' assists counted — and the two study-phase replays were free');
// The point of the assist counter is that it is reported ALONGSIDE accuracy,
// never subtracted from it.
ok(rec.correct / rec.questions === 0.75, 'accuracy is still 12/16 = 0.75 despite the assists (' +
   rec.correct / rec.questions + ')');
ok(rec.level === 5 && rec.mode === 'identify' && rec.context === 'cadence' &&
   rec.taper === 2 && rec.singGate === 0,
   'the record carries the settings it was run with');
// House rule: anything persisted is unix SECONDS. A millisecond stamp here
// would be ~1.7e12 and would render as the year 57000 (contract §A).
ok(rec.started === Math.floor(START / 1000) && rec.started < 1e11,
   'started is unix SECONDS (' + rec.started + ')');
ok(rec.durationSec === Math.round((CLOCK - START - PAUSE_MS) / 1000),
   'durationSec excludes the ' + (PAUSE_MS / 1000) + 's pause (' + rec.durationSec + 's)');
ok(rec.centsN === 3 && rec.centsSum === 14 + 25 + 7,
   'three mic trials, |cents| summed with the re-sung one REPLACED (' +
   rec.centsN + ' / ' + rec.centsSum + ')');
ok(sess.finish() === rec, 'finish() is idempotent');
var threw = false;
try { sess.next(); } catch (e) { threw = true; }
ok(threw, 'next() after finish() throws rather than silently extending the session');

console.log('\n== ear-session: summarize ==');
var sum = Session.summarize(rec);
ok(sum.accuracy === 0.75, 'accuracy 0.75 (' + sum.accuracy + ')');
ok(sum.medianMs === med(expMs) && sum.medianMs === 415,
   'median response time ' + sum.medianMs + ' ms');
ok(Math.abs(sum.meanCents - (14 + 25 + 7) / 3) < 1e-9,
   'mean |cents| ' + f2(sum.meanCents));
// perDegree must reproduce the tally this script kept independently.
var pdBad = [], pdAsked = 0, pdRight = 0, e, ascending = true;
for (i = 0; i < sum.perDegree.length; i++) {
  e = sum.perDegree[i];
  if (i && e.deg <= sum.perDegree[i - 1].deg) ascending = false;
  if (e.asked !== expAsked[e.deg] || e.correct !== expRight[e.deg])
    pdBad.push('deg ' + e.deg + ' = ' + e.asked + '/' + e.correct +
               ' expected ' + expAsked[e.deg] + '/' + expRight[e.deg]);
  if (Math.abs(e.accuracy - e.correct / e.asked) > 1e-9) pdBad.push('deg ' + e.deg + ' accuracy');
  pdAsked += e.asked; pdRight += e.correct;
}
ok(pdBad.length === 0, 'perDegree matches an independent tally of all 16 trials' +
   (pdBad.length ? ' — ' + pdBad.join('; ') : ''));
ok(pdAsked === 16 && pdRight === 12, 'perDegree sums back to 16 asked / 12 correct');
ok(ascending, 'perDegree comes out in keyboard order (ascending degree)');
var cBad = [], cTotal = 0, descending = true;
for (i = 0; i < sum.confusions.length; i++) {
  e = sum.confusions[i];
  cTotal += e.n;
  if (i && e.n > sum.confusions[i - 1].n) descending = false;
  var found = false;
  for (j = 0; j < expConf.length; j++)
    if (expConf[j].target === e.target && expConf[j].answered === e.answered && expConf[j].n === e.n) found = true;
  if (!found) cBad.push(e.target + '->' + e.answered + ' x' + e.n);
}
ok(cBad.length === 0 && sum.confusions.length === expConf.length,
   'confusions are the ordered (heard, called it) pairs, all ' + expConf.length + ' of them' +
   (cBad.length ? ' — unexpected ' + cBad.join(', ') : ''));
ok(cTotal === 4, 'the four wrong answers account for every confusion (' + cTotal + ')');
ok(descending, 'confusions are ranked descending by count');

// A hand-built record: four wrong answers on one pair, two on another, one on a
// third, deliberately stored OUT of order. summarize() must not trust the order
// it was given — a record can arrive from D1 or from another client.
var handRec = {
  questions: 20, correct: 13, centsN: 0, centsSum: 0,
  detail: '{"d":{"0":[5,5],"3":[4,1],"10":[6,2],"7":[5,5]},' +
          '"c":[[3,2,1],[10,9,4],[3,4,2]],"m":812}'
};
var hs = Session.summarize(handRec);
ok(hs.accuracy === 13 / 20 && hs.medianMs === 812, 'a stored record summarises (' +
   f2(hs.accuracy * 100) + '%, ' + hs.medianMs + ' ms)');
ok(hs.meanCents === null, 'meanCents is null, not 0, when the mic was never used');
ok(hs.perDegree.length === 4 &&
   hs.perDegree[0].deg === 0 && hs.perDegree[1].deg === 3 &&
   hs.perDegree[2].deg === 7 && hs.perDegree[3].deg === 10,
   'perDegree is re-sorted into degree order (' +
   hs.perDegree.map(function (x) { return x.deg; }).join(',') + ')');
ok(hs.confusions.length === 3 &&
   hs.confusions[0].target === 10 && hs.confusions[0].answered === 9 && hs.confusions[0].n === 4 &&
   hs.confusions[1].target === 3 && hs.confusions[1].answered === 4 && hs.confusions[1].n === 2 &&
   hs.confusions[2].target === 3 && hs.confusions[2].answered === 2 && hs.confusions[2].n === 1,
   'out-of-order confusions are ranked descending: ' +
   hs.confusions.map(function (x) { return x.target + '->' + x.answered + 'x' + x.n; }).join(' '));
// The object form is tolerated so a hand-written or re-encoded record still reads.
var objRec = { questions: 4, correct: 3,
               detail: { d: { '5': { asked: 4, correct: 3 } },
                         c: [{ target: 5, answered: 4, n: 1 }], m: 500 } };
var os = Session.summarize(objRec);
ok(os.perDegree.length === 1 && os.perDegree[0].asked === 4 &&
   os.confusions.length === 1 && os.confusions[0].target === 5,
   'the {asked,correct} / {target,answered,n} object form also summarises');
var empty = Session.summarize({});
ok(empty.accuracy === 0 && empty.perDegree.length === 0 && empty.confusions.length === 0 &&
   empty.medianMs === null, 'an empty record summarises to zeroes instead of throwing');

console.log('\n== ear-session: the cadence taper holds the key ==');
// design §6: replaying the context every N questions IS the memory drill. If
// the key silently moved every question the app would still look right and the
// exercise would be gone, so assert the transitions themselves.
var tap = Session.create({ level: 4, context: 'cadence', taper: 4,
                           length: { kind: 'questions', value: 12 },
                           voiceLo: 43, voiceHi: 67, clock: clock }, rndFrom(31337));
var tKeys = [], ctxAt = [];
for (i = 0; i < 12; i++) {
  trial = tap.next();
  tKeys.push(trial.tonicPc);
  if (trial.playContext) ctxAt.push(i + 1);
  tap.ready(); CLOCK += 250; tap.answer(trial.degree); CLOCK += 80;
}
ok(ctxAt.join(',') === '1,5,9', 'taper 4 re-establishes the key on questions 1, 5, 9 (got ' +
   ctxAt.join(',') + ')');
var held = (tKeys[0] === tKeys[1] && tKeys[1] === tKeys[2] && tKeys[2] === tKeys[3] &&
            tKeys[4] === tKeys[5] && tKeys[5] === tKeys[6] && tKeys[6] === tKeys[7] &&
            tKeys[8] === tKeys[9] && tKeys[9] === tKeys[10] && tKeys[10] === tKeys[11]);
ok(held, 'the tonic is HELD for the whole taper window (' + tKeys.join(',') + ')');
ok(tKeys[0] !== tKeys[4] && tKeys[4] !== tKeys[8],
   'and moves to a different key at each refresh (' + tKeys[0] + ' -> ' + tKeys[4] + ' -> ' + tKeys[8] + ')');

// taper 'session' (persisted as 0) — established once and never refreshed.
var one = Session.create({ level: 3, context: 'cadence', taper: 'session',
                           length: { kind: 'questions', value: 8 }, clock: clock }, rndFrom(5150));
var oneCtx = [], oneKeys = [];
for (i = 0; i < 8; i++) {
  trial = one.next(); oneKeys.push(trial.tonicPc);
  if (trial.playContext) oneCtx.push(i + 1);
  one.ready(); CLOCK += 200; one.answer(trial.degree); CLOCK += 60;
}
ok(oneCtx.join(',') === '1', "taper 'session' establishes the key once (" + oneCtx.join(',') + ')');
var oneHeld = true;
for (i = 1; i < oneKeys.length; i++) if (oneKeys[i] !== oneKeys[0]) oneHeld = false;
ok(oneHeld, 'and the whole session stays in that key (' + oneKeys.join(',') + ')');
ok(one.finish().taper === 0, "taper 'session' persists as 0 (design §13)");

// A drone is a sustained tonic under everything; the taper explicitly does not
// apply, so the key must not move under it whatever taper was set.
var drone = Session.create({ level: 5, context: 'drone', taper: 1,
                             length: { kind: 'questions', value: 10 }, clock: clock }, rndFrom(808));
var dCtx = [], dKeys = [];
for (i = 0; i < 10; i++) {
  trial = drone.next(); dKeys.push(trial.tonicPc);
  if (trial.playContext) dCtx.push(i + 1);
  drone.ready(); CLOCK += 200; drone.answer(trial.degree); CLOCK += 60;
}
ok(dCtx.join(',') === '1', 'a drone is established exactly once (' + dCtx.join(',') + ')');
var droneHeld = true;
for (i = 1; i < dKeys.length; i++) if (dKeys[i] !== dKeys[0]) droneHeld = false;
ok(droneHeld, 'the tonic never moves under a held drone (' + dKeys.join(',') + ')');

// taper 1 is the other extreme: a fresh key every single question.
var fast = Session.create({ level: 1, context: 'cadence', taper: 1,
                            length: { kind: 'questions', value: 10 }, clock: clock }, rndFrom(99));
var fCtx = 0, fKeys = [];
for (i = 0; i < 10; i++) {
  trial = fast.next(); fKeys.push(trial.tonicPc);
  if (trial.playContext) fCtx++;
  fast.ready(); CLOCK += 200; fast.answer(trial.degree); CLOCK += 60;
}
var fRepeat = 0;
for (i = 1; i < fKeys.length; i++) if (fKeys[i] === fKeys[i - 1]) fRepeat++;
ok(fCtx === 10 && fRepeat === 0,
   'taper 1 re-establishes every question, never twice in the same key (' + fKeys.join(',') + ')');

console.log('\n== ear-session: verdict bands ==');
// design §8: <70 low, 70-90 in band, >90 high. The boundaries are the whole
// point of the "~80%" guidance, so test them and not the middle.
ok(Session.verdict(69).band === 'low', '69% is below the training band');
ok(Session.verdict(70).band === 'in',  '70% is IN the band (inclusive lower edge)');
ok(Session.verdict(90).band === 'in',  '90% is IN the band (inclusive upper edge)');
ok(Session.verdict(91).band === 'high', '91% is above the band');
ok(Session.verdict(0.69).band === 'low' && Session.verdict(0.70).band === 'in' &&
   Session.verdict(0.90).band === 'in' && Session.verdict(0.91).band === 'high',
   'the same four boundaries expressed as 0..1');
ok(Session.verdict(69, 4).suggestLevel === 3, 'below the band at L4 suggests L3');
ok(Session.verdict(80, 4).suggestLevel === 4, 'in the band suggests staying put');
ok(Session.verdict(91, 4).suggestLevel === 5, 'above the band at L4 suggests L5');
ok(Session.verdict(20, 1).suggestLevel === 1, 'L1 is the floor — never suggests L0');
ok(Session.verdict(99, 7).suggestLevel === 7, 'L7 is the ceiling — never suggests L8');
ok(Session.verdict(80).suggestLevel === null, 'with no level given, suggestLevel is null');
var vBad = 0;
for (i = 0; i <= 100; i++) if (!Session.verdict(i, 3).text) vBad++;
ok(vBad === 0, 'every accuracy from 0 to 100 gets a line of text');
// autoAdvance is deliberately stricter than the band: it moves the SAVED level.
ok(Session.autoAdvance({ level: 3, questions: 20, correct: 19 }).moved === 'up',
   'autoAdvance promotes on 95% over 20 questions');
ok(Session.autoAdvance({ level: 3, questions: 20, correct: 10 }).moved === 'down',
   'autoAdvance demotes on 50% over 20 questions');
ok(Session.autoAdvance({ level: 3, questions: 20, correct: 16 }).moved === null,
   'autoAdvance holds at 80%');
ok(Session.autoAdvance({ level: 3, questions: 8, correct: 8 }).moved === null,
   'a short session is not evidence — 8 perfect questions promote nothing');
ok(Session.autoAdvance({ level: 7, questions: 20, correct: 20 }).level === 7 &&
   Session.autoAdvance({ level: 1, questions: 20, correct: 0 }).level === 1,
   'autoAdvance never leaves the 1..7 ladder');

/* ==========================================================================
 * ear-pitch.detect  —  pure MPM
 * ======================================================================== */

console.log('\n== ear-pitch: the acceptance gates are the design numbers ==');
ok(Pitch.RMS_MIN === 0.01 && Pitch.CLARITY_MIN === 0.9, 'RMS > 0.01, clarity >= 0.9 (design §11)');
ok(Pitch.STABLE_N === 8 && Pitch.ATTACK_MS === 80, '8 consecutive frames, 80 ms attack guard');
ok(Pitch.FMIN === 70 && Pitch.FMAX === 1000, 'the lag search is bounded to 70-1000 Hz');

console.log('\n== ear-pitch: pure sines land inside a cent ==');
var RATES = [48000, 44100], FREQS = [110, 220, 440];
var r, c;
for (i = 0; i < RATES.length; i++) {
  for (j = 0; j < FREQS.length; j++) {
    r = Pitch.detect(sineBuf(FREQS[j], RATES[i], W, 0.5, 0.37), RATES[i]);
    c = r.hz > 0 ? centsBetween(r.hz, FREQS[j]) : -9999;
    ok(Math.abs(c) < 1 && r.clarity >= 0.99 && r.rms > Pitch.RMS_MIN,
       FREQS[j] + ' Hz @ ' + (RATES[i] / 1000) + 'k -> ' + f2(r.hz) + ' Hz, ' +
       f2(c) + ' cents, clarity ' + f2(r.clarity));
  }
}
// A tone with a WEAK fundamental, then one with none at all. This is what a
// sung vowel down a laptop mic really looks like, and a detector that follows
// the loudest partial would call both of these 220 Hz.
r = Pitch.detect(harmBuf(110, SR, W, [0.05, 1, 0.8, 0.6, 0.4, 0.3, 0.2]), SR);
ok(Math.abs(centsBetween(r.hz, 110)) < 2,
   'weak fundamental at 110 Hz -> ' + f2(r.hz) + ' Hz, not the 2nd partial');
r = Pitch.detect(harmBuf(110, SR, W, [0, 1, 0.8, 0.6, 0.4, 0.3, 0.2]), SR);
ok(Math.abs(centsBetween(r.hz, 110)) < 2,
   'MISSING fundamental at 110 Hz -> ' + f2(r.hz) + ' Hz (the pitch is the period, not a partial)');

console.log('\n== ear-pitch: MPM must not octave-halve — the reason MPM is here ==');
// A 110 Hz sawtooth carries every harmonic at full strength, so its NSDF peak
// at 2T is very nearly as tall as the one at T. Plain autocorrelation takes the
// taller and reports 55 Hz; the user sings the right degree and is told they
// are wrong, which is the worst failure this app has.
r = Pitch.detect(sawBuf(110, SR, W, 0.5, 0.13), SR);
ok(r.hz > 80, '110 Hz sawtooth does NOT halve to 55 Hz (got ' + f2(r.hz) + ' Hz)');
ok(Math.abs(centsBetween(r.hz, 110)) < 5,
   '...and lands on 110 Hz within ' + f2(Math.abs(centsBetween(r.hz, 110))) + ' cents, clarity ' + f2(r.clarity));
// Note that at 48 kHz the lag search floors at 70 Hz (ear-pitch.js:61), so 55 Hz
// is not even representable — the assertion above cannot fail the way the bug
// would really present. These four saws ARE in range for their own half: 75, 82,
// 110 and 220 Hz all sit inside 70-1000, so a halving here is reportable and the
// test has teeth.
var HALVABLE = [150, 165, 220, 440];
var halveBad = [];
for (i = 0; i < HALVABLE.length; i++) {
  r = Pitch.detect(sawBuf(HALVABLE[i], SR, W, 0.5, 0.41), SR);
  c = r.hz > 0 ? centsBetween(r.hz, HALVABLE[i]) : -9999;
  if (Math.abs(c) > 5) halveBad.push(HALVABLE[i] + ' -> ' + f2(r.hz) + ' (' + f2(c) + ' cents)');
}
ok(halveBad.length === 0, 'sawtooths at 150/165/220/440 Hz — whose f/2 IS inside the search ' +
   'band — all report f, never f/2' + (halveBad.length ? ' — ' + halveBad.join('; ') : ''));
// The low end is where the NSDF's own lobe around lag 0 is still tall when it
// reaches the search floor; ear-pitch.js:154-160 exists for exactly this, and
// without it an E2 comes back as a note two and a half octaves up.
r = Pitch.detect(sawBuf(82.41, SR, W, 0.5, 0.29), SR);
ok(Math.abs(centsBetween(r.hz, 82.41)) < 5,
   'a low E2 sawtooth (82.41 Hz) reports ' + f2(r.hz) + ' Hz, not ~1 kHz');
// Phase must not matter: the window a rAF frame happens to catch is arbitrary.
var phBad = [];
for (i = 0; i < 8; i++) {
  r = Pitch.detect(sawBuf(110, SR, W, 0.5, i / 8), SR);
  if (Math.abs(centsBetween(r.hz, 110)) > 5) phBad.push(f2(r.hz));
}
ok(phBad.length === 0, 'stable across all eight window phase offsets' +
   (phBad.length ? ' — ' + phBad.join(', ') : ''));

console.log('\n== ear-pitch: silence and noise report LOW CLARITY, not a wrong note ==');
r = Pitch.detect(new Float32Array(W), SR);
ok(r.hz === 0 && r.clarity === 0 && r.rms === 0,
   'digital silence yields no pitch at all (hz ' + r.hz + ', clarity ' + r.clarity + ')');
// White noise is the dangerous one: it is LOUD, so the RMS gate passes it. Only
// the clarity gate stands between room noise and a confidently wrong answer.
var noiseBad = [], SEEDS = [1, 7, 99, 4242, 987654321];
for (i = 0; i < SEEDS.length; i++) {
  r = Pitch.detect(noiseBuf(W, 0.3, rndFrom(SEEDS[i])), SR);
  if (r.rms <= Pitch.RMS_MIN) noiseBad.push('seed ' + SEEDS[i] + ' was too quiet to be a fair test');
  if (r.clarity >= Pitch.CLARITY_MIN)
    noiseBad.push('seed ' + SEEDS[i] + ' clarity ' + f2(r.clarity) + ' at ' + f2(r.hz) + ' Hz');
}
ok(noiseBad.length === 0, 'white noise is loud enough to pass the RMS gate and is rejected by ' +
   'clarity alone, on all ' + SEEDS.length + ' seeds' + (noiseBad.length ? ' — ' + noiseBad.join('; ') : ''));
r = Pitch.detect(sineBuf(440, SR, W, 0.002, 0.1), SR);
ok(r.rms < Pitch.RMS_MIN, 'a whisper-quiet tone is below the RMS gate (' + f2(r.rms * 1000) + ' e-3)');
ok(Pitch.detect(null, SR).hz === 0 && Pitch.detect(new Float32Array(W), 0).hz === 0,
   'a missing buffer or a zero sample rate returns no pitch rather than NaN');

console.log('\n== ear-pitch: hzToNote ==');
var hn = Pitch.hzToNote(440);
ok(hn.midi === 69 && hn.pc === 9 && hn.cents === 0, 'A440 is MIDI 69, pc 9, 0 cents');
hn = Pitch.hzToNote(220);
ok(hn.midi === 57 && hn.pc === 9, 'A220 is MIDI 57 and the SAME pitch class — degrees are octave-invariant');
hn = Pitch.hzToNote(440 * Math.pow(2, 25 / 1200));
ok(hn.midi === 69 && hn.cents === 25, '25 cents sharp of A440 reads as +25 on the needle');
hn = Pitch.hzToNote(440 * Math.pow(2, -49 / 1200));
ok(hn.midi === 69 && hn.cents === -49, '49 cents flat is still A, at -49');
ok(Pitch.hzToNote(0) === null && Pitch.hzToNote(-1) === null, 'no frequency, no note');

console.log('\n' + (failures ? failures + ' TEST(S) FAILED' : 'ALL TESTS PASSED'));
process.exit(failures ? 1 : 0);
