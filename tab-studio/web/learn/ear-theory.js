/* ============================================================================
 * ear-theory.js  —  keys, scale degrees and reference cadences for /learn.
 *
 * The ear drill trains ONE skill: name the scale degree of a note against an
 * established key (design Part I §1). Degrees are octave-invariant — ♭7 is ♭7 in
 * any register — so every answer is compared as a pitch class, and this module
 * owns all of the mod-12 arithmetic. It is PURE: no DOM, no audio, no clock, and
 * no Math.random(). Randomness is injected as `rnd()` so a seeded generator makes
 * a whole session reproducible from Node.
 *
 * Do-based minor, always. 1 is the tonic in BOTH modes and minor degrees are
 * spelled against the parallel major (1 2 ♭3 4 5 ♭6 ♭7). That is how a jazz/funk
 * bassist names chord tones, and it means the tonic never moves between modes.
 * There is deliberately no la-based minor anywhere in here.
 *
 * Spelling is real musicianship, not cosmetics: the ♭7 of E♭ major is D♭, never
 * C♯, and the key is E♭ major, never D♯ major. chord-core.js:16 NAMES is a
 * sharp-only table and structurally cannot express that, so key names and note
 * names are built here from a letter + an accidental — see spell(). Cadences,
 * by contrast, DO reuse chord-core.js:20-33 QUAL as the pitch-class-set table
 * rather than retyping interval numbers.
 *
 *   EarTheory.DEGREES                        — 12 × {pc,num,solfege,black}
 *   EarTheory.LEVELS                         — 7 × {n,name,degrees,mode,spread,taper}
 *   EarTheory.VOICES                         — timbre names, mirrors ear-audio.js
 *   EarTheory.FLAT / .SHARP                  — the two accidental glyphs
 *   EarTheory.levelFor(n)                    — clamped LEVELS lookup, 1-based
 *   EarTheory.keyName(pc, mode)              — 'B♭'          spelled for the key
 *   EarTheory.keyLabel(pc, mode)             — 'B♭ major'
 *   EarTheory.spellDegree(deg, tonicPc, mode)— 'D♭'          no octave
 *   EarTheory.noteName(midi, tonicPc, mode)  — 'D♭4'         C4 = MIDI 60
 *   EarTheory.degreeOf(midi, tonicPc)        — 0…11
 *   EarTheory.midiForDegree(deg, tonicPc, oct) — MIDI of a degree over a tonic
 *   EarTheory.label(deg, style)              — '♭3' | 'me' | '♭3 · me'
 *   EarTheory.cadence(kind, tonicPc, mode)   — [{midis,beats,roman,name}]
 *   EarTheory.playBand(voiceLo, voiceHi, spread) — {lo,hi} MIDI band for test notes
 *   EarTheory.nextQuestion(state, rnd)       — the whole draw for one trial
 *   EarTheory.midiToFreq(midi)               — Hz
 * ========================================================================== */
var EarTheory = (function () {
  'use strict';

  // The literal ♭ / ♯ glyphs used throughout this file are exactly these two code
  // points; the constants exist so string tests never depend on a copy-paste.
  var FLAT  = '♭';        // ♭  MUSIC FLAT SIGN
  var SHARP = '♯';        // ♯  MUSIC SHARP SIGN

  function norm12(n) { return ((Math.round(n) % 12) + 12) % 12; }

  // ---- degrees --------------------------------------------------------------
  // design Part I §2. `pc` is semitones above the tonic, so DEGREES[d].pc === d
  // and the array doubles as the answer-index table for the on-screen keyboard.
  // `black` marks the five that fall on black keys of a piano ROOTED AT THE TONIC
  // (not on an absolute C keyboard) — that is what the answer widget draws, and
  // it is what makes the user's own "how hard? the black keys" framing literal.
  var DEGREES = [
    { pc:  0, num: '1',  solfege: 'do',  black: false },
    { pc:  1, num: '♭2', solfege: 'ra',  black: true  },
    { pc:  2, num: '2',  solfege: 're',  black: false },
    { pc:  3, num: '♭3', solfege: 'me',  black: true  },
    { pc:  4, num: '3',  solfege: 'mi',  black: false },
    { pc:  5, num: '4',  solfege: 'fa',  black: false },
    { pc:  6, num: '♯4', solfege: 'fi',  black: true  },
    { pc:  7, num: '5',  solfege: 'sol', black: false },
    { pc:  8, num: '♭6', solfege: 'le',  black: true  },
    { pc:  9, num: '6',  solfege: 'la',  black: false },
    { pc: 10, num: '♭7', solfege: 'te',  black: true  },
    { pc: 11, num: '7',  solfege: 'ti',  black: false }
  ];

  // ---- levels ---------------------------------------------------------------
  // design Part I §3. `spread` is how many octaves above the tonic test notes may
  // land: L4 differs from L3 ONLY in spread, which isolates "hold the tonic while
  // the register moves" as its own skill. `taper` is the default context refresh
  // interval in questions (design §6) — the UI may override it per session.
  // L6 is the genre payload: blue third, blue fifth and dominant seventh added to
  // the major scale, which is the natural bridge into full chromatic.
  var LEVELS = [
    { n: 1, name: 'Do Re Mi',      degrees: [0, 2, 4],                            mode: 'major', spread: 1, taper: 1 },
    { n: 2, name: 'Pentachord',    degrees: [0, 2, 4, 5, 7],                      mode: 'major', spread: 1, taper: 1 },
    { n: 3, name: 'Full major',    degrees: [0, 2, 4, 5, 7, 9, 11],               mode: 'major', spread: 1, taper: 4 },
    { n: 4, name: 'Major, wide',   degrees: [0, 2, 4, 5, 7, 9, 11],               mode: 'major', spread: 2, taper: 4 },
    { n: 5, name: 'Natural minor', degrees: [0, 2, 3, 5, 7, 8, 10],               mode: 'minor', spread: 2, taper: 8 },
    { n: 6, name: 'Funk colours',  degrees: [0, 2, 3, 4, 5, 6, 7, 9, 10, 11],     mode: 'major', spread: 2, taper: 8 },
    { n: 7, name: 'All twelve',    degrees: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], mode: 'major', spread: 2, taper: 8 }
  ];

  function levelFor(n) {
    n = Math.round(n || 1);
    if (n < 1) n = 1;
    if (n > LEVELS.length) n = LEVELS.length;
    return LEVELS[n - 1];
  }

  // Timbre names. This list MUST stay identical to EarAudio.VOICES (ear-audio.js,
  // contract §F); it is duplicated rather than imported because ear-theory.js is
  // pure and loads first — it must require() cleanly under Node with no audio
  // module present at all.
  var VOICES = ['rhodes', 'pluck', 'reed', 'flute', 'bass', 'organ'];

  // ---- key and note spelling ------------------------------------------------
  var LETTERS   = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  var LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

  // Major keys, circle-of-fifths spelling. Ties are broken toward the fewer
  // accidentals: D♭ (5♭) beats C♯ (7♯), A♭ (4♭) beats G♯ (8♯). At the tritone the
  // design lists BOTH F♯ and G♭ as legitimate, and we take F♯ for a concrete
  // reason: spell() below would have to write A𝄫 for the ♭2 of G♭ and B𝄫 for its
  // ♭3, while F♯ never needs more than a single sharp for any of the 12 degrees.
  var MAJOR_KEYS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

  // Minor keys are NOT the same names shifted — the minor circle sits three
  // fifths flatter, so the sharp side reaches C♯/G♯/D♯ and the flat side stops at
  // E♭. "D♭ minor" (8♭) and "A♭ minor" (7♭) are not keys anyone writes; C♯ minor
  // and G♯ minor are. At the tritone-from-C spot we take E♭ minor (6♭) over
  // D♯ minor (6♯) because E♭ minor is overwhelmingly the one in print.
  var MINOR_KEYS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

  function isMinor(mode) { return mode === 'minor'; }

  function keyName(pc, mode) {
    return (isMinor(mode) ? MINOR_KEYS : MAJOR_KEYS)[norm12(pc)];
  }
  function keyLabel(pc, mode) {
    return keyName(pc, mode) + (isMinor(mode) ? ' minor' : ' major');
  }

  // Split a key name back into {letter index, alteration} so degrees can be
  // spelled by stepping letters rather than by looking up a chromatic table.
  function keyParts(pc, mode) {
    var name = keyName(pc, mode), a = name.charAt(1);
    return { letter: LETTERS.indexOf(name.charAt(0)),
             alt: a === FLAT ? -1 : (a === SHARP ? 1 : 0) };
  }

  // Letter step (0 = the tonic's own letter, 1 = the next letter up, …) for each
  // degree, primary first and an enharmonic fallback second. The primary is the
  // do-based-minor vocabulary itself: ♭2 is a SECOND, ♭3 is a THIRD, ♯4 is a
  // FOURTH — that is why the numbers are spelled the way §2 spells them.
  // The fallback exists because a strictly-correct primary can demand a double
  // accidental in a remote key (the ♭2 of D♭ is E𝄫; the ♯4 of C♯ minor is F𝄪).
  // Nobody writes those on a flash card, and the fallback always lands on a
  // natural or a single accidental — verified over all 24 keys × 12 degrees.
  var STEPS = [
    [0, 6],   //  1   … or ♯7
    [1, 0],   //  ♭2  … or ♯1
    [1, 2],   //  2
    [2, 1],   //  ♭3  … or ♯2
    [2, 3],   //  3   … or ♭4
    [3, 2],   //  4
    [3, 4],   //  ♯4  … or ♭5
    [4, 5],   //  5
    [5, 4],   //  ♭6  … or ♯5
    [5, 6],   //  6
    [6, 5],   //  ♭7  … or ♯6
    [6, 0]    //  7   … or ♭1
  ];

  // How far the given letter must be bent to sound `targetPc`, folded into
  // −6…+5 so that a wrap (C♭ = pc 11 under letter C = pc 0) reads as −1, not +11.
  function alterFor(letterIdx, targetPc) {
    return ((targetPc - LETTER_PC[letterIdx] + 18) % 12) - 6;
  }

  function accidental(alt) {
    var g = alt < 0 ? FLAT : SHARP, n = Math.abs(alt), s = '', i;
    for (i = 0; i < n; i++) s += g;
    return s;
  }

  // Spell one degree in one key. Returns the letter index and alteration too,
  // because noteName() needs the alteration to place the octave number.
  function spell(deg, tonicPc, mode) {
    deg = norm12(deg);
    var kp = keyParts(tonicPc, mode), target = norm12(tonicPc + deg);
    var cands = STEPS[deg], best = null, i, li, alt;
    for (i = 0; i < cands.length; i++) {
      li = (kp.letter + cands[i]) % 7;
      alt = alterFor(li, target);
      if (!best || Math.abs(alt) < Math.abs(best.alt)) best = { li: li, alt: alt };
      if (Math.abs(alt) <= 1) break;         // primary spelling wins whenever it is sane
    }
    return { name: LETTERS[best.li] + accidental(best.alt), letter: best.li, alt: best.alt };
  }

  function spellDegree(deg, tonicPc, mode) { return spell(deg, tonicPc, mode).name; }

  function degreeOf(midi, tonicPc) { return norm12(Math.round(midi) - Math.round(tonicPc)); }

  // `oct` is the SCIENTIFIC octave of the TONIC (4 → the octave containing middle
  // C), not of the resulting note: degrees run 0…11 above the tonic, so anything
  // above 7 of a tonic late in the octave sounds in oct+1. That is intended — the
  // tonic is the reference and everything is measured up from it.
  function midiForDegree(deg, tonicPc, oct) {
    return (Math.round(oct == null ? 4 : oct) + 1) * 12 + norm12(tonicPc) + norm12(deg);
  }

  function noteName(midi, tonicPc, mode) {
    midi = Math.round(midi);
    var s = spell(degreeOf(midi, tonicPc), tonicPc, mode);
    // The octave belongs to the LETTER, not to the sounding pitch: C♭4 sounds as
    // B3 but is written in octave 4, and B♯3 sounds as C4 but is written in 3.
    // Undoing the accidental before the divide is what gets that right.
    return s.name + (Math.floor((midi - s.alt) / 12) - 1);
  }

  function label(deg, style) {
    var d = DEGREES[norm12(deg)];
    if (style === 'solfege') return d.solfege;
    if (style === 'both') return d.num + ' · ' + d.solfege;
    return d.num;                            // 'numbers' is the default (design §2)
  }

  // ---- cadences -------------------------------------------------------------
  // Only the six qualities the two progressions need. chord-core.js:20-33 QUAL is
  // the real table and is used whenever it is loaded; this copy exists solely so
  // `require('./ear-theory.js')` works in the test harness, where ChordCore is a
  // browser global that does not exist. Keep the pcs identical to chord-core.js.
  var FALLBACK_QUAL = [
    { q: 'maj',   pcs: [0, 4, 7] },
    { q: 'min',   pcs: [0, 3, 7] },
    { q: '7',     pcs: [0, 4, 7, 10] },
    { q: 'm7',    pcs: [0, 3, 7, 10] },
    { q: 'maj7',  pcs: [0, 4, 7, 11] },
    { q: 'm7b5',  pcs: [0, 3, 6, 10] }
  ];

  // Display suffixes. chord-core.js spells m7b5 with an ASCII 'b'; every accidental
  // the ear trainer shows the user is a real glyph, so the suffix is re-tabled here
  // rather than post-processed out of ChordCore.QUAL[].suffix.
  var SUFFIX = { maj: '', min: 'm', '7': '7', m7: 'm7', maj7: 'maj7', m7b5: 'm7' + FLAT + '5' };

  function qualPcs(q) {
    // typeof on an undeclared identifier is legal even under 'use strict', which
    // is the whole point of this guard — ChordCore is simply absent under Node.
    var table = (typeof ChordCore !== 'undefined' && ChordCore && ChordCore.QUAL) ? ChordCore.QUAL : FALLBACK_QUAL;
    for (var i = 0; i < table.length; i++) if (table[i].q === q) return table[i].pcs;
    return [0, 4, 7];
  }

  // design Part I §6. Minor uses i–iv–V–i and iiø–V–i: the V stays MAJOR (and the
  // ii-V dominant keeps its major third) because the raised leading tone is what
  // makes the ear hear "minor tonic" rather than "relative major's vi".
  var PROG = {
    'cadence': {
      major: [ { deg: 0, q: 'maj', beats: 1, roman: 'I' },
               { deg: 5, q: 'maj', beats: 1, roman: 'IV' },
               { deg: 7, q: 'maj', beats: 1, roman: 'V' },
               { deg: 0, q: 'maj', beats: 2, roman: 'I' } ],
      minor: [ { deg: 0, q: 'min', beats: 1, roman: 'i' },
               { deg: 5, q: 'min', beats: 1, roman: 'iv' },
               { deg: 7, q: 'maj', beats: 1, roman: 'V' },
               { deg: 0, q: 'min', beats: 2, roman: 'i' } ]
    },
    'ii-V-I': {
      major: [ { deg: 2, q: 'm7',   beats: 1, roman: 'ii7' },
               { deg: 7, q: '7',    beats: 1, roman: 'V7' },
               { deg: 0, q: 'maj7', beats: 2, roman: 'Imaj7' } ],
      minor: [ { deg: 2, q: 'm7b5', beats: 1, roman: 'iiø' },
               { deg: 7, q: '7',    beats: 1, roman: 'V7' },
               { deg: 0, q: 'min',  beats: 2, roman: 'i' } ]
    }
  };

  var BASS_LO = 48;            // C3 — every chord root lands in 48…59
  var SEED_LO = 60;            // the first upper voicing is stacked close above C4
  var UP_LO   = 55, UP_HI = 79;// the upper voices never leave G3…G5

  function seatIn(pc, lo) { return lo + norm12(pc - lo); }

  // The instance of `pc` nearest `ref`, kept inside the upper-voice window. Ties
  // (a tritone away) resolve downward, which is arbitrary but stable.
  function nearestPc(pc, ref) {
    var m = ref + norm12(pc - ref + 6) - 6;
    if (m < UP_LO) m += 12;
    if (m > UP_HI) m -= 12;
    return m;
  }

  function permute(items) {
    if (items.length <= 1) return [items.slice()];
    var out = [], i, j, rest, subs;
    for (i = 0; i < items.length; i++) {
      rest = items.slice(0, i).concat(items.slice(i + 1));
      subs = permute(rest);
      for (j = 0; j < subs.length; j++) out.push([items[i]].concat(subs[j]));
    }
    return out;
  }

  // Voice-lead one chord's upper pitch classes against the previous voicing by
  // brute force: try every assignment of pcs to voices, place each at its nearest
  // instance, keep the cheapest total motion. With three upper voices that is six
  // candidates — trivially cheap, and it is why I–IV–V–I comes out as the textbook
  // C4-E4-G4 / C4-F4-A4 / B3-D4-G4 / C4-E4-G4 instead of a stack of root positions.
  function voiceUpper(pcs, prev) {
    if (!prev) {
      var seed = [], i;
      for (i = 0; i < pcs.length; i++) seed.push(seatIn(pcs[i], SEED_LO));
      return seed.sort(function (a, b) { return a - b; });
    }
    var perms = permute(pcs), best = null, bestCost = Infinity, p, v, cost, k, ref;
    for (p = 0; p < perms.length; p++) {
      v = []; cost = 0;
      for (k = 0; k < perms[p].length; k++) {
        ref = prev[k] != null ? prev[k] : prev[prev.length - 1];
        v.push(nearestPc(perms[p][k], ref));
        cost += Math.abs(v[k] - ref);
      }
      // A unison between two voices thins the chord out; nudge the search away
      // from it without forbidding it outright.
      for (k = 1; k < v.length; k++) if (v.indexOf(v[k]) < k) cost += 3;
      if (cost < bestCost) { bestCost = cost; best = v; }
    }
    return best.sort(function (a, b) { return a - b; });
  }

  // kind 'cadence' → I–IV–V–I, 'ii-V-I' → the jazz cadence, 'drone' → one held
  // tonic. Returns [{midis, beats, roman, name}]; `beats` is relative, the caller
  // multiplies by 60/bpm. For 'drone' the single entry's beats is nominal — the
  // drone is sustained indefinitely by EarAudio.startDrone(midis[0]) (contract §F).
  function cadence(kind, tonicPc, mode) {
    tonicPc = norm12(tonicPc);
    var m = isMinor(mode) ? 'minor' : 'major';
    if (kind === 'drone') {
      return [ { midis: [seatIn(tonicPc, BASS_LO)], beats: 4,
                 roman: m === 'minor' ? 'i' : 'I', name: spellDegree(0, tonicPc, mode) } ];
    }
    var prog = (PROG[kind] || PROG['cadence'])[m];
    var out = [], prev = null, i, c, root, pcs, upper, j, mids;
    for (i = 0; i < prog.length; i++) {
      c = prog[i];
      root = norm12(tonicPc + c.deg);
      pcs = qualPcs(c.q);
      // Four-note chords hand their root to the bass and voice only 3rd-5th-7th
      // above it; triads keep all three tones, which doubles the root an octave or
      // two up — normal, and it keeps every voicing exactly three voices wide.
      upper = [];
      for (j = (pcs.length > 3 ? 1 : 0); j < pcs.length; j++) upper.push(norm12(root + pcs[j]));
      upper = voiceUpper(upper, prev);
      prev = upper;
      mids = [seatIn(root, BASS_LO)].concat(upper);
      out.push({ midis: mids, beats: c.beats, roman: c.roman,
                 name: spellDegree(c.deg, tonicPc, mode) + (SUFFIX[c.q] || '') });
    }
    return out;
  }

  // ---- register -------------------------------------------------------------
  // 40 is the bottom of the MPM lag search (70 Hz, design §11) — a tonic below it
  // could be played but never sung back and graded. 88 is a self-imposed ceiling
  // so a two-octave spread over a soprano range does not turn shrill.
  var BAND_MIN = 40, BAND_MAX = 88;

  // The MIDI window test notes may occupy. The tonic is seated at the lowest
  // instance of its pitch class at or above `lo`, so the tonic itself can sit
  // anywhere in lo…lo+11; a spread of S octaves then reaches lo+11+12S−1. That is
  // why the band is widened to at least 12S+10 semitones even when the singer's
  // range is narrower — otherwise some keys would have no legal seat at all.
  // Widening is biased upward (⅓ down, ⅔ up) because the tonic sits at the bottom:
  // a slightly-too-high top note is still nameable, a too-low reference just turns
  // to mud.
  function playBand(voiceLo, voiceHi, spread) {
    var need = 12 * (spread === 2 ? 2 : 1) + 10;
    var lo = Math.round(voiceLo), hi = Math.round(voiceHi), down;
    if (!(lo < hi)) { lo = 43; hi = 67; }             // baritone default, design §9
    if (hi - lo < need) {
      down = Math.floor((need - (hi - lo)) / 3);
      hi += (need - (hi - lo)) - down;
      lo -= down;
    }
    if (lo < BAND_MIN) lo = BAND_MIN;
    if (hi < lo + need) hi = lo + need;
    if (hi > BAND_MAX) { hi = BAND_MAX; if (lo > hi - need) lo = hi - need; }
    return { lo: lo, hi: hi };
  }

  // ---- the draw -------------------------------------------------------------
  // player.js:41 already has this exact one-liner, but it is closure-private and
  // never exported (contract §C) and we are explicitly not modifying player.js.
  // The duplication is deliberate — do not "fix" it by reaching into that module.
  function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  // Uniform pick. Some seeded generators can return exactly 1.0, which would index
  // one past the end, so the result is clamped rather than trusted.
  function pick(arr, rnd) {
    var i = Math.floor(rnd() * arr.length);
    if (i < 0) i = 0;
    if (i >= arr.length) i = arr.length - 1;
    return arr[i];
  }

  var THIN_LOW = { flute: 1, pluck: 1, rhodes: 1 };

  /* Draw one trial.
   *
   * state {
   *   level         1…7            — indexes LEVELS; supplies degrees/mode/spread
   *   questionIndex 0-based         — position in the session, drives the taper
   *   lastKey       0…11 | null     — tonic pc of the previous question
   *   lastDegrees   [deg, …]        — recent degrees, MOST RECENT FIRST (2 is enough)
   *   voiceLo       MIDI            — singer's low note   (design §9)
   *   voiceHi       MIDI            — singer's high note
   *   context       'cadence'|'ii-V-I'|'drone'   — informational here; the caller
   *                                 decides what to PLAY when newKey is true
   *   taper         1|2|4|8|0       — re-establish every N questions, 0 = once per
   *                                 session. Omitted → the level's default.
   *   voice         'random' | one of VOICES   — optional; omitted means random
   * }
   *
   * Returns {tonicPc, mode, degree, midi, voice, newKey}.
   *
   * rnd() is consumed in a fixed order so seeded tests can predict it:
   *   key (only when the key changes) → degree → octave (only when spread is 2)
   *   → timbre (only when the timbre is random).
   */
  function nextQuestion(state, rnd) {
    if (typeof rnd !== 'function') throw new Error('EarTheory.nextQuestion(state, rnd): rnd is required');
    state = state || {};
    var lv    = levelFor(state.level);
    var qi    = Math.max(0, Math.round(state.questionIndex || 0));
    var taper = (state.taper == null) ? lv.taper : Math.round(state.taper);
    // The level supplies the DEFAULT register spread, but the settings panel
    // exposes it as its own control (design §12, learn.js:246) — so honour an
    // explicit override exactly the way `taper` above is honoured. Reading
    // lv.spread unconditionally left that control inert at every level whose
    // default it disagreed with, and worse, disagreed with the band the caller
    // had already computed from the same setting (ear-session.js:185).
    var spread = (state.spread === 1 || state.spread === 2) ? state.spread : lv.spread;

    // Context is due on question 0 and then every `taper` questions; taper 0 is
    // the 'session' setting — established once and never refreshed. In `drone`
    // context there is no cadence to replay, so the caller reads newKey as
    // "restart the drone on this tonic" instead (design §6).
    var newKey = (qi === 0) || (taper > 0 && qi % taper === 0);

    var lastKey = (state.lastKey == null) ? null : norm12(state.lastKey);
    var tonicPc, keys = [], k;
    if (newKey || lastKey === null) {
      // design §7: never the same key twice in a row — back-to-back repeats let
      // the user coast on absolute memory of the last tonic instead of re-hearing it.
      for (k = 0; k < 12; k++) if (k !== lastKey) keys.push(k);
      tonicPc = pick(keys, rnd);
      newKey = true;                        // a key the user has not heard needs its context
    } else {
      tonicPc = lastKey;
    }

    // design §7: never the same degree three times running. Two in a row is fine
    // (and useful — it proves the answer was heard, not guessed from novelty).
    var pool = lv.degrees, ld = state.lastDegrees || [], trimmed = [], i;
    if (ld.length >= 2 && ld[0] === ld[1]) {
      for (i = 0; i < pool.length; i++) if (pool[i] !== ld[0]) trimmed.push(pool[i]);
      if (trimmed.length) pool = trimmed;   // never strand the draw on a 1-degree level
    }
    var degree = pick(pool, rnd);

    var band = playBand(state.voiceLo, state.voiceHi, spread);
    var seat = seatIn(tonicPc, band.lo);    // the tonic itself, lowest instance in the band
    var oct  = (spread === 2 && rnd() < 0.5) ? 1 : 0;
    var midi = seat + degree + 12 * oct;
    if (midi > band.hi) midi -= 12;         // playBand() sizes the band so this cannot
                                            // fire; kept because a caller could pass a
                                            // hand-made band through voiceLo/voiceHi.

    var fixed = !!(state.voice && state.voice !== 'random');
    var voice = fixed ? state.voice : pick(VOICES, rnd);
    // design §10: `bass` is the voice "used preferentially in the low register".
    // flute, pluck and rhodes lose their fundamental down there and the perceived
    // pitch turns ambiguous, which would corrupt the training signal rather than
    // just sounding thin. A user-pinned timbre is never overridden.
    if (!fixed && midi < 45 && THIN_LOW[voice]) voice = 'bass';

    return { tonicPc: tonicPc, mode: lv.mode, degree: degree, midi: midi, voice: voice, newKey: newKey };
  }

  var api = {
    DEGREES: DEGREES, LEVELS: LEVELS, VOICES: VOICES, FLAT: FLAT, SHARP: SHARP,
    levelFor: levelFor,
    keyName: keyName, keyLabel: keyLabel,
    spellDegree: spellDegree, noteName: noteName,
    degreeOf: degreeOf, midiForDegree: midiForDegree,
    label: label, cadence: cadence, playBand: playBand,
    nextQuestion: nextQuestion, midiToFreq: midiToFreq
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EarTheory = api;
  return api;
})();
