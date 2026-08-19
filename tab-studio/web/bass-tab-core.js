/* ============================================================================
 * bass-tab-core.js  —  MIDI -> bass tab engine (no DOM; runs in Node & browser)
 *
 * Pipeline:
 *   parseMidi(bytes)                  -> song {ppq, notes, tempos, timeSigs, ...}
 *   transformNotes(notes, opts)       -> shifted notes (octave / semitone / time)
 *   buildColumns(notes, layoutOpts)   -> grid of time columns + bar structure
 *   assignFingering(notes, fbOpts)    -> chooses (string,fret,finger) ergonomically
 *   analyzeErgonomics(...)            -> playability metrics + flagged spots
 *   renderAscii(...)                  -> classic monospace tab text
 *
 * Standard 4-string electric bass tuning (scientific pitch, middle C = MIDI 60):
 *   E1=28  A1=33  D2=38  G2=43   (string index 0=E .. 3=G)
 * ========================================================================== */
(function (global) {
  'use strict';

  // --- constants ------------------------------------------------------------
  var STD_TUNING = [
    { name: 'E', open: 28 },
    { name: 'A', open: 33 },
    { name: 'D', open: 38 },
    { name: 'G', open: 43 }
  ];
  // Standard 6-string guitar tuning, low → high: E2 A2 D3 G3 B3 E4 (MIDI 40..64).
  // The fingering/render engine is tuning-agnostic (it reads tuning[].open and
  // tuning.length), so the same convert()/assignFingering()/renderAscii() drive a
  // 6-string guitar tab simply by passing this tuning.
  var GUITAR_TUNING = [
    { name: 'E', open: 40 },
    { name: 'A', open: 45 },
    { name: 'D', open: 50 },
    { name: 'G', open: 55 },
    { name: 'B', open: 59 },
    { name: 'e', open: 64 }
  ];
  var NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  function pitchName(p) { return NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1); }

  // ===========================================================================
  // 1. MIDI PARSER  (Standard MIDI File, formats 0/1)
  // ===========================================================================
  function parseMidi(bytes) {
    var d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var pos = 0;
    function u8() { return d[pos++]; }
    function u16() { return (d[pos++] << 8) | d[pos++]; }
    function u32() { return ((d[pos++] << 24) | (d[pos++] << 16) | (d[pos++] << 8) | d[pos++]) >>> 0; }
    function str(n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(d[pos++]); return s; }
    function vlen() { var v = 0, c; do { c = d[pos++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; }

    if (str(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd header).');
    var hlen = u32();
    var format = u16(), ntracks = u16(), division = u16();
    pos += hlen - 6; // skip any extra header bytes
    if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported (need PPQ).');
    var ppq = division;

    var tempos = [];      // {tick, usPerQuarter, bpm}
    var timeSigs = [];     // {tick, num, den}
    var trackNames = [];
    var notesRaw = [];     // {start, end, pitch, velocity, channel, track}

    for (var t = 0; t < ntracks; t++) {
      if (str(4) !== 'MTrk') throw new Error('Corrupt MIDI: expected MTrk for track ' + t + '.');
      var tlen = u32(), end = pos + tlen, abs = 0, running = null;
      var open = {}; // pitch -> [{start, vel, ch}]
      while (pos < end) {
        abs += vlen();
        var status = d[pos];
        if (status & 0x80) { pos++; running = status; } else { status = running; }
        var ev = status & 0xf0, ch = status & 0x0f;
        if (status === 0xff) {                       // meta event
          var mtype = u8(), mlen = vlen(), mstart = pos;
          if (mtype === 0x51 && mlen === 3) {
            var us = (d[mstart] << 16) | (d[mstart + 1] << 8) | d[mstart + 2];
            tempos.push({ tick: abs, usPerQuarter: us, bpm: 60000000 / us });
          } else if (mtype === 0x58 && mlen >= 2) {
            timeSigs.push({ tick: abs, num: d[mstart], den: Math.pow(2, d[mstart + 1]) });
          } else if (mtype === 0x03 || mtype === 0x01) {
            trackNames.push(str(mlen)); pos = mstart; // str advanced pos; reset then skip below
          }
          pos = mstart + mlen;
        } else if (status === 0xf0 || status === 0xf7) { // sysex
          var sl = vlen(); pos += sl;
        } else if (ev === 0xc0 || ev === 0xd0) {         // program / channel pressure (1 byte)
          pos += 1;
        } else {                                          // 2-byte channel voice
          var d1 = d[pos++], d2 = d[pos++];
          if (ev === 0x90 && d2 > 0) {
            (open[d1] = open[d1] || []).push({ start: abs, vel: d2, ch: ch });
          } else if (ev === 0x80 || (ev === 0x90 && d2 === 0)) {
            var st = open[d1] && open[d1].shift();
            if (st) notesRaw.push({ start: st.start, end: abs, pitch: d1, velocity: st.vel, channel: st.ch, track: t });
          }
        }
      }
      // close any hanging notes at track end
      for (var p in open) open[p].forEach(function (st) {
        notesRaw.push({ start: st.start, end: abs, pitch: +p, velocity: st.vel, channel: st.ch, track: t });
      });
      pos = end;
    }

    if (!tempos.length) tempos.push({ tick: 0, usPerQuarter: 500000, bpm: 120 });
    if (!timeSigs.length) timeSigs.push({ tick: 0, num: 4, den: 4 });
    tempos.sort(function (a, b) { return a.tick - b.tick; });
    timeSigs.sort(function (a, b) { return a.tick - b.tick; });
    notesRaw.sort(function (a, b) { return a.start - b.start || a.pitch - b.pitch; });

    return {
      ppq: ppq, format: format, ntracks: ntracks,
      tempos: tempos, timeSigs: timeSigs, trackNames: trackNames,
      notes: notesRaw
    };
  }

  // ===========================================================================
  // 2. ANALYSIS HELPERS (used to give the user honest, non-guessing hints)
  // ===========================================================================
  // Greatest-common-divisor of onset gaps -> finest grid the *rhythm* needs.
  // Also report the finest grid including note durations (often finer, e.g. staccato).
  function detectGrid(notes, ppq) {
    var starts = [];
    notes.forEach(function (n) { starts.push(n.start); });
    starts = Array.from(new Set(starts)).sort(function (a, b) { return a - b; });
    var onset = 0;
    for (var i = 1; i < starts.length; i++) onset = gcd(onset, starts[i] - starts[i - 1]);
    var finest = onset;
    notes.forEach(function (n) { finest = gcd(finest, n.end - n.start); });
    return {
      onsetTicks: onset, onsetLabel: onset ? gridLabel(onset, ppq) : null,
      finestTicks: finest, finestLabel: finest ? gridLabel(finest, ppq) : null,
      // back-compat
      ticks: onset, label: onset ? gridLabel(onset, ppq) : null
    };
  }
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a; }
  function gridLabel(ticks, ppq) {
    // express ticks as a fraction of a quarter note -> note value
    var q = ticks / ppq;                  // quarters
    var den = 1 / q;                       // e.g. 4 => 1/16
    if (Math.abs(den - Math.round(den)) < 1e-6) return '1/' + Math.round(den * 4) + ' note';
    // triplet check
    var t3 = q * 3 / 2;                    // crude
    return '~' + q.toFixed(3) + ' quarter';
  }

  function pitchStats(notes) {
    if (!notes.length) return { min: null, max: null };
    var min = Infinity, max = -Infinity;
    notes.forEach(function (n) { if (n.pitch < min) min = n.pitch; if (n.pitch > max) max = n.pitch; });
    return { min: min, max: max };
  }

  // Where does the music start, in bar/beat terms (1-based bar, 1-based beat)?
  function firstNoteLocation(notes, ppq, timeSig) {
    if (!notes.length) return null;
    var t = notes[0].start;
    return tickToBarBeat(t, ppq, timeSig);
  }
  function tickToBarBeat(tick, ppq, timeSig) {
    var ticksPerBar = ppq * 4 * timeSig.num / timeSig.den;
    var bar = Math.floor(tick / ticksPerBar);
    var inBar = tick - bar * ticksPerBar;
    var beat = inBar / (ppq * 4 / timeSig.den);
    return { bar: bar + 1, beat: beat + 1, ticksPerBar: ticksPerBar, rawTick: tick };
  }

  // Convert an absolute tick to seconds using the tempo map (piecewise constant).
  // bpmOverride, if given, ignores the map and uses one constant tempo.
  function tickToSeconds(tick, tempos, ppq, bpmOverride) {
    if (bpmOverride) return tick * (60 / bpmOverride) / ppq;
    var sec = 0;
    for (var i = 0; i < tempos.length; i++) {
      var segStart = tempos[i].tick;
      var segEnd = (i + 1 < tempos.length) ? tempos[i + 1].tick : Infinity;
      if (tick <= segStart) break;
      var to = Math.min(tick, segEnd);
      if (to > segStart) sec += (to - segStart) * (tempos[i].usPerQuarter / ppq) / 1e6;
      if (tick <= segEnd) break;
    }
    return sec;
  }
  // Inverse of tickToSeconds: a time in seconds -> absolute tick. Walks the same
  // piecewise-constant tempo map so the playback playhead lands on the right column.
  function secondsToTicks(sec, tempos, ppq, bpmOverride) {
    if (sec <= 0) return 0;
    if (bpmOverride) return sec * bpmOverride / 60 * ppq;
    var acc = 0; // seconds elapsed up to the current segment's start tick
    for (var i = 0; i < tempos.length; i++) {
      var segStart = tempos[i].tick;
      var segEnd = (i + 1 < tempos.length) ? tempos[i + 1].tick : Infinity;
      var secPerTick = (tempos[i].usPerQuarter / ppq) / 1e6;
      var segSec = (segEnd - segStart) * secPerTick;
      if (segEnd === Infinity || sec <= acc + segSec) return segStart + (sec - acc) / secPerTick;
      acc += segSec;
    }
    return 0;
  }
  // The tempo in effect at a given tick (BPM).
  function bpmAt(tick, tempos) {
    var bpm = tempos[0].bpm;
    for (var i = 0; i < tempos.length; i++) { if (tempos[i].tick <= tick) bpm = tempos[i].bpm; else break; }
    return bpm;
  }

  // ===========================================================================
  // 3. TRANSFORMS  (non-destructive: returns a new note array)
  // ===========================================================================
  function transformNotes(notes, opts) {
    opts = opts || {};
    var octave = (opts.octaveShift || 0) * 12;
    var semis = opts.semitoneShift || 0;
    var dt = opts.tickShift || 0;
    var out = notes.map(function (n) {
      return {
        start: n.start + dt, end: n.end + dt,
        pitch: n.pitch + octave + semis,
        velocity: n.velocity, channel: n.channel, track: n.track,
        origStart: n.start, origPitch: n.pitch
      };
    });
    // drop notes pushed before t=0 by a left shift
    return out.filter(function (n) { return n.end > 0; }).map(function (n) {
      if (n.start < 0) n.start = 0; return n;
    });
  }

  // Reduce a possibly-polyphonic transcription (e.g. basic-pitch output, which
  // adds octave harmonics above the fundamental and stacks ghost notes) to a
  // single playable bass line. Near-simultaneous detections within `eps` ticks
  // are treated as one onset; we keep one note per onset (lowest pitch = the
  // bass fundamental by default, or loudest with pick:'loud'), then trim each
  // note's tail to the next onset so the line is strictly monophonic.
  function monophonicReduce(notes, ppq, opts) {
    opts = opts || {};
    var eps = opts.eps != null ? opts.eps : Math.max(1, Math.round((ppq || 480) / 8));
    var pick = opts.pick || 'low';
    function cp(n) { return { start: n.start, end: n.end, pitch: n.pitch, velocity: n.velocity, channel: n.channel, track: n.track }; }
    var src = notes.slice().filter(function (n) { return n.end > n.start; })
      .sort(function (a, b) { return a.start - b.start || a.pitch - b.pitch; });
    var picks = [], i = 0;
    while (i < src.length) {
      var gStart = src[i].start, j = i, best = src[i];
      while (j < src.length && src[j].start <= gStart + eps) {
        var c = src[j];
        if (pick === 'loud') { if (c.velocity > best.velocity || (c.velocity === best.velocity && c.pitch < best.pitch)) best = c; }
        else if (c.pitch < best.pitch || (c.pitch === best.pitch && c.velocity > best.velocity)) best = c;
        j++;
      }
      picks.push(cp(best));
      i = j;
    }
    for (var k = 0; k < picks.length - 1; k++) if (picks[k].end > picks[k + 1].start) picks[k].end = picks[k + 1].start;
    return picks.filter(function (n) { return n.end > n.start; });
  }

  // ===========================================================================
  // 4. ERGONOMIC FINGERING  (Viterbi-style min-cost path over fretboard choices)
  // ===========================================================================
  // For each note we enumerate every (string,fret) that can sound that pitch,
  // then pick the sequence that minimises total hand travel + position cost.
  function fretChoices(pitch, tuning, maxFret) {
    var out = [];
    for (var s = 0; s < tuning.length; s++) {
      var f = pitch - tuning[s].open;
      if (f >= 0 && f <= maxFret) out.push({ string: s, fret: f });
    }
    return out;
  }

  function assignFingering(notes, opts) {
    opts = opts || {};
    var tuning = opts.tuning || STD_TUNING;
    var maxFret = opts.maxFret == null ? 24 : opts.maxFret;
    var avoidOpen = !!opts.avoidOpen;   // funk muting: prefer fretted notes over open strings
    var W = Object.assign({
      travel: 1.0,        // cost per fret of hand movement between consecutive notes
      stringChange: 0.8,   // cost for changing strings
      stringSkip: 1.2,     // extra per skipped string (E->D etc.)
      height: 0.12,        // mild preference for lower frets (per fret)
      openBonus: 0.6,      // reward using an open string (when NOT avoiding open)
      openPenalty: 6.0,    // cost of an open string when avoidOpen is on (soft: still
                           // allowed when a note has no fretted alternative, e.g. low E)
      preferStr: 0.0       // (reserved)
    }, opts.weights || {});

    var forced = opts.forced || {};   // noteIndex -> {string,fret} pinned by the user

    var unplayable = [];
    var nodes = notes.map(function (n, i) {
      var ch = fretChoices(n.pitch, tuning, maxFret);
      if (!ch.length) unplayable.push({ index: i, pitch: n.pitch });
      var fc = forced[i];
      if (fc) {
        var pin = ch.filter(function (c) { return c.string === fc.string && c.fret === fc.fret; });
        if (pin.length) return pin;   // restrict the DP to the user's chosen position
      }
      return ch;
    });

    function posCost(c) {
      var openTerm = c.fret === 0 ? (avoidOpen ? W.openPenalty : -W.openBonus) : 0;
      return c.fret * W.height + openTerm;
    }
    // hand reference fret for travel: open string doesn't pin the hand, so it
    // "inherits" the previous fretted position (handled by carrying refFret).
    function transCost(prev, prevRef, cur) {
      var travel = 0;
      if (cur.fret !== 0) travel = Math.abs(cur.fret - prevRef) * W.travel;
      var sc = 0;
      if (prev.string !== cur.string) {
        sc = W.stringChange + Math.abs(prev.string - cur.string - 0) * 0 +
             Math.max(0, Math.abs(prev.string - cur.string) - 1) * W.stringSkip;
      }
      return travel + sc;
    }

    // DP over the PLAYABLE subsequence only. A note whose pitch is out of range
    // has an empty choice set (unplayable); including it would set every later
    // dp cost to Infinity and collapse the whole backtrace, so we skip it here
    // and leave its position null. Transitions connect consecutive *played*
    // notes, which is also what a player feels.
    var N = nodes.length;
    if (!N) return { positions: [], unplayable: unplayable, chosen: [] };
    var playIdx = [];
    for (var pi = 0; pi < N; pi++) if (nodes[pi].length) playIdx.push(pi);
    var M = playIdx.length;
    var chosen = new Array(N);
    for (var z = 0; z < N; z++) chosen[z] = null;
    if (M) {
      var dp = [], back = [], ref = [];
      var first = nodes[playIdx[0]];
      dp[0] = first.map(posCost);
      back[0] = first.map(function () { return -1; });
      ref[0] = first.map(function (c) { return c.fret === 0 ? null : c.fret; });

      for (var i = 1; i < M; i++) {
        dp[i] = []; back[i] = []; ref[i] = [];
        var cur = nodes[playIdx[i]], prevSet = nodes[playIdx[i - 1]];
        for (var j = 0; j < cur.length; j++) {
          var best = Infinity, bestK = 0, bestRef = null;
          for (var k = 0; k < prevSet.length; k++) {
            if (dp[i - 1][k] === Infinity) continue;
            var prevRef = ref[i - 1][k] == null ? prevSet[k].fret : ref[i - 1][k];
            // if previous was open & had no prior ref, treat its ref as current fret (no travel)
            if (ref[i - 1][k] == null && prevSet[k].fret === 0) prevRef = cur[j].fret || prevRef;
            var c = dp[i - 1][k] + transCost(prevSet[k], prevRef, cur[j]);
            if (c < best) { best = c; bestK = k; bestRef = (cur[j].fret === 0 ? prevRef : cur[j].fret); }
          }
          dp[i][j] = best + posCost(cur[j]);
          back[i][j] = bestK;
          ref[i][j] = bestRef;
        }
      }
      // backtrace over the played subsequence, then scatter back to note indices
      var last = nodes[playIdx[M - 1]], bj = 0, bv = Infinity;
      for (var j2 = 0; j2 < last.length; j2++) if (dp[M - 1][j2] < bv) { bv = dp[M - 1][j2]; bj = j2; }
      for (var i2 = M - 1; i2 >= 0; i2--) { chosen[playIdx[i2]] = nodes[playIdx[i2]][bj]; bj = back[i2][bj]; }
    }

    // finger assignment: one-finger-per-fret hand window, track shifts
    var positions = [];
    var base = null; // fret under index finger
    for (var i3 = 0; i3 < N; i3++) {
      var c2 = chosen[i3] || null;
      if (!c2) { positions.push(null); continue; }
      var finger = 0, shifted = false;
      if (c2.fret === 0) {
        finger = 0; // open string, no finger
      } else {
        if (base == null) { base = c2.fret; }
        if (c2.fret < base) { base = c2.fret; shifted = true; }
        else if (c2.fret > base + 3) { base = c2.fret - 3; shifted = true; }
        finger = c2.fret - base + 1;
      }
      positions.push({
        string: c2.string, fret: c2.fret, finger: finger,
        baseFret: base, shifted: shifted, pitch: notes[i3].pitch
      });
    }
    return { positions: positions, unplayable: unplayable, chosen: chosen };
  }

  // ===========================================================================
  // 5. LAYOUT  (group notes into quantized time columns + bar lines)
  // ===========================================================================
  function buildColumns(notes, opts) {
    var ppq = opts.ppq, grid = opts.gridTicks, ts = opts.timeSig;
    var origin = opts.originTick || 0;
    var ticksPerBar = ppq * 4 * ts.num / ts.den;
    var stepsPerBar = Math.round(ticksPerBar / grid);

    // snap each note to a grid column index relative to origin
    var byCol = {};
    var maxCol = 0;
    notes.forEach(function (n, i) {
      var rel = n.start - origin;
      var col = Math.round(rel / grid);
      if (col < 0) col = 0;
      (byCol[col] = byCol[col] || []).push(i);
      if (col > maxCol) maxCol = col;
    });

    var columns = [];
    for (var c = 0; c <= maxCol; c++) {
      columns.push({
        col: c,
        bar: Math.floor(c / stepsPerBar),
        beatStep: c % stepsPerBar,
        isBarStart: (c % stepsPerBar) === 0,
        noteIdx: byCol[c] || []
      });
    }
    return { columns: columns, stepsPerBar: stepsPerBar, ticksPerBar: ticksPerBar };
  }

  // ===========================================================================
  // 5b. RHYTHM  (turn note durations/gaps into standard note & rest values)
  // ===========================================================================
  // Standard values, expressed in quarter-note units (q). d = note-value
  // denominator (1=whole, 2=half, 4=quarter, 8=eighth, 16=sixteenth, 32=…).
  var RHY_VALUES = [
    { d: 1,  dotted: false, q: 4 },     // whole
    { d: 2,  dotted: true,  q: 3 },     // dotted half
    { d: 2,  dotted: false, q: 2 },     // half
    { d: 4,  dotted: true,  q: 1.5 },   // dotted quarter
    { d: 4,  dotted: false, q: 1 },     // quarter
    { d: 8,  dotted: true,  q: 0.75 },  // dotted eighth
    { d: 8,  dotted: false, q: 0.5 },   // eighth
    { d: 16, dotted: true,  q: 0.375 }, // dotted sixteenth
    { d: 16, dotted: false, q: 0.25 },  // sixteenth
    { d: 32, dotted: false, q: 0.125 }  // thirty-second
  ];
  // nearest standard note/rest value to a duration in ticks
  function valueOfTicks(ticks, ppq) {
    var qu = ticks / ppq, best = RHY_VALUES[RHY_VALUES.length - 1], bd = 1e9;
    RHY_VALUES.forEach(function (v) { var dd = Math.abs(qu - v.q); if (dd < bd) { bd = dd; best = v; } });
    return { d: best.d, dotted: best.dotted };
  }
  // split a silent span (in grid steps) into aligned rest glyphs, bar by bar.
  //
  // `grid` MUST be the exact (fractional) ticks-per-step, never a rounded one:
  // `avail` keeps only the values that land on a whole number of steps, and the
  // test for that is an exact-integer test. Hand it a rounded grid and every ratio
  // misses by a fraction of a percent, `avail` comes back EMPTY, and every rest
  // falls through to the 1-step fallback below — a bar of silence drawn as `spb`
  // separate sixteenth-rests instead of one whole rest.
  //
  // The trigger is simply `ticksPerBar / stepsPerBar` not being a whole number; a
  // tempo mismatch is one way to get there, but plain ppq 220 on any triplet grid
  // (or 1/32) does it too, so this hit most projects here, not an exotic few. On
  // seed-private-eyes it turned 244 rest glyphs into 1601 and the tab's SVG from
  // ~3.9k elements into ~11.4k — wrong on the page, and what buried older iPads.
  //
  // It also un-breaks the `guard` below: at one step per rest, a silence longer
  // than 2000 steps hit the cap and was silently TRUNCATED, desynchronising the
  // rhythm lane from the staff for the rest of the piece. The longest silence in
  // the projects here is 1548 steps — one longer intro from that bug.
  function decomposeRest(startCol, steps, grid, ppq, spb) {
    // Round ONCE and test the rounded value. Testing `st >= 1` on the raw ratio
    // drops a value whose true length is exactly one step whenever it computes as
    // 0.9999999999999999 — and then the rest falls through to the fixed sixteenth
    // below, notating a sixteenth where (say, in 7/8 on a 1/8 grid) an eighth
    // belongs. Everything downstream wants the integer anyway.
    var avail = RHY_VALUES
      .map(function (v) { var st = v.q * ppq / grid; return { v: v, st: st, r: Math.round(st) }; })
      .filter(function (o) { return Math.abs(o.st - o.r) < 1e-6 && o.r >= 1; })
      .sort(function (a, b) { return b.st - a.st; });
    var out = [], col = startCol, rem = steps, guard = 0;
    while (rem > 0 && guard++ < 2000) {
      var posInBar = ((col % spb) + spb) % spb;
      var cap = Math.min(rem, spb - posInBar);
      var pick = null;
      for (var k = 0; k < avail.length; k++) {
        var st = avail[k].r;
        if (st <= cap && (col % st === 0 || st === 1)) { pick = { d: avail[k].v.d, dotted: avail[k].v.dotted, st: st }; break; }
      }
      if (!pick) pick = { d: 16, dotted: false, st: 1 };
      out.push({ kind: 'rest', startCol: col, steps: pick.st, value: { d: pick.d, dotted: pick.dotted } });
      col += pick.st; rem -= pick.st;
    }
    return out;
  }
  // Returns an ordered list of {kind:'note'|'rest', startCol, steps, value:{d,dotted}, noteIdx}
  function buildRhythm(notes, layout, ppq) {
    // Exact ticks-per-step, recovered the way the layout actually spaced the
    // columns. Rounding it was fatal in decomposeRest (see the note there) and
    // also shifted a few percent of NOTE glyphs — those move too, and toward the
    // truth: `soundSteps` and `valueOfTicks` now describe the width the staff
    // really draws, where before they measured against a step size nothing used.
    var spb = layout.stepsPerBar, grid = layout.ticksPerBar / spb;
    var onsetCols = layout.columns.filter(function (c) { return c.noteIdx.length; });
    var ev = [];
    if (!onsetCols.length) return ev;
    // leading rests: fill the partial first bar before the first (pickup) note
    var f = onsetCols[0].col, barStart = Math.floor(f / spb) * spb;
    if (f > barStart) decomposeRest(barStart, f - barStart, grid, ppq, spb).forEach(function (r) { ev.push(r); });

    for (var i = 0; i < onsetCols.length; i++) {
      var c = onsetCols[i];
      var idx = c.noteIdx[0], bestDur = -1;          // represent the column by its longest note
      c.noteIdx.forEach(function (j) { var dd = notes[j].end - notes[j].start; if (dd > bestDur) { bestDur = dd; idx = j; } });
      var n = notes[idx], thisCol = c.col;
      var nextCol = (i + 1 < onsetCols.length) ? onsetCols[i + 1].col : null;
      var soundSteps = Math.max(1, Math.round((n.end - n.start) / grid));
      var slotSteps = (nextCol != null) ? (nextCol - thisCol) : soundSteps;
      var playSteps, restSteps = 0;
      if (nextCol == null) { playSteps = soundSteps; }
      else if (soundSteps >= slotSteps * 0.85) { playSteps = slotSteps; }   // legato: fill to next
      else { playSteps = Math.max(1, soundSteps); restSteps = slotSteps - playSteps; } // staccato: note + rest
      if (nextCol != null) playSteps = Math.min(playSteps, slotSteps);
      ev.push({ kind: 'note', startCol: thisCol, steps: playSteps, value: valueOfTicks(playSteps * grid, ppq), noteIdx: idx });
      if (restSteps > 0) decomposeRest(thisCol + playSteps, restSteps, grid, ppq, spb).forEach(function (r) { ev.push(r); });
    }
    return ev;
  }

  // ===========================================================================
  // 6. ERGONOMIC REPORT
  // ===========================================================================
  function analyzeErgonomics(notes, positions, ppq, timeSig, tempoOpts) {
    tempoOpts = tempoOpts || {};
    var tempos = tempoOpts.tempos || [{ tick: 0, usPerQuarter: 500000, bpm: 120 }];
    var bpmOv = tempoOpts.bpmOverride || 0;
    var FAST_SEC = 0.18; // notes landing closer than this make a shift genuinely hard
    function sec(t) { return tickToSeconds(t, tempos, ppq, bpmOv); }
    // tempo follows a note's ORIGINAL position in the song timeline, not its
    // (possibly time-shifted) display position — so trimming lead bars across a
    // tempo change doesn't mislabel the tempo.
    function ot(n) { return n && n.origStart != null ? n.origStart : (n ? n.start : 0); }

    var played = [];
    positions.forEach(function (p, i) { if (p) played.push({ p: p, n: notes[i], i: i }); });
    var frets = played.filter(function (x) { return x.p.fret > 0; }).map(function (x) { return x.p.fret; });
    var minFret = frets.length ? Math.min.apply(null, frets) : 0;
    var maxFret = frets.length ? Math.max.apply(null, frets) : 0;

    var shifts = 0, biggestJump = 0, biggestJumpAt = null, fastShifts = [], peakRate = 0;
    for (var i = 1; i < played.length; i++) {
      var a = played[i - 1], b = played[i];
      if (b.p.shifted) shifts++;
      var dtSec = sec(ot(b.n)) - sec(ot(a.n));
      if (dtSec > 0.001) peakRate = Math.max(peakRate, 1 / dtSec);
      if (a.p.fret > 0 && b.p.fret > 0) {
        var jump = Math.abs(b.p.fret - a.p.fret);
        if (jump > biggestJump) { biggestJump = jump; biggestJumpAt = tickToBarBeat(b.n.start, ppq, timeSig); }
        if (jump >= 5 && dtSec > 0 && dtSec <= FAST_SEC) {
          fastShifts.push({
            from: a.p.fret, to: b.p.fret, jump: jump,
            ms: Math.round(dtSec * 1000), loc: tickToBarBeat(b.n.start, ppq, timeSig)
          });
        }
      }
    }

    // per-note difficulty (for colouring): fret height + jump-from-prev + how fast it arrives
    var diff = positions.map(function (p, i) {
      if (!p) return null;
      var score = 0;
      if (p.fret >= 12) score += 1; if (p.fret >= 17) score += 1;
      if (p.shifted) score += 1;
      if (i > 0 && positions[i - 1] && positions[i - 1].fret > 0 && p.fret > 0) {
        var j = Math.abs(p.fret - positions[i - 1].fret);
        var dts = sec(ot(notes[i])) - sec(ot(notes[i - 1]));
        if (j >= 5) score += 1; if (j >= 9) score += 1;
        if (j >= 5 && dts > 0 && dts <= FAST_SEC) score += 1; // hard *because* it's fast
      }
      return score >= 3 ? 'hard' : score >= 1 ? 'med' : 'easy';
    });

    // overall difficulty 0..100 (now tempo-aware via fastShifts + peak note rate)
    var score = 0;
    score += Math.min(35, shifts * 1.3);
    score += Math.min(22, (maxFret) * 1.0);
    score += Math.min(18, biggestJump * 1.4);
    score += Math.min(15, fastShifts.length * 3);
    score += Math.min(10, Math.max(0, peakRate - 4) * 2.5); // dense fast passages
    var rating = score < 25 ? 'Easy' : score < 50 ? 'Moderate' : score < 75 ? 'Challenging' : 'Hard';

    return {
      noteCount: played.length,
      minFret: minFret, maxFret: maxFret,
      positionShifts: shifts,
      biggestJump: biggestJump, biggestJumpAt: biggestJumpAt,
      fastShifts: fastShifts,
      peakRate: Math.round(peakRate * 10) / 10,
      tempoUsed: bpmOv || (played.length ? Math.round(bpmAt(ot(played[0].n), tempos)) : Math.round(tempos[0].bpm)),
      perNoteDifficulty: diff,
      score: Math.round(score), rating: rating
    };
  }

  // ===========================================================================
  // 7. ASCII TAB RENDER
  // ===========================================================================
  function renderAscii(notes, positions, layoutResult, tuning, opts) {
    opts = opts || {};
    var barsPerLine = opts.barsPerLine || 4;
    var cols = layoutResult.columns, spb = layoutResult.stepsPerBar;
    tuning = tuning || STD_TUNING;

    // cell width = widest fret token + 1 dash, min 3 (so "12" fits with a dash)
    var cellW = 3;
    positions.forEach(function (p) { if (p) cellW = Math.max(cellW, String(p.fret).length + 1); });

    var nStrings = tuning.length;
    var totalBars = cols.length ? cols[cols.length - 1].bar + 1 : 0;
    var lines = [];

    for (var barStart = 0; barStart < totalBars; barStart += barsPerLine) {
      var barEnd = Math.min(barStart + barsPerLine, totalBars);
      // build one row per string (top = highest string = last in tuning)
      var rows = [];
      for (var s = nStrings - 1; s >= 0; s--) rows.push(tuning[s].name.padEnd(2) + '|');
      // bar number ruler
      var ruler = '   ';
      for (var c = 0; c < cols.length; c++) {
        var col = cols[c];
        if (col.bar < barStart || col.bar >= barEnd) continue;
        if (col.isBarStart) ruler += String(col.bar + 1).padEnd(cellW * spb + 1);
      }

      for (var ci = 0; ci < cols.length; ci++) {
        var col2 = cols[ci];
        if (col2.bar < barStart || col2.bar >= barEnd) continue;
        if (col2.isBarStart && col2.col !== barStart * spb) {
          for (var r = 0; r < rows.length; r++) rows[r] += '|';
        }
        // figure which string (if any) plays here
        var tokByString = {};
        col2.noteIdx.forEach(function (idx) {
          var p = positions[idx];
          if (p) tokByString[p.string] = String(p.fret);
        });
        for (var s2 = nStrings - 1, ri = 0; s2 >= 0; s2--, ri++) {
          var tok = tokByString[s2];
          if (tok == null) rows[ri] += '-'.repeat(cellW);
          else rows[ri] += tok + '-'.repeat(cellW - tok.length);
        }
      }
      for (var r2 = 0; r2 < rows.length; r2++) rows[r2] += '|';
      lines.push(ruler.replace(/\s+$/, ''));
      lines = lines.concat(rows);
      lines.push('');
    }
    return lines.join('\n');
  }

  // ===========================================================================
  // 7b. MANUAL POSITION OVERRIDES
  // ===========================================================================
  // A stable per-note identity that survives octave / semitone / time shifts, so
  // a user's manual position pick can be re-applied (and persisted) across any
  // transform. origStart/origPitch are the pre-transform values; a per-pair
  // counter disambiguates true unisons (identical pitch & onset).
  function noteKeys(notes) {
    var seen = {}, keys = [];
    notes.forEach(function (n) {
      var base = (n.origStart != null ? n.origStart : n.start) + ':' +
                 (n.origPitch != null ? n.origPitch : n.pitch);
      var c = seen[base] || 0; seen[base] = c + 1;
      keys.push(base + ':' + c);
    });
    return keys;
  }
  // Is a saved {string,fret} override still a legal way to sound `pitch`? (It may
  // not be after an octave change moves the note off that string / the fretboard.)
  function validOverride(ov, pitch, tuning, maxFret) {
    if (!ov || ov.string == null || ov.fret == null) return false;
    if (ov.string < 0 || ov.string >= tuning.length) return false;
    if (ov.fret < 0 || ov.fret > maxFret) return false;
    return tuning[ov.string].open + ov.fret === pitch;
  }

  // ===========================================================================
  // 8. HIGH-LEVEL CONVENIENCE
  // ===========================================================================
  function convert(song, settings) {
    settings = settings || {};
    var tuning = settings.tuning || STD_TUNING;
    var maxFret = settings.maxFret == null ? 24 : settings.maxFret;
    var ts = settings.timeSig || song.timeSigs[0] || { num: 4, den: 4 };
    var notes = transformNotes(song.notes, {
      octaveShift: settings.octaveShift || 0,
      semitoneShift: settings.semitoneShift || 0,
      tickShift: settings.tickShift || 0
    });
    // origin = where bar 1 starts. Default: 0. (User shift handles "start in half a bar".)
    var origin = settings.originTick || 0;

    // map persisted overrides (keyed by stable note id) onto current note indices,
    // dropping any that no longer fit the transformed pitch / fret count.
    var keys = noteKeys(notes), forced = {};
    if (settings.overrides) {
      for (var i = 0; i < notes.length; i++) {
        var ov = settings.overrides[keys[i]];
        if (validOverride(ov, notes[i].pitch, tuning, maxFret)) forced[i] = { string: ov.string, fret: ov.fret };
      }
    }

    var layout = buildColumns(notes, {
      ppq: song.ppq, gridTicks: settings.gridTicks, timeSig: ts, originTick: origin
    });
    var fb = assignFingering(notes, {
      tuning: tuning, maxFret: maxFret,
      avoidOpen: settings.avoidOpen, weights: settings.weights, forced: forced
    });
    var rhythm = buildRhythm(notes, layout, song.ppq);
    var ergo = analyzeErgonomics(notes, fb.positions, song.ppq, ts,
      { tempos: song.tempos, bpmOverride: settings.bpmOverride || 0 });
    var ascii = renderAscii(notes, fb.positions, layout, tuning, { barsPerLine: settings.barsPerLine || 4 });
    return {
      notes: notes, layout: layout, fingering: fb, rhythm: rhythm, ergo: ergo,
      ascii: ascii, timeSig: ts, tuning: tuning, noteKeys: keys
    };
  }

  // --- exports --------------------------------------------------------------
  var api = {
    STD_TUNING: STD_TUNING, GUITAR_TUNING: GUITAR_TUNING, NOTE_NAMES: NOTE_NAMES, pitchName: pitchName,
    parseMidi: parseMidi, detectGrid: detectGrid, pitchStats: pitchStats,
    firstNoteLocation: firstNoteLocation, tickToBarBeat: tickToBarBeat, gridLabel: gridLabel,
    tickToSeconds: tickToSeconds, secondsToTicks: secondsToTicks, bpmAt: bpmAt,
    transformNotes: transformNotes, monophonicReduce: monophonicReduce,
    fretChoices: fretChoices, assignFingering: assignFingering,
    noteKeys: noteKeys, validOverride: validOverride,
    buildColumns: buildColumns, buildRhythm: buildRhythm, valueOfTicks: valueOfTicks,
    analyzeErgonomics: analyzeErgonomics, renderAscii: renderAscii,
    convert: convert
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BassTab = api;
})(typeof window !== 'undefined' ? window : globalThis);
