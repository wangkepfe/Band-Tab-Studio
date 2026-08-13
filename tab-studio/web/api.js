/* ============================================================================
 * api.js — the ONE network surface of the cloud build. Every request the browser
 * makes to the Worker goes through here; nothing else in the app calls fetch()
 * against /api. It also owns the payload codec (gzip → base64 and back), so
 * app.js and sync.js only ever see a plain project.json object.
 *
 * INERT unless STUDIO_CONFIG.mode === 'cloud'. In 'web' / 'desktop' builds every
 * network method rejects with code 'not_cloud' and nothing is wired up — the
 * static build's own fetches (app.js) keep working untouched.
 *
 *   Api.me() / signInGithub(cb) / signOut()
 *   Api.listProjects(opts) / getProject(id, o) / getHead(id)
 *   Api.createProject(o) / saveProject(id, o) / forkProject(id, o)
 *   Api.renameProject(id, name, ifMatch) / deleteProject(id) / recordView(id)
 *   Api.encodePayload(meta) / decodePayload(b64, enc) / shaMeta(meta)
 *   Api.listSeedProjects() / getSeedProject(id)    <- the bundled fallback library
 *   Api.cardsToLegacy(cards)                       <- shape renderLibrary() eats
 *
 * Rejections are Errors carrying .status (number), .code (the server's error
 * envelope code) and .body (the parsed envelope), so callers switch on .code.
 * ========================================================================== */
var StudioApi = (function () {
  'use strict';

  var CFG   = window.STUDIO_CONFIG || {};
  var CLOUD = (CFG.mode === 'cloud');
  var BASE  = '/api';                 // same-origin Worker (assets.run_worker_first)

  // MUST match worker/db.js MAX_PAYLOAD_CHARS. If this is the larger of the two, a
  // payload between the values passes the local precheck and dies as a server 413
  // instead of showing the friendly local message.
  var MAX_PAYLOAD_CHARS = 700000;     // the Worker's 413 ceiling; fail here, not there
  var MAX_NAME_CHARS    = 200;
  // fetch(keepalive) bodies share a 64 KB per-origin budget; over that the request
  // is rejected outright, so the pagehide save falls back to a normal fetch.
  var KEEPALIVE_MAX     = 60000;
  var FLAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
  var B64_RE  = /^[A-Za-z0-9+/=]*$/;

  /* ====================== errors ====================== */
  function apiError(status, code, body, msg) {
    var e = new Error(msg || code || ('HTTP ' + status));
    e.status = status | 0; e.code = code || ''; e.body = body || null;
    return e;
  }
  function disabled() { return apiError(0, 'not_cloud', null, 'Cloud API is inert outside mode "cloud".'); }
  function offline(e) { return apiError(0, 'offline', null, (e && e.message) || 'Network unreachable.'); }
  function codeFor(status) {
    return status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden'
      : status === 404 ? 'not_found' : status === 409 ? 'conflict'
      : status === 412 ? 'precondition_failed' : status === 413 ? 'payload_too_large'
      : status === 429 ? 'rate_limited' : status >= 500 ? 'internal' : 'bad_request';
  }

  /* ====================== fetch plumbing ====================== */
  // The SPA fallback answers a MISSING path with index.html and HTTP 200, so a 200
  // alone never proves a route exists (the same trap app.js:670's isHtml() guards).
  // Every response goes through this check, API and static alike.
  function isHtml(r) { return /text\/html/i.test(r.headers.get('content-type') || ''); }

  function readBody(r) {
    return r.text().then(function (t) {
      if (!t) return null;
      try { return JSON.parse(t); } catch (e) { return { _text: t }; }
    }, function () { return null; });
  }
  // Resolves the parsed body on success; rejects with an Error carrying the
  // server's {error:{code,...}} envelope on anything else.
  function ok(r) {
    if (r.ok && !isHtml(r)) return readBody(r).then(function (b) { return { r: r, body: b }; });
    return readBody(r).then(function (b) {
      if (r.ok) throw apiError(r.status, 'bad_response', b, 'Server returned a page, not JSON — is the Worker deployed?');
      var env = (b && b.error) || {};
      throw apiError(r.status, env.code || codeFor(r.status), env, env.message || ('Request failed (' + r.status + ')'));
    });
  }
  function req(path, init) {
    if (!CLOUD) return Promise.reject(disabled());
    init = init || {};
    init.credentials = 'same-origin';       // always, on every call
    return fetch(BASE + path, init).then(ok, function (e) { throw offline(e); });
  }
  function jsonOf(res) { return res.body; }

  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function pct(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function nowSec() { return Math.floor(Date.now() / 1000); }
  function isFlatId(id) { return typeof id === 'string' && FLAT_ID.test(id); }
  function clampName(n) {
    n = String(n == null ? '' : n).trim() || 'Untitled';
    return n.length > MAX_NAME_CHARS ? n.slice(0, MAX_NAME_CHARS) : n;
  }
  /* ====================== ETags ======================
   * ETags are OPAQUE. worker/routes.js:174 etagFor() emits "<version>" for a
   * read-only viewer and "<version>+w" for one who may edit (so signing in can
   * never be answered with a 304 that keeps a stale canEdit:false), and
   * etagMatches() is an EXACT string compare. Echoing a bare quoted number in
   * If-None-Match therefore never matches for an author or an admin — the users
   * who re-open projects most — and they re-download the whole payload every time.
   * So: remember the exact string the server sent, per project, and echo THAT.
   * If-Match is different and stays numeric: the server parses it with a \d regex
   * and compares it to projects.version.
   */
  var etagSeen = {};                  // projectId -> the last ETag string seen
  var ETAG_CACHE_MAX = 200;           // a long browsing session must not grow forever
  function etagVersion(r) {
    var t = r.headers.get('ETag') || '';
    var m = t.match(/"?(\d+)"?/);
    return m ? +m[1] : null;
  }
  function rememberEtag(id, r) {
    var t = (r && r.headers && r.headers.get('ETag')) || '';
    if (!id || !t) return t;
    if (etagSeen[id] === undefined && countKeys(etagSeen) >= ETAG_CACHE_MAX) etagSeen = {};
    etagSeen[id] = t;
    return t;
  }
  function countKeys(o) { var n = 0, k; for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) n++; } return n; }
  // Accepts either the opaque tag the caller kept, or the plain version number it
  // holds. A remembered tag is used ONLY when its version matches the caller's, so
  // this can never manufacture a 304 for bytes the caller does not actually have.
  function ifNoneMatchFor(id, want) {
    var s = String(want == null ? '' : want).trim();
    if (!s) return '';
    if (s.charAt(0) === '"' || s.indexOf('W/') === 0) return s;   // already opaque
    var known = etagSeen[id] || '';
    var m = known.match(/(\d+)/);
    if (known && m && m[1] === s.replace(/^"|"$/g, '')) return known;
    return '"' + s + '"';
  }
  // If-Match is the numeric version and nothing else. Tolerates being handed an
  // opaque tag ("7+w") so a caller mixing the two cannot send a header the server
  // would parse as a different version.
  function ifMatchFor(v) {
    var m = String(v == null ? '' : v).match(/\d+/);
    return m ? '"' + m[0] + '"' : null;
  }

  /* ====================== payload codec ====================== */
  // base64 in 32 KB slices: String.fromCharCode.apply blows the argument limit
  // somewhere north of ~100 K arguments, and a big drum project gets there.
  function b64FromBytes(bytes) {
    var CHUNK = 0x8000, parts = [], i;
    for (i = 0; i < bytes.length; i += CHUNK) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    return btoa(parts.join(''));
  }
  function bytesFromB64(b64) {
    var bin = atob(String(b64 || '')), out = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function h8(n) { return ('0000000' + ((n >>> 0).toString(16))).slice(-8); }
  // The no-SubtleCrypto fallback. crypto.subtle is UNDEFINED outside a secure
  // context (plain http://, file://) and release-web.bat documents dropping dist/
  // on arbitrary static hosts, so this path is reachable. Returning '' there kills
  // sync.js's no-op brake (`sha && sha === lastSyncedSha`), which is the ONE thing
  // keeping an idle tab at zero rows written — so hash it cheaply instead.
  // The digest is advisory at both ends (sync.js's local comparison, and the
  // server's payload_sha, which schemaNotes calls a cache hint and never a trust
  // boundary). 32 lowercase hex chars: legal for X-Studio-Sha (/^[0-9a-f]{1,64}$/)
  // and, at half a SHA-256's length, never confusable with one.
  // Shift-add FNV-1a rather than Math.imul: every intermediate stays inside int32.
  function weakHex(bytes) {
    var a = 0x811c9dc5, b = 0x9e3779b9, i, v;
    for (i = 0; i < bytes.length; i++) {
      v = bytes[i];
      a = (a ^ v) >>> 0;
      a = (a + ((a << 1) + (a << 4) + (a << 7) + (a << 8) + (a << 24))) >>> 0;
      b = (b + v) >>> 0;
      b = ((b << 13) | (b >>> 19)) >>> 0;
      b = (b ^ (b >>> 7)) >>> 0;
    }
    return h8(a) + h8(b) + h8(bytes.length) + h8(a ^ b);
  }
  function sha256Hex(bytes) {
    var subtle = null;
    try { subtle = window.crypto && window.crypto.subtle; } catch (e) { subtle = null; }
    if (!subtle) return Promise.resolve(weakHex(bytes));
    return subtle.digest('SHA-256', bytes).then(function (buf) {
      var v = new Uint8Array(buf), s = '', i;
      for (i = 0; i < v.length; i++) s += (v[i] < 16 ? '0' : '') + v[i].toString(16);
      return s;
    }, function () { return weakHex(bytes); });
  }

  // gzip, COLLECTED INTO ONE BUFFER. We deliberately do not hand the
  // CompressionStream's ReadableStream to fetch as a body: a streamed request
  // needs duplex:'half' (Chromium-only) and carries no Content-Length, which
  // would leave the Worker unable to enforce its size cap before reading.
  function gzipBytes(bytes) {
    if (typeof CompressionStream !== 'function') return Promise.resolve({ bytes: bytes, encoding: 'identity+b64' });
    var cs;
    try { cs = new CompressionStream('gzip'); } catch (e) { return Promise.resolve({ bytes: bytes, encoding: 'identity+b64' }); }
    try {
      var w = cs.writable.getWriter();
      w.write(bytes).catch(function () {}); w.close().catch(function () {});
    } catch (e) { return Promise.resolve({ bytes: bytes, encoding: 'identity+b64' }); }
    return new Response(cs.readable).arrayBuffer().then(function (buf) {
      return { bytes: new Uint8Array(buf), encoding: 'gzip+b64' };
    }, function () {
      // Safari < 16.4 and anything that trips on the stream: ship the raw JSON
      // base64'd. ~1.33x the bytes instead of ~0.16x, still far under the caps —
      // the `encoding` column exists for exactly this.
      return { bytes: bytes, encoding: 'identity+b64' };
    });
  }
  function gunzipBytes(bytes) {
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(apiError(0, 'no_gunzip', null, 'This browser cannot read compressed projects.'));
    }
    var ds = new DecompressionStream('gzip');
    var w = ds.writable.getWriter();
    w.write(bytes).catch(function () {}); w.close().catch(function () {});
    return new Response(ds.readable).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  // meta object -> what the write routes need. bytes = the PRE-base64 byte count,
  // sha = sha256 of the PRE-gzip UTF-8 JSON (both per the schema's conventions).
  function encodePayload(meta) {
    var json;
    if (!meta || typeof meta !== 'object') return Promise.reject(apiError(0, 'bad_document', null, 'No project document to save.'));
    try { json = JSON.stringify(meta); } catch (e) { return Promise.reject(apiError(0, 'bad_document', null, 'Project could not be serialized.')); }
    var raw = new TextEncoder().encode(json);
    return sha256Hex(raw).then(function (sha) {
      return gzipBytes(raw).then(function (g) {
        var b64 = b64FromBytes(g.bytes);
        if (b64.length > MAX_PAYLOAD_CHARS) throw apiError(413, 'payload_too_large', null, 'This project is too large to save to the cloud.');
        return { payloadB64: b64, bytes: g.bytes.length, sha: sha, encoding: g.encoding };
      });
    });
  }
  function decodePayload(b64, encoding) {
    if (!B64_RE.test(String(b64 || ''))) return Promise.reject(apiError(0, 'bad_payload', null, 'Server sent a payload that is not base64.'));
    var bytes;
    try { bytes = bytesFromB64(b64); } catch (e) { return Promise.reject(apiError(0, 'bad_payload', null, 'Could not decode the project payload.')); }
    var p = (encoding === 'identity+b64') ? Promise.resolve(bytes) : gunzipBytes(bytes);
    return p.then(function (out) { return JSON.parse(new TextDecoder().decode(out)); });
  }
  // The no-op brake's cheap half: the sha alone, WITHOUT paying for the gzip.
  // sync.js compares this against the last synced sha and skips the PUT on a match,
  // which is what keeps an idle tab at zero rows written.
  function shaMeta(meta) {
    var json;
    try { json = JSON.stringify(meta); } catch (e) { return Promise.resolve(''); }
    return sha256Hex(new TextEncoder().encode(json));
  }

  /* ====================== denormalized card fields ====================== */
  // The list route never parses the payload, so the client declares every field a
  // library card shows. Derived in ONE place so create / save / fork agree.
  function metaFacts(meta) {
    var tracks = (meta && meta.tracks) || [];
    var seen = {}, insts = [];
    tracks.forEach(function (t) {
      var id = (t && t.instrument) || '';
      if (id && !seen[id]) { seen[id] = 1; insts.push(id); }
    });
    return {
      youtubeUrl: (meta && meta.youtubeUrl) || '',
      hasSong: (meta && meta.song) ? 1 : 0,
      trackCount: tracks.length,
      instruments: insts.join(',')
    };
  }
  function writeHeaders(o) {
    var f = o.facts || { youtubeUrl: '', hasSong: 0, trackCount: 0, instruments: '' };
    var h = {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Studio-Client': '1',                          // CSRF guard, every mutation
      'X-Studio-Encoding': o.encoding || 'gzip+b64',
      'X-Studio-Bytes': String(o.bytes || 0),
      'X-Studio-Sha': o.sha || '',
      'X-Studio-Youtube': pct(f.youtubeUrl || ''),
      'X-Studio-Has-Song': f.hasSong ? '1' : '0',
      'X-Studio-Track-Count': String(f.trackCount || 0),
      'X-Studio-Instruments': f.instruments || ''
    };
    // X-Studio-Name is OMITTED when the caller names nothing, so the SERVER's own
    // default applies: forkRoute (routes.js:777) does `m.name || copyName(src.name)`
    // => "<source> (copy)". Sending clampName(undefined) === 'Untitled' stole that
    // fallback and stored every server-side fork as "Untitled". The two routes that
    // demand a name (create, save — readMeta requireName:true) always pass one.
    var nm = (o.name == null) ? '' : String(o.name).trim();
    if (nm) h['X-Studio-Name'] = pct(clampName(nm));
    if (o.idempotencyKey) h['Idempotency-Key'] = o.idempotencyKey;
    if (o.ifMatch != null && o.ifMatch !== '') {
      var im = ifMatchFor(o.ifMatch);
      if (im) h['If-Match'] = im;
    }
    if (o.forkSource) h['X-Studio-Fork-Source'] = o.forkSource;
    // No X-Studio-Id here on purpose: POST /api/admin/import is the only route that
    // accepts a caller-chosen id, it is admin-only, and it is driven by
    // tools/seed-d1.js from Node — never from this browser client.
    return h;
  }
  // The body is the raw base64 and nothing else — no JSON envelope, so the Worker
  // never parses a request that carries the payload. A Blob (not a stream) so the
  // request has a Content-Length the Worker can check before reading it.
  function payloadBody(b64) { return new Blob([b64], { type: 'text/plain; charset=utf-8' }); }

  /* ====================== auth ====================== */
  function me() {
    if (!CLOUD) return Promise.resolve({ user: null });
    // Never rejects: the whole app has to boot whether or not there is a session.
    return req('/me', { method: 'GET', cache: 'no-store' })
      .then(jsonOf)
      .then(function (j) { return { user: (j && j.user) || null }; })
      .catch(function (e) { return { user: null, offline: e.code === 'offline' }; });
  }
  // Starts the GitHub round trip. Resolves NEVER on success — the document is
  // navigating away, and a caller that kept running would race the unload.
  function signInGithub(callbackURL) {
    if (!CLOUD) return Promise.reject(disabled());
    return req('/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', callbackURL: callbackURL || '/' })
    }).then(jsonOf).then(function (j) {
      // Better Auth answers {url:'<github authorize url>', redirect:true}. `redirect`
      // is a BOOLEAN — falling back to it (as `j.url || j.redirect` did) assigns
      // `true` whenever the shape changes or an error body comes back, and the next
      // line then navigates to /true. Take the url, or nothing.
      var url = (j && typeof j.url === 'string') ? j.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) throw apiError(0, 'no_redirect', j, 'Sign-in did not return a GitHub URL.');
      window.location.href = url;
      return new Promise(function () {});   // deliberately never settles
    });
  }
  function signOut() {
    return req('/auth/sign-out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function () { return undefined; });
  }

  /* ====================== projects: read ====================== */
  function listProjects(o) {
    o = o || {};
    var q = [];
    if (o.order) q.push('order=' + enc(o.order));
    if (o.q) q.push('q=' + enc(String(o.q).slice(0, 80)));
    if (o.mine) q.push('mine=1');
    if (o.owner) q.push('owner=' + enc(o.owner));
    if (o.limit) q.push('limit=' + (o.limit | 0));
    if (o.cursor) q.push('cursor=' + enc(o.cursor));
    return req('/projects' + (q.length ? '?' + q.join('&') : ''), { method: 'GET', cache: 'no-store' })
      .then(jsonOf)
      .then(function (j) {
        return {
          projects: (j && j.projects) || [],
          nextCursor: (j && j.nextCursor) || null,
          order: (j && j.order) || 'updated',
          orderDegraded: !!(j && j.orderDegraded)
        };
      });
  }
  // Returns { project: Card, meta: <decoded project.json>, version, etag,
  // notModified }. Pass `etag` back as o.ifNoneMatch on the next open (the plain
  // version number works too) and a match answers 304 with no payload — that is how
  // a returning user avoids re-downloading 78 KB. A 304 carries NO card, so a caller
  // using it must still hold the previous card as well as the meta.
  function getProject(id, o) {
    o = o || {};
    if (!CLOUD) return Promise.reject(disabled());
    if (!isFlatId(id)) return Promise.reject(apiError(400, 'bad_request', null, 'Bad project id.'));
    var init = { method: 'GET', credentials: 'same-origin', cache: 'no-store' };
    if (o.ifNoneMatch != null && o.ifNoneMatch !== '') {
      var inm = ifNoneMatchFor(id, o.ifNoneMatch);
      if (inm) init.headers = { 'If-None-Match': inm };
    }
    return fetch(BASE + '/projects/' + enc(id), init).then(function (r) {
      if (r.status === 304) {
        return { project: null, meta: null, version: etagVersion(r) || o.ifNoneMatch, etag: rememberEtag(id, r) || etagSeen[id] || '', notModified: true };
      }
      return ok(r).then(function (res) {
        var j = res.body || {};
        var tag = rememberEtag(id, res.r);
        return decodePayload(j.payload, j.encoding).then(function (meta) {
          return {
            project: j.project || null, meta: meta,
            version: (j.project && j.project.version) || etagVersion(res.r),
            etag: tag, notModified: false
          };
        });
      });
    }, function (e) { throw offline(e); });
  }
  function getHead(id) {
    if (!isFlatId(id)) return Promise.reject(apiError(400, 'bad_request', null, 'Bad project id.'));
    return req('/projects/' + enc(id) + '/head', { method: 'GET', cache: 'no-store' }).then(function (res) {
      var j = res.body || {};
      rememberEtag(id, res.r);
      return { project: j.project || null, version: j.version, payloadSha: j.payloadSha || '', payloadBytes: j.payloadBytes || 0 };
    });
  }

  /* ====================== projects: write ====================== */
  function createProject(o) {
    o = o || {};
    return encodePayload(o.meta).then(function (p) {
      return req('/projects', {
        method: 'POST',
        // createRoute reads the name with requireName:true, so it is clamped here to
        // a guaranteed-non-empty value rather than left for writeHeaders to default.
        headers: writeHeaders({ name: clampName(o.name || (o.meta && o.meta.name)), encoding: p.encoding, bytes: p.bytes, sha: p.sha, facts: metaFacts(o.meta), idempotencyKey: o.idempotencyKey }),
        body: payloadBody(p.payloadB64)
      }).then(function (res) {
        var j = res.body || {};
        if (j.project && j.project.id) rememberEtag(j.project.id, res.r);
        return { project: j.project || null, version: j.version || 1, sha: p.sha, replay: res.r.headers.get('X-Studio-Idempotent-Replay') === '1' };
      });
    });
  }
  // The CAS save. ifMatch is the version you loaded; a 409 means the row moved and
  // the caller must NOT retry blind — see sync.js's conflictCopy().
  function saveProject(id, o) {
    o = o || {};
    if (!isFlatId(id)) return Promise.reject(apiError(400, 'bad_request', null, 'Bad project id.'));
    return encodePayload(o.meta).then(function (p) {
      var init = {
        method: 'PUT',
        // saveRoute reads the name with requireName:true — same rule as create.
        headers: writeHeaders({ name: clampName(o.name || (o.meta && o.meta.name)), encoding: p.encoding, bytes: p.bytes, sha: p.sha, facts: metaFacts(o.meta), ifMatch: o.ifMatch }),
        body: payloadBody(p.payloadB64)
      };
      // A last-gasp save from pagehide: keepalive lets the request outlive the
      // document, but only within the spec's 64 KB body budget.
      if (o.keepalive && p.payloadB64.length <= KEEPALIVE_MAX) init.keepalive = true;
      return req('/projects/' + enc(id), init).then(function (res) {
        var j = res.body || {};
        rememberEtag(id, res.r);
        return { project: j.project || null, version: j.version, updated: j.updated || nowSec(), actedAsAdmin: !!j.actedAsAdmin, sha: p.sha };
      });
    });
  }
  // meta === null + fromServer copies the STORED bytes inside D1 (nothing crosses
  // the wire). Passing meta forks the caller's LOCAL, possibly-edited document —
  // that is the case that makes a logged-out edit survivable.
  function forkProject(id, o) {
    o = o || {};
    if (!isFlatId(id)) return Promise.reject(apiError(400, 'bad_request', null, 'Bad project id.'));
    function send(p) {
      return req('/projects/' + enc(id) + '/fork', {
        method: 'POST',
        headers: writeHeaders({
          // No name => no X-Studio-Name => the server names the fork
          // "<source> (copy)" itself. See writeHeaders.
          name: o.name, encoding: p.encoding, bytes: p.bytes, sha: p.sha,
          facts: o.facts || metaFacts(o.meta), idempotencyKey: o.idempotencyKey,
          // Declared on BOTH paths. forkRoute otherwise infers the mode from
          // hasBody(), and an explicit header cannot be misread.
          forkSource: p.fromServer ? 'server' : 'client'
        }),
        body: p.body
      }).then(function (res) {
        var j = res.body || {};
        if (j.project && j.project.id) rememberEtag(j.project.id, res.r);
        return { project: j.project || null, version: j.version || 1, forkOf: j.forkOf || id, forkRoot: j.forkRoot || null, sha: p.sha };
      });
    }
    if (o.fromServer || !o.meta) return send({ encoding: 'gzip+b64', bytes: 0, sha: '', body: '', fromServer: true });
    return encodePayload(o.meta).then(function (p) { return send({ encoding: p.encoding, bytes: p.bytes, sha: p.sha, body: payloadBody(p.payloadB64) }); });
  }
  // Renaming never re-uploads the payload — that is the whole reason PATCH exists.
  function renameProject(id, name, ifMatch) {
    if (!isFlatId(id)) return Promise.reject(apiError(400, 'bad_request', null, 'Bad project id.'));
    var h = { 'Content-Type': 'application/json', 'X-Studio-Client': '1' };
    if (ifMatch != null && ifMatch !== '') {
      var im = ifMatchFor(ifMatch);
      if (im) h['If-Match'] = im;
    }
    return req('/projects/' + enc(id), { method: 'PATCH', headers: h, body: JSON.stringify({ name: clampName(name) }) })
      .then(function (res) {
        var j = res.body || {};
        rememberEtag(id, res.r);
        return { project: j.project || null, version: j.version };
      });
  }
  // Soft delete. ALWAYS inspects the response — the desktop path at app.js:653
  // fires and forgets, which is how a failed delete looks like a success.
  function deleteProject(id) {
    if (!isFlatId(id)) return Promise.reject(apiError(400, 'bad_request', null, 'Bad project id.'));
    return req('/projects/' + enc(id), { method: 'DELETE', headers: { 'X-Studio-Client': '1' } })
      .then(function () { delete etagSeen[id]; return { ok: true, id: id }; });
  }
  // One row written, or zero. Resolves false and NEVER rejects: a failed view
  // record must not disturb an open. Layer 2 of the suppression stack (the
  // localStorage dedupe) lives here so every caller gets it.
  function recordView(id) {
    if (!CLOUD || !isFlatId(id)) return Promise.resolve(false);
    var S = window.StudioStore;
    if (S && S.markViewed && !S.markViewed(id, nowSec())) return Promise.resolve(false);
    return fetch(BASE + '/projects/' + enc(id) + '/view', {
      method: 'POST', credentials: 'same-origin', headers: { 'X-Studio-Client': '1' }
    }).then(function (r) { return r.headers.get('X-Studio-View-Recorded') === '1'; }, function () { return false; });
  }

  /* ====================== bundled seed library ====================== */
  // The static projects/ bundle build.js ships. In cloud mode it is the FALLBACK
  // library — what a visitor sees when D1 is unreachable, or before the seed
  // import has run against a fresh database.
  //
  // The url stays RELATIVE (no leading '/') so the app still works when it is
  // deployed under a sub-path, and carries ?v=<build> because the old
  // cache:'force-cache' at app.js:587/673 pins a returning visitor to a stale
  // library forever no matter what Cache-Control build.js emits.
  // build.js is supposed to stamp the generated config.js with a build id. If it
  // does not, a CONSTANT '?v=' busts nothing, so fall back to a value minted once
  // per page load: the fallback library is only read when D1 is unreachable, and
  // serving it stale is worse than losing the 304 on that rare path. Emitting
  // STUDIO_CONFIG.version from build.js restores the 304s.
  var SESSION_STAMP = 's' + Date.now().toString(36);
  function libVersion() { return String(CFG.libVersion || CFG.version || CFG.build || SESSION_STAMP); }
  function seedUrl(rel) { return 'projects/' + rel + '?v=' + enc(libVersion()); }
  function seedFetch(rel) {
    return fetch(seedUrl(rel), { credentials: 'same-origin', cache: 'no-cache' }).then(function (r) {
      if (!r.ok || isHtml(r)) throw apiError(r.status, 'not_found', null, 'Bundled library not found.');
      return r.json();
    });
  }
  function listSeedProjects() {
    if (!CLOUD) return Promise.reject(disabled());
    return seedFetch('index.json').then(function (j) {
      return ((j && j.projects) || []).map(function (p) {
        return {
          id: p.id, name: p.name || 'Untitled', updated: p.updated || 0, created: p.updated || 0,
          youtubeUrl: p.youtubeUrl || '', hasSong: !!p.hasSong,
          instruments: (p.instruments || []).filter(Boolean), trackCount: p.trackCount || 0,
          version: 1, ownerId: null, ownerName: 'bundled', ownerImage: '',
          isMine: false, canEdit: false, forkOf: null, forkRoot: null, viewedAt: null, seed: true
        };
      });
    });
  }
  function getSeedProject(id) {
    if (!CLOUD) return Promise.reject(disabled());
    if (!isFlatId(id)) return Promise.reject(apiError(400, 'bad_request', null, 'Bad project id.'));
    return seedFetch(enc(id) + '.json');
  }

  /* ====================== view helpers ====================== */
  // Card -> the shape renderLibrary() (app.js:677) already consumes, plus the new
  // affordances (isMine / canEdit / ownerName / viewedAt) it can grow into.
  function cardsToLegacy(cards) {
    return (cards || []).map(function (c) {
      return {
        id: c.id, name: c.name || 'Untitled', updated: c.updated || 0,
        youtubeUrl: c.youtubeUrl || '', hasSong: !!c.hasSong,
        instruments: c.instruments || [], trackCount: c.trackCount || 0,
        isMine: !!c.isMine, canEdit: !!c.canEdit, ownerName: c.ownerName || '',
        viewedAt: c.viewedAt || null, version: c.version || 1, seed: !!c.seed, draft: !!c.draft
      };
    });
  }

  return {
    enabled: function () { return CLOUD; },
    base: function () { return BASE; },
    isFlatId: isFlatId, isHtml: isHtml, nowSec: nowSec, clampName: clampName, metaFacts: metaFacts,
    me: me, signInGithub: signInGithub, signOut: signOut,
    listProjects: listProjects, getProject: getProject, getHead: getHead,
    createProject: createProject, saveProject: saveProject, forkProject: forkProject,
    renameProject: renameProject, deleteProject: deleteProject, recordView: recordView,
    encodePayload: encodePayload, decodePayload: decodePayload, shaMeta: shaMeta,
    listSeedProjects: listSeedProjects, getSeedProject: getSeedProject, seedUrl: seedUrl,
    cardsToLegacy: cardsToLegacy
  };
})();
// House idiom is a bare global; the contract names it StudioApi. Both, one object.
var Api = StudioApi;
