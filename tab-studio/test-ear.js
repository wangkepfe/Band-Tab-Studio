/* ============================================================================
 * test-ear.js  —  Node harness for the pure logic of /learn.
 *
 * ear-theory.js, ear-session.js and ear-pitch.js#detect carry the dual-export
 * tail (contract §A) precisely so they can be exercised head-less, with no DOM,
 * no AudioContext and no microphone. Everything they own is either arithmetic
 * or a state machine, which means every claim the design makes about them is
 * checkable here rather than by ear at 1 a.m.
 *
 * TWO MODULES ARE REACHED BY A SEAM INSTEAD, because the sing-back change spec
 * put load-bearing decisions in both of them. ear-store.js is browser-only — it
 * reads window.STUDIO_CONFIG at load and everything it owns lives in
 * localStorage — so it is evaluated in a fresh V8 context with exactly those two
 * globals stubbed (loadStore() below). learn.js is DOM-bound and cannot be
 * evaluated at all, so the one piece of it this file must protect — the
 * direction readout's banding and its SIGN, change spec §2 — is pinned by an
 * oracle plus a narrow grep over the source. Neither seam copies logic into the
 * repo: the files on disk stay the only implementation there is.
 *
 * Four of the assertions below are load-bearing rather than decorative:
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
 *   • THE SIGN OF THE NEEDLE. change spec §2 puts a DIRECTION where the sung
 *     note's name used to be, and an inverted one is both the likeliest
 *     regression in that change and the hardest to catch by reading: '▲ higher'
 *     over a singer who is already sharp looks entirely reasonable right up
 *     until you try to sing it. So it is asserted from both ends — what the
 *     bands must say, and what learn.js actually compares.
 *
 * Style follows test-core.js: a flat script, '== section ==' banners, one
 * one-line ok(), inline fixtures, process.exit(failures ? 1 : 0). Randomness is
 * always a seeded rnd() — the modules take it injected (contract §F) so that
 * these runs are byte-identical every time and a failure is never "flaky".
 *
 *   run:  node tab-studio/test-ear.js       (or `npm test`, which runs both)
 * ========================================================================== */
var path = require('path');
// fs and vm are the two seams described above: fs reads learn.js as TEXT (it can
// never be executed here) and vm hosts ear-store.js in a context that owns a
// stubbed `window`. Nothing else in this file needs either.
var fs   = require('fs');
var vm   = require('vm');

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

console.log('\n== ear-theory: the one-octave unisex band (change spec §4) ==');
// The new default range is EXACTLY twelve semitones — narrower than every
// voice-type preset above and narrower than `need` at BOTH spreads. So the
// widening branch of playBand() is no longer an edge case reached by a garbage
// range, it is the path every fresh install takes on every question. An inverted
// or empty band there would break the draw for first-run users and for nobody
// else, which is exactly the class of bug that reaches production.
var uni = Theory.voiceRangeFor('unisex');
ok(uni && uni.lo === 53 && uni.hi === 65, 'the unisex preset is 53-65 (' +
   (uni ? uni.lo + '-' + uni.hi : 'missing') + ')');
b = Theory.playBand(uni.lo, uni.hi, 1);
ok(b.lo === 50 && b.hi === 72 && b.lo < b.hi, 'unisex at spread 1 widens to 50-72 (' +
   b.lo + '-' + b.hi + ')');
b = Theory.playBand(uni.lo, uni.hi, 2);
ok(b.lo === 46 && b.hi === 80 && b.lo < b.hi, 'unisex at spread 2 widens to 46-80 (' +
   b.lo + '-' + b.hi + ')');
// The fallback moved with the default (ear-theory.js:421). Baritone would have
// come back 43-67 here, so this distinguishes the new fallback from the old one
// rather than merely asserting that SOME band came out.
b = Theory.playBand(null, null, 1);
ok(b.lo === 50 && b.hi === 72, 'a missing range falls back to the UNISEX band, not the old baritone (' +
   b.lo + '-' + b.hi + ')');
// ear-store.js:244-245 admits any voiceLo in 24…84 with a span of exactly 12, so
// all 61 of those ranges are reachable from storage — a calibration lands on one
// of them the moment a singer's own octave is measured. Walked exhaustively
// rather than sampled at the ends, because playBand()'s two clamps (BAND_MIN
// below, BAND_MAX above) fire at OPPOSITE ends of that walk and a fault in either
// one is invisible from the other.
var octBad = [];
for (i = 24; i <= 84; i++) {
  for (sp = 1; sp <= 2; sp++) {
    b = Theory.playBand(i, i + 12, sp);
    need = 12 * sp + 10;
    if (!(b.lo < b.hi)) octBad.push(i + '/' + sp + ' inverted or empty (' + b.lo + '-' + b.hi + ')');
    if (b.hi - b.lo < need) octBad.push(i + '/' + sp + ' only ' + (b.hi - b.lo) + ' wide');
    if (b.lo < 40 || b.hi > 88) octBad.push(i + '/' + sp + ' leaves 40..88 (' + b.lo + '-' + b.hi + ')');
  }
}
ok(octBad.length === 0, 'all 61 storable one-octave ranges x both spreads: lo < hi, wide enough, ' +
   'inside 40..88' + (octBad.length ? ' — ' + octBad.slice(0, 4).join('; ') : ''));

console.log('\n== ear-theory: the voice range presets ==');
// design §9's five voice types, plus change spec §4's unisex default IN FIRST
// PLACE — the settings <select> renders this array in order (learn.js:144-149),
// so "first" is a real requirement and not a tidiness one.
var VR = Theory.VOICE_RANGES;
ok(VR.length === 6, 'six presets (' + VR.length + ')');
ok(VR[0].id === 'unisex' && VR[0].lo === 53 && VR[0].hi === 65,
   'unisex F3-F4 = 53-65 and it is FIRST (' + VR[0].id + ' ' + VR[0].lo + '-' + VR[0].hi + ')');
// change spec §4 asks for a hint saying this is the range most people of any
// voice type can sing, and that Calibrate will fit it to them. The default is the
// one preset a user never chose, so it is the one that has to explain itself.
ok(typeof VR[0].hint === 'string' && VR[0].hint.length > 20 &&
   /calibrat/i.test(VR[0].hint),
   'and it carries a hint that mentions calibrating (' + (VR[0].hint || '(none)') + ')');
// Every preset design §9 shipped with, at its original numbers. Introducing a new
// default must not have quietly re-tuned anybody's voice type — a stored
// 'baritone' resolves through this table on every load.
var WANT_RANGES = { bass: [40, 64], baritone: [43, 67], tenor: [48, 69], alto: [53, 74], soprano: [60, 81] };
var vrBad = [], vrSeen = {}, vr, wantR, rid;
for (i = 0; i < VR.length; i++) {
  vr = VR[i];
  if (vrSeen[vr.id]) vrBad.push('duplicate id ' + vr.id);
  vrSeen[vr.id] = 1;
  if (!vr.id || !vr.name) vrBad.push('preset ' + i + ' is unlabelled');
  // A preset the storage layer would refuse is worse than no preset: it would be
  // pickable in the panel and come back as something else on the next load.
  // ear-store.js:244-245 is the validator these have to survive.
  if (!(vr.hi - vr.lo >= 12 && vr.hi - vr.lo <= 36)) vrBad.push(vr.id + ' span ' + (vr.hi - vr.lo));
  if (vr.lo < 24 || vr.lo > 84) vrBad.push(vr.id + ' lo ' + vr.lo + ' outside ear-store.js:244');
  wantR = WANT_RANGES[vr.id];
  if (wantR && (vr.lo !== wantR[0] || vr.hi !== wantR[1]))
    vrBad.push(vr.id + ' moved to ' + vr.lo + '-' + vr.hi + ', was ' + wantR.join('-'));
}
ok(vrBad.length === 0, 'ids unique, spans storable, and every design §9 preset still at its own MIDI range' +
   (vrBad.length ? ' — ' + vrBad.join('; ') : ''));
var missingR = [];
for (rid in WANT_RANGES) if (WANT_RANGES.hasOwnProperty(rid) && !vrSeen[rid]) missingR.push(rid);
ok(missingR.length === 0, 'bass, baritone, tenor, alto and soprano all survive the new default' +
   (missingR.length ? ' — lost ' + missingR.join(', ') : ''));
// 'custom' is the calibration affordance, not a range: it has no lo/hi to be the
// truth about, so learn.js:143 appends it to the <select> itself. A 'custom' in
// THIS table would carry numbers, and those numbers would overwrite a real
// calibration the moment the panel was re-rendered.
ok(!vrSeen.custom && Theory.voiceRangeFor('custom') === null,
   "'custom' is not a preset — it is the calibration flow (learn.js:143)");
ok(Theory.voiceRangeFor('unisex') === VR[0] && Theory.voiceRangeFor('baritone') === VR[2],
   'voiceRangeFor() returns the table entry itself, so a caller cannot get a stale copy');
ok(Theory.voiceRangeFor('') === null && Theory.voiceRangeFor(undefined) === null &&
   Theory.voiceRangeFor('mezzo') === null,
   'an unknown id resolves to null rather than to a guess');
// The label is the only place a singer ever sees what a preset MEANS, and the
// copy of this table that used to live in learn.js had already drifted: it
// printed MIDI 40 as 'C2' when 40 is E2. So the names are checked against their
// own numbers instead of being eyeballed. Every preset bound happens to be a
// natural, so the sharp-vs-flat choice in SCI below can never be the thing that
// fails here.
var SCI = ['C', 'C' + SHARP, 'D', 'E' + FLAT, 'E', 'F', 'F' + SHARP, 'G', 'A' + FLAT, 'A', 'B' + FLAT, 'B'];
function sci(midi) { return SCI[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }
var NDASH = '–';                      // U+2013, the glyph the table itself uses
var nameBad = [], paren;
for (i = 0; i < VR.length; i++) {
  paren = /\(([^)]+)\)/.exec(VR[i].name);
  if (!paren) { nameBad.push(VR[i].id + ' label names no range'); continue; }
  if (paren[1] !== sci(VR[i].lo) + NDASH + sci(VR[i].hi))
    nameBad.push(VR[i].id + ' says (' + paren[1] + ') but is ' + sci(VR[i].lo) + NDASH + sci(VR[i].hi));
}
ok(nameBad.length === 0, 'every preset label spells its own MIDI numbers correctly' +
   (nameBad.length ? ' — ' + nameBad.join('; ') : ''));
// The same band property the five-preset loop above asserts, driven off the TABLE
// this time rather than off a copy of it — so a preset added to VOICE_RANGES is
// covered the day it lands, not the day somebody remembers this file.
var vrBandBad = [];
for (i = 0; i < VR.length; i++) {
  for (sp = 1; sp <= 2; sp++) {
    b = Theory.playBand(VR[i].lo, VR[i].hi, sp);
    need = 12 * sp + 10;
    if (!(b.lo < b.hi) || b.hi - b.lo < need || b.lo < 40 || b.hi > 88)
      vrBandBad.push(VR[i].id + '/' + sp + ' -> ' + b.lo + '-' + b.hi);
  }
}
ok(vrBandBad.length === 0, 'all six presets x both spreads give a legal band' +
   (vrBandBad.length ? ' — ' + vrBandBad.join('; ') : ''));

console.log('\n== ear-theory: singTarget folds the played note into the voice ==');
// change spec §1. The PLAYED note keeps the register it was drawn in — spreading
// the register is the skill L4+ exists to train — and only the note the VOICE
// chases moves. Two things therefore have to hold for every played octave: the
// pitch class must survive the fold intact (otherwise the drill would ask for a
// different degree than the one it played) and the answer must land somewhere a
// human can actually sing.
var stBad = [], tgt, pcWant;
for (i = 0; i < VR.length; i++) {
  for (m = 12; m <= 108; m++) {
    tgt = Theory.singTarget(m, VR[i].lo, VR[i].hi);
    pcWant = ((m % 12) + 12) % 12;
    if (((tgt % 12) + 12) % 12 !== pcWant)
      stBad.push(VR[i].id + ' midi ' + m + ' -> ' + tgt + ', pc ' + (tgt % 12) + ' not ' + pcWant);
    // Every preset spans at least 12 semitones, so [lo, hi] holds at least 13
    // chromatic values and therefore an instance of ALL twelve pitch classes.
    // There is consequently never an excuse to leave the singer's range.
    if (tgt < VR[i].lo || tgt > VR[i].hi)
      stBad.push(VR[i].id + ' midi ' + m + ' -> ' + tgt + ' outside ' + VR[i].lo + '-' + VR[i].hi);
    if (tgt !== Math.round(tgt)) stBad.push(VR[i].id + ' midi ' + m + ' -> non-integer ' + tgt);
  }
}
ok(stBad.length === 0, 'all six ranges x 97 played notes: right pitch class, inside the singer band' +
   (stBad.length ? ' — ' + stBad.slice(0, 4).join('; ') : ''));
// NEAREST THE CENTRE, ties going low — change spec §1's actual rule, read
// independently here rather than derived from the module. This is the half of the
// rule that carries the musical judgement (the middle of a comfortable range is
// the part of it that is actually comfortable) and it is INVISIBLE to the two
// checks above: on the one-octave unisex band all but one pitch class has a
// single instance to choose from, so a version that aimed at the bottom of the
// range would pass every assertion so far and still hand a soprano her lowest C
// on every question.
function nearestToCentre(pc, lo, hi) {
  var mid = (lo + hi) / 2, want = ((pc % 12) + 12) % 12, best = null, mm;
  // Ascending with a STRICTLY-less comparison, so an exact tie keeps the lower
  // instance — the same resolution, and the same reason, as ear-theory.js:469.
  for (mm = lo - 24; mm <= hi + 24; mm++) {
    if (((mm % 12) + 12) % 12 !== want) continue;
    if (best === null || Math.abs(mm - mid) < Math.abs(best - mid)) best = mm;
  }
  return best;
}
var midBad = [], WIDE = [[53, 65], [43, 67], [60, 81], [40, 64], [48, 84], [60, 62]];
for (i = 0; i < WIDE.length; i++) {
  for (m = 0; m < 12; m++) {
    tgt = Theory.singTarget(m + 60, WIDE[i][0], WIDE[i][1]);
    pcWant = nearestToCentre(m, WIDE[i][0], WIDE[i][1]);
    if (tgt !== pcWant)
      midBad.push(WIDE[i].join('-') + ' pc ' + m + ' -> ' + tgt + ', centre says ' + pcWant);
  }
}
ok(midBad.length === 0, 'across six bands x 12 pitch classes the target is the instance nearest the ' +
   'band CENTRE, not its bottom' + (midBad.length ? ' — ' + midBad.slice(0, 4).join('; ') : ''));
// The case that makes it concrete: a soprano asked for a C. Her range is 60-81,
// so C4 and C5 are both in it and both perfectly singable — but 72 sits near the
// middle of her voice and 60 is the very bottom of it.
ok(Theory.singTarget(48, 60, 81) === 72,
   'a soprano singing a C gets C5 (72), the one in the middle of her range, not her lowest C (' +
   Theory.singTarget(48, 60, 81) + ')');
// The target must not depend on WHICH octave the note was played in, only on its
// pitch class. If it did, the same degree would be sung in two different places
// depending on the draw, and the intonation stat (design §11) would be measuring
// the register rather than the ear.
var invBad = 0;
for (m = 24; m <= 84; m++) if (Theory.singTarget(m, 53, 65) !== Theory.singTarget(m + 12, 53, 65)) invBad++;
ok(invBad === 0, 'the target depends on the pitch class alone, never on the played octave (' +
   invBad + ' disagreements)');
// The claim the whole fold rests on (design §1): the degree the user is asked to
// SING is bit-identical to the degree that was PLAYED. If that ever stopped being
// true the app would be grading a different question than it asked.
var degBad = [];
for (i = 0; i < 12; i++) {
  for (m = 36; m <= 96; m++) {
    if (Theory.degreeOf(Theory.singTarget(m, 53, 65), i) !== Theory.degreeOf(m, i))
      degBad.push('tonic ' + i + ' midi ' + m);
  }
}
ok(degBad.length === 0, 'over 12 tonics x 61 played notes the folded target is the SAME DEGREE' +
   (degBad.length ? ' — ' + degBad.slice(0, 3).join('; ') : ''));
// The three worked examples: a bass note two octaves below the band and a note
// two octaves above it both come home to the same B3, and a note already in the
// band is left exactly where it is.
ok(Theory.singTarget(35, 53, 65) === 59, 'B1 (35) is sung back as B3 (59) — up two octaves (' +
   Theory.singTarget(35, 53, 65) + ')');
ok(Theory.singTarget(83, 53, 65) === 59, 'B5 (83) folds DOWN to the same B3 (' +
   Theory.singTarget(83, 53, 65) + ')');
ok(Theory.singTarget(59, 53, 65) === 59, 'a note already inside the band is left alone');
// The centre of 53-65 is 59, so F sits exactly a tritone away and F3 (53) and F4
// (65) are equidistant from it — the one exact tie this function can produce, and
// in the DEFAULT range at that. It must resolve DOWN: the top of a range is where
// a voice starts pushing, and a pushed note goes sharp, which would feed the
// intonation stat a bias belonging to the singer's larynx rather than to the ear
// being trained.
ok(Theory.singTarget(41, 53, 65) === 53 && Theory.singTarget(89, 53, 65) === 53,
   'the tritone tie (F, from either octave) resolves to the LOWER instance, 53 not 65 (' +
   Theory.singTarget(41, 53, 65) + ')');
// Same fallback as playBand(), for the same reason: a caller with no usable range
// must still be handed a singable note rather than a NaN.
ok(Theory.singTarget(60, null, null) === 60 && Theory.singTarget(60, 70, 50) === 60 &&
   Theory.singTarget(35, undefined, undefined) === 59,
   'a missing or inverted range falls back to unisex 53-65, exactly as playBand() does');
// A band narrower than ear-store.js will ever persist can still arrive from a
// hand-edited blob, and then some pitch class genuinely has no instance inside
// it. The answer must still be the NEAREST instance rather than null, NaN, or a
// note in the wrong octave register entirely.
var narrowBad = [];
for (m = 0; m < 12; m++) {
  tgt = Theory.singTarget(60 + m, 60, 62);
  if (((tgt % 12) + 12) % 12 !== m) narrowBad.push('pc ' + m + ' -> ' + tgt);
  if (tgt < 48 || tgt > 74) narrowBad.push('pc ' + m + ' -> ' + tgt + ', over an octave outside 60-62');
}
ok(narrowBad.length === 0, 'a two-semitone band still yields the nearest instance of the right pitch class' +
   (narrowBad.length ? ' — ' + narrowBad.join('; ') : ''));

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
// The 'tonic' context is the entry rung of the ladder: one reference note, the
// 1, and no harmony at all. Shaped like the drone — a single midi — but seated
// where the CALLER asks, because the note the user hears has to be the exact
// instance the trial's degree was measured up from, not merely some octave of
// the right pitch class.
var tn = Theory.cadence('tonic', 3, 'major');
ok(tn.length === 1 && tn[0].midis.length === 1 && tn[0].midis[0] % 12 === 3 &&
   tn[0].beats > 0 && !!tn[0].name,
   'the tonic context is one labelled reference note (MIDI ' + tn[0].midis[0] + ')');
ok(Theory.cadence('tonic', 3, 'major', 63)[0].midis[0] === 63,
   'and it takes the seat the caller passes, so the reference is the note the degree was measured from');
ok(Theory.cadence('drone', 3, 'major', 63)[0].midis[0] === dr[0].midis[0],
   'while the drone ignores that seat and stays in the bass octave, where a sustained tonic belongs');
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
// nextQuestion hands back the SEAT it measured the degree from, because the
// 'tonic' context sounds exactly that note as its reference. So midi - tonicMidi
// must BE the degree — or the degree an octave up when spread 2 lifts the note —
// and it can never be negative, or the "reference" would sit above the note it
// is a reference for.
var seatBad = [], r3 = rndFrom(4242);
var s3 = { level: 7, questionIndex: 0, taper: 1, lastKey: null, lastDegrees: [],
           voiceLo: 43, voiceHi: 67, spread: 2 };
for (i = 0; i < 200; i++) {
  s3.questionIndex = i;
  q = Theory.nextQuestion(s3, r3);
  if (q.tonicMidi % 12 !== q.tonicPc) seatBad.push('seat ' + q.tonicMidi + ' is not the tonic');
  if (q.midi - q.tonicMidi !== q.degree && q.midi - q.tonicMidi !== q.degree + 12)
    seatBad.push('gap ' + (q.midi - q.tonicMidi) + ' for degree ' + q.degree);
  s3.lastKey = q.tonicPc;
  s3.lastDegrees = [q.degree].concat(s3.lastDegrees).slice(0, 2);
}
ok(seatBad.length === 0, 'every draw returns the seat its degree was measured from: ' +
   'midi - tonicMidi is the degree, or the degree an octave up' +
   (seatBad.length ? ' — ' + seatBad.slice(0, 3).join('; ') : ''));

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

console.log('\n== ear-session: the voice range floor is the unisex default too ==');
// The THIRD copy of 53-65. EarTheory.VOICE_RANGES[0] is the table, ear-store.js
// is what a fresh install persists, and ear-session.js:83-84 is the floor under a
// caller who supplied neither bound. It read 43-67 (baritone) after change spec
// §4 moved the default, which is a disagreement nothing would have surfaced: a
// settings-less session would simply have drawn its notes in a range no woman was
// ever asked about, and the comment beside it claimed to be quoting design §9.
var noRange = Session.create({ level: 1, context: 'cadence',
                               length: { kind: 'questions', value: 4 }, clock: clock }, rndFrom(7)).settings();
ok(noRange.voiceLo === 53 && noRange.voiceHi === 65,
   'a session created with no voice range falls back to unisex 53-65 (' +
   noRange.voiceLo + '-' + noRange.voiceHi + ')');
ok(noRange.voiceLo === Theory.VOICE_RANGES[0].lo && noRange.voiceHi === Theory.VOICE_RANGES[0].hi,
   '...which is EarTheory.VOICE_RANGES[0], so all three copies of that pair agree');
ok(noRange.band.lo === 50 && noRange.band.hi === 72,
   'and the band it derives is playBand(53, 65, 1) = 50-72 (' +
   noRange.band.lo + '-' + noRange.band.hi + ')');

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

// A single reference note is a CONTEXT, not a drone: it stops sounding, so it is
// exactly the thing that fades and it must re-establish on the taper like a
// cadence. Each trial also has to carry the seat its degree was measured from,
// at or below the test note — that seat IS what this context plays.
var refS = Session.create({ level: 3, context: 'tonic', taper: 2,
                            length: { kind: 'questions', value: 8 }, clock: clock }, rndFrom(515));
var rCtx = [], rBad = [];
for (i = 0; i < 8; i++) {
  trial = refS.next();
  if (trial.playContext) rCtx.push(i + 1);
  if (trial.context !== 'tonic') rBad.push('q' + (i + 1) + ' context ' + trial.context);
  if (trial.tonicMidi % 12 !== trial.tonicPc) rBad.push('q' + (i + 1) + ' seat ' + trial.tonicMidi);
  if (trial.midi < trial.tonicMidi) rBad.push('q' + (i + 1) + ' reference above the test note');
  refS.ready(); CLOCK += 200; refS.answer(trial.degree); CLOCK += 60;
}
ok(rCtx.join(',') === '1,3,5,7',
   'the tonic context tapers like a cadence, not like a drone (' + rCtx.join(',') + ')');
ok(rBad.length === 0, 'and every trial carries the seat its degree was measured from' +
   (rBad.length ? ' — ' + rBad.slice(0, 3).join('; ') : ''));
ok(refS.finish().context === 'tonic', "and 'tonic' reaches the session record intact");

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

/* ==========================================================================
 * ear-store  —  the settings round trip
 *
 * ear-store.js is the one /learn module with no dual-export tail, and it is
 * RIGHT not to have one: it reads window.STUDIO_CONFIG at load and everything it
 * owns lives in window.localStorage, so contract §A's "pure-logic modules get
 * the Node tail" simply does not describe it. validateSettings() is still plain
 * arithmetic over a plain object though, and change spec §4 moves the default
 * voice range straight through it — including through the one clamp that could
 * silently widen it — so it is loaded here the only way a browser module can be:
 * evaluated in a fresh V8 context with the two globals it actually touches
 * stubbed out. The file on disk stays the only implementation; this is a seam,
 * not a second copy.
 * ======================================================================== */

var LS_SETTINGS = 'studio.learn.settings';

// `seed` is the raw JSON already sitting under studio.learn.settings — i.e. what
// a RELOAD would find. Feeding one back into a fresh instance is how a
// save -> reload -> validate cycle is expressed with no browser in the room, and
// it is the only way to prove a value reached storage rather than merely being
// re-defaulted on the way out.
function loadStore(seed) {
  var backing = {};
  if (seed != null) backing[LS_SETTINGS] = String(seed);
  var sandbox = {
    window: {
      // 'web', not 'cloud': the local half IS the product (ear-store.js:45-49)
      // and the network half must stay dark, or these tests would depend on a
      // StudioApi that is not here.
      STUDIO_CONFIG: { mode: 'web' },
      localStorage: {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null; },
        setItem: function (k, v) { backing[k] = String(v); }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(LEARN, 'ear-store.js'), 'utf8'), sandbox,
                  { filename: 'ear-store.js' });
  return { store: sandbox.EarStore, raw: function () { return backing[LS_SETTINGS]; } };
}

console.log('\n== ear-store: the unisex default survives save -> reload -> validate ==');
var st0 = loadStore(null), d0 = st0.store.defaults();
ok(d0.voiceRange === 'unisex' && d0.voiceLo === 53 && d0.voiceHi === 65,
   'a fresh install defaults to unisex 53-65 (' + d0.voiceRange + ' ' + d0.voiceLo + '-' + d0.voiceHi + ')');
// ear-store.js deliberately never reads EarTheory (a storage layer that depended
// on the theory layer could not be loaded or tested without it), so these three
// numbers are genuinely written down twice. That is defensible only while the two
// copies agree, which is what this asserts.
ok(d0.voiceRange === Theory.VOICE_RANGES[0].id && d0.voiceLo === Theory.VOICE_RANGES[0].lo &&
   d0.voiceHi === Theory.VOICE_RANGES[0].hi,
   'and it is the SAME 53-65 as EarTheory.VOICE_RANGES[0] — the two copies agree');
// The trap change spec §4 calls out by name. voiceHi is validated against
// voiceLo + 12 as a MINIMUM and the new default is exactly 12 wide, so an
// exclusive bound there would widen every fresh install to 53-77 without a word —
// and the stored range would then contradict the preset name displayed beside it.
var s1 = st0.store.saveSettings(st0.store.defaults());
ok(s1.voiceHi === 65 && s1.voiceLo === 53,
   'saving the default does NOT widen it to 53-77: exactly twelve semitones is admitted (' +
   s1.voiceLo + '-' + s1.voiceHi + ')');
ok(String(st0.raw()).indexOf('"voiceHi":65') >= 0,
   'and the 65 really reached storage rather than being re-derived on the way out');
var reloaded = loadStore(st0.raw()).store.settings();
ok(reloaded.voiceRange === 'unisex' && reloaded.voiceLo === 53 && reloaded.voiceHi === 65,
   'a reload reads it back identically (' + reloaded.voiceRange + ' ' +
   reloaded.voiceLo + '-' + reloaded.voiceHi + ')');
// Not just at 53. A calibration can land anywhere intIn() accepts, and every one
// of those 61 lows must keep an exactly-one-octave span intact.
var spanBad = [], sv;
for (i = 24; i <= 84; i++) {
  sv = st0.store.saveSettings({ voiceRange: 'custom', voiceLo: i, voiceHi: i + 12 });
  if (sv.voiceLo !== i || sv.voiceHi !== i + 12) spanBad.push(i + ' -> ' + sv.voiceLo + '-' + sv.voiceHi);
}
ok(spanBad.length === 0, 'a twelve-semitone span survives at all 61 storable lows' +
   (spanBad.length ? ' — ' + spanBad.slice(0, 4).join('; ') : ''));
// The other side of that boundary, so the assertion above is known to be testing
// a LIVE clamp rather than an absent one: eleven semitones really is widened, and
// thirty-seven really is cut back (design §9's 12-36 window).
sv = st0.store.saveSettings({ voiceLo: 53, voiceHi: 64 });
ok(sv.voiceHi === 65, 'eleven semitones IS widened to the minimum twelve (' + sv.voiceHi + ')');
sv = st0.store.saveSettings({ voiceLo: 40, voiceHi: 90 });
ok(sv.voiceHi === 76, 'and fifty semitones is cut back to the maximum thirty-six (' + sv.voiceHi + ')');

console.log('\n== ear-store: the tonic context round-trips ==');
// A context this validator does not know is silently rewritten to 'cadence', so
// an option added to the settings menu but not to ear-store.js's enum looks
// exactly like a setting that refuses to stick — pick it, reload, and it is a
// cadence again. That is the whole failure mode this pins.
var stC = loadStore(null);
ok(stC.store.saveSettings({ context: 'tonic' }).context === 'tonic',
   "'tonic' survives saveSettings");
ok(loadStore(stC.raw()).store.settings().context === 'tonic',
   'and reads back as tonic after a reload, so it really reached storage');
ok(loadStore(null).store.saveSettings({ context: 'wobble' }).context === 'cadence',
   'while a context nobody ships still falls back to cadence');

console.log('\n== ear-store: an existing user is NOT migrated onto the new default ==');
// ear-store.js:189-192 makes this a promise in prose; this is the assertion that
// keeps it true. A stored voiceRange is a real decision — quite possibly the
// output of a calibration the user sat through — and a DEFAULT that changes
// underneath it must not rewrite it. validateSettings() fills only keys that are
// `undefined`, and the day that becomes "fills keys that are falsy" or "fills
// keys not in DEFAULTS" is the day every baritone silently becomes a unisex.
var OLD = '{"level":4,"voiceRange":"baritone","voiceLo":43,"voiceHi":67,"labels":"solfege"}';
var oldStore = loadStore(OLD), oldS = oldStore.store.settings();
ok(oldS.voiceRange === 'baritone' && oldS.voiceLo === 43 && oldS.voiceHi === 67,
   'a persisted baritone 43-67 loads as baritone 43-67, NOT unisex (' + oldS.voiceRange + ' ' +
   oldS.voiceLo + '-' + oldS.voiceHi + ')');
ok(oldS.level === 4 && oldS.labels === 'solfege', 'and the rest of that blob is left alone too');
// The upgrade is ADDITIVE: keys a older blob predates still arrive from DEFAULTS,
// which is what stops "not migrating" from meaning "not upgrading".
ok(oldS.singGate === 0 && oldS.sessionSec === 600 && oldS.spread === 1,
   'while keys the blob never had are still filled in from DEFAULTS');
// Merely opening and closing the settings panel writes the whole blob back. That
// path must not migrate anyone either.
oldStore.store.saveSettings(oldS);
var oldAgain = loadStore(oldStore.raw()).store.settings();
ok(oldAgain.voiceRange === 'baritone' && oldAgain.voiceLo === 43 && oldAgain.voiceHi === 67,
   'and it survives a save/reload cycle — opening the settings panel migrates nobody (' +
   oldAgain.voiceRange + ' ' + oldAgain.voiceLo + '-' + oldAgain.voiceHi + ')');
// Every other preset, the same way. A voice type is the one setting a user picks
// with their own body, so all five are pinned rather than one standing in for the
// rest.
var migBad = [], stored;
for (i = 1; i < VR.length; i++) {
  stored = loadStore('{"voiceRange":"' + VR[i].id + '","voiceLo":' + VR[i].lo +
                     ',"voiceHi":' + VR[i].hi + '}').store.settings();
  if (stored.voiceRange !== VR[i].id || stored.voiceLo !== VR[i].lo || stored.voiceHi !== VR[i].hi)
    migBad.push(VR[i].id + ' -> ' + stored.voiceRange + ' ' + stored.voiceLo + '-' + stored.voiceHi);
}
ok(migBad.length === 0, 'all five voice-type presets round-trip untouched through the new validator' +
   (migBad.length ? ' — ' + migBad.join('; ') : ''));

/* ==========================================================================
 * learn.js  —  the direction readout
 *
 * change spec §2 put the sing feedback in learn.js, which is DOM-bound: it
 * touches document at load, owns window.Learn and carries no dual-export tail,
 * so renderDirection() cannot be called from here the way playBand() can. Not
 * testing it was not an option — see the fourth bullet at the top of this file —
 * so it is pinned from BOTH sides:
 *
 *   • an ORACLE, the banding table transcribed from the spec, asserts what the
 *     readout must say at every boundary and on both signs;
 *   • a source GREP asserts that learn.js really does read sharp off `cents > 0`
 *     and really does band at 50 / 150, so an inversion or a re-tuned threshold
 *     breaks this file even though the oracle would still happily agree with
 *     itself.
 *
 * The grep is the half with teeth, and it is deliberately narrow — three
 * constants, one comparison, one needle expression, one leak check — so that
 * refactoring learn.js does not break it but changing what it MEANS does.
 * ======================================================================== */

console.log('\n== learn.js: direction banding, transcribed from change spec §2 ==');

// The spec's table. `cents` is signed and measured FROM the target, so positive
// means the singer is above it.
function direction(cents) {
  var mag = Math.abs(cents), sharp = (cents > 0);
  if (mag <= 50)  return { word: '✓ that\'s it',                 coach: 'hold it',    cls: 'ok' };
  if (mag <= 150) return { word: sharp ? '▼ lower' : '▲ higher',  coach: 'almost',     cls: 'near' };
  return                 { word: sharp ? '▼ lower' : '▲ higher',  coach: 'keep going', cls: '' };
}
// learn.css makes this percentage the needle's CENTRE (translateX(-50%)), so 50
// is matched and ±50 cents reaches the ends of the bar.
function needle(cents) { return Math.max(0, Math.min(100, 50 + cents)); }

// Both signs at both boundaries, plus the ±600 worst case a tritone away. The
// boundaries are the entire content of the table — the middle of a band is not
// where a banding bug lives.
var DIR = [
  [    0, '✓ that\'s it', 'hold it',    'ok'   ],
  [   50, '✓ that\'s it', 'hold it',    'ok'   ],
  [  -50, '✓ that\'s it', 'hold it',    'ok'   ],
  [   51, '▼ lower',      'almost',     'near' ],
  [  -51, '▲ higher',     'almost',     'near' ],
  [  150, '▼ lower',      'almost',     'near' ],
  [ -150, '▲ higher',     'almost',     'near' ],
  [  151, '▼ lower',      'keep going', ''     ],
  [ -151, '▲ higher',     'keep going', ''     ],
  [  600, '▼ lower',      'keep going', ''     ],
  [ -600, '▲ higher',     'keep going', ''     ]
];
var dirBad = [], dres, dcase;
for (i = 0; i < DIR.length; i++) {
  dcase = DIR[i];
  dres = direction(dcase[0]);
  if (dres.word !== dcase[1] || dres.coach !== dcase[2] || dres.cls !== dcase[3])
    dirBad.push(dcase[0] + ' -> ' + dres.word + ' / ' + dres.coach + ' / ' + (dres.cls || '(none)'));
}
ok(dirBad.length === 0, 'both signs at 0, ' + String.fromCharCode(177) + '50, ' +
   String.fromCharCode(177) + '51, ' + String.fromCharCode(177) + '150, ' +
   String.fromCharCode(177) + '151 and ' + String.fromCharCode(177) +
   '600 band exactly as the spec says' + (dirBad.length ? ' — ' + dirBad.join('; ') : ''));
// THE SIGN, stated as plainly as it can be stated, because this is the assertion
// that would have caught an inverted needle. learn.js:989 centsFromPc() returns
// the sung pitch MINUS the target, so a positive number means the voice is ABOVE
// the note and the only useful instruction is to come DOWN.
ok(direction(120).word === '▼ lower',
   'POSITIVE cents = the singer is SHARP = the instruction is LOWER (' + direction(120).word + ')');
ok(direction(-120).word === '▲ higher',
   'NEGATIVE cents = the singer is FLAT = the instruction is HIGHER (' + direction(-120).word + ')');
ok(direction(51).word !== direction(-51).word && direction(600).word !== direction(-600).word,
   'the two signs never give the same instruction, near the boundary or far from it');
// The needle inherits that sign: a sharp singer sits to the RIGHT of centre, like
// every hardware tuner ever built.
ok(needle(0) === 50 && needle(50) === 100 && needle(-50) === 0,
   'the needle centres on a match and reaches the ends of the bar at ' +
   String.fromCharCode(177) + '50 cents');
ok(needle(600) === 100 && needle(-600) === 0,
   'and is clamped to the bar, not run off it, at the ' + String.fromCharCode(177) + '600 worst case');

console.log('\n== learn.js: the shipped thresholds and sign, read off the source ==');
var SRC = fs.readFileSync(path.join(LEARN, 'learn.js'), 'utf8');
ok(/var\s+MATCH_CENTS\s*=\s*50\s*;/.test(SRC), 'learn.js bands a match at 50 cents');
ok(/var\s+NEAR_CENTS\s*=\s*150\s*;/.test(SRC), "learn.js bands 'almost' at 150 cents");
ok(/var\s+MAX_SING_MISS\s*=\s*3\s*;/.test(SRC),
   "change spec §3's escape hatch opens after 3 unmatched holds on one trial");
// The comparison itself, and then what is done with it. Inverting either half
// breaks exactly one of these two, which is why both are asserted rather than
// one standing in for the other.
ok(/sharp\s*=\s*\(\s*cents\s*>\s*0\s*\)/.test(SRC), 'learn.js reads SHARP off `cents > 0`');
ok(SRC.indexOf("sharp ? '▼ lower' : '▲ higher'") >= 0 && SRC.indexOf("sharp ? '▲ higher'") < 0,
   "...and sends a sharp singer DOWN: sharp ? '▼ lower' : '▲ higher', never the reverse");
// The needle is the nastier half of an inversion: flip this and the words stay
// right while the bar lies, which is the combination a reader skims past.
ok(/50\s*\+\s*cents/.test(SRC) && !/50\s*-\s*cents/.test(SRC),
   'the needle is 50 + cents, so a sharp singer sits RIGHT of centre');
ok(/Math\.abs\(cents\)\s*<=\s*MATCH_CENTS/.test(SRC),
   'the gate opens on |cents| <= MATCH_CENTS (change spec §3), not on any steady pitch');
// change spec §0, the correctness fix this whole change exists for. The old
// readout printed EarTheory.noteName() of whatever had just been sung while the
// stage header showed the key — a name plus one subtraction IS the degree, with
// no ear involved anywhere. Nothing between onSingFrame() and singTargetPc() may
// name a note again.
//
// The COMMENTS in that block do discuss noteName(), because the rationale for
// removing it is written there, so they are stripped first. The stripper is
// crude on purpose: this block contains no string and no regex literal carrying a
// // or /* sequence, which is the only thing that could fool it.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
var from = SRC.indexOf('function onSingFrame'), to = SRC.indexOf('function singTargetPc');
ok(from > 0 && to > from, 'the sing-feedback block is where this test expects it (' + from + '..' + to + ')');
var block = stripComments(SRC.slice(from, to));
ok(block.indexOf('noteName') < 0 && block.indexOf('spellDegree') < 0 &&
   block.indexOf('keyLabel') < 0 && block.indexOf('.label(') < 0,
   'the live readout names no note, spells no degree and prints no syllable (change spec §0)');
ok(block.indexOf('▼ lower') > 0 && block.indexOf('▲ higher') > 0 && block.indexOf('that') > 0,
   '...and renders the three direction strings in its place');
// REVEAL is the other half of the same rule and the easy one to over-correct:
// the answer is committed by then, so naming the note is the entire point of the
// study phase (change spec §2). learn.js must still call noteName() SOMEWHERE.
ok(SRC.indexOf('noteName(') > 0,
   'and the note name still exists elsewhere in learn.js — REVEAL is where it belongs');

console.log('\n' + (failures ? failures + ' TEST(S) FAILED' : 'ALL TESTS PASSED'));
process.exit(failures ? 1 : 0);
