/* ============================================================================
 * app.js  —  the unified Studio shell.
 *
 * Owns the PROJECT model (the app's document): a project bundles a YouTube link,
 * the song audio, isolated stems, and multiple editable instrument TRACKS (bass,
 * drums, piano, …) each with its own MIDI/drum data, stem and view options.
 * There's no multi-track timeline — you pick a track and see it in its
 * instrument-appropriate view (bass→bass tab, drums→drum tab, others→piano-roll),
 * all under one shared transport. Projects persist server-side (/api/projects)
 * with save + auto-update.
 * ========================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }
  function fmt(sec) { sec = Math.max(0, sec || 0); var m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
  function flash(msg) { var t = $('toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(flash._t); flash._t = setTimeout(function () { t.classList.remove('show'); }, 3000); }
  function revoke(u) { if (u && u.indexOf('blob:') === 0) { try { URL.revokeObjectURL(u); } catch (e) {} } }

  var currentView = 'pianoroll';
  var drumData = null;   // mirror of the active drum track for the drum tab
  // Three modes. 'desktop' = full app served by the local FastAPI backend (AI
  // pipeline + on-disk project library). 'web' = the static offline build: editor
  // + bundled starter projects, projects persist as local .studio.json files.
  // 'cloud' = the hosted build: same editor, but projects live in D1 behind the
  // Worker, with GitHub sign-in, forking and cross-device sync.
  //
  // WEB deliberately means "there is NO local FastAPI backend", which is true for
  // both 'web' and 'cloud'. All 13 existing WEB read sites keep that meaning and
  // stay correct; only the handful of places that must diverge test CLOUD.
  // Do NOT redefine WEB as (mode === 'web') — app.js:492 relies on it to keep
  // doSave() the sole writer of projects/<id>/project.json on desktop.
  var MODE = (window.STUDIO_CONFIG && window.STUDIO_CONFIG.mode) || 'desktop';
  var CLOUD = (MODE === 'cloud');
  var WEB = (MODE !== 'desktop');

  /* ---- instrument targets ---- */
  var TARGETS = {
    bass:   { id: 'bass',   label: 'Bass',   kind: 'melodic', stem: 'bass',  model: 'htdemucs',    minFreq: '30',  maxFreq: '400',  minNote: '80', onset: '0.5', frame: '0.3',  shifts: '2', center: 40, markers: { 28: 1, 33: 1, 38: 1, 43: 1 }, instrument: 'bass',  defaultView: 'basstab' },
    piano:  { id: 'piano',  label: 'Piano',  kind: 'melodic', stem: 'piano', model: 'htdemucs_6s', minFreq: '',    maxFreq: '',     minNote: '50', onset: '0.4', frame: '0.25', shifts: '2', center: 60, markers: {}, instrument: 'piano', defaultView: 'pianoroll' },
    guitar: { id: 'guitar', label: 'Guitar', kind: 'melodic', stem: 'guitar', model: 'htdemucs_6s', minFreq: '70', maxFreq: '1400', minNote: '60', onset: '0.4', frame: '0.3',  shifts: '2', center: 52, markers: { 40: 1, 45: 1, 50: 1, 55: 1, 59: 1, 64: 1 }, instrument: 'guitar', defaultView: 'guitartab' },
    vocals: { id: 'vocals', label: 'Vocals', kind: 'melodic', stem: 'vocals', model: 'htdemucs',    minFreq: '80', maxFreq: '1200', minNote: '80', onset: '0.5', frame: '0.3',  shifts: '2', center: 60, markers: {}, instrument: 'piano', defaultView: 'pianoroll' },
    keys:   { id: 'keys',   label: 'Keys',   kind: 'melodic', stem: 'other',  model: 'htdemucs',    minFreq: '',    maxFreq: '',    minNote: '60', onset: '0.4', frame: '0.3',  shifts: '2', center: 60, markers: {}, instrument: 'piano', defaultView: 'pianoroll' },
    drums:  { id: 'drums',  label: 'Drums',  kind: 'drum',    stem: 'drums', model: 'htdemucs',     shifts: '2', center: 48, markers: {}, instrument: 'bass', defaultView: 'drumtab' }
  };
  function curTarget() {
    var key = $('targetSel').value, T = TARGETS[key] || TARGETS.bass, m = T.model;
    if ($('ftChk').checked && m === 'htdemucs') m = 'htdemucs_ft';
    return Object.assign({}, T, { model: m });
  }
  function instLabel(id) { return (TARGETS[id] || {}).label || id; }
  function instKind(id) { return (TARGETS[id] || {}).kind || 'melodic'; }

  /* ====================== project model ====================== */
  function emptyProject() { return { id: null, name: '', youtubeUrl: '', youtubeOffset: 0, song: null, tracks: {}, activeTrackId: null }; }
  var project = emptyProject();
  // "Song" is the default play source whenever one is available — until the user
  // explicitly picks a source from the Synth/Song switch, after which we respect it.
  var srcUserPicked = false;

  /* ---- views ---- */
  var roll = PianoRoll.create($('rollCanvas'), {
    onChange: function () { updateStats(); Transport.rebuildMelodic(); if (TAB_VIEWS[currentView]) TAB_VIEWS[currentView].render(); scheduleSave(); },
    onSeek: function (t) { Transport.seekTick(t); },
    onSelection: function (n) { $('selCount').textContent = n ? '  ·  ' + n + ' selected' : ''; },
    onTool: setToolUI,
    modalOpen: isModalOpen,
    // hear notes as they are drawn / dragged to another pitch, in the track's own voice
    onAudition: function (pitch, vel, sec) { EditorPlayer.previewNote(pitch, vel, sec); },
    follow: function () { return $('followChk').checked; }
  });
  var bassTab = BassTabView.create($('tabHost'), {
    getProject: function () { return roll.getProject(); },
    onSeekSeconds: function (s) { Transport.seekSeconds(s); },
    onStatus: function (ergo) { updateErgo(ergo); },
    onChange: function () { scheduleSave(); },   // fingering override edits
    onZoom: function () { updateTabZoomPct(); },
    follow: function () { return Transport.isRunning(); }   // page-flip only while playing
  });
  // Guitar Tab reuses the same fretted-instrument engine/renderer with a 6-string
  // standard tuning. Both tab views read the shared piano-roll notes (getProject).
  var guitarTab = BassTabView.create($('guitarTabHost'), {
    getProject: function () { return roll.getProject(); },
    onSeekSeconds: function (s) { Transport.seekSeconds(s); },
    onStatus: function (ergo) { updateGuitarErgo(ergo); },
    onChange: function () { scheduleSave(); },
    onZoom: function () { updateTabZoomPct(); },
    follow: function () { return Transport.isRunning(); },
    tuning: BassTab.GUITAR_TUNING
  });
  // Guitar Chords (Tab Type 1): chord progression + diagram charts, detected from
  // the same shared piano-roll notes via ChordCore.
  var guitarChords = GuitarChordView.create($('guitarChordHost'), {
    getProject: function () { return roll.getProject(); },
    onSeekSeconds: function (s) { Transport.seekSeconds(s); },
    onStatus: function (st) { updateChordInfo(st); }
  });
  // view-name -> view controller that re-renders from the shared notes when active.
  var TAB_VIEWS = { basstab: bassTab, guitartab: guitarTab, guitarchords: guitarChords };
  function melodicViewFor(instrument) {
    return instrument === 'bass' ? 'basstab' : instrument === 'guitar' ? 'guitartab' : 'pianoroll';
  }
  function tabViewForInstrument(instrument) { return TAB_VIEWS[melodicViewFor(instrument)] || null; }
  guitarTab.setOptions({ maxFret: 19 });   // guitar default (vs the view's 24-fret bass default)

  // Playing-style router: chordal/strummed guitar -> chord charts (Type 1); single-note
  // lead/riff -> 6-string tab (Type 2). Uses the polyphony signal validated in research
  // (fraction of time >=3 notes sound at once — the dominant comp-vs-solo discriminator).
  function guitarPolyphony(notes, ppq) {
    if (!notes || !notes.length) return 0;
    var end = notes.reduce(function (m, n) { return Math.max(m, n.end); }, 0);
    var step = Math.max(1, Math.round((ppq || 480) / 4));   // 16th-note grid
    var hi = 0, tot = 0;
    for (var t = 0; t < end; t += step) {
      var c = 0;
      for (var i = 0; i < notes.length; i++) if (notes[i].start <= t && notes[i].end > t) c++;
      if (c >= 3) hi++; tot++;
    }
    return tot ? hi / tot : 0;
  }
  function defaultGuitarView(notes, ppq) { return guitarPolyphony(notes, ppq) >= 0.30 ? 'guitarchords' : 'guitartab'; }
  var drumRoll = DrumRoll.create($('drumCanvas'), {
    onEdit: function (events) {
      if (drumData) { drumData.events = events; drumData.duration = Math.max(drumData.duration || 0, drumEnd(events)); Transport.setDrumDuration(drumData.duration); }
      Transport.setDrumEvents(events); renderDrumSheet(); scheduleSave();
    },
    onHistory: function (u, r) { $('dUndo').disabled = !u; $('dRedo').disabled = !r; },
    onTool: function (t) { dToolUI(t); },   // keep the toolbar in sync with keyboard tool changes (B/V)
    onSeekSeconds: function (s) { Transport.seekSeconds(s); },   // click the drum timeline to move the playhead
    isPlaying: function () { return Transport.isRunning(); },     // drives play-time auto-follow (~30% from left)
    modalOpen: isModalOpen
  });
  function drumEnd(events) { return (events || []).reduce(function (a, e) { return Math.max(a, e.time_sec || 0); }, 0) + 0.5; }

  /* ---- synth + transport ---- */
  EditorPlayer.configure({ getProject: function () { return roll.getProject(); }, setPlayhead: function () { }, onState: function () { } });
  YouTubePlayer.mount('ytPlayer');
  // In cloud mode YouTube is the ONLY playback source, so a dead video has to say so.
  // Without this, a deleted/private/region-blocked/embed-disabled video leaves the
  // Song button enabled, the clock at 0:00 and the transport spinning forever.
  // flash() and refreshSrcButtons() are hoisted declarations in this IIFE, so the
  // forward reference is safe.
  YouTubePlayer.setOnFail(function (msg, code) {
    flash(msg);
    if (YouTubePlayer.hasVideo()) {
      // The video is fine — the BROWSER refused a scripted play (the iPad's
      // normal answer; see youtube.js). One tap inside the player fixes it for
      // the session, so the panel has to be on screen to be tapped: a toast that
      // fades in three seconds is no use if the user hid the video earlier. The
      // title carries the instruction after the toast is gone.
      if (code === 'autoplay-blocked' || code === 'not-started') {
        $('ytTitle').textContent = 'Tap ▶ on the video to start';
        $('ytPanel').style.display = '';
      }
      return;
    }
    // A NUMBER means the failure came from the player, so the iframe is on
    // screen showing YouTube's OWN error page — its wording ("Video player
    // configuration error", "Video unavailable") is as diagnostic as the code,
    // and it carries YouTube's own way out to the watch page. Hiding the panel
    // threw all of that away a beat before the toast faded, which is why the
    // only report an iPad could produce was one sentence and no number. Our own
    // string codes (bad-url · api-blocked · no-host · construct-failed ·
    // timeout) leave no iframe worth looking at, so those still hide it.
    var fromPlayer = code !== null && code !== undefined && !isNaN(parseInt(code, 10));
    // The title is one ellipsised 12px line, so the number goes FIRST or it gets
    // truncated off the end — it has to survive a screenshot.
    $('ytTitle').textContent = fromPlayer ? ('YouTube error ' + code) : 'YouTube — unavailable';
    $('ytPanel').style.display = fromPlayer ? '' : 'none';
    refreshSrcButtons();
  });
  Transport.init({
    getProject: function () { return roll.getProject(); },
    melodicSynth: EditorPlayer, drumSynth: DrumSynth,
    audios: { original: $('songAudio'), stem: $('stemAudio') },
    youtube: YouTubePlayer,
    views: {
      pianoroll: { setPlayheadTick: function (t) { roll.setPlayhead(t); } },
      basstab: { setPlayheadTick: function (t) { bassTab.setPlayheadTick(t); } },
      guitartab: { setPlayheadTick: function (t) { guitarTab.setPlayheadTick(t); } },
      guitarchords: { setPlayheadTick: function (t) { guitarChords.setPlayheadTick(t); } },
      drumtab: { setPlayheadSeconds: function (s) { drumRoll.setPlayhead(s); updateDrumSheetPlayhead(s); } }
    },
    onUpdate: onTransport,
    // Transport refuses to start when the YouTube player isn't ready yet; without a
    // notice channel that refusal is silent and reads as a dead play button.
    onNotice: flash
  });
  function onTransport(st) {
    $('btnPlay').textContent = st.playing ? '⏸' : '▶';
    $('timeNow').textContent = fmt(st.posSec); $('timeTotal').textContent = fmt(st.durationSec);
    // The video is rolling, so the "tap ▶ on the video" instruction above has
    // done its job — put the plain title back. (This rides the transport's own
    // update channel rather than YouTubePlayer.setOnState(), which is a single
    // slot that Transport.init() owns.)
    if (st.playing && YouTubePlayer.isPlaying() && $('ytTitle').textContent !== 'YouTube') $('ytTitle').textContent = 'YouTube';
  }

  /* ---- backend client (desktop only — the web build has no backend) ---- */
  if (!WEB) Workflow.init({
    getTarget: curTarget,
    onSong: onSong, onStem: onStem,
    onMelodicMidi: onMelodicResult, onDrumData: onDrumResult,
    onMidiFile: openMidiFile, flash: flash
  });

  /* ====================== view switching ====================== */
  function setTabEnabled(view, on) {
    var b = $('viewTabs').querySelector('[data-view=' + view + ']');
    if (b) { b.classList.toggle('disabled', !on); if (!on) b.classList.remove('on'); }
  }
  function updateViewAvailability(instrument) {
    var isDrum = instKind(instrument) === 'drum';
    setTabEnabled('pianoroll', !isDrum);
    setTabEnabled('basstab', instrument === 'bass');
    setTabEnabled('guitartab', instrument === 'guitar');
    setTabEnabled('guitarchords', instrument === 'guitar');
    setTabEnabled('drumtab', isDrum);
  }
  function setView(name) {
    var b = $('viewTabs').querySelector('[data-view=' + name + ']');
    if (b && b.classList.contains('disabled')) return;
    currentView = name;
    Array.prototype.forEach.call($('viewTabs').children, function (x) { x.classList.toggle('on', x.dataset.view === name); });
    show($('panePianoRoll'), name === 'pianoroll'); show($('paneBassTab'), name === 'basstab'); show($('paneGuitarTab'), name === 'guitartab'); show($('paneGuitarChords'), name === 'guitarchords'); show($('paneDrumTab'), name === 'drumtab');
    show($('toolsPianoRoll'), name === 'pianoroll'); show($('toolsBassTab'), name === 'basstab'); show($('toolsGuitarTab'), name === 'guitartab'); show($('toolsGuitarChords'), name === 'guitarchords'); show($('toolsDrumTab'), name === 'drumtab');
    show($('tabZoom'), name === 'basstab' || name === 'guitartab'); updateTabZoomPct();
    Transport.setView(name);
    redrawActiveView();
    refreshSrcButtons();
  }
  // Re-render whichever view is on screen. drumRoll.resize() rather than .render():
  // the drum canvas only re-measures its parent in resize(), and the panel fold changes
  // the pane's height under it. resize() renders, so this stays one call.
  function redrawActiveView() {
    if (currentView === 'pianoroll') roll.redraw();
    else if (TAB_VIEWS[currentView]) TAB_VIEWS[currentView].render();
    else if (currentView === 'drumtab') drumRoll.resize();
  }
  $('viewTabs').addEventListener('click', function (e) { var b = e.target.closest('.vtab'); if (b && !b.classList.contains('disabled')) setView(b.dataset.view); });

  // ---- tab zoom (bass/guitar tab) + settings-toolbar show/hide ----
  function activeTabView() { return currentView === 'basstab' ? bassTab : currentView === 'guitartab' ? guitarTab : null; }
  function updateTabZoomPct() { var v = activeTabView(); if (v) $('tabZoomReset').textContent = Math.round(v.getZoom() * 100) + '%'; }
  function tabZoomBy(mult) { var v = activeTabView(); if (!v) return; v.setZoom(mult === 0 ? 1 : v.getZoom() * mult); updateTabZoomPct(); }
  $('tabZoomOut').onclick = function () { tabZoomBy(1 / 1.15); };
  $('tabZoomIn').onclick = function () { tabZoomBy(1.15); };
  $('tabZoomReset').onclick = function () { tabZoomBy(0); };
  // Fold every settings surface away — header, source bar, track strip and the per-view
  // toolbar — so the workspace gets the whole screen (studio.css does the hiding). The
  // choice is remembered across sessions, which is why the boot call below runs it too
  // rather than just setting the class: caret, title and aria have to agree with it.
  // A fold resizes the canvases without a window resize event. Each canvas does watch
  // itself with a ResizeObserver, but redrawing here as well makes it explicit rather
  // than a side effect of a callback that only fires while the tab is compositing —
  // and it costs one frame. Safe at boot: every view is constructed above (l.62-122).
  function panelsFolded() { return document.body.classList.contains('settings-collapsed'); }
  function setPanelsFolded(folded) {
    document.body.classList.toggle('settings-collapsed', folded);
    var b = $('btnSettings');
    b.setAttribute('aria-expanded', folded ? 'false' : 'true');
    b.title = folded ? 'Bring the header, tracks and settings back (F)'
                     : 'Fold the header, tracks and settings away — full screen for the tab (F)';
    $('btnSettingsCaret').textContent = folded ? '▾' : '▴';
    redrawActiveView();
    try { localStorage.setItem('studioSettingsCollapsed', folded ? '1' : ''); } catch (e) {}
  }
  $('btnSettings').onclick = function () { setPanelsFolded(!panelsFolded()); };
  (function () {
    var on = false; try { on = !!localStorage.getItem('studioSettingsCollapsed'); } catch (e) {}
    setPanelsFolded(on);
  })();

  /* ====================== tracks ====================== */
  function trackList() { return Object.keys(project.tracks).map(function (k) { return project.tracks[k]; }); }

  // The tempo the note ticks were written at — what maps a tick to its second in the
  // song. Tracks saved since this became explicit carry it. For older ones: everything
  // this backend transcribes comes out of pretty_midi at 220 ppq / 120 BPM, so that
  // signature means 120 no matter what the tempo box was left on; anything else came
  // from an imported MIDI, whose own tempo is the anchor.
  function timelineTempoFor(t) {
    return t.timelineTempo || (t.ppq === 220 ? 120 : (t.tempo || 120));
  }
  function fmtBpm(v) { return Math.round((+v || 120) * 100) / 100; }   // keep fractional BPM (99.4 ≠ 99)

  function serializeActive() {
    var id = project.activeTrackId; if (!id) return;
    var t = project.tracks[id]; if (!t) return;
    if (t.kind === 'drum') { t.events = drumRoll.getEvents(); t.duration = Math.max(t.duration || 0, drumEnd(t.events)); t.gridOffset = drumRoll.getGridOffset(); if (drumData) t.tempo = drumData.tempo; }
    else {
      var pj = roll.getProject();
      t.notes = pj.notes; t.ppq = pj.ppq; t.tempo = pj.tempo; t.timeSig = pj.timeSig;
      t.timelineTempo = pj.timelineTempo || pj.tempo;
      t.rollGridOffset = roll.getGridOffset();
      var tv = tabViewForInstrument(t.instrument);
      if (tv) { t.view = tv.getOptions(); t.overrides = tv.getOverrides(); }
      // Guitar has two sub-views (6-string tab + chord charts). Remember which one
      // is open and the chord ribbon's own options so both survive a track switch.
      if (t.instrument === 'guitar') { t.activeView = currentView; t.chordView = guitarChords.getOptions(); }
    }
  }

  function activateTrack(id, opts) {
    opts = opts || {};
    var t = project.tracks[id]; if (!t) return;
    if (project.activeTrackId && project.activeTrackId !== id) serializeActive();
    project.activeTrackId = id;
    var wasLoading = loading; loading = true;
    $('targetSel').value = t.instrument; applyTarget();
    updateViewAvailability(t.instrument);
    if (t.kind === 'drum') {
      drumData = { events: t.events || [], tempo: t.tempo || 120, duration: Math.max(t.duration || 0, drumEnd(t.events)), gridOffset: t.gridOffset || 0, adtlib: false };
      drumRoll.setData(drumData); drumRoll.zoomFit();
      Transport.setDrumEvents(drumData.events); Transport.setDrumDuration(drumData.duration);
      Transport.setDrumTempo(drumData.tempo); Transport.setDrumGridOffset(drumData.gridOffset);
      $('dGridShift').value = drumData.gridOffset;
      $('bpmInput').value = Math.round(drumData.tempo);   // the transport BPM box reflects the drum tempo
      show($('drumEmpty'), !(t.events && t.events.length));
      setStemAudio(t.stem);
      setView('drumtab');
      renderDrumSheet();
    } else {
      roll.load({ ppq: t.ppq || 480, tempo: t.tempo || 120, timelineTempo: timelineTempoFor(t),
                  timeSig: t.timeSig || { num: 4, den: 4 }, notes: t.notes || [] });
      roll.setGridOffset(t.rollGridOffset || 0); $('prGridOffset').value = t.rollGridOffset || 0;
      $('bpmInput').value = fmtBpm(t.tempo || 120);
      $('tsNum').value = (t.timeSig && t.timeSig.num) || 4; $('tsDen').value = (t.timeSig && t.timeSig.den) || 4;
      var tv = tabViewForInstrument(t.instrument);
      if (tv) {
        tv.setOverrides(t.overrides || {});
        tv.setOptions(t.view || {});               // re-renders the tab
        syncTabToolbar(t.instrument, tv.getOptions());
      }
      // Restore the chord ribbon's options (the chord view is a single shared
      // instance, so reset to defaults when this track has none — never leak the
      // previous track's settings).
      if (t.instrument === 'guitar') {
        var cv = t.chordView || { barsPerLine: 4, offsetTicks: 0 };
        guitarChords.setOptions(cv); syncGuitarChordsToolbar(cv);
      }
      Transport.rebuildMelodic();
      setStemAudio(t.stem);
      // Restore the guitar sub-view the user last had open; a first-time track (no
      // saved activeView) auto-routes by detected style. Bass/other map 1:1.
      var mview = (t.instrument === 'guitar' && t.activeView) ? t.activeView : melodicViewFor(t.instrument);
      if (t.instrument === 'guitar' && !t.activeView && !opts.keepView) mview = defaultGuitarView(t.notes || [], t.ppq || 480);
      setView(mview);
    }
    loading = wasLoading;
    updateStats(); renderTracks(); refreshSrcButtons();
  }

  // Mint a unique track id for an instrument (bass -> bass, then bass-2, bass-3 …),
  // so multiple tracks of the same instrument (e.g. two guitars) can coexist.
  function uniqueTrackId(base) {
    if (!project.tracks[base]) return base;
    var i = 2; while (project.tracks[base + '-' + i]) i++;
    return base + '-' + i;
  }
  // opts.id pins the track id (default = instrument, the single-track case);
  // opts.name overrides the label; opts.activate=false adds without switching to it.
  function upsertMelodic(instrument, m, opts) {
    opts = opts || {};
    var T = TARGETS[instrument] || TARGETS.bass;
    var id = opts.id || instrument;
    var t = project.tracks[id] || { id: id, instrument: instrument, kind: 'melodic', name: opts.name || T.label, view: {}, overrides: {} };
    if (opts.name) t.name = opts.name;
    t.notes = m.notes; t.ppq = m.ppq; t.tempo = m.tempo; t.timelineTempo = m.tempo; t.timeSig = m.timeSig;
    project.tracks[id] = t;
    if (opts.activate !== false) activateTrack(id);
    scheduleSave();
    return t;
  }

  // Split a guitar track into a monophonic LEAD track (-> 6-string tab) and a
  // RHYTHM track (the chordal remainder -> chord charts). The original track keeps
  // its id and becomes the rhythm part; a new track holds the lead. Both share the
  // guitar stem. This is how one guitar stem (rhythm + lead at once) becomes two.
  function splitGuitarTrack(srcId) {
    var t = project.tracks[srcId];
    if (!t || t.instrument !== 'guitar' || t.kind !== 'melodic') { flash('Select a guitar track to split.'); return; }
    if (project.activeTrackId === srcId) serializeActive();   // capture live edits first
    var parts = ChordCore.splitLeadRhythm(t.notes || [], t.ppq || 480);
    if (!parts.lead.length || !parts.rhythm.length) { flash('This part doesn’t split into distinct lead + rhythm.'); return; }
    var leadId = uniqueTrackId('guitar');
    var lead = upsertMelodic('guitar', { notes: parts.lead, ppq: t.ppq, tempo: t.tempo, timeSig: t.timeSig },
                             { id: leadId, name: 'Guitar (lead)', activate: false });
    if (t.stem) lead.stem = t.stem;                            // share the same guitar stem
    t.name = 'Guitar (rhythm)'; t.notes = parts.rhythm; t.view = {}; t.overrides = {};
    t.activeView = null; t.chordView = {};                    // re-auto-route the chordal remainder (don't restore the pre-split sub-view)
    renderTracks();
    activateTrack(srcId);                                      // land on the rhythm/chords part
    flash('Split guitar → Lead (' + parts.lead.length + ') + Rhythm (' + parts.rhythm.length + ' notes).');
    scheduleSave();
  }
  // Detect a guitar part that carries a rhythm AND a lead at once, and hint to split.
  function maybeSuggestSplit(notes, ppq) {
    if (ChordCore.concurrency(notes) >= 0.5)
      flash('This guitar part plays rhythm + lead together — use “Split parts” to get two guitar tracks.');
  }
  // Onset weights by drum role for tempo / bar-grid detection — kick & snare
  // carry the pulse, hats & cymbals only colour it. (Kept in sync with the
  // WEIGHT table in test-tempo.js.)
  var DRUM_ONSET_WEIGHT = {
    kick: 1.6, snare: 1.4, floor_tom: 1.1, tom1: 1.0, tom2: 1.0,
    crash: 1.0, ride: 0.6, hihat: 0.6, hihat_open: 0.7
  };
  // Recover { tempo, gridOffset } from drum hits.
  //   trustPrior=true  → an imported MIDI carries a reliable tempo, so keep it and
  //                      detect only the bar-grid phase.
  //   trustPrior=false → audio ingest (librosa/ADTOF): the autocorrelation pulse
  //                      wins (it fixes librosa octave slips), falling back to
  //                      priorBpm only when the estimate is too weak to believe.
  // The offset is always phased against the tempo we KEEP — never a discarded one.
  function autoDetectDrumGrid(events, priorBpm, trustPrior) {
    var onsets = (events || []).map(function (e) {
      return { t: e.time_sec, w: (DRUM_ONSET_WEIGHT[e.type] || 1) * ((e.velocity || 100) / 100) };
    });
    var t = TempoCore.detectTempo(onsets, { fallbackBpm: priorBpm || 120 });
    var tempo = trustPrior ? (priorBpm || t.bpm)
                           : (t.confidence >= 0.3 ? t.bpm : (priorBpm || t.bpm));
    var g = TempoCore.detectGridOffset(onsets, { tsNum: 4, bpm: tempo });
    return { tempo: tempo, gridOffset: Math.round(g.offsetSec * 1000) / 1000,
             confidence: Math.min(t.confidence, g.confidence) };
  }

  function upsertDrums(data) {
    var t = project.tracks.drums || { id: 'drums', instrument: 'drums', kind: 'drum', name: 'Drums' };
    t.events = data.events || []; t.duration = data.duration || 0;
    // Fresh ingest (transcription / MIDI import) carries no grid offset, so
    // auto-detect tempo + bar-grid phase to lay the hits into correct bars with
    // no manual tuning. A project RESTORE keeps its saved values — it reactivates
    // through activateTrack(), never here.
    if (data.gridOffset == null) {
      var d = autoDetectDrumGrid(t.events, data.tempo, !!data.tempoTrusted);
      t.tempo = d.tempo; t.gridOffset = d.gridOffset;
    } else {
      t.tempo = data.tempo || 120; t.gridOffset = data.gridOffset || 0;
    }
    project.tracks.drums = t;
    activateTrack('drums');
    scheduleSave();
  }

  function renderTracks() {
    var strip = $('trackStrip'); if (!strip) return;
    strip.innerHTML = '';
    var tracks = trackList();
    show($('trackbar'), true);
    if (!tracks.length) { strip.classList.remove('filled'); var e = document.createElement('span'); e.className = 'dim'; e.textContent = 'No tracks yet — extract one above, or open a project.'; strip.appendChild(e); return; }
    strip.classList.add('filled');
    tracks.forEach(function (t) {
      // a track is never removed — the strip is a switch, like the view tabs below
      var b = document.createElement('button');
      b.className = 'trk' + (t.id === project.activeTrackId ? ' on' : '');
      b.textContent = t.name + (t.stem ? ' ♪' : '');
      b.title = t.instrument + (t.kind === 'drum' ? ' · ' + (t.events ? t.events.length : 0) + ' hits' : ' · ' + (t.notes ? t.notes.length : 0) + ' notes') + (t.stem ? ' · stem' : '');
      b.onclick = function () { if (t.id !== project.activeTrackId) activateTrack(t.id); };
      strip.appendChild(b);
    });
  }

  /* ====================== source / pipeline results ====================== */
  function onSong(blob, name, youtubeUrl) {
    if (project.song) revoke(project.song.url);
    project.song = { name: name, blob: blob, url: URL.createObjectURL(blob), file: null };
    if (youtubeUrl) { project.youtubeUrl = youtubeUrl; $('ytUrl').value = youtubeUrl; }
    if (!project.name) { project.name = name.replace(/\.[^.]+$/, ''); $('projName').value = project.name; }
    $('songName').textContent = name + (youtubeUrl ? '  ·  YouTube' : ''); show($('songMeta'), true);
    $('songAudio').src = project.song.url; show($('songAudioRow'), true);
    refreshSrcButtons();
    if (project.id) uploadSong().then(scheduleSaveNow);
  }
  function onStem(blob, name, instrument) {
    var t = project.tracks[instrument];
    if (!t) { t = { id: instrument, instrument: instrument, kind: instKind(instrument), name: instLabel(instrument), view: {}, overrides: {} }; project.tracks[instrument] = t; }
    if (t.stem) revoke(t.stem.url);
    t.stem = { name: name, blob: blob, url: URL.createObjectURL(blob), file: null };
    if (project.activeTrackId === t.id) setStemAudio(t.stem);
    renderTracks(); refreshSrcButtons();
    if (project.id) uploadStem(t.id).then(scheduleSaveNow);
  }
  function onMelodicResult(bytes, instrument) {
    var m = MidiIO.read(bytes);
    upsertMelodic(instrument, { notes: m.notes, ppq: m.ppq, tempo: m.tempo, timeSig: m.timeSig });
    flash(m.notes.length + ' notes → ' + instLabel(instrument) + ' track.');
    if (instrument === 'guitar') maybeSuggestSplit(m.notes, m.ppq);
  }
  function onDrumResult(data) { upsertDrums(data); flash((data.events || []).length + ' drum hits → Drums track.'); }

  // Parse MIDI bytes into a track (drum channel → drum tab, else a melodic track).
  // Used by the "Open MIDI" file import (and, offline, the seed generator mirrors it).
  function importMidiBytes(bytes, opts) {
    opts = opts || {};
    var m = MidiIO.read(bytes);
    var drumCh = m.notes.filter(function (n) { return n.channel === 9; }).length;
    if (m.notes.length && drumCh / m.notes.length >= 0.5) {
      var tps = (m.tempo / 60) * (m.ppq || 480);
      var events = m.notes.map(function (n) { return { time_sec: n.start / tps, type: DrumTabCore.GM_TO_TYPE[n.pitch], velocity: n.velocity || 100 }; }).filter(function (e) { return e.type; });
      var dur = m.notes.reduce(function (a, n) { return Math.max(a, n.end); }, 0) / tps;
      // a MIDI carries a reliable tempo — keep it, auto-detect only the bar phase.
      upsertDrums({ events: events, tempo: m.tempo, duration: dur, tempoTrusted: true });
      flash(events.length + ' drum hits imported.');
    } else {
      var inst = opts.instrument || (instKind(curTarget().id) === 'melodic' ? curTarget().id : 'bass');
      upsertMelodic(inst, { notes: m.notes, ppq: m.ppq, tempo: m.tempo, timeSig: m.timeSig }, { id: opts.id, name: opts.name });
      flash(m.notes.length + ' notes imported → ' + (opts.name || instLabel(inst)) + '.');
    }
  }
  function openMidiFile(file) {
    var r = new FileReader();
    r.onload = function () {
      try { importMidiBytes(new Uint8Array(r.result)); }
      catch (e) { flash('Could not read MIDI: ' + e.message); }
    };
    r.readAsArrayBuffer(file);
  }

  function setStemAudio(stem) {
    var a = $('stemAudio');
    if (stem && stem.url) { a.src = stem.url; show($('stemRow'), true); }
    else { a.removeAttribute('src'); show($('stemRow'), false); }
    refreshSrcButtons();
  }
  function clearEditors() {
    var wasLoading = loading; loading = true;
    roll.load({ ppq: 480, tempo: 120, timeSig: { num: 4, den: 4 }, notes: [] });
    roll.setGridOffset(0); $('prGridOffset').value = 0;
    drumData = null; if (drumRoll.clearData) drumRoll.clearData(); show($('drumEmpty'), true);
    renderDrumSheet();   // clear the staff to its empty-state (drops the playhead + stale layout)
    bassTab.setOverrides({}); bassTab.render(); guitarTab.setOverrides({}); guitarTab.render(); guitarChords.clear();
    setStemAudio(null); updateStats(); updateViewAvailability('bass'); setView('pianoroll');
    loading = wasLoading;
  }

  /* ====================== persistence ====================== */
  var saveTimer = null, loading = false, dirty = false, pendingUploads = 0;
  // Set by sync.js immediately before it navigates to GitHub for OAuth. Without it
  // the beforeunload guard below raises "Leave site? Changes you may have made will
  // not be saved" at the exact moment we are sending the user to sign in — which is
  // how people abandon the login believing they lost their work. The edit is already
  // committed to IndexedDB by then; the navigation is deliberate, not a loss.
  var suppressUnload = false;
  function markSave(s) { var e = $('saveStatus'); if (e) e.textContent = s; }
  // `loading` suppresses saves during programmatic track/project loads (so merely
  // browsing tracks or opening a project doesn't dirty/re-PUT it).
  function scheduleSave() {
    if (loading) return;
    dirty = true;
    // cloud: hand off to sync.js, which commits to IndexedDB first (durable before
    // the network) and then drains lazily. noteEdit() is synchronous.
    if (CLOUD) { markSave('•'); StudioSync.noteEdit(); return; }
    // web build has no backend: edits live in memory and persist via "Save file".
    if (WEB) { markSave('edited — Save file'); return; }
    if (!project.id) { markSave('unsaved'); return; }
    markSave('•'); clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 800);
  }
  function scheduleSaveNow() { if (WEB || !project.id) return; clearTimeout(saveTimer); doSave(); }
  function serializeMeta() {
    var tracks = trackList().map(function (t) {
      var o = { id: t.id, instrument: t.instrument, kind: t.kind, name: t.name };
      if (t.kind === 'drum') { o.events = (t.events || []).map(function (e) { return { time_sec: e.time_sec, type: e.type, velocity: e.velocity }; }); o.tempo = t.tempo || 120; o.duration = t.duration || 0; o.gridOffset = t.gridOffset || 0; }
      else { o.notes = t.notes || []; o.ppq = t.ppq || 480; o.tempo = t.tempo || 120; o.timelineTempo = timelineTempoFor(t); o.timeSig = t.timeSig || { num: 4, den: 4 }; o.view = t.view || {}; o.overrides = t.overrides || {}; o.rollGridOffset = t.rollGridOffset || 0; if (t.instrument === 'guitar') { if (t.activeView) o.activeView = t.activeView; o.chordView = t.chordView || {}; } }
      if (t.stem && t.stem.file) o.stem = { file: t.stem.file, name: t.stem.name };
      return o;
    });
    return { id: project.id, name: project.name || 'Untitled', youtubeUrl: project.youtubeUrl || '', youtubeOffset: project.youtubeOffset || 0,
      song: project.song && project.song.file ? { file: project.song.file, name: project.song.name } : null,
      tracks: tracks, activeTrackId: project.activeTrackId };
  }
  function doSave() {
    if (WEB || !project.id) return;
    // never PUT project.json while an audio upload is in flight — serializeMeta
    // omits a song/stem whose .file isn't set yet, which would drop the reference.
    if (pendingUploads > 0) { clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 300); return; }
    serializeActive();
    markSave('saving…');
    fetch('/api/projects/' + project.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(serializeMeta()) })
      .then(function (r) { if (!r.ok) throw new Error('save failed'); return r.json(); })
      .then(function () { dirty = false; markSave('saved ✓'); })
      .catch(function () { markSave('save failed'); flash('Auto-save failed (backend offline?) — your edits are not saved.'); });
  }
  function uploadSong() {
    if (!project.id || !project.song || !project.song.blob) return Promise.resolve();
    pendingUploads++;
    var fd = new FormData(); fd.append('file', project.song.blob, project.song.name || 'song.mp3'); fd.append('role', 'song');
    return fetch('/api/projects/' + project.id + '/audio', { method: 'POST', body: fd })
      .then(function (r) { if (!r.ok) throw new Error('upload failed'); return r.json(); })
      .then(function (j) { project.song.file = j.file; })
      .catch(function () { flash('Song upload failed — audio not saved.'); })
      .then(function () { pendingUploads--; });
  }
  function uploadStem(trackId) {
    var t = project.tracks[trackId];
    if (!project.id || !t || !t.stem || !t.stem.blob || t.stem.file) return Promise.resolve();
    // Key the backend stem file by INSTRUMENT (not track id) so split tracks that
    // share one guitar stem map to the same stems/guitar.wav instead of duplicating.
    var inst = t.instrument || 'stem';
    pendingUploads++;
    var fd = new FormData(); fd.append('file', t.stem.blob, t.stem.name || (inst + '.wav')); fd.append('role', 'stem'); fd.append('instrument', inst);
    return fetch('/api/projects/' + project.id + '/audio', { method: 'POST', body: fd })
      .then(function (r) { if (!r.ok) throw new Error('upload failed'); return r.json(); })
      .then(function (j) { t.stem.file = j.file; })
      .catch(function () { flash('Stem upload failed — audio not saved.'); })
      .then(function () { pendingUploads--; });
  }

  function projectHasContent() { return !!(project.song || Object.keys(project.tracks).length); }
  // In cloud mode a dirty document is already committed to IndexedDB and re-openable
  // from the "On this device" drafts section, so the discard prompt is simply untrue —
  // and clicking Cancel would block the user from opening anything at all.
  function confirmDiscard() { if (CLOUD) return true; return !(dirty && projectHasContent()) || confirm('Discard unsaved changes to the current project?'); }
  // Returns true if it actually reset; false if the user cancelled the discard
  // prompt — silent callers must bail on false or they'd clobber (and auto-save
  // over) the project the user chose to keep.
  function newProject(silent) {
    if (!confirmDiscard()) return false;
    clearTimeout(saveTimer);
    if (project.song) revoke(project.song.url);
    trackList().forEach(function (t) { if (t.stem) revoke(t.stem.url); });
    project = emptyProject(); dirty = false; Workflow.reset(); srcUserPicked = false;
    $('projName').value = ''; $('ytUrl').value = ''; applyYoutubeOffset(); markSave('');
    show($('songMeta'), false); $('songAudio').removeAttribute('src'); show($('songAudioRow'), false);
    YouTubePlayer.clear(); $('ytPanel').style.display = 'none';
    Transport.stop(); clearEditors(); renderTracks();
    if (!silent) flash('New project.');
    return true;
  }
  function saveProject() {
    // MUST come before the WEB branch: WEB is true in cloud mode, so the other order
    // turns every cloud save into a file download. requestSave() decides create vs
    // save-in-place vs fork vs sign-in gate on its own.
    if (CLOUD) { StudioSync.requestSave(); return; }
    if (WEB) { saveProjectToFile(); return; }
    if (project.id) { scheduleSaveNow(); return; }
    project.name = ($('projName').value || '').trim() || defaultName();
    $('projName').value = project.name;
    var fd = new FormData(); fd.append('name', project.name);
    markSave('creating…');
    fetch('/api/projects', { method: 'POST', body: fd })
      .then(function (r) { if (!r.ok) throw new Error('create failed'); return r.json(); })
      .then(function (j) {
        project.id = j.id;
        var ups = [];
        if (project.song && project.song.blob) ups.push(uploadSong());
        trackList().forEach(function (t) { if (t.stem && t.stem.blob) ups.push(uploadStem(t.id)); });
        return Promise.all(ups);
      })
      .then(function () { doSave(); flash('Project saved: ' + project.name); })
      .catch(function () { markSave('save failed'); flash('Could not save project (backend offline?).'); });
  }
  // Web persistence: download the project as a .studio.json the user keeps on
  // their device (re-open it via "Open file"). Audio isn't embedded — a web
  // project is notes/tabs + an optional YouTube link.
  function saveProjectToFile() {
    serializeActive();
    project.name = ($('projName').value || '').trim() || defaultName();
    $('projName').value = project.name;
    // Never fabricate an id in cloud mode: ids are server-minted there, and writing a
    // made-up one into the live model would make sync push against a nonexistent
    // project. "Save file" stays reachable as the export escape hatch for users whose
    // IndexedDB is unavailable (private-mode Safari), where sign-in is refused.
    if (!CLOUD && !project.id) project.id = 'proj-' + Math.random().toString(36).slice(2, 10);
    var safe = project.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
    download(new TextEncoder().encode(JSON.stringify(serializeMeta())), safe + '.studio.json', 'application/json');
    dirty = false; markSave('saved to file'); flash('Saved to file: ' + safe + '.studio.json');
  }
  function defaultName() {
    if (project.song && project.song.name) return project.song.name.replace(/\.[^.]+$/, '');
    return 'Untitled ' + new Date().toLocaleDateString();
  }
  function openProject(id) {
    if (!confirmDiscard()) return;
    clearTimeout(saveTimer);
    // openProject accepts BOTH a server project id and a 'local_<hex>' draft key, so
    // library cards of either kind pass straight through.
    if (CLOUD) { StudioSync.openProject(id); return; }
    if (WEB) {
      // web build: the library is the static projects/ bundle (read-only here).
      // Opened projects are editable in memory and saved back via "Save file".
      fetch('projects/' + encodeURIComponent(id) + '.json', { cache: 'force-cache' })
        .then(function (r) { if (!r.ok || isHtml(r)) throw new Error('not found'); return r.json(); })
        .then(function (meta) { loadProjectMeta(meta, null); })
        .catch(function (e) { flash('Could not open project: ' + e.message); });
      return;
    }
    fetch('/api/projects/' + id).then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(function (meta) {
        // Saved-project audio is served same-origin by the local backend.
        var audUrl = function (file) {
          var enc = String(file).split('/').map(encodeURIComponent).join('/');  // keep '/' separators, escape segments
          return '/api/projects/' + id + '/audio/' + enc;
        };
        loadProjectMeta(meta, audUrl);
      })
      .catch(function (e) { flash('Could not open project: ' + e.message); });
  }
  // Apply a fetched/imported project.json to the live model. `audUrl(file)->url`
  // resolves saved audio (local backend); pass null when there is no backend
  // (web build / file import) — those projects carry no local audio, only
  // notes/tabs plus an optional YouTube link used as the Song source.
  function loadProjectMeta(meta, audUrl) {
    if (project.song) revoke(project.song.url);
    trackList().forEach(function (t) { if (t.stem) revoke(t.stem.url); });
    project = emptyProject(); srcUserPicked = false;
    project.id = meta.id || null; project.name = meta.name || 'Untitled'; project.youtubeUrl = meta.youtubeUrl || '';
    project.youtubeOffset = +meta.youtubeOffset || 0;
    $('projName').value = project.name; $('ytUrl').value = project.youtubeUrl; applyYoutubeOffset();
    if (audUrl && meta.song && meta.song.file) {
      project.song = { name: meta.song.name, file: meta.song.file, url: audUrl(meta.song.file), blob: null };
      $('songName').textContent = (meta.song.name || 'song') + (project.youtubeUrl ? '  ·  YouTube' : ''); show($('songMeta'), true);
      $('songAudio').src = project.song.url; show($('songAudioRow'), true);
      // materialize the song into a Blob so the pipeline can extract more tracks from it
      fetch(project.song.url).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) { if (b) { project.song.blob = b; Workflow.adoptSong(b, project.song.name); } }).catch(function () { });
    } else {
      show($('songMeta'), false); $('songAudio').removeAttribute('src'); Workflow.reset();
      // no local audio: wire the project's YouTube link as the Song source if any
      if (project.youtubeUrl) setSongYouTube(project.youtubeUrl); else { YouTubePlayer.clear(); $('ytPanel').style.display = 'none'; }
    }
    (meta.tracks || []).forEach(function (t) {
      var tr = { id: t.id || t.instrument, instrument: t.instrument, kind: t.kind, name: t.name || instLabel(t.instrument) };
      if (t.kind === 'drum') { tr.events = t.events || []; tr.tempo = t.tempo || 120; tr.duration = t.duration || 0; tr.gridOffset = t.gridOffset || 0; }
      else { tr.notes = t.notes || []; tr.ppq = t.ppq || 480; tr.tempo = t.tempo || 120; tr.timelineTempo = timelineTempoFor(t); tr.timeSig = t.timeSig || { num: 4, den: 4 }; tr.view = t.view || {}; tr.overrides = t.overrides || {}; tr.rollGridOffset = t.rollGridOffset || 0; if (t.activeView) tr.activeView = t.activeView; if (t.chordView) tr.chordView = t.chordView; }
      if (audUrl && t.stem && t.stem.file) tr.stem = { name: t.stem.name, file: t.stem.file, url: audUrl(t.stem.file), blob: null };
      project.tracks[tr.id] = tr;
    });
    renderTracks();
    var first = (meta.activeTrackId && project.tracks[meta.activeTrackId]) ? meta.activeTrackId : Object.keys(project.tracks)[0];
    if (first) activateTrack(first); else clearEditors();
    dirty = false; markSave(WEB ? '' : 'saved ✓'); closeLibrary(); flash('Opened: ' + project.name);
  }
  // Import a project.json the user saved with "Save file" (web persistence; works
  // in desktop too as a plain import — it won't auto-bind to the backend).
  function openProjectFromFile(file) {
    if (!confirmDiscard()) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var meta = JSON.parse(r.result);
        if (!meta || !Array.isArray(meta.tracks)) throw new Error('not a project file');
        clearTimeout(saveTimer);
        loadProjectMeta(meta, null);
        // An imported file carries a foreign meta.id. Without this, sync would still
        // be pointed at whatever project was open and the first edit to the import
        // would push over it.
        if (CLOUD) StudioSync.requestNew();
      } catch (e) { flash('Could not read project file: ' + e.message); }
    };
    r.readAsText(file);
  }
  function deleteProject(id) {
    if (CLOUD) {
      return StudioApi.deleteProject(id).then(function () {
        if (project.id === id) StudioSync.requestNew();
        fetchProjects();
      }, function (e) { flash('Could not delete: ' + e.message); });
    }
    // NB: the desktop path never checked r.ok, so a 404 read as success and the row
    // reappeared on the next refresh.
    fetch('/api/projects/' + id, { method: 'DELETE' }).then(function (r) {
      if (!r.ok) throw new Error('delete failed');
      if (project.id === id) newProject();
      fetchProjects();
    }).catch(function () { flash('Could not delete project.'); });
  }

  /* ====================== project library ====================== */
  var libProjects = [], libLoaded = false;
  function openLibrary() { $('libOverlay').style.display = ''; $('libSearch').value = ''; libLoaded = false; renderLibrary(); fetchProjects(); setTimeout(function () { $('libSearch').focus(); }, 30); }
  function closeLibrary() { $('libOverlay').style.display = 'none'; }
  // The library lists projects. Desktop reads them from the local backend; the web
  // build reads them from the bundled static projects/ library (read-only here,
  // editable once opened, saved back via "Save file").
  // isHtml: the SPA fallback (_redirects '/* /index.html 200') serves index.html
  // with HTTP 200 for a MISSING file — so a 200 alone doesn't mean it exists.
  // Reject HTML so a not-deployed bundle fails clearly instead of as JSON garbage.
  function isHtml(r) { return /text\/html/i.test(r.headers.get('content-type') || ''); }
  var libMine = false;   // "My projects" filter (cloud only)
  function fetchProjects() {
    // cloud: the library is D1 — every project is public, search runs server-side,
    // and the default order is this user's most-recently-viewed. Drafts held only on
    // this device are prepended by listLibrary().
    if (CLOUD) {
      var opts = { order: 'recent', q: ($('libSearch').value || '').trim() };
      if (libMine && StudioSync.user()) opts.mine = 1;   // the Worker 400s on mine=1 while anonymous
      StudioSync.listLibrary(opts).then(function (page) {
        libProjects = (page && page.projects) || []; libLoaded = true; renderLibrary();
      }, function () { libProjects = []; libLoaded = true; renderLibrary(); });
      return;
    }
    var url = WEB ? 'projects/index.json' : '/api/projects';
    fetch(url, { cache: WEB ? 'force-cache' : 'no-store' }).then(function (r) { return (r.ok && !isHtml(r)) ? r.json() : { projects: [] }; })
      .then(function (j) { libProjects = (j && j.projects) || []; libLoaded = true; renderLibrary(); })
      .catch(function () { libProjects = []; libLoaded = true; renderLibrary(); });
  }
  function renderLibrary() {
    var q = ($('libSearch').value || '').toLowerCase().trim();
    var list = $('libList'); list.innerHTML = '';
    // cloud searches server-side, so filtering again here would double-filter the page
    // against a stale input and hide rows the server already matched.
    var items = CLOUD ? libProjects : libProjects.filter(function (p) { return !q || (p.name || '').toLowerCase().indexOf(q) >= 0; });
    if (!items.length) {
      var emptyMsg = !libLoaded ? 'Loading…'
        : libProjects.length ? 'No projects match.'
        : CLOUD ? (q ? 'No projects match.' : libMine ? 'You have no projects yet — open any project and edit it to make a copy.' : 'No projects yet.')
        : WEB ? 'No projects bundled.'
        : 'No saved projects yet — load a song, extract a track, then Save.';
      show($('libEmpty'), !!emptyMsg); $('libEmpty').textContent = emptyMsg;
      return;
    }
    show($('libEmpty'), false);
    items.forEach(function (p) {
      var row = document.createElement('div'); row.className = 'lib-item';
      var open = document.createElement('button'); open.className = 'lib-open';
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name || 'Untitled';
      var meta = document.createElement('span'); meta.className = 'meta';
      var insts = (p.instruments || []).filter(Boolean);
      meta.textContent = (insts.length ? insts.join(' · ') : 'empty') + (p.hasSong ? '  ·  ♪' : '') + (p.youtubeUrl ? '  ·  YT' : '') + '  ·  ' + fmtDate(p.updated);
      open.appendChild(nm); open.appendChild(meta);
      // Every project is public, so say whose it is — and mark the ones that exist
      // only in this browser, because those are the ones that can be lost.
      if (CLOUD) {
        var tag = document.createElement('span'); tag.className = 'lib-badge';
        if (p.draft) { tag.textContent = 'on this device'; tag.classList.add('draft'); }
        else if (p.isMine) { tag.textContent = 'mine'; tag.classList.add('mine'); }
        else if (p.ownerName) { tag.textContent = p.ownerName; }
        if (tag.textContent) open.appendChild(tag);
      }
      open.onclick = function () { openProject(p.id); };
      row.appendChild(open);
      // Delete only applies to the desktop backend's library; the web build's list is
      // read-only (open + edit + Save file instead).
      // Desktop: every row is deletable. Cloud: only rows you own (R4) — canEdit is
      // supplied by the server and is also true for admin.
      if (!WEB || (CLOUD && (p.canEdit || p.draft))) {
        var del = document.createElement('button'); del.className = 'lib-del'; del.textContent = '🗑'; del.title = 'Delete project';
        del.onclick = function (e) {
          e.stopPropagation();
          if (!confirm('Delete project "' + (p.name || 'Untitled') + '"?')) return;
          if (CLOUD && p.draft) { StudioSync.discardDraft(p.id).then(fetchProjects); return; }
          deleteProject(p.id);
        };
        row.appendChild(del);
      }
      list.appendChild(row);
    });
  }
  function fmtDate(t) { if (!t) return '—'; try { return new Date(t * 1000).toLocaleString(); } catch (e) { return '—'; } }

  /* ---- cloud auth UI ------------------------------------------------------
   * Called at boot and on every sync state change. Everything is built with
   * textContent, never innerHTML: all projects are public, so owner names are
   * attacker-supplied strings rendered in other people's browsers.
   * ----------------------------------------------------------------------- */
  function renderAuthUI() {
    if (!CLOUD) return;
    var slot = $('authSlot'); if (!slot) return;
    var u = (window.StudioSync && StudioSync.user) ? StudioSync.user() : null;
    slot.innerHTML = '';
    if (u) {
      if (u.image) {
        var img = document.createElement('img'); img.className = 'avatar';
        img.src = u.image; img.alt = ''; img.width = 20; img.height = 20;
        slot.appendChild(img);
      }
      var who = document.createElement('span'); who.className = 'who';
      who.textContent = u.name || 'signed in';
      if (u.isAdmin) who.title = 'admin';
      slot.appendChild(who);
      var out = document.createElement('button'); out.className = 'btn sm'; out.textContent = 'Sign out';
      out.onclick = function () { StudioSync.signOut(); };
      slot.appendChild(out);
    } else {
      var inb = document.createElement('button'); inb.className = 'btn sm';
      inb.textContent = 'Sign in with GitHub';
      inb.title = 'Needed to duplicate or save a project. Browsing and editing work without it.';
      inb.onclick = function () { StudioSync.signIn(); };
      slot.appendChild(inb);
    }
    // "My projects" is meaningless — and rejected by the Worker — while logged out.
    var mw = $('libMineWrap'); if (mw) mw.style.display = u ? '' : 'none';
    if (!u && libMine) { libMine = false; var mc = $('libMine'); if (mc) mc.checked = false; }
  }

  /* ====================== transport UI ====================== */
  $('btnPlay').onclick = function () { Transport.toggle(); };
  $('btnStop').onclick = function () { Transport.stop(); };
  var metro = false;
  $('btnMetro').onclick = function () { metro = !metro; this.classList.toggle('on', metro); this.setAttribute('aria-pressed', metro); Transport.setMetro(metro); };
  $('srcSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-src]');
    if (b && !b.disabled) {
      srcUserPicked = true;
      Transport.setSource(b.dataset.src); refreshSrcButtons();
      // selecting the Song source re-shows the (hideable) video panel
      if (b.dataset.src === 'original' && YouTubePlayer.hasVideo()) $('ytPanel').style.display = '';
    }
  });
  // Wire a song's YouTube video as the "Song" source (web app has no audio file).
  function setSongYouTube(url) {
    if (url && YouTubePlayer.load(url)) {
      project.youtubeUrl = url;
      $('ytTitle').textContent = 'YouTube';
      $('ytPanel').style.display = '';
    } else {
      YouTubePlayer.clear();
      $('ytPanel').style.display = 'none';
    }
    refreshSrcButtons();
  }
  $('ytHide').onclick = function () { $('ytPanel').style.display = 'none'; };
  function refreshSrcButtons() {
    var seg = $('srcSeg');
    seg.querySelector('[data-src=original]').disabled = !Transport.sourceAvailable('original');
    var synthBtn = seg.querySelector('[data-src=synth]');
    synthBtn.disabled = !Transport.sourceAvailable('synth');
    if (!Transport.sourceAvailable(Transport.getSource())) Transport.setSource('synth');
    // default to the Song source once one is available, unless the user picked one
    if (!srcUserPicked && Transport.sourceAvailable('original') && Transport.getSource() !== 'original') Transport.setSource('original');
    Array.prototype.forEach.call(seg.children, function (b) { b.classList.toggle('on', b.dataset.src === Transport.getSource()); });
  }
  ['songAudio', 'stemAudio'].forEach(function (id) { var el = $(id); if (el) ['loadeddata', 'canplay', 'emptied'].forEach(function (ev) { el.addEventListener(ev, refreshSrcButtons); }); });

  // Apply a tempo to the active drum track (the grid + sheet + metronome all key
  // off it). Tempo may be fractional from auto-detect; the BPM box shows it rounded.
  function applyDrumTempo(v) {
    v = +v || 120;
    var t = project.tracks[project.activeTrackId];
    if (t && t.kind === 'drum') t.tempo = v;
    if (drumData) drumData.tempo = v;
    Transport.setDrumTempo(v); drumRoll.render(); renderDrumSheet();
    $('bpmInput').value = Math.round(v);
  }
  $('bpmInput').addEventListener('change', function () {
    var v = +this.value || 120, t = project.tracks[project.activeTrackId];
    if (t && t.kind === 'drum') { applyDrumTempo(v); scheduleSave(); }
    else { roll.setTempo(v); }
  });
  function setTS() { roll.setTimeSig(+$('tsNum').value || 4, +$('tsDen').value || 4); }
  $('tsNum').addEventListener('change', setTS); $('tsDen').addEventListener('change', setTS);

  // any blocking dialog is open → editor/global hotkeys should stand down so e.g.
  // Esc-to-close-Help doesn't also clear the selection in the editor behind it.
  function isModalOpen() { return $('helpOverlay').style.display !== 'none' || $('libOverlay').style.display !== 'none' || $('qzOverlay').style.display !== 'none'; }
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' && e.key !== ' ') return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) || isModalOpen()) return;
    e.preventDefault(); Transport.toggle();
  });
  // global "?" opens the user guide from any view
  document.addEventListener('keydown', function (e) {
    if (e.key !== '?') return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) || isModalOpen()) return;
    e.preventDefault(); showHelp(true);
  });
  // global "F" folds / unfolds the settings panels. Bare F only: Ctrl/⌘+F is the
  // browser's find and Alt+F opens a menu, and neither view binds F of its own.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'f' && e.key !== 'F') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) || isModalOpen()) return;
    e.preventDefault(); setPanelsFolded(!panelsFolded());
  });

  /* ====================== piano-roll toolbar ====================== */
  function gridTicks() {
    var ppq = roll.stats().ppq, v = $('gridSel').value;
    var map = { q: ppq, '8': ppq / 2, '8t': ppq / 3, '16': ppq / 4, '16t': ppq / 6, '32': ppq / 8 };
    return Math.round(map[v] || ppq / 4);
  }
  $('gridSel').addEventListener('change', function () { roll.setGridTicks(gridTicks()); });
  $('snapChk').addEventListener('change', function () { roll.setSnap(this.checked); });
  // Piano-roll bar-grid shift (move the grid, not the notes — align bar 1 to the music).
  function applyRollGridOffset(ticks) {
    ticks = Math.round(+ticks || 0);
    roll.setGridOffset(ticks);
    var t = project.tracks[project.activeTrackId];
    if (t && t.kind !== 'drum') t.rollGridOffset = ticks;
    $('prGridOffset').value = ticks;
    if (!loading) scheduleSave();
  }
  $('prGridOffset').addEventListener('change', function () { applyRollGridOffset(this.value); });
  $('prGridOffL').onclick = function () { applyRollGridOffset(roll.getGridOffset() - 10); };
  $('prGridOffR').onclick = function () { applyRollGridOffset(roll.getGridOffset() + 10); };
  // Align the roll's bar grid to the song in one click: BPM + grid offset. Prefer the
  // drum track's numbers — its detector works on hit times in real seconds and is far
  // steadier than melodic onsets (sustained notes make a weak pulse). No drums → fall
  // back to the note onsets, converted to seconds through the timeline tempo.
  $('prAuto').onclick = function () {
    var pj = roll.getProject();
    if (!pj.notes.length) { flash('No notes to align the grid to yet.'); return; }
    var secPerTick = 60 / ((pj.timelineTempo || 120) * (pj.ppq || 480));
    var dt = trackList().filter(function (t) { return t.kind === 'drum' && (t.events || []).length; })[0];
    var bpm, originSec, src;
    if (dt) { bpm = dt.tempo || 120; originSec = dt.gridOffset || 0; src = 'drum track'; }
    else {
      var r = TempoCore.analyze(pj.notes.map(function (n) { return n.start * secPerTick; }).sort(function (a, b) { return a - b; }),
                                { tsNum: +$('tsNum').value || 4 });
      bpm = r.bpm; originSec = r.offsetSec; src = 'note onsets';
    }
    roll.setTempo(bpm); $('bpmInput').value = fmtBpm(bpm);
    applyRollGridOffset(Math.round(originSec / secPerTick));
    flash('Auto: ' + fmtBpm(bpm) + ' BPM · grid offset ' + Math.round(originSec * 1000) + ' ms (from the ' + src + ').');
  };
  function setToolUI(t) { $('toolSelect').classList.toggle('on', t === 'select'); $('toolDraw').classList.toggle('on', t === 'draw'); }
  $('toolSelect').onclick = function () { roll.setTool('select'); setToolUI('select'); };
  $('toolDraw').onclick = function () { roll.setTool('draw'); setToolUI('draw'); };
  $('btnUndo').onclick = roll.undo; $('btnRedo').onclick = roll.redo;
  $('btnCopy').onclick = roll.copy; $('btnPaste').onclick = roll.paste;
  $('btnDup').onclick = roll.duplicate; $('btnDel').onclick = roll.deleteSel;
  $('btnQuant').onclick = function () { roll.quantize(1, false); };
  $('btnMono').onclick = function () {
    var p = roll.getProject(); var before = p.notes.length;
    p.notes = BassTab.monophonicReduce(p.notes, p.ppq, { pick: 'low' });
    roll.load(p); if (TAB_VIEWS[currentView]) TAB_VIEWS[currentView].render();
    flash('Reduced ' + before + ' → ' + p.notes.length + ' notes (monophonic).');
  };
  $('btnOctUp').onclick = function () { roll.transpose(12); };
  $('btnOctDown').onclick = function () { roll.transpose(-12); };
  $('btnZoomHIn').onclick = function () { roll.zoomTime(1.25); };
  $('btnZoomHOut').onclick = function () { roll.zoomTime(0.8); };
  $('btnZoomVIn').onclick = function () { roll.zoomPitch(1.2); };
  $('btnZoomVOut').onclick = function () { roll.zoomPitch(1 / 1.2); };
  $('btnZoomFit').onclick = function () { roll.fitTime(); };

  /* ====================== bass-tab toolbar ====================== */
  function btOpts(p) { bassTab.setOptions(p); scheduleSave(); }
  // Detect the bar offset (ticks) that lines bar 1 up with the music and apply it
  // to a fretted-tab view. Meaningful when the notes carry a real tempo (e.g. an
  // imported MIDI); a raw basic-pitch transcription is laid out at a flat 120 BPM.
  function autoAlignMelodicBars(view, inputId) {
    var p = roll.getProject();
    if (!p.notes || p.notes.length < 4) { flash('Not enough notes to align bars.'); return; }
    // read the meter from the project (what the tab actually renders against), not
    // the shared DOM boxes — they can lag behind on a track switch.
    var ppq = p.ppq || 480, ts = p.timeSig || { num: 4, den: 4 };
    // Measure bars the way the tab now draws them: on the musical tempo, which is
    // ppq × timelineTempo/tempo ticks wide.
    var musicalTempo = p.tempo || 120;
    var layoutPpq = ppq * ((p.timelineTempo || musicalTempo) / musicalTempo);
    var tsNum = ts.num || 4, den = ts.den || 4, barTicks = layoutPpq * 4 * tsNum / den;
    var starts = p.notes.map(function (n) { return { t: n.start, w: (n.velocity || 100) / 100 }; });
    var r = TempoCore.detectBarOffsetTicks(starts, { ppq: layoutPpq, tsNum: tsNum, den: den });
    var off = r.offsetTicks;
    // A leftward (negative) shift moves notes earlier; transformNotes drops/clamps
    // any pushed before tick 0, silently erasing a pickup. If that would happen,
    // use the equivalent rightward shift (a leading pickup bar) so every note survives.
    var minStart = p.notes.reduce(function (m, n) { return Math.min(m, n.start); }, Infinity);
    if (off < 0 && minStart + off < 0) off += barTicks;
    view.setOptions({ offsetTicks: off });
    if ($(inputId)) $(inputId).value = off;
    scheduleSave();
    flash('Auto bars: offset ' + off + ' ticks.');
  }
  $('btMono').addEventListener('change', function () { btOpts({ monophonic: this.checked }); });
  $('btAvoidOpen').addEventListener('change', function () { btOpts({ avoidOpen: this.checked }); });
  $('btFingers').addEventListener('change', function () { btOpts({ showFingers: this.checked }); });
  $('btMaxFret').addEventListener('change', function () { btOpts({ maxFret: +this.value || 24 }); });
  $('btGrid').addEventListener('change', function () { btOpts({ gridDiv: this.value }); });
  $('btBars').addEventListener('change', function () { btOpts({ barsPerLine: +this.value || 4 }); });
  $('btOffset').addEventListener('change', function () { btOpts({ offsetTicks: Math.round(+this.value || 0) }); });
  $('btAuto').onclick = function () { autoAlignMelodicBars(bassTab, 'btOffset'); };
  $('btOctUp').onclick = function () { btOpts({ octaveShift: (bassTab.getOptions().octaveShift || 0) + 1 }); };
  $('btOctDown').onclick = function () { btOpts({ octaveShift: (bassTab.getOptions().octaveShift || 0) - 1 }); };
  $('btCopy').onclick = function () { var a = bassTab.getAscii && bassTab.getAscii(); if (!a) { flash('No tab yet.'); return; } navigator.clipboard && navigator.clipboard.writeText(a); flash('ASCII tab copied.'); };
  $('btExport').onclick = function () { var a = bassTab.getAscii && bassTab.getAscii(); if (!a) { flash('No tab yet.'); return; } download(new TextEncoder().encode(a), (project.name || 'bass') + '-tab.txt', 'text/plain'); };
  $('btPrint').onclick = function () { printFrettedTab(bassTab, 'Bass'); };
  function updateErgo(ergo) { var e = $('btErgo'); if (!e) return; e.textContent = ergo ? (ergo.rating + ' · ' + ergo.noteCount + ' notes · frets ' + ergo.minFret + '–' + ergo.maxFret) : '—'; }
  function syncBassToolbar(v) {
    if ($('btMono')) $('btMono').checked = v.monophonic !== false;
    if ($('btAvoidOpen')) $('btAvoidOpen').checked = !!v.avoidOpen;
    if ($('btFingers')) $('btFingers').checked = v.showFingers !== false;
    if ($('btMaxFret')) $('btMaxFret').value = v.maxFret || 24;
    if ($('btGrid')) $('btGrid').value = v.gridDiv || '16';
    if ($('btBars')) $('btBars').value = v.barsPerLine || 4;
    if ($('btOffset')) $('btOffset').value = v.offsetTicks || 0;
  }

  /* ====================== guitar-tab toolbar (mirrors bass; drives guitarTab) ====================== */
  function gtOpts(p) { guitarTab.setOptions(p); scheduleSave(); }
  $('gtMono').addEventListener('change', function () { gtOpts({ monophonic: this.checked }); });
  $('gtAvoidOpen').addEventListener('change', function () { gtOpts({ avoidOpen: this.checked }); });
  $('gtFingers').addEventListener('change', function () { gtOpts({ showFingers: this.checked }); });
  $('gtMaxFret').addEventListener('change', function () { gtOpts({ maxFret: +this.value || 19 }); });
  $('gtGrid').addEventListener('change', function () { gtOpts({ gridDiv: this.value }); });
  $('gtBars').addEventListener('change', function () { gtOpts({ barsPerLine: +this.value || 4 }); });
  $('gtOffset').addEventListener('change', function () { gtOpts({ offsetTicks: Math.round(+this.value || 0) }); });
  $('gtAuto').onclick = function () { autoAlignMelodicBars(guitarTab, 'gtOffset'); };
  $('gtOctUp').onclick = function () { gtOpts({ octaveShift: (guitarTab.getOptions().octaveShift || 0) + 1 }); };
  $('gtOctDown').onclick = function () { gtOpts({ octaveShift: (guitarTab.getOptions().octaveShift || 0) - 1 }); };
  $('gtCopy').onclick = function () { var a = guitarTab.getAscii && guitarTab.getAscii(); if (!a) { flash('No tab yet.'); return; } navigator.clipboard && navigator.clipboard.writeText(a); flash('ASCII tab copied.'); };
  $('gtExport').onclick = function () { var a = guitarTab.getAscii && guitarTab.getAscii(); if (!a) { flash('No tab yet.'); return; } download(new TextEncoder().encode(a), (project.name || 'guitar') + '-tab.txt', 'text/plain'); };
  function updateGuitarErgo(ergo) { var e = $('gtErgo'); if (!e) return; e.textContent = ergo ? (ergo.rating + ' · ' + ergo.noteCount + ' notes · frets ' + ergo.minFret + '–' + ergo.maxFret) : '—'; }
  function syncGuitarToolbar(v) {
    if ($('gtMono')) $('gtMono').checked = v.monophonic !== false;
    if ($('gtAvoidOpen')) $('gtAvoidOpen').checked = !!v.avoidOpen;
    if ($('gtFingers')) $('gtFingers').checked = v.showFingers !== false;
    if ($('gtMaxFret')) $('gtMaxFret').value = v.maxFret || 19;
    if ($('gtGrid')) $('gtGrid').value = v.gridDiv || '16';
    if ($('gtBars')) $('gtBars').value = v.barsPerLine || 4;
    if ($('gtOffset')) $('gtOffset').value = v.offsetTicks || 0;
  }
  // Sync whichever fretted-instrument toolbar matches the active melodic instrument.
  function syncTabToolbar(instrument, v) {
    if (instrument === 'guitar') syncGuitarToolbar(v);
    else if (instrument === 'bass') syncBassToolbar(v);
  }
  // "Split parts" (both guitar toolbars): split the active guitar track into lead + rhythm.
  if ($('gtSplit')) $('gtSplit').onclick = function () { splitGuitarTrack(project.activeTrackId); };

  /* ====================== guitar-chords toolbar (Tab Type 1) ====================== */
  $('gcBars').addEventListener('change', function () { guitarChords.setOptions({ barsPerLine: +this.value || 4 }); scheduleSave(); });
  $('gcOffset').addEventListener('change', function () { guitarChords.setOptions({ offsetTicks: Math.round(+this.value || 0) }); scheduleSave(); });
  $('gcCopy').onclick = function () { var a = guitarChords.getAscii && guitarChords.getAscii(); if (!a) { flash('No chords detected yet.'); return; } navigator.clipboard && navigator.clipboard.writeText(a); flash('Chord progression copied.'); };
  if ($('gcSplit')) $('gcSplit').onclick = function () { splitGuitarTrack(project.activeTrackId); };
  // Reflect a track's saved chord-ribbon options back into the toolbar on restore.
  function syncGuitarChordsToolbar(v) {
    v = v || {};
    if ($('gcBars')) $('gcBars').value = v.barsPerLine || 4;
    if ($('gcOffset')) $('gcOffset').value = v.offsetTicks || 0;
  }
  function updateChordInfo(st) { var e = $('gcInfo'); if (!e) return; e.textContent = st ? (st.count + ' changes · ' + st.unique + ' chords') : '—'; }

  /* ====================== drum-tab toolbar ====================== */
  function dToolUI(t) { $('dToolSelect').classList.toggle('on', t === 'select'); $('dToolDraw').classList.toggle('on', t === 'draw'); }
  $('dToolSelect').onclick = function () { drumRoll.setTool('select'); };   // setTool fires onTool → dToolUI
  $('dToolDraw').onclick = function () { drumRoll.setTool('draw'); };
  $('dSnap').addEventListener('change', function () { drumRoll.setSnap(this.checked); });
  $('dGridSub').addEventListener('change', function () { drumRoll.setGridSub(+this.value); renderDrumSheet(); });
  $('dUndo').onclick = function () { drumRoll.undo(); }; $('dRedo').onclick = function () { drumRoll.redo(); };

  /* ---- drum bar-grid shift (move the grid, not the notes — re-align to audio) ---- */
  function applyDrumGridOffset(sec) {
    sec = Math.round((+sec || 0) * 1000) / 1000;
    drumRoll.setGridOffset(sec);
    if (drumData) drumData.gridOffset = sec;
    Transport.setDrumGridOffset(sec);
    $('dGridShift').value = sec;
    renderDrumSheet(); scheduleSave();
  }
  $('dGridShift').addEventListener('change', function () { applyDrumGridOffset(this.value); });
  $('dShiftL').onclick = function () { applyDrumGridOffset(drumRoll.getGridOffset() - 0.01); };
  $('dShiftR').onclick = function () { applyDrumGridOffset(drumRoll.getGridOffset() + 0.01); };
  // Auto-detect tempo + bar-grid offset from the current hits and apply both.
  $('dAuto').onclick = function () {
    var events = drumRoll.getEvents();
    if (!events || !events.length) { flash('No drum hits to analyse yet.'); return; }
    var d = autoDetectDrumGrid(events, (drumData && drumData.tempo) || 120);
    applyDrumTempo(d.tempo);
    applyDrumGridOffset(d.gridOffset);   // re-renders the sheet, updates the box, saves
    flash('Auto: ' + Math.round(d.tempo) + ' BPM · grid offset ' + Math.round(d.gridOffset * 1000) + ' ms.');
  };

  /* ---- traditional drum sheet (auto-aligned staff below the grid) ---- */
  // On by default: the staff reads straight off the grid (it quantizes its own
  // display copy) so no manual Quantize pass is needed first.
  var sheetOn = true;
  function renderDrumSheet() {
    if (!sheetOn) return;
    var host = $('drumSheet'); if (!host) return;
    DrumSheet.render(host, {
      events: drumRoll.getEvents(),
      tempo: (drumData && drumData.tempo) || 120,
      gridOffset: drumRoll.getGridOffset(),
      gridSub: drumRoll.getGridSub(),
      tsNum: 4, barsPerLine: 4
    });
  }
  // Drive the staff's playhead from the transport so it scrolls with playback
  // (it follows vertically while playing, and just marks the spot when paused).
  function updateDrumSheetPlayhead(s) {
    if (!sheetOn) return;
    DrumSheet.setPlayhead(s, Transport.isRunning());
  }
  function applySheetVisibility() {
    show($('drumSheetWrap'), sheetOn);
    document.body.classList.toggle('sheet-on', sheetOn);
  }
  $('dSheetChk').addEventListener('change', function () {
    sheetOn = this.checked;
    applySheetVisibility();
    renderDrumSheet();
  });
  $('dSheetChk').checked = sheetOn;   // reflect the default-on state in the toolbar
  applySheetVisibility();
  $('dZoomIn').onclick = function () { drumRoll.zoomIn(); }; $('dZoomOut').onclick = function () { drumRoll.zoomOut(); }; $('dZoomFit').onclick = function () { drumRoll.zoomFit(); };
  $('dDlJson').onclick = function () {
    if (!drumData) return;
    var blob = new Blob([JSON.stringify(Object.assign({}, drumData, { events: drumRoll.getEvents() }), null, 2)], { type: 'application/json' });
    dl(URL.createObjectURL(blob), (project.name || 'drums') + '.json');
  };
  $('dDlMidi').onclick = exportDrumMidi;
  function dl(href, name) { var a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
  // Build a GM channel-10 drum MIDI from the live drum grid (DrumTabCore lane → GM note).
  function exportDrumMidi() {
    var events = drumRoll.getEvents();
    if (!events.length) { flash('No drum hits to export.'); return; }
    var ppq = 480, tempo = (drumData && drumData.tempo) || 120, tps = (tempo / 60) * ppq;
    var notes = events.map(function (e) {
      var lane = DrumTabCore.LANES[DrumTabCore.TYPE_TO_IDX[e.type]];
      var pitch = (lane && lane.midi && lane.midi[0]) || 38;
      var st = Math.round((e.time_sec || 0) * tps);
      return { start: st, end: st + Math.round(ppq / 8), pitch: pitch, velocity: e.velocity || 100, channel: 9 };
    });
    download(MidiIO.write({ ppq: ppq, tempo: tempo, timeSig: { num: 4, den: 4 }, notes: notes }), (project.name || 'drums') + '-drums.mid', 'audio/midi');
  }

  /* ====================== header / global toolbar ====================== */
  // Route through sync so it drops the previous serverId. Without that, the first
  // edit on the new blank document would push it over the project that was open.
  $('btnNewProj').onclick = function () { if (newProject() === false) return; if (CLOUD) StudioSync.requestNew(); };
  $('btnSaveProj').onclick = saveProject;
  $('btnOpenFile').onclick = function () { $('projFileInput').click(); };
  $('projFileInput').addEventListener('change', function (e) { if (e.target.files[0]) { openProjectFromFile(e.target.files[0]); e.target.value = ''; } });
  $('btnLibrary').onclick = openLibrary;
  // Duplicate is the only way a non-author keeps their changes (R4), and it requires
  // sign-in (R1) — requestDuplicate() raises the gate itself when logged out.
  if ($('btnDuplicate')) $('btnDuplicate').onclick = function () { if (CLOUD) StudioSync.requestDuplicate(); };
  if ($('libMine')) $('libMine').addEventListener('change', function () { libMine = !!this.checked; fetchProjects(); });
  // In the backend-less web build, "Save" downloads the project as a file. In cloud
  // mode Save means save-to-your-account, so keep the plain label there.
  if (WEB && !CLOUD) { $('btnSaveProj').textContent = 'Save file'; $('btnSaveProj').title = 'Download this project as a .studio.json file'; }
  if (CLOUD) { $('btnSaveProj').title = 'Save to your account — sign in with GitHub if you haven\'t'; }
  $('libClose').onclick = closeLibrary;
  $('libOverlay').addEventListener('click', function (e) { if (e.target === this) closeLibrary(); });
  // cloud search runs server-side, so re-query (debounced) instead of just
  // re-filtering the page already in hand.
  var libSearchTimer = null;
  $('libSearch').addEventListener('input', function () {
    if (!CLOUD) { renderLibrary(); return; }
    clearTimeout(libSearchTimer);
    libSearchTimer = setTimeout(fetchProjects, 250);
  });
  $('projName').addEventListener('change', function () {
    project.name = (this.value || '').trim() || defaultName(); this.value = project.name;
    // A rename is metadata only — requestRename PATCHes it without re-uploading the
    // whole payload, and falls back to a normal edit when the doc is dirty or the
    // user isn't the author.
    if (CLOUD) { StudioSync.requestRename(project.name); return; }
    scheduleSave();
  });
  $('btnOpenMidi').onclick = function () { $('midiInput').click(); };
  // MIDI import is client-side, so it's wired here (works in both web + desktop;
  // the workflow source-bar drop zone is desktop-only).
  $('midiInput').addEventListener('change', function (e) { if (e.target.files[0]) { openMidiFile(e.target.files[0]); e.target.value = ''; } });
  $('btnExportMidi').onclick = function () {
    var t = project.tracks[project.activeTrackId];
    if (t && t.kind === 'drum') { exportDrumMidi(); return; }
    // Note ticks are on the timeline's tempo, so the file carries that tempo — the
    // exported MIDI still lines up with the song second-for-second.
    var pj = roll.getProject(); pj.tempo = pj.timelineTempo || pj.tempo;
    download(MidiIO.write(pj), (project.name || 'studio') + '.mid', 'audio/midi');
  };
  /* ====================== quantize modal (all instrument types) ====================== */
  (function () {
    var sel = $('qzGrid'); if (!sel) return;
    QuantizeCore.GRIDS.forEach(function (g) {
      var o = document.createElement('option'); o.value = g.value; o.textContent = g.label; sel.appendChild(o);
    });
    sel.value = '16';
  })();
  function qzTriplet() { return QuantizeCore.find($('qzGrid').value).triplet; }
  function qzSyncLabels() {
    $('qzSwingVal').textContent = (+$('qzSwing').value) + '%';
    var trip = qzTriplet();
    $('qzSwing').disabled = trip;
    $('qzSwingRow').style.opacity = trip ? 0.4 : 1;
    $('qzSwingNote').textContent = trip ? 'swing doesn’t apply to a triplet grid'
      : '50% = straight · 66% = triplet shuffle · 75% = hard shuffle';
    var bias = +$('qzBias').value;
    $('qzBiasVal').textContent = bias === 0 ? 'centre' : (bias < 0 ? '◄ ' + (-bias) + '%' : bias + '% ►');
    $('qzStrengthVal').textContent = (+$('qzStrength').value) + '%';
  }
  ['qzSwing', 'qzBias', 'qzStrength'].forEach(function (id) { $(id).addEventListener('input', qzSyncLabels); });
  $('qzGrid').addEventListener('change', qzSyncLabels);

  function openQuantize() {
    var t = project.tracks[project.activeTrackId];
    if (!t) { flash('No track to quantize — add notes first.'); return; }
    if (t.kind === 'drum') { $('qzGrid').value = String(drumRoll.getGridSub()); }
    else { var m = { q: '4', '8': '8', '8t': '8t', '16': '16', '16t': '16t', '32': '32' }; $('qzGrid').value = m[$('gridSel').value] || '16'; }
    $('qzTrackName').textContent = '· ' + (t.name || t.instrument);
    show($('qzLengthsRow'), t.kind !== 'drum');
    qzSyncLabels();
    $('qzOverlay').style.display = '';
  }
  function closeQuantize() { $('qzOverlay').style.display = 'none'; }
  function applyQuantize() {
    var t = project.tracks[project.activeTrackId]; if (!t) { closeQuantize(); return; }
    var gridV = $('qzGrid').value, trip = qzTriplet();
    var o = {
      swing: trip ? 0.5 : (+$('qzSwing').value) / 100,
      bias: (+$('qzBias').value) / 100 * 0.5,           // −100..100% → −0.5..0.5 of a grid step
      strength: (+$('qzStrength').value) / 100
    };
    if (t.kind === 'drum') {
      o.gridSec = QuantizeCore.gridSeconds(gridV, (drumData && drumData.tempo) || 120);
      var n = drumRoll.quantizeAdvanced(o);
      // keep the drum grid-sub (and the read-only sheet, which renders against it) showing
      // the grid we just snapped to — for the straight grids the sub can represent.
      var straightSub = { '4': 4, '8': 8, '16': 16, '32': 32 }[gridV];
      if (straightSub && drumRoll.getGridSub() !== straightSub) {
        drumRoll.setGridSub(straightSub);
        if ($('dGridSub')) $('dGridSub').value = String(straightSub);
      }
      renderDrumSheet();
      flash('Quantized ' + n + ' drum hits.');
    } else {
      o.gridTicks = QuantizeCore.gridTicks(gridV, roll.stats().ppq);
      o.lengths = $('qzLengths').checked;
      var n2 = roll.quantizeAdvanced(o);
      if (TAB_VIEWS[currentView]) TAB_VIEWS[currentView].render();
      flash('Quantized ' + n2 + ' notes.');
    }
    closeQuantize(); scheduleSave();
  }
  $('btnQuantize').onclick = openQuantize;
  $('qzApply').onclick = applyQuantize;
  $('qzCancel').onclick = closeQuantize;
  $('qzClose').onclick = closeQuantize;
  $('qzOverlay').addEventListener('click', function (e) { if (e.target === this) closeQuantize(); });

  $('btnHelp').onclick = function () { showHelp(true); };
  $('helpClose').onclick = function () { showHelp(false); };
  $('helpOverlay').addEventListener('click', function (e) { if (e.target === this) showHelp(false); });
  function showHelp(on) { $('helpOverlay').style.display = on ? '' : 'none'; }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if ($('qzOverlay').style.display !== 'none') $('qzOverlay').style.display = 'none';
    else if ($('libOverlay').style.display !== 'none') closeLibrary();
    else if ($('helpOverlay').style.display !== 'none') showHelp(false);
  });

  $('targetSel').addEventListener('change', applyTarget);
  $('ftChk').addEventListener('change', function () { });
  // Load the pasted link immediately when there is no local audio (web + cloud). In
  // cloud mode YouTube is the ONLY playback source, so without this the Song source
  // stays dead until reload and none of youtube.js's failure reporting can fire.
  $('ytUrl').addEventListener('change', function () {
    project.youtubeUrl = (this.value || '').trim();
    if (WEB) setSongYouTube(project.youtubeUrl);
    scheduleSave();
  });

  // youtube offset — one project-level sync delay for the YouTube "Song" audio,
  // shown next to the bar "offset" in every melodic tab toolbar. All three inputs
  // mirror project.youtubeOffset; the transport applies it to YouTube playback.
  var YT_OFFSET_INPUTS = ['btYtOffset', 'gtYtOffset', 'gcYtOffset'];
  function applyYoutubeOffset() {
    var v = project.youtubeOffset || 0;
    YT_OFFSET_INPUTS.forEach(function (id) { var el = $(id); if (el) el.value = v; });
    Transport.setYoutubeOffset(v);
  }
  YT_OFFSET_INPUTS.forEach(function (id) {
    var el = $(id); if (!el) return;
    el.addEventListener('change', function () {
      project.youtubeOffset = Math.round((+this.value || 0) * 1000) / 1000;
      applyYoutubeOffset(); scheduleSave();
    });
  });
  function applyTarget() {
    var T = TARGETS[$('targetSel').value] || TARGETS.bass;
    roll.setGuides({ markers: T.markers || {}, centerPitch: T.center || 48 });
    EditorPlayer.setInstrument(T.instrument || 'bass');
    $('btnSongToBass').textContent = T.kind === 'drum' ? '▶ Song → Drums' : '▶ Song → ' + T.label + ' MIDI';
    $('btnSeparate').textContent = 'Separate ' + T.label.toLowerCase();
    var tag = $('stemTag'); if (tag) tag.textContent = 'isolated ' + T.label.toLowerCase();
    $('ftChk').disabled = (T.model === 'htdemucs_6s'); $('ftWrap').style.opacity = $('ftChk').disabled ? 0.45 : 1;
  }

  /* ---- helpers ---- */
  function updateStats() { var s = roll.stats(); $('noteCount').textContent = s.notes + (s.notes === 1 ? ' note' : ' notes'); }
  function download(bytes, name, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/octet-stream' }), url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // Open a clean black-and-white copy of a fretted tab (bass/guitar) in a new
  // window and invoke the browser's print dialog — the user prints it or picks
  // "Save as PDF". No difficulty colours, no fingering; everything is vector SVG,
  // so the PDF stays crisp at any scale. Each system is scaled to the page width
  // at one uniform units→page ratio (the last, shorter line stays proportionally
  // narrower) and never splits across a page.
  function printFrettedTab(view, label) {
    var p = view.getPrintable && view.getPrintable();
    if (!p) { flash('No tab yet — nothing to print.'); return; }
    var title = project.name || label || 'Tab';
    // split the rendered systems, give each a proportional width so bars keep a
    // constant size across lines (viewBox + CSS width:100% keeps them vector-crisp).
    var parts = p.systemsHtml.match(/<svg[\s\S]*?<\/svg>/g) || [];
    var maxW = 1;
    parts.forEach(function (s) { var m = s.match(/data-w="([\d.]+)"/); if (m) maxW = Math.max(maxW, +m[1]); });
    var systems = parts.map(function (s) {
      var m = s.match(/data-w="([\d.]+)"/), w = m ? +m[1] : maxW;
      return '<div class="sys" style="width:' + (w / maxW * 100).toFixed(3) + '%">' + s + '</div>';
    }).join('');
    var ts = p.timeSig || { num: 4, den: 4 };
    var sub = ['Tuning ' + p.tuning, p.tempo + ' BPM', ts.num + '/' + ts.den];
    if (p.ergo) sub.push('frets ' + p.ergo.minFret + '-' + p.ergo.maxFret);
    var doc =
      '<!doctype html><html><head><meta charset="utf-8"><title>' + escHtml(title) + '</title><style>' +
      '@page{margin:0}' +
      'html,body{background:#fff;margin:0}' +
      'body{color:#000;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
        'padding:14mm 12mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.head{margin:0 0 12px;border-bottom:1px solid #ddd;padding-bottom:8px}' +
      '.head h1{font-size:19px;margin:0 0 3px;font-weight:700;color:#000}' +
      '.head .sub{font-size:12px;color:#444}.head .sub b{color:#000;font-weight:600}' +
      '.sys{break-inside:avoid;page-break-inside:avoid;margin:0 0 7px}' +
      '.sys svg{display:block;width:100%;height:auto}' +
      '.foot{margin-top:12px;font-size:10px;color:#999}' +
      '</style></head><body>' +
      '<div class="head"><h1>' + escHtml(title) + '</h1>' +
      '<div class="sub"><b>' + escHtml(label) + '</b> &nbsp;·&nbsp; ' + sub.map(escHtml).join(' &nbsp;·&nbsp; ') + '</div>' +
      '</div>' +
      '<div class="sheet">' + systems + '</div>' +
      '<div class="foot">Made with Band Tab Studio</div>' +
      '</body></html>';
    var w = window.open('', '_blank');
    if (!w) { flash('Allow pop-ups to print/save the tab as PDF.'); return; }
    w.document.open(); w.document.write(doc); w.document.close(); w.focus();
    // inline SVG lays out synchronously; a short beat lets the window paint first.
    setTimeout(function () { try { w.print(); } catch (e) {} }, 250);
  }

  window.addEventListener('beforeunload', function (e) { if (dirty && !suppressUnload) { e.preventDefault(); e.returnValue = ''; } });

  /* ---- init ---- */
  if (WEB) document.body.classList.add('mode-web');       // CSS hides .desktop-only
  if (CLOUD) document.body.classList.add('mode-cloud');   // CSS shows the cloud-only bits
  roll.setGridTicks(gridTicks());
  setToolUI('select'); dToolUI('select');
  applyTarget(); updateViewAvailability('bass');
  updateStats(); refreshSrcButtons(); renderTracks();
  setView('pianoroll');

  /* ---- cloud boot ----------------------------------------------------------
   * Everything in sync.js is inert until init() runs, so this chain is what makes
   * the whole cloud product exist. resume() MUST run before the library first
   * renders: it owns the ?resume=<draftKey> return from the OAuth round trip (the
   * page navigated away to GitHub and came back — this is where the user's
   * in-progress edit is reclaimed) as well as ?p=<projectId> deep links.
   * init() is synchronous and returns undefined; resume() returns a promise.
   * ------------------------------------------------------------------------ */
  if (CLOUD) {
    StudioStore.ready().then(function () {
      StudioSync.init({
        serializeMeta:   serializeMeta,
        serializeActive: serializeActive,
        loadProjectMeta: loadProjectMeta,
        setProjectId:    function (id) { project.id = id; },
        getProjectId:    function () { return project.id; },
        getName:         function () { return ($('projName').value || '').trim() || project.name; },
        setName:         function (n) { project.name = n; $('projName').value = n; },
        markSave:        markSave,
        flash:           flash,
        setDirty:        function (b) { dirty = !!b; },
        onState:         renderAuthUI,
        suppressUnload:  function (b) { suppressUnload = !!b; }
      });
      renderAuthUI();
      return StudioSync.resume();
    }).then(function () { renderAuthUI(); }, function (e) {
      flash('Cloud sync unavailable: ' + (e && e.message ? e.message : 'unknown error'));
    });
  }

  // debug/automation handle
  window.Studio = {
    roll: roll, bassTab: bassTab, guitarTab: guitarTab, guitarChords: guitarChords, drumRoll: drumRoll, transport: Transport,
    getProject: function () { return project; }, activateTrack: activateTrack,
    newProject: newProject, saveProject: saveProject, openProject: openProject,
    onSong: onSong, onStem: onStem, onMelodicResult: onMelodicResult, onDrumResult: onDrumResult,
    setView: setView, curTarget: curTarget
  };
})();
