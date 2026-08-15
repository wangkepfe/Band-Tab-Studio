/* ============================================================================
 * youtube.js — a YouTube IFrame player wrapped to look like the transport's
 * other sources (play/pause/stop/seek/currentTime/duration/isPlaying), so the
 * tab playhead can sync to a YouTube video. Used as the "Song" source in the web
 * app, where there's no downloaded audio to play.
 *
 *   YouTubePlayer.mount(divId)            create the player div host
 *   YouTubePlayer.load(url) -> bool       cue a video (returns false if no id)
 *   YouTubePlayer.hasVideo() / isReady()
 *   YouTubePlayer.play()/pause()/stop()/seek(sec)
 *   YouTubePlayer.currentTime()/duration()/isPlaying()
 *   YouTubePlayer.title()
 *   YouTubePlayer.setOnFail(fn)           fn(message, code) — fatal, human text
 *   YouTubePlayer.setOnState(fn)          fn(playing) — the PLAYER changed state
 *   YouTubePlayer.lastError()             last failure message, '' if none
 *
 * iPad / iOS. Two things behave differently there and both used to read as "the
 * app is broken", because neither has any equivalent on a desktop browser:
 *
 *   1. SCRIPTED PLAYBACK IS REFUSED. playVideo() is a postMessage into a
 *      cross-origin iframe, and Safari does not carry the page's user gesture
 *      across that boundary — so the tap on the transport's ▶ is not a gesture
 *      inside the player, and iOS blocks a play() with audio. Desktop Chrome's
 *      autoplay policy waves the same call through, which is exactly why this
 *      only ever showed up on the iPad. The one thing that DOES work is a tap on
 *      the YouTube player itself; that unlocks the media element for the rest of
 *      the session, after which the transport drives it normally. So: report the
 *      block the moment it happens (onAutoplayBlocked), and hand playback the
 *      player starts on its own back to the transport via setOnState() — without
 *      that the video plays and the tab just sits there.
 *
 *   2. THE CLOCK STALLS. See the position-clock block further down.
 *
 * FAILURE HANDLING. In the cloud/web build YouTube is the ONLY playback source —
 * no audio is hosted — so a video that refuses to play is a dead app, not a
 * degraded one. Every failure used to present identically: hasVideo() stayed
 * true so the Song button stayed enabled, isPlaying() kept returning the
 * optimistic flag, and currentTime()/duration() both stayed 0, so transport.js's
 * completion test was false forever — the rAF loop spun, the button showed the
 * pause glyph, the clock sat at 0:00, and nothing was said to the user.
 *
 *   video deleted / private   -> onError 100
 *   embedding disabled        -> onError 101 / 150
 *   region-blocked            -> onError 150 (occasionally 101)
 *   malformed / stale link    -> onError 2, or extractId() finding no id
 *   this site not identified
 *   as the embedder           -> onError 153 (no Referer reached youtube.com),
 *                                152 (identity refused), 151 (rights-holder
 *                                block). None of the three are in Google's
 *                                published list, so they used to arrive as a
 *                                sentence with no number in it and nothing to
 *                                look up — which is exactly how an iPad
 *                                reported one and cost a day. They come off the
 *                                embed player's own table, which is TOTAL:
 *                                  l2 = function (c) { return c ? T[c] || 5 : 5 }
 *                                so the ONLY values it can ever send are
 *                                2 / 5 / 150 / 151 / 152 / 153 — everything it
 *                                doesn't recognise collapses to 5. A code with
 *                                no sentence below is therefore a NEW code, not
 *                                a stale one, which is why reason() always
 *                                prints the number.
 *   youtube.com unreachable   -> the iframe_api <script> fires onerror; if the
 *                                request hangs instead of erroring (proxy black
 *                                hole, captive portal), or the player is built
 *                                but never reaches onReady, the ready watchdog
 *                                armed by load() fires instead
 *
 * fail() is the single funnel for all of them. It CLEARS videoId, which is what
 * lets the rest of the app notice: hasVideo() goes false, so
 * Transport.sourceAvailable('original') flips, so the Song button disables on
 * the next refreshSrcButtons() — and it hands one human sentence to the
 * setOnFail() callback (app.js wires flash()).
 * ========================================================================== */
var YouTubePlayer = (function () {
  'use strict';
  var player = null, ready = false, host = null;
  var apiLoading = false, apiReady = false;
  var videoId = null, stPlaying = false, wantPlay = false;
  var pendingSeek = 0;                 // seek asked for before the player was ready
  var onFail = null, onState = null, lastErr = '';
  var readyTimer = 0, startTimer = 0;

  // How long to wait for the iframe handshake before calling YouTube dead, and
  // how long after playVideo() before accepting that playback never started.
  var READY_TIMEOUT_MS = 15000, START_TIMEOUT_MS = 6000;

  // The IFrame API's onError codes, in words a musician can act on.
  var REASONS = {
    2:   'That YouTube link isn’t a valid video.',
    5:   'This browser can’t play that YouTube video.',
    100: 'That YouTube video is gone — deleted or private.',
    101: 'That video’s owner doesn’t allow it to play outside YouTube.',
    150: 'That video can’t play here — embedding is blocked, or it isn’t available in this region.',
    // Undocumented by Google, but shipping — see the embedder note in the header.
    151: 'A rights holder has blocked that video from playing outside YouTube.',
    152: 'YouTube wouldn’t accept this site as the embedder of that video.',
    153: 'YouTube couldn’t tell which site is embedding the video — this browser sent no referrer.'
  };

  // The sentence for a player error, ALWAYS carrying the number. An iPad has no
  // console without a tethered Mac and the toast is gone in three seconds, so a
  // failure the user can only relay as "it said it can't be played here" is one
  // nobody can act on — and by the table above, a code with no sentence is a
  // code nobody has seen before, which is precisely the one worth knowing. One
  // parenthesis is the whole price.
  function reason(code) {
    return (REASONS[code] || 'That YouTube video can’t be played here.') + ' (code ' + code + ')';
  }

  function extractId(url) {
    if (!url) return null;
    var m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/v\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{11}$/.test(url) ? url : null;
  }

  /* ---- position clock -------------------------------------------------------
   * getCurrentTime() is NOT a live read of the video. The widget API keeps a
   * cached playerInfo that the iframe pushes over postMessage, and returns
   *
   *     playerInfo.currentTime + min(secondsSinceThatMessage, 1) * playbackRate
   *
   * adding that second term only while the CACHED playerState is exactly
   * PLAYING. So the instant those messages are delayed past a second, the
   * reported time FLAT-LINES — and then jumps when the next one lands. Safari
   * throttles timers in cross-origin frames far harder than desktop Chrome does,
   * so reading it straight into the transport looks perfect on a PC and
   * drags-then-lurches on an iPad: the playhead trailing the audio and catching
   * up in steps is the whole "not synced" complaint.
   *
   * The fix is to treat every CHANGED reading as an anchor and run the clock
   * locally in between. Every fresh reading re-anchors, so this cannot drift away
   * from the video — it only fills in the gaps YouTube leaves. While the player
   * is reporting normally (the desktop case) the output is the raw reading,
   * unchanged.
   */
  var anchorPos = 0, anchorWall = 0;   // (position, wall clock) the local clock runs from
  var lastRaw = -1;                    // last reading the player handed us
  var lastOut = -1;                    // last position we handed the transport
  var seekWait = false;                // ignore stale readings until a seek lands
  var ytState = -1;                    // last onStateChange — pushed, never polled
  var rate = 1;                        // last onPlaybackRateChange
  var SEEK_SETTLE = 0.6;               // a reading this close to the target means the seek landed
  var SEEK_GRACE_MS = 1500;            // …or stop waiting for it and believe the player again
  var BACKSTEP_HOLD = 0.35;            // hide sub-frame backwards jitter, never a real seek
  var MAX_COAST_MS = 5000;             // longest the local clock runs unconfirmed

  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function rawTime() { try { return (isReady() && player.getCurrentTime()) || 0; } catch (e) { return 0; } }
  function anchor(sec, t) { anchorPos = Math.max(0, sec); anchorWall = t; }
  function resetClock(sec) { anchor(sec || 0, nowMs()); lastRaw = -1; lastOut = -1; seekWait = false; }
  // Only dead-reckon while the player has TOLD us it is playing. ytState comes
  // from onStateChange, which is pushed on transition — unlike playerInfo's
  // cached copy, it can't be silently stale, so a buffering video never has the
  // playhead running away from it.
  function predict(t) {
    if (ytState !== 1) return anchorPos;
    // Bound the coast. Past MAX_COAST_MS the player's silence isn't throttling,
    // it's the page having been suspended (backgrounded tab, sleeping iPad) with
    // rAF stopped — and running the clock through that would put the playhead
    // minutes into a video that never moved. Hold, and let the next real reading
    // re-anchor (which currentTime() does before it calls this).
    return anchorPos + Math.min(Math.max(0, t - anchorWall), MAX_COAST_MS) / 1000 * (rate || 1);
  }

  function clearStart() { if (startTimer) { clearTimeout(startTimer); startTimer = 0; } }
  function clearTimers() { if (readyTimer) { clearTimeout(readyTimer); readyTimer = 0; } clearStart(); }
  // setOnFail() is the ONE reporting channel. The console line is a breadcrumb
  // for the case where nobody wired it — a dead playback source must never be
  // completely invisible, not even to a developer with the console open.
  function report(msg, code) {
    lastErr = msg;
    if (typeof onFail === 'function') { try { onFail(msg, code); } catch (e) {} }
    else if (window.console && console.warn) console.warn('[youtube] ' + msg + ' (' + code + ') — no setOnFail handler is wired');
  }
  // The PLAYER changed state on its own — the user pressed ▶/⏸ inside the video
  // rather than on the transport. Transport.init() subscribes and adopts it, so
  // the tab follows. On iPad this is not an edge case: a tap on the player is the
  // only way playback ever starts (see the header note), so without this the
  // video plays and the playhead never moves.
  function emitState(playing) { if (typeof onState === 'function') { try { onState(playing); } catch (e) {} } }

  // The ready watchdog spans the WHOLE path from load() to onReady: the API
  // script download, the YT.Player construction and the iframe handshake. It
  // used to be armed only after the API had loaded, which left the worst
  // version of "youtube.com unreachable" silent forever — a request that hangs
  // rather than erroring fires no onerror, reaches no onReady and armed no
  // timer, so hasVideo() stayed true and the Song button stayed enabled on a
  // player that was never going to speak again.
  function armReady() {
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = setTimeout(function () {
      readyTimer = 0;
      if (!isReady()) fail('YouTube isn’t responding — the video couldn’t be loaded.', 'timeout');
    }, READY_TIMEOUT_MS);
  }

  // The one funnel for every FATAL failure. Dropping videoId is the load-bearing
  // part: it's what makes hasVideo() false, which disables the Song source.
  function fail(msg, code) {
    clearTimers();
    videoId = null; wantPlay = false; stPlaying = false; pendingSeek = 0;
    report(msg, code);
  }

  // The browser refused a SCRIPTED play() — nothing is wrong with the video, so
  // this is not a fail(): videoId survives and the Song source stays selectable.
  // Drop only the optimistic playing flag so the transport's completion test
  // fires on the very next frame instead of showing a pause glyph over a video
  // that isn't moving.
  //
  // This is the iPad's normal path, and the message is the recipe out of it: one
  // tap inside the player unlocks the media element for the session, and from
  // then on the transport's play/pause/seek all work. onAutoplayBlocked is the
  // documented signal for exactly this; the 6 s stalled() watchdog below stays as
  // the fallback for player builds that don't emit it.
  function blocked() {
    clearStart();
    wantPlay = false; stPlaying = false;
    report('Safari blocked playback — tap ▶ on the video itself once. The tab follows it, and the transport works from then on.', 'autoplay-blocked');
  }

  // Softer than fail(): the video itself is fine, playback just never started —
  // the classic autoplay-policy refusal when playVideo() lands outside a user
  // gesture. Drop only the optimistic playing flag, so the transport's
  // completion test fires on the next frame instead of spinning forever.
  function stalled() {
    startTimer = 0;
    if (!stPlaying) return;
    var st = -1;
    try { st = (player && player.getPlayerState) ? player.getPlayerState() : -1; } catch (e) {}
    // -1 UNSTARTED / 5 CUED mean the play request was refused outright. 3
    // BUFFERING is just a slow network, which is not a failure — leave it be.
    if (st !== -1 && st !== 5) return;
    stPlaying = false; wantPlay = false;
    report('YouTube didn’t start — tap ▶ on the video itself once, then use the transport.', 'not-started');
  }

  function loadApi(cb) {
    if (apiReady || (window.YT && window.YT.Player)) { apiReady = true; cb(); return; }
    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () { apiReady = true; if (typeof prev === 'function') prev(); cb(); };
    if (apiLoading) return;
    apiLoading = true;
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    // youtube.com blocked by a network/extension, or simply offline. Without
    // this the player is never constructed, onReady never fires, and nothing
    // ever tells anyone — the Song button just stays enabled and dead.
    // apiLoading is released so a later load() gets a genuine retry.
    s.onerror = function () {
      apiLoading = false;
      fail('Couldn’t reach YouTube — check your connection or a blocker extension.', 'api-blocked');
    };
    document.head.appendChild(s);
  }

  function mount(divId) { host = divId; }

  function ensurePlayer(id) {
    loadApi(function () {
      // A callback queued behind a failed/slow API load can arrive long after
      // the user moved on — ignore it if the wanted video has changed since.
      if (id !== videoId) return;
      // load() armed the ready watchdog before we got here and nothing below
      // disarms it except onReady or fail(), so every exit from this function is
      // still covered by it.
      if (player) {
        try { player.cueVideoById(id); }
        catch (e) { fail('YouTube isn’t responding — the video couldn’t be loaded.', 'cue-failed'); }
        return;
      }
      if (!host) { fail('The YouTube player has nowhere to live on this page.', 'no-host'); return; }
      try {
        player = new YT.Player(host, {
          width: '100%', height: '100%', videoId: id,
          playerVars: { controls: 1, rel: 0, modestbranding: 1, playsinline: 1, fs: 1 },
          events: {
            onReady: function () {
              ready = true;
              if (readyTimer) { clearTimeout(readyTimer); readyTimer = 0; }
              try { rate = player.getPlaybackRate() || 1; } catch (e) { rate = 1; }
              resetClock(0);
              // Replay a seek the user made while the player was still building,
              // so the video doesn't silently start from 0 after the wait.
              if (pendingSeek > 0) { seek(pendingSeek); pendingSeek = 0; }
              if (wantPlay) { stPlaying = true; try { player.playVideo(); } catch (e) {} armStart(); }
            },
            onStateChange: function (e) {
              var S = YT.PlayerState;
              ytState = e.data;
              // Force the next currentTime() to re-anchor: whatever the local
              // clock was extrapolating stopped being true at this transition.
              lastRaw = -1;
              if (e.data === S.PLAYING) { stPlaying = true; clearStart(); emitState(true); }
              else if (e.data === S.PAUSED || e.data === S.ENDED) { stPlaying = false; clearStart(); emitState(false); }
              // BUFFERING / CUED / UNSTARTED are deliberately NOT reported: a
              // transport that stopped on every buffering gap would be worse than
              // one that waits it out.
            },
            // Playback rate is a learning tool (half-speed for a fast line), and
            // the local clock has to walk at the same rate or it outruns the audio.
            onPlaybackRateChange: function (e) {
              anchor(rawTime(), nowMs());
              rate = (e && +e.data) || 1;
              lastRaw = -1;
            },
            // The browser refused a scripted play (the iPad's normal answer to
            // playVideo(); see the header note). Dispatch is by event name, so
            // registering this is safe on player builds that never send it.
            onAutoplayBlocked: function () { blocked(); },
            // Deleted, private, region-blocked, embed-disabled, bad id, and the
            // embedder-identity family: all of them land here, and all of them
            // used to be invisible.
            onError: function (e) {
              var code = (e && typeof e.data !== 'undefined') ? e.data : null;
              fail(reason(code), code);
            }
          }
        });
      } catch (e) {
        // A half-loaded API or a missing host div throws here; without this the
        // failure would sit unreported until the watchdog expired 15 s later.
        player = null;
        fail('Couldn’t start the YouTube player on this page.', 'construct-failed');
      }
    });
  }

  function armStart() { clearStart(); startTimer = setTimeout(stalled, START_TIMEOUT_MS); }

  function load(url) {
    var id = extractId(url);
    if (!id) { fail('That YouTube link isn’t one Studio recognises.', 'bad-url'); return false; }
    clearTimers();
    videoId = id; wantPlay = false; stPlaying = false; pendingSeek = 0; lastErr = '';
    ytState = -1; resetClock(0);
    if (isReady()) {
      // A live player just re-cues; an unavailable video answers on onError.
      try { player.cueVideoById(id); }
      catch (e) { fail('YouTube isn’t responding — the video couldn’t be loaded.', 'cue-failed'); return false; }
    } else {
      armReady();                               // covers download + build + handshake
      ensurePlayer(id);
    }
    return true;
  }

  function clear() {
    clearTimers();
    videoId = null; wantPlay = false; stPlaying = false; pendingSeek = 0; lastErr = '';
    ytState = -1; resetClock(0);
    if (isReady()) { try { player.stopVideo(); } catch (e) {} }
  }
  function hasVideo() { return !!videoId; }
  function isReady() { return !!(ready && player); }
  // play() keeps setting the optimistic flag before the player is ready (so the
  // transport doesn't finalize during the handshake), which is only safe because
  // readyTimer/startTimer will clear it if the video never actually starts.
  // Transport.play() refuses to get here at all until isReady().
  function play() {
    if (!videoId) return;                       // failed or never loaded — nothing to play
    wantPlay = true; stPlaying = true;
    if (isReady()) { try { player.playVideo(); } catch (e) {} armStart(); }
    // Not ready: the optimistic flag above is only safe while some watchdog is
    // running to clear it. Transport.play() refuses this path outright; this is
    // the belt for any other caller.
    else if (!readyTimer) armReady();
  }
  function pause() { clearStart(); wantPlay = false; stPlaying = false; if (isReady()) { try { player.pauseVideo(); } catch (e) {} } }
  function stop() { clearStart(); wantPlay = false; stPlaying = false; if (isReady()) { try { player.pauseVideo(); } catch (e) {} seek(0); } }
  function seek(sec) {
    sec = Math.max(0, sec);
    if (isReady()) {
      // A seek reaches the cached playerInfo only when the iframe answers, and
      // until then getCurrentTime() still reports where the video USED to be —
      // long enough on a throttled iPad to rubber-band the playhead back to the
      // old spot for a beat. Believe the requested position until a reading
      // agrees with it (or the grace window runs out).
      resetClock(sec); seekWait = true;
      try { player.seekTo(sec, true); } catch (e) {}
    }
    else if (videoId) pendingSeek = sec;        // replayed from onReady
  }
  function currentTime() {
    if (!isReady()) return 0;
    var t = nowMs(), raw = rawTime();
    if (seekWait && (Math.abs(raw - predict(t)) < SEEK_SETTLE || t - anchorWall > SEEK_GRACE_MS)) seekWait = false;
    if (raw !== lastRaw) { lastRaw = raw; if (!seekWait) anchor(raw, t); }
    var out = predict(t);
    // Our dead reckoning can land a hair ahead of the player's next report, and a
    // playhead that stutters backwards reads as a bug — hold until the player
    // catches up. A real jump (seek, loop, chapter) is far wider than this window.
    if (ytState === 1 && lastOut >= 0 && out < lastOut && lastOut - out < BACKSTEP_HOLD) out = lastOut;
    lastOut = out;
    return out;
  }
  function duration() { try { return (isReady() && player.getDuration()) || 0; } catch (e) { return 0; } }
  // isPlaying reports INTENT (set on play, cleared on pause/end) so the transport
  // doesn't finalize during the player's BUFFERING gap right after play().
  function isPlaying() { return stPlaying; }
  function title() { try { var d = player && player.getVideoData && player.getVideoData(); return (d && d.title) || ''; } catch (e) { return ''; } }
  // fn(message, code) — code is the YT error number, or 'api-blocked' |
  // 'timeout' | 'bad-url' | 'not-started' | 'autoplay-blocked'. app.js wires
  // flash() + a refreshSrcButtons() so the Song button disables in the same beat.
  // Only the FATAL codes clear the video; 'not-started'/'autoplay-blocked' leave
  // it playable, so a handler must check hasVideo() before disabling anything.
  function setOnFail(fn) { onFail = (typeof fn === 'function') ? fn : null; }
  // fn(playing) — the player started/stopped on its own. ONE slot, and
  // Transport.init() owns it; anything else that needs to know rides the
  // transport's onUpdate instead of stealing the registration.
  function setOnState(fn) { onState = (typeof fn === 'function') ? fn : null; }
  function lastError() { return lastErr; }

  return { mount: mount, load: load, clear: clear, hasVideo: hasVideo, isReady: isReady,
           play: play, pause: pause, stop: stop, seek: seek,
           currentTime: currentTime, duration: duration, isPlaying: isPlaying, title: title,
           setOnFail: setOnFail, setOnState: setOnState, lastError: lastError };
})();
