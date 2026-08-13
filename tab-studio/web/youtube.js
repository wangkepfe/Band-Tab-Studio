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
 *   YouTubePlayer.lastError()             last failure message, '' if none
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
  var onFail = null, lastErr = '';
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
    150: 'That video can’t play here — embedding is blocked, or it isn’t available in this region.'
  };

  function extractId(url) {
    if (!url) return null;
    var m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/v\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{11}$/.test(url) ? url : null;
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
    report('YouTube didn’t start — press play on the video once, then use the transport.', 'not-started');
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
              // Replay a seek the user made while the player was still building,
              // so the video doesn't silently start from 0 after the wait.
              if (pendingSeek > 0) { try { player.seekTo(pendingSeek, true); } catch (e) {} pendingSeek = 0; }
              if (wantPlay) { stPlaying = true; try { player.playVideo(); } catch (e) {} armStart(); }
            },
            onStateChange: function (e) {
              var S = YT.PlayerState;
              if (e.data === S.PLAYING) { stPlaying = true; clearStart(); }
              else if (e.data === S.PAUSED || e.data === S.ENDED) { stPlaying = false; clearStart(); }
            },
            // Deleted, private, region-blocked, embed-disabled, bad id: all five
            // land here, and all five used to be invisible.
            onError: function (e) {
              var code = (e && typeof e.data !== 'undefined') ? e.data : null;
              fail(REASONS[code] || 'That YouTube video can’t be played here.', code);
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
  function stop() { clearStart(); wantPlay = false; stPlaying = false; if (isReady()) { try { player.pauseVideo(); player.seekTo(0, true); } catch (e) {} } }
  function seek(sec) {
    sec = Math.max(0, sec);
    if (isReady()) { try { player.seekTo(sec, true); } catch (e) {} }
    else if (videoId) pendingSeek = sec;        // replayed from onReady
  }
  function currentTime() { try { return (isReady() && player.getCurrentTime()) || 0; } catch (e) { return 0; } }
  function duration() { try { return (isReady() && player.getDuration()) || 0; } catch (e) { return 0; } }
  // isPlaying reports INTENT (set on play, cleared on pause/end) so the transport
  // doesn't finalize during the player's BUFFERING gap right after play().
  function isPlaying() { return stPlaying; }
  function title() { try { var d = player && player.getVideoData && player.getVideoData(); return (d && d.title) || ''; } catch (e) { return ''; } }
  // fn(message, code) — code is the YT error number, or 'api-blocked' |
  // 'timeout' | 'bad-url' | 'not-started'. app.js wires flash() + a
  // refreshSrcButtons() so the Song button disables in the same beat.
  function setOnFail(fn) { onFail = (typeof fn === 'function') ? fn : null; }
  function lastError() { return lastErr; }

  return { mount: mount, load: load, clear: clear, hasVideo: hasVideo, isReady: isReady,
           play: play, pause: pause, stop: stop, seek: seek,
           currentTime: currentTime, duration: duration, isPlaying: isPlaying, title: title,
           setOnFail: setOnFail, lastError: lastError };
})();
