// Node test harness for the bass-tab engine (web/bass-tab-core.js).
//   run:  node tab-studio/test-core.js
const fs = require('fs');
const path = require('path');
const BassTab = require(path.join(__dirname, 'web', 'bass-tab-core.js'));

const MIDI = path.join(__dirname, '..', 'seed-sources', 'Too Many Kicks Bass.mid');
const buf = fs.readFileSync(MIDI);
const song = BassTab.parseMidi(new Uint8Array(buf));

let failures = 0;
function ok(cond, msg) { console.log((cond ? '  ok  ' : ' FAIL ') + msg); if (!cond) failures++; }

console.log('== parse ==');
console.log('ppq', song.ppq, 'tracks', song.ntracks, 'notes', song.notes.length,
  'tempos', song.tempos.map(t => Math.round(t.bpm)).join(','));

const grid = BassTab.detectGrid(song.notes, song.ppq);
const ps = BassTab.pitchStats(song.notes);
console.log('grid', grid.label, '| pitch', BassTab.pitchName(ps.min), '..', BassTab.pitchName(ps.max));

console.log('\n== monophonic example: full fingering ==');
const r = BassTab.convert(song, { octaveShift: -1, gridTicks: 120 });
ok(r.fingering.positions.filter(Boolean).length === song.notes.length,
  'every note gets a position (' + r.fingering.positions.filter(Boolean).length + '/' + song.notes.length + ')');
ok(r.ascii.indexOf('\n') > 0 && /\d/.test(r.ascii), 'ascii tab has fret digits');
console.log(r.ascii.split('\n').slice(0, 10).join('\n'));

console.log('\n== regression: DP must not blank on unplayable notes ==');
// Inject 3 out-of-range (unplayable) pitches among playable ones; the Viterbi
// must still assign positions to all the PLAYABLE notes (the old bug left them null).
const mixed = [];
for (let i = 0; i < 30; i++) mixed.push({ start: i * 120, end: i * 120 + 100, pitch: 40 + (i % 5), velocity: 100 });
mixed.splice(5, 0, { start: 5 * 120, end: 5 * 120 + 100, pitch: 10, velocity: 100 });   // far below E1 → unplayable
mixed.splice(15, 0, { start: 15 * 120, end: 15 * 120 + 100, pitch: 12, velocity: 100 });
mixed.splice(25, 0, { start: 25 * 120, end: 25 * 120 + 100, pitch: 11, velocity: 100 });
const fb = BassTab.assignFingering(mixed, { tuning: BassTab.STD_TUNING, maxFret: 24 });
const playable = mixed.length - fb.unplayable.length;
ok(fb.positions.filter(Boolean).length === playable,
  'all playable notes assigned despite unplayable ones (' + fb.positions.filter(Boolean).length + '/' + playable + ', unplayable ' + fb.unplayable.length + ')');

console.log('\n== regression: monophonicReduce collapses polyphony ==');
const poly = [
  { start: 0, end: 480, pitch: 40, velocity: 100 },   // onset 1: chord (keep lowest)
  { start: 5, end: 200, pitch: 52, velocity: 120 },
  { start: 10, end: 240, pitch: 47, velocity: 90 },
  { start: 240, end: 720, pitch: 43, velocity: 100 },  // onset 2 overlaps onset 1's tail
  { start: 244, end: 300, pitch: 55, velocity: 80 },
];
const mono = BassTab.monophonicReduce(poly, 480, { pick: 'low' });
ok(mono.length === 2, 'two onsets -> two notes (' + mono.length + ')');
ok(mono[0].pitch === 40 && mono[1].pitch === 43, 'kept the lowest pitch at each onset');
ok(mono[0].end <= mono[1].start, 'first note trimmed to be monophonic');

console.log('\n== rhythm lane: rests must tile the silence, at every grid ==');
// The rhythm lane had no coverage at all, and it carried a bug that only showed up
// when ticksPerBar/stepsPerBar came out fractional: decomposeRest's value table went
// empty and every rest collapsed to a single-column sixteenth — visually wrong (a
// silent bar drawn as 24 glyphs instead of one whole rest) and, past 2000 steps of
// silence, silently truncated. These two invariants pin that down.
function rhythmOf(ppq, tempo, timelineTempo, num, den, divTicks, notes) {
  // mirrors bass-tab.js render(): layout ppq scales by the tempo ratio, and the
  // grid is ticksPerBar/steps — never a rounded tick count
  const lp = ppq * (timelineTempo / tempo);
  const tpb = lp * 4 * num / den;
  const steps = Math.max(1, Math.round(tpb / divTicks(lp)));
  const s = { ppq: lp, notes: notes, tempos: [{ tick: 0, usPerQuarter: Math.round(6e7 / tempo), bpm: tempo }],
              timeSigs: [{ tick: 0, num: num, den: den }] };
  return BassTab.convert(s, { tuning: BassTab.STD_TUNING, maxFret: 24, timeSig: { num: num, den: den },
    gridTicks: tpb / steps, originTick: 0, barsPerLine: 4, bpmOverride: tempo });
}
const DIVS = {
  '4': p => p, '8': p => p / 2, '8t': p => p / 3,
  '16': p => p / 4, '16t': p => p / 6, '32': p => p / 8
};
// two notes far apart, so most of the piece is silence for the rests to tile
const sparse = [{ start: 0, end: 100, pitch: 40, velocity: 100 },
                { start: 26000, end: 26200, pitch: 43, velocity: 100 }];
let tiled = 0, bad = [];
[[220, 120, 120], [220, 99.4, 120], [480, 120, 120], [220, 140, 97.3]].forEach(function (t) {
  [[4, 4], [3, 4], [6, 8], [5, 4]].forEach(function (ts) {
    Object.keys(DIVS).forEach(function (d) {
      const r = rhythmOf(t[0], t[1], t[2], ts[0], ts[1], DIVS[d], sparse);
      const spb = r.layout.stepsPerBar;
      let cursor = null, why = null;
      r.rhythm.forEach(function (e) {
        if (cursor !== null && e.startCol !== cursor) why = why || ('gap/overlap at col ' + e.startCol + ' (expected ' + cursor + ')');
        if (e.kind === 'rest' && Math.floor(e.startCol / spb) !== Math.floor((e.startCol + e.steps - 1) / spb))
          why = why || ('rest crosses a bar line at col ' + e.startCol);
        if (!(e.steps >= 1)) why = why || ('non-positive steps at col ' + e.startCol);
        cursor = e.startCol + e.steps;
      });
      if (why) bad.push(t.join('/') + ' ' + ts.join('/') + ' ' + d + ': ' + why); else tiled++;
    });
  });
});
ok(bad.length === 0, 'rhythm tiles with no gap/overlap and no rest crosses a bar (' + tiled + ' configs)' +
  (bad.length ? ' — ' + bad.slice(0, 3).join('; ') : ''));

// The specific shape of the old bug: a fully silent bar must NOT come back as one
// glyph per grid column. On a 1/16-triplet grid that would be 24 sixteenth-rests.
const gap = rhythmOf(220, 99.40012027414554, 120, 4, 4, DIVS['16t'], sparse);
const restsPerBar = gap.rhythm.filter(e => e.kind === 'rest').length / Math.max(1, gap.layout.columns.length / gap.layout.stepsPerBar);
ok(restsPerBar < 4, 'silence is merged into long rests, not one per column (' + restsPerBar.toFixed(2) + ' rests/bar)');
ok(gap.rhythm.some(e => e.kind === 'rest' && e.value.d <= 2),
  'whole/half rests actually appear in a long silence');

// A silence longer than decomposeRest's 2000-iteration guard must still be covered.
// Checking the LAST event is not enough — buildRhythm appends the next note after
// the rests, so a truncated run leaves a hole in the MIDDLE while the array still
// ends in the right place. Look for the hole.
const longGap = [{ start: 0, end: 100, pitch: 40, velocity: 100 },
                 { start: 300000, end: 300200, pitch: 43, velocity: 100 }];
const lg = rhythmOf(220, 99.40012027414554, 120, 4, 4, DIVS['16t'], longGap);
let lgCursor = null, lgHole = null;
lg.rhythm.forEach(function (e) {
  if (lgCursor !== null && e.startCol !== lgCursor)
    lgHole = lgHole || (e.startCol - lgCursor) + ' columns dropped before col ' + e.startCol;
  lgCursor = e.startCol + e.steps;
});
ok(!lgHole, 'a very long silence is tiled through, not truncated by the guard' + (lgHole ? ' — ' + lgHole : ''));

console.log('\n' + (failures ? failures + ' TEST(S) FAILED' : 'ALL TESTS PASSED'));
process.exit(failures ? 1 : 0);
