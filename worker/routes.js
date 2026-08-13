/* ============================================================================
 * worker/routes.js  —  every /api/* handler, plus the ROUTES table that
 * worker/index.js compiles into its router.
 *
 * House rules enforced throughout (these are the reasons the app fits inside
 * the Free plan's 10 ms CPU and 100,000 rows written per day):
 *
 *  1. THE PAYLOAD IS NEVER PARSED. It arrives as the raw request body (base64
 *     text) with all metadata in X-Studio-* headers, and it leaves by string
 *     concatenation. No JSON.parse, no JSON.stringify and no ArrayBuffer ever
 *     touches it — D1 converts ArrayBuffer params with Array.from, which is why
 *     payload_b64 is TEXT and stays TEXT.
 *  2. AUTHORIZATION AND QUOTA ARE CHECKED WITH A CHEAP SELECT *BEFORE* ANY
 *     WRITE. The CHECK constraints and the CAS in db.js are a backstop, not
 *     control flow: a 403 / 404 / 409 / 429 must cost 0 rows written.
 *  3. Every db.js call is fed to ctx.log(), so meta.rows_written and
 *     meta.rows_read land in the request log line and the quota budget is
 *     MEASURED in production rather than assumed.
 *  4. SQL lives in db.js. The one exception is documented where it happens
 *     (the owner-exists probe in the admin transfer route).
 *
 * Two deviations from the written contract, both visible from the outside and
 * both deliberate:
 *   • the contract splits these across worker/routes/{me,projects,views,
 *     admin}.js and puts readMeta/readPayload in worker/http.js; this build
 *     consolidates them here (same function shapes, same behaviour), and
 *     exports readMeta/readPayload so a later worker/http.js can re-export them;
 *   • order=recent paging is delegated wholesale to db.js's listProjects(),
 *     which owns the two-phase cursor. Re-implementing it here would produce
 *     two incompatible cursor encodings for one query string.
 * ========================================================================== */
import {
  MAX_PAYLOAD_CHARS,
  MAX_DETAIL_CHARS,
  VIEW_FLOOR_SEC,
  isB64,
  isFlatId,
  toCard,
  toEarSession,
  insertEarSession,
  listEarSessions,
  getProject,
  getProjectExists,
  listProjects,
  insertProject,
  forkProjectServerSide,
  updateProjectPayload,
  renameProject,
  setDeleted,
  hardDeleteProject,
  transferOwner,
  recordView,
  findByClientKey
} from './db.js';

import {
  HttpError,
  canEdit,
  canListOwner,
  requireUser,
  requireAdmin,
  requireEditor,
  requireClientHeader
} from './auth.js';

/* ---------------------------------------------------------------------------
 * limits
 * ------------------------------------------------------------------------ */
const MAX_NAME = 200;            // decoded characters
const MAX_Q = 80;                // search substring
const MAX_YOUTUBE = 500;
const MAX_INSTRUMENTS = 200;     // the comma-joined string, as stored
const MAX_INSTRUMENT_IDS = 32;
const MAX_TRACKS = 10000;
const MAX_OWNER_ID = 128;
const MAX_CURSOR = 512;
const MAX_JSON_BODY = 4096;      // PATCH / transfer bodies carry no payload

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

const SAVE_FLOOR_SEC = 3;        // PUT is 429 while `updated > now - 3`
const MAX_UNIX_SECONDS = 4102444800;   // 2100-01-01, the import header clamp

const ENCODINGS = { 'gzip+b64': 1, 'identity+b64': 1 };

/* --- /learn (ear trainer) limits -------------------------------------------
 *
 * The POST body is the ONE JSON body in this file that is not a few dozen
 * bytes, because it carries `detail`. The arithmetic for its cap: 2,000
 * characters of detail (db.js MAX_DETAIL_CHARS), doubled to 4,000 in the worst
 * case where the client sends it as a JSON *string* and every character needs
 * escaping, plus ~300 characters for the thirteen scalar fields and their keys.
 * 8,192 is ~2x that. MAX_JSON_BODY (4,096) would reject a legitimate maximal
 * session, which is why readJsonBody() now takes a per-route cap. */
const MAX_LEARN_BODY = 8192;
const DEFAULT_LEARN_LIMIT = 60;  // what the /learn client asks for
const MAX_LEARN_LIMIT = 100;     // db.js MAX_EAR_LIMIT; see its response-size note

/* Enum domains, as ARRAYS rather than lookup objects on purpose: a bare object
 * literal inherits Object.prototype, so `LEARN_MODES['constructor']` would be
 * truthy and a client could smuggle a non-value past an `if (map[v])` test.
 * Three-element indexOf is also faster than the property lookup it replaces. */
const LEARN_MODES = ['identify', 'produce'];
const LEARN_CONTEXTS = ['cadence', 'ii-V-I', 'drone'];
const LEARN_TAPERS = [0, 1, 2, 4, 8];      // questions between key re-statements

const MAX_LEARN_DURATION = 86400;   // 24 h; 'endless' mode in a forgotten tab
const MAX_LEARN_QUESTIONS = 10000;  // ~7 s/question for 20 straight hours
const MAX_LEARN_ASSISTS = 100000;   // NOT bounded by questions: one trial can be
                                    // replayed repeatedly (design Part I s4)
const MAX_ABS_CENTS = 1200;         // one octave of |deviation| per mic trial

/* HOW FAR `started` MAY SIT FROM THE SERVER'S CLOCK. It is the CLIENT's clock
 * (the session is written to localStorage first and POSTed after, design Part I
 * s13), so it has to be accepted with some slack and refused past it:
 *  · FUTURE 1 day — a machine whose clock is a few hours fast is common; a
 *    session that claims to be from next year would sort above every real row
 *    in the list forever, and no later correct row could displace it.
 *  · PAST 365 days — the sync path replays sessions that were saved offline,
 *    which can legitimately be weeks old. Beyond a year it is a broken clock
 *    (or a millisecond value divided by something), not a backlog.
 * REJECTED rather than silently clamped to ctx.now: clamping a batch of replayed
 * offline sessions would collapse them all onto the same second and turn them
 * into PK collisions — which db.js would then resolve by walking `started`
 * forward, inventing a practice history that never happened. */
const LEARN_FUTURE_SEC = 86400;
const LEARN_PAST_SEC = 31536000;

/* A day counts toward the streak when it holds at least this much practice —
 * design Part I s8, "streak of consecutive days with >= 5 minutes". */
const LEARN_STREAK_MIN_SEC = 300;

/* PER-USER WRITE BRAKES. Isolate-local and free — a D1 counter would BE a write
 * on the path we are bounding. Not security controls (the real cost of abuse is
 * that an account needs a GitHub OAuth round trip, and an attacker spread across
 * colos sees isolates x limit); they exist so that a stuck client loop, or one
 * signed-in account, cannot eat the ACCOUNT-WIDE 100,000 rows written/day and
 * deny saves to everybody else for the rest of the day.
 *
 * Every ceiling below is stated in rows/day for the pathological case, because
 * that is the number that matters and the per-minute figure is not:
 *
 *   create/fork  20/min, 200/hour  x 4 rows = 19,200/day   (19% of cap)
 *   save (PUT)   30/min, 600/hour  x 2 rows = 28,800/day   (29% of cap)
 *   rename PATCH 10/min, 120/hour  x 2 rows =  5,760/day   (5.8% of cap)
 *   view POST            60/hour   x 1 row  =  1,440/day   (1.4% of cap)
 *   learn POST   10/min, 60/hour   x 1 row  =  1,440/day   (1.4% of cap)
 *
 * The hourly figures are the binding ones and they are set ABOVE what a human
 * can produce: the client autosaves behind a 10 s floor, so an hour of unbroken
 * editing is ~360 saves; a rename is a typed field; a view is a project open;
 * a learn session is TEN MINUTES of practice, so 60/hour is already six times
 * what the drill itself can generate. The per-minute figures only smooth bursts
 * — for /learn, the burst that matters is the offline backlog EarStore replays
 * on the first sign-in after a week away.
 *
 * These sit ALONGSIDE the per-project floors (SAVE_FLOOR_SEC on PUT and PATCH,
 * VIEW_FLOOR_SEC in the recent_views upsert). The floors bound one row being
 * rewritten in a loop; these bound a client cycling through many rows, which is
 * the hole a per-project floor cannot see. */
const CREATE_PER_MIN = 20;
const CREATE_PER_HOUR = 200;
const SAVE_PER_MIN = 30;
const SAVE_PER_HOUR = 600;
const RENAME_PER_MIN = 10;
const RENAME_PER_HOUR = 120;
const VIEW_PER_HOUR = 60;
const LEARN_PER_MIN = 10;
const LEARN_PER_HOUR = 60;

/* ---------------------------------------------------------------------------
 * isolate-local rate limiter
 *
 * Deliberately crude: one Map, whole-map eviction past the cap. A per-key LRU
 * would cost more CPU than the thing it protects. worker/index.js does NOT use
 * this for /api/auth/* — auth.js ships its own token bucket (with an optional
 * cross-isolate binding) and owns that path.
 * ------------------------------------------------------------------------ */
const buckets = new Map();
const BUCKET_CAP = 5000;

export function rateLimit(key, limit, windowSec, now) {
  if (buckets.size > BUCKET_CAP) buckets.clear();
  const b = buckets.get(key);
  if (!b || b.reset <= now) { buckets.set(key, { n: 1, reset: now + windowSec }); return true; }
  if (b.n >= limit) return false;
  b.n++;
  return true;
}

function guardCreateRate(ctx, userId) {
  if (!rateLimit('cm:' + userId, CREATE_PER_MIN, 60, ctx.now) ||
      !rateLimit('ch:' + userId, CREATE_PER_HOUR, 3600, ctx.now)) {
    throw new HttpError(429, 'rate_limited', { retryAfter: 60, detail: 'too many new projects' });
  }
}

/* PUT /api/projects/:id was throttled per PROJECT (3 s) and not per USER, so a
 * client saving 20 different projects every 3 seconds wrote 400 rows/min —
 * 576,000/day, 5.7x the entire account's daily cap. The per-project floor cannot
 * see that pattern by construction; this can. */
function guardSaveRate(ctx, userId) {
  if (!rateLimit('sm:' + userId, SAVE_PER_MIN, 60, ctx.now) ||
      !rateLimit('sh:' + userId, SAVE_PER_HOUR, 3600, ctx.now)) {
    throw new HttpError(429, 'rate_limited', { retryAfter: 60, detail: 'saving too fast' });
  }
}

/* PATCH had NO brake of any kind: no rate limit and no server-side floor, while
 * every PATCH writes 2 rows (the row plus idx_projects_recent, because `updated`
 * bumps) and hands back the new version needed for the next one. 50,000 of them
 * — comfortably inside the 100,000 Worker requests/day cap — exhausted the whole
 * account's rows-written budget from a laptop. */
function guardRenameRate(ctx, userId) {
  if (!rateLimit('rm:' + userId, RENAME_PER_MIN, 60, ctx.now) ||
      !rateLimit('rh:' + userId, RENAME_PER_HOUR, 3600, ctx.now)) {
    throw new HttpError(429, 'rate_limited', { retryAfter: 60, detail: 'renaming too fast' });
  }
}

/* POST /api/learn/sessions writes 1 row and has no per-row floor to fall back
 * on — every session is a NEW primary key, so there is no equivalent of
 * SAVE_FLOOR_SEC or the recent_views ON CONFLICT floor to bound a client that
 * loops. This IS the only brake on that path, which is why it exists even
 * though the ceiling is six times what the drill can produce.
 *
 * The bucket keys ('lm:', 'lh:') are distinct from the create ('cm:'/'ch:'),
 * save ('sm:'/'sh:'), rename ('rm:'/'rh:') and view ('vw:') prefixes, so a
 * user's practice log and their saves never spend each other's budget. */
function guardLearnRate(ctx, userId) {
  if (!rateLimit('lm:' + userId, LEARN_PER_MIN, 60, ctx.now) ||
      !rateLimit('lh:' + userId, LEARN_PER_HOUR, 3600, ctx.now)) {
    throw new HttpError(429, 'rate_limited', { retryAfter: 60, detail: 'too many practice sessions' });
  }
}

/* ---------------------------------------------------------------------------
 * small helpers
 * ------------------------------------------------------------------------ */
function bad(detail, field) {
  const extra = { detail: detail };
  if (field) extra.field = field;
  return new HttpError(400, 'bad_request', extra);
}

function requireFlatId(id) {
  if (!isFlatId(id)) throw bad('project id must match /^[A-Za-z0-9_-]{1,64}$/', 'id');
  return id;
}

// Header values are latin-1 on the wire; the client percent-encodes UTF-8 so
// free text (names, YouTube URLs) survives intact.
function decodeHeader(raw, field) {
  if (raw === null || raw === undefined) return null;
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    throw bad('header is not valid percent-encoded UTF-8', field);
  }
}

// Control characters would corrupt the library list and the log line, and a NUL
// would truncate the name in some SQLite tooling. Strip them, then trim.
const CTRL_RE = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']+', 'g');

function cleanText(s) {
  return String(s).replace(CTRL_RE, ' ').trim();
}

function intHeader(request, field, min, max) {
  const raw = request.headers.get(field);
  if (raw === null || raw.trim() === '') return null;
  const n = parseInt(raw, 10);
  if (!isFinite(n) || String(n) !== raw.trim()) throw bad('expected an integer', field);
  if (n < min || n > max) throw bad('out of range [' + min + ', ' + max + ']', field);
  return n;
}

// Accepts "3", W/"3", 3, and our own "3+w" variant (see etagFor).
function parseIfMatch(raw) {
  if (!raw) return null;
  const m = /^\s*(?:W\/)?"?(\d{1,15})/.exec(raw);
  return m ? parseInt(m[1], 10) : null;
}

/* ETag policy.
 *
 * The contract specifies ETag: "<version>". A project response also carries
 * canEdit / isMine, which are viewer-dependent — so a bare version tag would
 * let a user who has just signed in receive a 304 and keep a stale
 * canEdit:false, silently disabling their own Save button. The tag therefore
 * gains a '+w' suffix when the viewer may edit. It is invisible to any client
 * that treats ETags as opaque, it still parses as "<version>" for If-Match, and
 * it forces a 200 on the one transition that matters. */
function etagFor(version, writable) {
  return '"' + version + (writable ? '+w' : '') + '"';
}

function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const parts = ifNoneMatch.split(',');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].trim().replace(/^W\//, '') === etag) return true;
  }
  return false;
}

// db.js re-SELECTs an inserted row through the LEFT JOIN on `user`, so
// owner_name is normally populated. This is the belt for the braces: on a
// create the owner IS the caller, so we can always name them.
function withOwnerIdentity(row, user) {
  if (!row || !user || row.owner_id !== user.id) return row;
  if (!row.owner_name) row.owner_name = user.name || null;
  if (!row.owner_image) row.owner_image = user.image || null;
  return row;
}

function cardOf(row, ctx, extra) {
  return toCard(row, ctx.viewer, extra);
}

// db.js reports write failures as codes, not exceptions. Map them once.
function writeFailure(res) {
  if (!res || !res.code) return new HttpError(500, 'internal');
  if (res.code === 'payload_too_large') return new HttpError(413, 'payload_too_large', { limit: MAX_PAYLOAD_CHARS });
  if (res.code === 'id_taken') return new HttpError(409, 'conflict', { detail: 'that id already exists' });
  if (res.code === 'id_exhausted') return new HttpError(500, 'id_exhausted');
  if (res.code === 'not_found') return new HttpError(404, 'not_found');
  return bad('could not store the project (' + res.code + ')');
}

/* ---------------------------------------------------------------------------
 * readMeta / readPayload — THE ONLY places request metadata and the payload
 * enter the Worker. (The contract puts these in worker/http.js; they are
 * exported so that module can re-export them verbatim.)
 * ------------------------------------------------------------------------ */
export function readMeta(request, opts) {
  const o = opts || {};
  const h = request.headers;

  let name = decodeHeader(h.get('X-Studio-Name'), 'X-Studio-Name');
  if (name !== null) {
    name = cleanText(name);
    if (name.length > MAX_NAME) throw bad('name exceeds ' + MAX_NAME + ' characters', 'X-Studio-Name');
  }
  if (o.requireName && !name) throw bad('X-Studio-Name is required', 'X-Studio-Name');

  const encoding = h.get('X-Studio-Encoding') || 'gzip+b64';
  if (!ENCODINGS[encoding]) throw bad("expected 'gzip+b64' or 'identity+b64'", 'X-Studio-Encoding');

  const sha = (h.get('X-Studio-Sha') || '').trim().toLowerCase();
  if (sha && !/^[0-9a-f]{1,64}$/.test(sha)) throw bad('expected lowercase hex', 'X-Studio-Sha');

  let youtubeUrl = decodeHeader(h.get('X-Studio-Youtube'), 'X-Studio-Youtube');
  youtubeUrl = youtubeUrl === null ? '' : cleanText(youtubeUrl);
  // Length-clamped, not scheme-gated: app.js stores whatever the user typed
  // into #ytUrl and renders it with textContent, and people paste bare
  // "youtu.be/..." links. Rejecting those would lose data to no benefit.
  if (youtubeUrl.length > MAX_YOUTUBE) {
    throw bad('youtube url exceeds ' + MAX_YOUTUBE + ' characters', 'X-Studio-Youtube');
  }

  const key = (h.get('Idempotency-Key') || '').trim();
  if (key && !isFlatId(key)) throw bad('must match /^[A-Za-z0-9_-]{1,64}$/', 'Idempotency-Key');
  if (o.requireIdempotencyKey && !key) throw bad('Idempotency-Key is required', 'Idempotency-Key');

  const forkSource = (h.get('X-Studio-Fork-Source') || '').trim().toLowerCase();
  if (forkSource && forkSource !== 'server' && forkSource !== 'client') {
    throw bad("expected 'server' or 'client'", 'X-Studio-Fork-Source');
  }

  return {
    name: name || '',
    encoding: encoding,
    bytes: intHeader(request, 'X-Studio-Bytes', 0, 1 << 30) || 0,
    sha: sha,
    youtubeUrl: youtubeUrl,
    hasSong: (h.get('X-Studio-Has-Song') || '').trim() === '1' ? 1 : 0,
    trackCount: intHeader(request, 'X-Studio-Track-Count', 0, MAX_TRACKS) || 0,
    instruments: normalizeInstruments(h.get('X-Studio-Instruments')),
    idempotencyKey: key || null,
    ifMatch: parseIfMatch(h.get('If-Match')),
    forkSource: forkSource
  };
}

// 'bass, Drums,,bass' -> 'bass,drums'. Stored as a plain comma-joined string
// because the library card only ever splits it apart again.
function normalizeInstruments(raw) {
  if (!raw) return '';
  const seen = Object.create(null);
  const out = [];
  const parts = String(raw).split(',');
  for (let i = 0; i < parts.length && out.length < MAX_INSTRUMENT_IDS; i++) {
    const v = parts[i].trim().toLowerCase();
    if (!v || seen[v]) continue;
    if (!/^[a-z0-9_-]{1,32}$/.test(v)) {
      throw bad('instrument ids must match /^[a-z0-9_-]{1,32}$/', 'X-Studio-Instruments');
    }
    seen[v] = 1;
    out.push(v);
  }
  const joined = out.join(',');
  if (joined.length <= MAX_INSTRUMENTS) return joined;
  const cut = joined.lastIndexOf(',', MAX_INSTRUMENTS);
  return cut > 0 ? joined.slice(0, cut) : joined.slice(0, MAX_INSTRUMENTS);
}

export async function readPayload(request, opts) {
  const o = opts || {};
  // A DECLARED LENGTH IS MANDATORY ON EVERY PAYLOAD ROUTE.
  //
  // Rejecting on the declared length first is the point: buffering 10 MB only to
  // measure it is exactly the CPU we do not have. But `Content-Length` is absent
  // on a chunked/streamed request body, and the old code simply skipped the
  // check in that case — so `await request.text()` would buffer whatever arrived
  // before the length test below ever ran. Workers accepts request bodies up to
  // 100 MB; decoding 100 MB of UTF-8 into a JS string blows the 128 MB isolate
  // memory limit and vastly exceeds the 10 ms CPU budget, and requireUser() —
  // one GitHub OAuth round trip — was the only thing standing in front of it.
  //
  // Every client of these routes sends a Blob or string body, which always
  // carries a Content-Length, so 411 costs nothing real and closes the hole
  // without a streaming reader we would then have to budget for.
  const cl = request.headers.get('Content-Length');
  const declared = (cl !== null && /^\s*\d{1,15}\s*$/.test(cl)) ? parseInt(cl, 10) : null;
  if (declared === null) {
    throw new HttpError(411, 'length_required', {
      detail: 'this route requires a single, numeric Content-Length (no chunked bodies)'
    });
  }
  if (declared > MAX_PAYLOAD_CHARS + 1024) {
    throw new HttpError(413, 'payload_too_large', { limit: MAX_PAYLOAD_CHARS });
  }

  let body;
  try {
    body = await request.text();
  } catch (e) {
    throw bad('could not read the request body');
  }

  // Belt for the braces: a lying Content-Length is a client bug, not a licence
  // to store the row.
  if (body.length > MAX_PAYLOAD_CHARS) {
    throw new HttpError(413, 'payload_too_large', { limit: MAX_PAYLOAD_CHARS });
  }
  if (!body.length) {
    if (o.allowEmpty) return '';
    throw bad('request body must be the base64 payload');
  }
  // The gate that makes the string-concatenated read path provably safe: this
  // alphabet contains no character JSON would have to escape.
  if (!isB64(body)) throw bad('body must be base64 (A-Z a-z 0-9 + / =)');
  return body;
}

// base64 length -> the pre-base64 byte count, for when the client omits
// X-Studio-Bytes. Exact, and cheaper than trusting a header we would have to
// validate anyway.
function bytesFromB64(b64) {
  const n = b64.length;
  if (n < 4) return 0;
  let pad = 0;
  if (b64.charCodeAt(n - 1) === 61) pad++;
  if (b64.charCodeAt(n - 2) === 61) pad++;
  return Math.max(0, ((n / 4) | 0) * 3 - pad);
}

/* `maxChars` is the PER-ROUTE cap, defaulting to MAX_JSON_BODY. Only
 * POST /learn/sessions passes one: its body carries the per-degree `detail`
 * blob and so is kilobytes rather than the few dozen bytes PATCH and transfer
 * send. Raising MAX_JSON_BODY itself would have widened the buffer every route
 * accepts in order to serve one of them. */
async function readJsonBody(request, maxChars) {
  const cap = (typeof maxChars === 'number' && maxChars > 0) ? maxChars : MAX_JSON_BODY;
  // Same rule as readPayload, same reason: without a declared length, the
  // `txt.length` test below only runs AFTER the whole body has been buffered
  // into a string. These routes (PATCH rename, admin transfer) carry a few dozen
  // bytes of JSON, so requiring a Content-Length costs nothing.
  const cl = request.headers.get('Content-Length');
  const declared = (cl !== null && /^\s*\d{1,15}\s*$/.test(cl)) ? parseInt(cl, 10) : null;
  if (declared === null) {
    throw new HttpError(411, 'length_required', {
      detail: 'this route requires a single, numeric Content-Length (no chunked bodies)'
    });
  }
  if (declared > cap) throw bad('body too large for this route');
  let txt;
  try {
    txt = await request.text();
  } catch (e) {
    throw bad('could not read the request body');
  }
  if (txt.length > cap) throw bad('body too large for this route');
  let obj;
  try {
    obj = JSON.parse(txt);
  } catch (e) {
    throw bad('body must be a JSON object');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad('body must be a JSON object');
  return obj;
}

function clampLimit(raw) {
  const n = parseInt(raw || '', 10);
  if (!isFinite(n)) return DEFAULT_LIMIT;
  return n < 1 ? 1 : (n > MAX_LIMIT ? MAX_LIMIT : n);
}

function readCursor(url) {
  const c = url.searchParams.get('cursor');
  if (!c) return null;
  // Cursors are db.js's own base64url; anything else is a client bug or a
  // probe, and either way it must not reach the query planner.
  if (c.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(c)) throw bad('malformed cursor', 'cursor');
  return c;
}

function readQ(url) {
  const q = url.searchParams.get('q');
  if (q === null) return null;
  const v = cleanText(q);
  if (v.length > MAX_Q) throw bad('q exceeds ' + MAX_Q + ' characters', 'q');
  return v || null;
}

/* ===========================================================================
 * GET /api/me
 * ======================================================================== */
export async function meRoute(request, ctx) {
  // Never 401: the client asks this to decide whether to SHOW a login button.
  if (!ctx.user) return ctx.json({ user: null });
  return ctx.json({
    user: {
      id: ctx.user.id,
      name: ctx.user.name || null,
      image: ctx.user.image || null,
      githubId: ctx.user.githubId || null,
      role: ctx.user.role || 'user',
      isAdmin: ctx.isAdmin
    }
  });
}

/* ===========================================================================
 * GET /api/projects
 *
 * Every project is public (R2), so this route never filters by viewer; the
 * viewer only picks the ORDER (R3) and colours the isMine / canEdit flags.
 *
 * Ordering is db.js's decision, not ours: listProjects() degrades 'recent' to
 * 'updated' whenever there is no per-user history to sort by (anonymous
 * caller) or when something else already owns the ordering (a search, a "My
 * projects" filter), and reports which order it actually used. We forward that
 * verbatim as order / orderDegraded so the UI can label the list "Recently
 * updated" honestly instead of lying.
 * ======================================================================== */
export async function listRoute(request, ctx) {
  const sp = ctx.url.searchParams;
  const mine = sp.get('mine') === '1';
  const ownerParam = sp.get('owner');

  let order = (sp.get('order') || '').toLowerCase();
  // An unknown value falls back to the default rather than erroring: a typo in
  // a query string should not blank the library.
  if (order !== 'recent' && order !== 'updated' && order !== 'name') {
    order = ctx.user ? 'recent' : 'updated';
  }

  if (mine && !ctx.user) throw bad('mine=1 requires a signed-in user', 'mine');

  // authzMatrix: "Admin may also pass &owner=<userId> to scope to any user;
  // non-admins passing &owner get 403". auth.js's canListOwner() is that rule,
  // and it additionally lets a signed-in user scope to THEIR OWN id — which is
  // just ?mine=1 spelled differently, and was previously a 403 for no reason
  // while canListOwner sat unused, a dead helper contradicting the shipped
  // route. One source of truth for the matrix: call it.
  let owner = null;
  if (ownerParam !== null) {
    owner = ownerParam.trim();
    if (!owner || owner.length > MAX_OWNER_ID) throw bad('owner must be a user id', 'owner');
    if (!canListOwner(ctx.session, owner)) {
      throw new HttpError(403, 'admin_only', { detail: 'owner= may only be your own id' });
    }
  }

  const res = await listProjects(ctx.env.DB, {
    order: order,
    q: readQ(ctx.url),
    ownerId: owner || (mine ? ctx.user.id : null),
    viewerId: ctx.user ? ctx.user.id : null,
    includeDeleted: false,
    limit: clampLimit(sp.get('limit')),
    cursor: readCursor(ctx.url)
  });
  ctx.log('listProjects', res);

  const rows = res.rows || [];
  const projects = new Array(rows.length);
  // Rows that came from the caller's own history carry row.viewed_at, which
  // toCard() picks up; padded rows carry null. That is what lets the UI draw a
  // truthful "Recently viewed" / "More projects" divider.
  for (let i = 0; i < rows.length; i++) projects[i] = cardOf(rows[i], ctx);

  return ctx.json({
    projects: projects,
    nextCursor: res.nextCursor || null,
    order: res.orderUsed || order,
    orderDegraded: !!res.degraded
  });
}

/* ===========================================================================
 * GET /api/projects/:id      — the only route that moves payload bytes out
 * ======================================================================== */
export async function getProjectRoute(request, ctx) {
  const id = requireFlatId(ctx.params.id);
  const got = await getProject(ctx.env.DB, id, { withPayload: true, includeDeleted: ctx.isAdmin });
  ctx.log('getProject', got);
  const row = got.row;
  if (!row) throw new HttpError(404, 'not_found');

  const card = cardOf(row, ctx);
  const etag = etagFor(row.version, canEdit(ctx.session, row));
  const headers = { 'ETag': etag, 'Cache-Control': 'no-cache' };

  // How a returning viewer avoids re-downloading up to ~80 KB.
  if (etagMatches(request.headers.get('If-None-Match'), etag)) return ctx.raw(null, 304, headers);

  const payload = String(row.payload_b64 || '');
  const encoding = ENCODINGS[row.encoding] ? row.encoding : 'gzip+b64';
  headers['Content-Type'] = 'application/json; charset=utf-8';

  // Built by STRING CONCATENATION, not JSON.stringify: escaping an 80 KB string
  // is the largest avoidable CPU cost on this route, and the base64 alphabet
  // contains nothing JSON would escape. isB64() is what makes that provable —
  // and if a row ever failed it we fall back to a correct (slower) encode
  // rather than emitting malformed JSON.
  const body = isB64(payload)
    ? '{"project":' + JSON.stringify(card) + ',"encoding":"' + encoding + '","payload":"' + payload + '"}'
    : JSON.stringify({ project: card, encoding: encoding, payload: payload });

  return ctx.raw(body, 200, headers);
}

/* ===========================================================================
 * GET /api/projects/:id/head — metadata only; never the payload.
 * sync.js calls this to decide whether a locally cached doc is still current
 * before spending the bandwidth.
 * ======================================================================== */
export async function headRoute(request, ctx) {
  const id = requireFlatId(ctx.params.id);
  const got = await getProject(ctx.env.DB, id, { withPayload: false, includeDeleted: ctx.isAdmin });
  ctx.log('getProject', got);
  const row = got.row;
  if (!row) throw new HttpError(404, 'not_found');

  return ctx.json({
    project: cardOf(row, ctx),
    version: row.version,
    payloadSha: row.payload_sha || '',
    payloadBytes: row.payload_bytes || 0
  }, 200, {
    'ETag': etagFor(row.version, canEdit(ctx.session, row)),
    'Cache-Control': 'no-cache'
  });
}

/* ===========================================================================
 * POST /api/projects
 * ======================================================================== */
export async function createRoute(request, ctx) {
  // X-Studio-Client is a genuine CSRF lock, not decoration: a custom header
  // forces a preflight on any cross-origin attempt, and this same-origin app
  // answers no preflight at all.
  requireClientHeader(request);
  requireUser(ctx.session);
  const user = ctx.user;
  const m = readMeta(request, { requireName: true, requireIdempotencyKey: true });
  guardCreateRate(ctx, user.id);

  // Cheap SELECT before any write: a retried create (flaky mobile network, a
  // double-tapped button, a browser resending after the OAuth round trip) must
  // return the FIRST project, not mint a second one.
  const dup = await findByClientKey(ctx.env.DB, user.id, m.idempotencyKey);
  ctx.log('findByClientKey', dup);
  if (dup.row) return replay(ctx, dup.row, user);

  const payload = await readPayload(request);
  const res = await insertProject(ctx.env.DB, {
    id: null,                                  // server-minted: no id squatting
    ownerId: user.id,
    clientKey: m.idempotencyKey,
    name: m.name,
    encoding: m.encoding,
    payloadB64: payload,
    payloadChecked: true,          // readPayload() just ran the base64 scan
    payloadBytes: m.bytes || bytesFromB64(payload),
    payloadSha: m.sha,
    youtubeUrl: m.youtubeUrl,
    hasSong: m.hasSong,
    trackCount: m.trackCount,
    instruments: m.instruments,
    forkOf: null,
    forkRoot: null,
    created: ctx.now,
    updated: ctx.now
  });
  ctx.log('insertProject', res);

  if (!res.ok) {
    if (res.code === 'idempotent_replay') return replay(ctx, res.row, user);
    throw writeFailure(res);
  }

  const row = withOwnerIdentity(res.row, user);
  return ctx.json({ project: cardOf(row, ctx), version: row.version || 1 }, 201, {
    'ETag': etagFor(row.version || 1, true),
    'Location': '/api/projects/' + row.id
  });
}

function replay(ctx, row, user) {
  const r = withOwnerIdentity(row, user);
  return ctx.json({ project: cardOf(r, ctx), version: r.version }, 200, {
    'X-Studio-Idempotent-Replay': '1',
    'ETag': etagFor(r.version, true)
  });
}

/* ===========================================================================
 * PUT /api/projects/:id      — save in place, compare-and-swap on version
 * ======================================================================== */
export async function saveRoute(request, ctx) {
  requireClientHeader(request);
  requireUser(ctx.session);
  const user = ctx.user;
  const id = requireFlatId(ctx.params.id);

  const ifMatch = parseIfMatch(request.headers.get('If-Match'));
  if (ifMatch === null) {
    throw new HttpError(412, 'precondition_failed', { detail: 'If-Match: "<version you loaded>" is required' });
  }

  // ONE cheap SELECT settles 404 / 403 / 409 / 429 before a single row is
  // written — and before the body is even read off the socket.
  const got = await getProject(ctx.env.DB, id, { withPayload: false, includeDeleted: true });
  ctx.log('getProject', got);
  const row = got.row;
  if (!row) throw new HttpError(404, 'not_found');
  // A soft-deleted row is 404 even for an admin: updateProjectPayload's CAS
  // carries `AND deleted = 0`, so the write could not land anyway. Restore
  // first, then save.
  if (row.deleted) throw new HttpError(404, 'not_found');

  requireEditor(ctx.session, row);   // 403 not_author {ownerId, ownerName}

  if (row.version !== ifMatch) {
    throw new HttpError(409, 'conflict', {
      serverVersion: row.version,
      serverUpdated: row.updated,
      serverSha: row.payload_sha || ''
    });
  }
  // Server-side save floor, PER PROJECT. The row was already read for the CAS,
  // so this check is free, and it holds against a hand-written client that
  // ignores the 10 s client-side floor.
  if (row.updated > ctx.now - SAVE_FLOOR_SEC) {
    throw new HttpError(429, 'rate_limited', { retryAfter: SAVE_FLOOR_SEC, detail: 'saving too fast' });
  }
  // ...and PER USER, which the floor above cannot do: it is keyed on the row, so
  // a client rotating through N projects multiplies the write rate by N. Checked
  // after authorization so an unauthorized caller cannot spend another user's
  // budget, and before the body is read so a 429 costs no bandwidth either.
  guardSaveRate(ctx, user.id);

  const m = readMeta(request, { requireName: true });
  const payload = await readPayload(request);
  const bytes = m.bytes || bytesFromB64(payload);

  const res = await updateProjectPayload(ctx.env.DB, {
    id: id,
    expectedVersion: ifMatch,
    name: m.name,
    encoding: m.encoding,
    payloadB64: payload,
    payloadChecked: true,          // readPayload() just ran the base64 scan
    payloadBytes: bytes,
    payloadSha: m.sha,
    youtubeUrl: m.youtubeUrl,
    hasSong: m.hasSong,
    trackCount: m.trackCount,
    instruments: m.instruments,
    at: ctx.now
  });
  ctx.log('updateProjectPayload', res);

  if (!res.ok) {
    if (res.code === 'not_found') throw new HttpError(404, 'not_found');
    if (res.code !== 'conflict') throw writeFailure(res);
    // Lost the compare-and-swap between our SELECT and the UPDATE.
    throw new HttpError(409, 'conflict', {
      serverVersion: res.serverVersion,
      serverUpdated: res.serverUpdated,
      serverSha: res.serverSha || ''
    });
  }

  // Answer from the row we already hold plus the fields we just wrote. A second
  // SELECT here would double the read cost of the hottest write in the app.
  const merged = mergeSaved(row, m, bytes, res.version, res.updated);
  return ctx.json({
    project: cardOf(merged, ctx),
    version: res.version,
    updated: res.updated,
    actedAsAdmin: ctx.isAdmin && row.owner_id !== user.id
  }, 200, { 'ETag': etagFor(res.version, true) });
}

function mergeSaved(row, m, bytes, version, updated) {
  const out = {};
  for (const k in row) out[k] = row[k];
  out.name = m.name;
  out.name_lc = m.name.toLowerCase();
  out.encoding = m.encoding;
  out.payload_bytes = bytes;
  out.payload_sha = m.sha;
  out.youtube_url = m.youtubeUrl;
  out.has_song = m.hasSong;
  out.track_count = m.trackCount;
  out.instruments = m.instruments;
  out.version = version;
  out.updated = updated;
  return out;
}

/* ===========================================================================
 * PATCH /api/projects/:id    — rename. Exists SO THAT a rename never
 * re-uploads the payload: an 80 KB round trip becomes a ~40 byte one.
 *
 * Cheap in bandwidth is not cheap in ROWS: every PATCH writes 2 (the row, plus
 * idx_projects_recent because `updated` bumps) and returns the new version the
 * next one needs, so this route gets the same two brakes PUT has — a per-user
 * rate limit and the per-project SAVE_FLOOR_SEC floor.
 * ======================================================================== */
export async function renameRoute(request, ctx) {
  requireClientHeader(request);
  requireUser(ctx.session);
  const user = ctx.user;
  const id = requireFlatId(ctx.params.id);

  const ifMatch = parseIfMatch(request.headers.get('If-Match'));
  if (ifMatch === null) {
    throw new HttpError(412, 'precondition_failed', { detail: 'If-Match: "<version you loaded>" is required' });
  }

  // Small, payload-free body — the one request shape it is safe to parse.
  const body = await readJsonBody(request);
  if (typeof body.name !== 'string') throw bad('name must be a string', 'name');
  const name = cleanText(body.name);
  if (!name) throw bad('name must not be empty', 'name');
  if (name.length > MAX_NAME) throw bad('name exceeds ' + MAX_NAME + ' characters', 'name');

  const got = await getProject(ctx.env.DB, id, { withPayload: false, includeDeleted: true });
  ctx.log('getProject', got);
  const row = got.row;
  if (!row || row.deleted) throw new HttpError(404, 'not_found');
  requireEditor(ctx.session, row);
  if (row.version !== ifMatch) {
    throw new HttpError(409, 'conflict', {
      serverVersion: row.version, serverUpdated: row.updated, serverSha: row.payload_sha || ''
    });
  }
  // Per-project floor, exactly as saveRoute does it — the row is already read,
  // so the check is free. It also means a rename lands at most once per
  // SAVE_FLOOR_SEC on a project that an autosave is actively writing; the client
  // folds a rejected rename back into the next full save.
  if (row.updated > ctx.now - SAVE_FLOOR_SEC) {
    throw new HttpError(429, 'rate_limited', { retryAfter: SAVE_FLOOR_SEC, detail: 'renaming too fast' });
  }
  // Per-user, after authorization so nobody can spend another user's budget.
  guardRenameRate(ctx, user.id);

  const res = await renameProject(ctx.env.DB, { id: id, name: name, expectedVersion: ifMatch, at: ctx.now });
  ctx.log('renameProject', res);
  if (!res.ok) {
    if (res.code === 'not_found') throw new HttpError(404, 'not_found');
    throw new HttpError(409, 'conflict', {
      serverVersion: res.serverVersion, serverUpdated: res.serverUpdated, serverSha: res.serverSha || ''
    });
  }

  row.name = res.name || name;
  row.name_lc = (res.name || name).toLowerCase();
  row.version = res.version;
  row.updated = res.updated || ctx.now;
  return ctx.json({ project: cardOf(row, ctx), version: res.version }, 200, {
    'ETag': etagFor(res.version, true)
  });
}

/* ===========================================================================
 * DELETE /api/projects/:id   — SOFT delete
 * ======================================================================== */
export async function deleteRoute(request, ctx) {
  requireClientHeader(request);
  requireUser(ctx.session);
  const id = requireFlatId(ctx.params.id);

  const got = await getProject(ctx.env.DB, id, { withPayload: false, includeDeleted: true });
  ctx.log('getProject', got);
  const row = got.row;
  if (!row) throw new HttpError(404, 'not_found');
  // A tombstone is invisible to non-admins, which requireEditor also enforces
  // via canRead; stated here so the 404-before-403 ordering is explicit.
  if (row.deleted && !ctx.isAdmin) throw new HttpError(404, 'not_found');
  requireEditor(ctx.session, row);
  // Already deleted: idempotent success, zero rows written.
  if (row.deleted) return ctx.json({ ok: true, id: id, deleted: true });

  const res = await setDeleted(ctx.env.DB, { id: id, deleted: 1, at: ctx.now });
  ctx.log('setDeleted', res);
  if (!res.ok && res.code === 'not_found') throw new HttpError(404, 'not_found');

  // Its recent_views rows are intentionally left behind: three tiny columns
  // each, removing them would be N writes, and hydrateCards already filters to
  // live projects, so tombstoned history is invisible.
  // (code 'noop' — someone else deleted it a moment ago — is still success.)
  return ctx.json({ ok: true, id: id, deleted: true });
}

/* ===========================================================================
 * POST /api/projects/:id/fork
 *
 * The route that makes R1 work: an anonymous editor's in-progress document is
 * sent as the body and becomes the fork's content, so nobody ever learns
 * mid-flow that they were not allowed to edit — they just get their own copy,
 * with the lineage recorded in fork_of.
 *
 * With X-Studio-Fork-Source: server (or an empty body) the stored bytes are
 * copied inside D1 by INSERT ... SELECT and never enter the Worker's heap.
 * ======================================================================== */
export async function forkRoute(request, ctx) {
  requireClientHeader(request);
  requireUser(ctx.session);
  const user = ctx.user;
  const id = requireFlatId(ctx.params.id);
  const m = readMeta(request, { requireIdempotencyKey: true });
  guardCreateRate(ctx, user.id);

  const got = await getProject(ctx.env.DB, id, { withPayload: false, includeDeleted: false });
  ctx.log('getProject', got);
  const src = got.row;
  if (!src) throw new HttpError(404, 'not_found');

  const dup = await findByClientKey(ctx.env.DB, user.id, m.idempotencyKey);
  ctx.log('findByClientKey', dup);
  if (dup.row) return replay(ctx, dup.row, user);

  const name = m.name || copyName(src.name);
  const forkRoot = src.fork_root || src.id;
  const serverSide = m.forkSource === 'server' || (m.forkSource !== 'client' && !hasBody(request));

  let res;
  if (serverSide) {
    // db.js mints the id and retries a PK collision internally; it also derives
    // fork_of / fork_root from the source row inside the INSERT ... SELECT.
    res = await forkProjectServerSide(ctx.env.DB, {
      sourceId: id,
      newId: null,
      ownerId: user.id,
      clientKey: m.idempotencyKey,
      name: name,
      at: ctx.now
    });
    ctx.log('forkProjectServerSide', res);
  } else {
    const payload = await readPayload(request);
    res = await insertProject(ctx.env.DB, {
      id: null,
      ownerId: user.id,
      clientKey: m.idempotencyKey,
      name: name,
      encoding: m.encoding,
      payloadB64: payload,
      payloadChecked: true,        // readPayload() just ran the base64 scan
      payloadBytes: m.bytes || bytesFromB64(payload),
      payloadSha: m.sha,
      youtubeUrl: m.youtubeUrl,
      hasSong: m.hasSong,
      trackCount: m.trackCount,
      instruments: m.instruments,
      forkOf: id,
      forkRoot: forkRoot,
      created: ctx.now,
      updated: ctx.now
    });
    ctx.log('insertProject.fork', res);
  }

  if (!res.ok) {
    if (res.code === 'idempotent_replay') return replay(ctx, res.row, user);
    throw writeFailure(res);
  }

  // The SOURCE ROW IS NEVER WRITTEN — there is no fork counter, deliberately:
  // it would turn a read action into a write on a row many users share.
  const row = withOwnerIdentity(res.row, user);
  if (!row.fork_of) row.fork_of = id;
  if (!row.fork_root) row.fork_root = forkRoot;

  return ctx.json({
    project: cardOf(row, ctx),
    version: row.version || 1,
    forkOf: row.fork_of,
    forkRoot: row.fork_root
  }, 201, {
    'ETag': etagFor(row.version || 1, true),
    'Location': '/api/projects/' + row.id
  });
}

function copyName(name) {
  const base = cleanText(name || 'Untitled') + ' (copy)';
  return base.length > MAX_NAME ? base.slice(0, MAX_NAME) : base;
}

function hasBody(request) {
  const cl = request.headers.get('Content-Length');
  if (cl !== null) return +cl > 0;
  return !!request.body;
}

/* ===========================================================================
 * POST /api/projects/:id/view    — R3's hot write path: 1 row written, or 0
 * ======================================================================== */
export async function viewRoute(request, ctx) {
  // ANONYMOUS FIRST, BEFORE EVERY OTHER CHECK. The authzMatrix specifies that an
  // anonymous view request is a silent 204 with zero rows written, explicitly so
  // a logged-out open is never noisy — and requireClientHeader() ran first, so a
  // client that forgot the header got a 403 bad_client instead. There is nothing
  // to CSRF against when there is no session and no write, and no id to
  // validate when we are not going to use it.
  if (!ctx.user) return ctx.raw(null, 204, { 'X-Studio-View-Recorded': '0' });

  requireClientHeader(request);
  const id = requireFlatId(ctx.params.id);

  // PER-USER BRAKE, before both the read and the write.
  //
  // The ON CONFLICT floor inside recordView() is keyed on (user_id, project_id),
  // so it bounds re-viewing ONE project and nothing else: a signed-in client
  // cycling through N distinct ids writes N rows every VIEW_FLOOR_SEC. The
  // quotaBudget's "a single user physically cannot exceed 5,760 rows/day" held
  // only at N=40; at N>=695 one account exhausts the entire 100,000/day cap, and
  // this library is designed to hold ~12,000 projects.
  //
  // SUPPRESSED SILENTLY, not 429: the whole point of this route is that opening
  // a project is never noisy, and losing a history entry is not worth an error.
  // The response header already tells an interested client it did not record.
  if (!rateLimit('vw:' + ctx.user.id, VIEW_PER_HOUR, 3600, ctx.now)) {
    return ctx.raw(null, 204, { 'X-Studio-View-Recorded': '0' });
  }

  // Cheap existence check before the write. recent_views has no foreign key
  // (by design — projects outlive their author's account), so without this any
  // flat-looking id would mint a history row for a project that never existed.
  // A view of a since-deleted project is simply not recorded, never an error
  // surfaced mid-open. getProjectExists() rather than getProject(): this is a
  // yes/no question on the app's hottest path, and getProject() answered it by
  // selecting all 19 card columns through the LEFT JOIN on `user` — 2 rows read
  // and a join where 1 row and no join will do.
  const got = await getProjectExists(ctx.env.DB, id);
  ctx.log('getProjectExists', got);
  if (!got.exists) return ctx.raw(null, 204, { 'X-Studio-View-Recorded': '0' });

  const res = await recordView(ctx.env.DB, {
    userId: ctx.user.id,
    projectId: id,
    at: ctx.now,
    floorSec: VIEW_FLOOR_SEC
  });
  ctx.log('recordView', res);

  // Same-origin app, so the client can read this header without
  // Access-Control-Expose-Headers. (It would need one the day this moves
  // cross-origin.)
  return ctx.raw(null, 204, { 'X-Studio-View-Recorded': res.recorded ? '1' : '0' });
}

/* ===========================================================================
 * /learn — the ear trainer's practice log (design Part I s13/s14).
 *
 * THE CLOUD COPY IS ADDITIVE, and that shapes both routes. Every completed
 * session is already in the browser's localStorage before either of these is
 * called; the POST is a best-effort backup the client retries on next load, and
 * a failure here is never something the user is shown. So: no idempotency key
 * (the primary key IS one — a replayed POST of the same session collides on
 * (user_id, started) and gets a 409 instead of a duplicate row), no ETag (rows
 * are immutable; there is nothing to revalidate), and no PATCH or DELETE at all
 * (a practice session is a fact that happened, not a document).
 *
 * THE BODY IS JSON HERE, unlike every other write in this file. That is not a
 * departure from house rule 1 — the payload stays opaque, it is just small
 * enough to model as fields: thirteen scalars the server must bound, plus one
 * `detail` string it never parses. The projects payload is 80 KB of base64 that
 * would cost more CPU to escape than to store; this is under 8 KB and every
 * field of it is a number the CHECK constraints care about.
 * ======================================================================== */

/* --- field validators. Every one of them throws bad(detail, field), so a
 * malformed session tells the client exactly which field it got wrong instead
 * of a blanket 400 or (worse) a CHECK-constraint 500 three layers down. ---- */

/** Strict: a JSON number that is an integer, in range. NOT parseInt on a
 *  string — the client is ours and sends JSON numbers, and accepting "12abc"
 *  here is how a typo becomes a silently truncated statistic. */
function learnInt(body, field, min, max) {
  const v = body[field];
  if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v) {
    throw bad('expected an integer', field);
  }
  if (v < min || v > max) throw bad('out of range [' + min + ', ' + max + ']', field);
  return v;
}

/** 0/1 on the wire (design Part I s13 spells singGate as 0|1), but a real
 *  boolean is accepted too: JSON.stringify of a JS `false` is the single most
 *  likely client-side accident and rejecting it would buy nothing. */
function learnBool(body, field) {
  const v = body[field];
  if (v === 0 || v === false) return 0;
  if (v === 1 || v === true) return 1;
  throw bad('expected 0 or 1', field);
}

function learnEnum(body, field, allowed) {
  const v = body[field];
  if (typeof v !== 'string' || allowed.indexOf(v) < 0) {
    throw bad("expected one of '" + allowed.join("', '") + "'", field);
  }
  return v;
}

/**
 * `detail` — the per-degree tally. STORED AS OPAQUE TEXT and never parsed by
 * the Worker (house rule 1), so what we validate is its TYPE and its LENGTH,
 * nothing about its shape.
 *
 * A string and a plain object are both accepted, and the object is serialized
 * here. That is deliberate rather than sloppy: the client's record carries
 * `detail` as compact JSON, and whether it arrives pre-stringified or as a
 * nested object depends on how EarStore hands it to Api.learnSaveSession —
 * a detail of the client that must not be able to produce a 400. Either way
 * exactly one string reaches D1, and it is the string that comes back out.
 * (JSON.parse produced this value, so it cannot be circular and stringify
 * cannot throw.)
 */
function learnDetail(body) {
  const v = body.detail;
  if (v === undefined || v === null) return '';
  let s;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'object' && !Array.isArray(v)) s = JSON.stringify(v);
  else throw bad('expected a JSON string or object', 'detail');
  if (s.length > MAX_DETAIL_CHARS) {
    throw bad('exceeds ' + MAX_DETAIL_CHARS + ' characters', 'detail');
  }
  return s;
}

function clampLearnLimit(raw) {
  const n = parseInt(raw || '', 10);
  if (!isFinite(n)) return DEFAULT_LEARN_LIMIT;
  return n < 1 ? 1 : (n > MAX_LEARN_LIMIT ? MAX_LEARN_LIMIT : n);
}

/**
 * The aggregate the end screen and the daily-encouragement line need, computed
 * over the rows we already hold. NO EXTRA STATEMENT: a COUNT(*) and a SUM()
 * across the user's whole history would be a second query for a number the
 * client can already see, and the local EarStore is the all-time authority
 * anyway (design Part I s13 — local first, cloud additive).
 *
 * WHAT THESE NUMBERS HONESTLY ARE, because two of them are windowed:
 *  · totalSessions / totalMinutes cover THE RETURNED WINDOW, not all time. At
 *    the default limit of 60 that is roughly two months of daily practice.
 *  · streak counts back from today over consecutive days holding at least
 *    LEARN_STREAK_MIN_SEC of practice. It can be UNDERSTATED if the window cuts
 *    it off — a user who logs several sessions a day exhausts 60 rows in under
 *    three weeks. The client asks for more when it wants a longer streak.
 *  · Days are UTC days (started / 86400). The server has no idea what timezone
 *    the user is in, and inventing one would be worse than being consistent:
 *    the client's own EarStore.stats() computes the streak in local time and is
 *    what the UI shows. This is the cross-device cross-check, not the display.
 *
 * An empty TODAY does not break the streak — today is still in progress, and a
 * user opening the app at 9 a.m. must not be told their streak is over.
 */
function learnStats(sessions, now) {
  const perDay = Object.create(null);      // null-prototype: day numbers are
  let totalSec = 0;                        // keys, and 'constructor' must not
  for (let i = 0; i < sessions.length; i++) {   // resolve to a function
    const s = sessions[i];
    totalSec += s.durationSec;
    const day = Math.floor(s.started / 86400);
    perDay[day] = (perDay[day] || 0) + s.durationSec;
  }
  const today = Math.floor(now / 86400);
  let day = (perDay[today] >= LEARN_STREAK_MIN_SEC) ? today : today - 1;
  let streak = 0;
  while (perDay[day] >= LEARN_STREAK_MIN_SEC) { streak++; day--; }
  return {
    totalSessions: sessions.length,
    totalMinutes: Math.round(totalSec / 60),
    streak: streak
  };
}

/* ===========================================================================
 * POST /api/learn/sessions   — record one completed session. 1 row written.
 * ======================================================================== */
export async function learnCreateSessionRoute(request, ctx) {
  // Same order as createRoute (routes.js:602): the CSRF lock first. A custom
  // header forces a preflight on any cross-origin attempt and this same-origin
  // app answers no preflight at all.
  requireClientHeader(request);
  requireUser(ctx.session);
  const user = ctx.user;
  // Before the body is read, so a looping client's 429 costs no bandwidth
  // either — and after requireUser, so nobody can spend another user's budget.
  guardLearnRate(ctx, user.id);

  const body = await readJsonBody(request, MAX_LEARN_BODY);

  // `started` is the CLIENT's clock. MAX_UNIX_SECONDS (routes.js:79) is the
  // same absolute clamp the admin import header uses; the two window tests
  // after it are what actually keep a broken clock out of the log.
  const started = learnInt(body, 'started', 1, MAX_UNIX_SECONDS);
  if (started > ctx.now + LEARN_FUTURE_SEC) {
    throw bad('is more than a day ahead of the server clock', 'started');
  }
  if (started < ctx.now - LEARN_PAST_SEC) {
    throw bad('is more than a year in the past', 'started');
  }

  const durationSec = learnInt(body, 'durationSec', 0, MAX_LEARN_DURATION);
  const level = learnInt(body, 'level', 1, 7);
  const mode = learnEnum(body, 'mode', LEARN_MODES);
  const context = learnEnum(body, 'context', LEARN_CONTEXTS);
  const taper = learnInt(body, 'taper', 0, 8);
  if (LEARN_TAPERS.indexOf(taper) < 0) {
    throw bad('expected ' + LEARN_TAPERS.join(', ') + ' (0 = once per session)', 'taper');
  }
  const singGate = learnBool(body, 'singGate');

  const questions = learnInt(body, 'questions', 0, MAX_LEARN_QUESTIONS);
  // Stated as its own check rather than folded into learnInt's range so the
  // 400 says what the actual invariant is; "out of range [0, 7]" would leave a
  // client author guessing where the 7 came from.
  const correct = learnInt(body, 'correct', 0, MAX_LEARN_QUESTIONS);
  if (correct > questions) throw bad('cannot exceed questions', 'correct');
  const assists = learnInt(body, 'assists', 0, MAX_LEARN_ASSISTS);

  // Mic trials are a subset of the questions asked, and each contributes at most
  // one octave of |deviation| — so an absent mic pins centsSum to 0 by
  // arithmetic rather than by a separate rule.
  const centsN = learnInt(body, 'centsN', 0, MAX_LEARN_QUESTIONS);
  if (centsN > questions) throw bad('cannot exceed questions', 'centsN');
  const centsSum = learnInt(body, 'centsSum', 0, centsN * MAX_ABS_CENTS);

  const res = await insertEarSession(ctx.env.DB, {
    userId: user.id,
    started: started,
    durationSec: durationSec,
    level: level,
    mode: mode,
    context: context,
    taper: taper,
    singGate: singGate,
    questions: questions,
    correct: correct,
    assists: assists,
    centsSum: centsSum,
    centsN: centsN,
    detail: learnDetail(body)
  });
  ctx.log('insertEarSession', res);

  if (!res.ok) {
    // Three collisions on (user_id, started) in a row. db.js walks `started`
    // forward one second per attempt rather than overwriting, so this means a
    // stuck client, not a second browser tab.
    if (res.code === 'conflict') {
      throw new HttpError(409, 'conflict', {
        detail: 'a session with that start time already exists'
      });
    }
    // Backstops. The validation above cannot produce these — db.js re-checks the
    // user id and the detail cap rather than writing a row it would regret.
    throw bad('could not store the session (' + res.code + ')');
  }

  // 201 with the STORED row, not the submitted one: `started` may have moved
  // forward a second to dodge a collision, and the client merges by `started`
  // (design Part I s13), so it has to be told which value actually landed.
  return ctx.json({ session: toEarSession(res.row) }, 201);
}

/* ===========================================================================
 * GET /api/learn/sessions?limit=60   — the caller's OWN sessions. 0 rows written.
 *
 * There is no `owner` parameter and no admin variant, deliberately: unlike
 * projects (which are public artifacts, R2), a practice log is private to the
 * person who made it and there is no product reason for anyone else to read it.
 * The scoping is therefore not a filter the caller passes but ctx.user.id,
 * bound directly into the WHERE clause.
 * ======================================================================== */
export async function learnListSessionsRoute(request, ctx) {
  // 401 rather than an empty list: unlike GET /api/me, the client only calls
  // this when it already believes it is signed in, so silence would hide an
  // expired cookie behind "you have never practised".
  requireUser(ctx.session);

  const res = await listEarSessions(
    ctx.env.DB, ctx.user.id, clampLearnLimit(ctx.url.searchParams.get('limit')));
  ctx.log('listEarSessions', res);

  const rows = res.rows || [];
  const sessions = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) sessions[i] = toEarSession(rows[i]);

  // Newest first, straight off the reverse index scan — the stats walk does not
  // reorder them and the client renders them in this order.
  return ctx.json({ sessions: sessions, stats: learnStats(sessions, ctx.now) });
}

/* ===========================================================================
 * admin  (R5: GitHub user 21693187, keyed off the NUMERIC id in auth.js)
 * ======================================================================== */
export async function adminListRoute(request, ctx) {
  requireAdmin(ctx.session);
  const sp = ctx.url.searchParams;
  const owner = sp.get('owner');
  if (owner !== null && (!owner.trim() || owner.length > MAX_OWNER_ID)) {
    throw bad('owner must be a user id', 'owner');
  }

  const deleted = (sp.get('deleted') || 'all').toLowerCase();
  if (deleted !== '0' && deleted !== '1' && deleted !== 'all') {
    throw bad('expected 0, 1 or all', 'deleted');
  }

  const res = await listProjects(ctx.env.DB, {
    order: 'updated',
    q: readQ(ctx.url),
    ownerId: owner ? owner.trim() : null,
    viewerId: ctx.user.id,
    includeDeleted: deleted !== '0',
    deletedOnly: deleted === '1',
    limit: clampLimit(sp.get('limit')),
    cursor: readCursor(ctx.url)
  });
  ctx.log('listProjects.admin', res);

  const rows = res.rows || [];
  const projects = new Array(rows.length);
  // extra.admin adds the two fields only this listing shows: deleted and
  // payloadBytes.
  for (let i = 0; i < rows.length; i++) projects[i] = cardOf(rows[i], ctx, { admin: true });

  return ctx.json({
    projects: projects,
    nextCursor: res.nextCursor || null,
    order: res.orderUsed || 'updated',
    orderDegraded: !!res.degraded
  });
}

export async function adminRestoreRoute(request, ctx) {
  requireAdmin(ctx.session);
  requireClientHeader(request);
  const id = requireFlatId(ctx.params.id);

  const got = await getProject(ctx.env.DB, id, { withPayload: false, includeDeleted: true });
  ctx.log('getProject', got);
  const row = got.row;
  if (!row) throw new HttpError(404, 'not_found');
  // Already live: do not burn 2 rows and a version bump restating it.
  if (!row.deleted) return ctx.json({ project: cardOf(row, ctx), version: row.version });

  const res = await setDeleted(ctx.env.DB, { id: id, deleted: 0, at: ctx.now });
  ctx.log('setDeleted', res);
  if (!res.ok && res.code === 'not_found') throw new HttpError(404, 'not_found');

  row.deleted = 0;
  row.version = res.version || row.version;
  row.updated = ctx.now;
  return ctx.json({ project: cardOf(row, ctx), version: row.version });
}

export async function adminHardDeleteRoute(request, ctx) {
  requireAdmin(ctx.session);
  requireClientHeader(request);
  const id = requireFlatId(ctx.params.id);

  // ?confirm must echo the path id, so a mis-fired request cannot destroy data.
  if (ctx.url.searchParams.get('confirm') !== id) {
    throw bad('confirm= must equal the project id being hard-deleted', 'confirm');
  }

  const got = await getProject(ctx.env.DB, id, { withPayload: false, includeDeleted: true });
  ctx.log('getProject', got);
  if (!got.row) throw new HttpError(404, 'not_found');

  // Irreversible outside D1 Time Travel's 7 days. One statement, 4 rows written.
  // The project's recent_views rows are NOT removed here and `viewsRemoved` is
  // therefore always 0: project_id is the trailing column of recent_views' only
  // index, so deleting by it is a full table scan (see db.js). The rows are
  // invisible — hydrateCards filters to live projects — and the prune cron reaps
  // them once they age out.
  const res = await hardDeleteProject(ctx.env.DB, id);
  ctx.log('hardDeleteProject', res);
  if (!res.ok) throw new HttpError(404, 'not_found');

  return ctx.json({ ok: true, hardDeleted: id, viewsRemoved: res.viewsRemoved || 0 });
}

export async function adminTransferRoute(request, ctx) {
  requireAdmin(ctx.session);
  requireClientHeader(request);
  const id = requireFlatId(ctx.params.id);

  const body = await readJsonBody(request);
  const ownerId = typeof body.ownerId === 'string' ? body.ownerId.trim() : '';
  if (!ownerId || ownerId.length > MAX_OWNER_ID) throw bad('ownerId must be a user id', 'ownerId');

  const got = await getProject(ctx.env.DB, id, { withPayload: false, includeDeleted: true });
  ctx.log('getProject', got);
  const row = got.row;
  if (!row) throw new HttpError(404, 'not_found');
  if (row.owner_id === ownerId) return ctx.json({ project: cardOf(row, ctx) });   // no-op, no write

  // The one place this module writes SQL, and only to reject a typo before it
  // orphans a project: projects.owner_id has NO foreign key by design (projects
  // are public artifacts that must survive their author's account being
  // deleted), so this probe is the whole of the referential integrity here.
  // If the table is not where we expect it, log and proceed — a wrong owner is
  // repairable with a second transfer; refusing every transfer is not.
  let known = true;
  try {
    known = !!(await ctx.env.DB.prepare('SELECT id FROM user WHERE id = ?1 LIMIT 1').bind(ownerId).first());
  } catch (e) {
    console.log(JSON.stringify({
      t: 'warn', op: 'transfer', detail: 'owner existence probe failed',
      e: String((e && e.message) || e)
    }));
  }
  if (!known) throw bad('unknown ownerId', 'ownerId');

  const res = await transferOwner(ctx.env.DB, { id: id, ownerId: ownerId, at: ctx.now });
  ctx.log('transferOwner', res);
  if (!res.ok) {
    if (res.code === 'client_key_conflict') {
      throw new HttpError(409, 'conflict', { detail: 'that owner already has a project with this client key' });
    }
    throw new HttpError(404, 'not_found');
  }

  // The only write in the app that touches uq_projects_owner_key: 3 rows.
  return ctx.json({ project: cardOf(res.row, ctx) });
}

/* POST /api/admin/import — the ONLY route that accepts a caller-chosen id.
 * Everyone else gets a server-minted one, which is what prevents id squatting
 * in a public, globally-keyed namespace. Used once by tools/seed-d1.js to land
 * the six committed projects on their existing ids so deployed URLs stay
 * stable. */
export async function adminImportRoute(request, ctx) {
  requireAdmin(ctx.session);
  requireClientHeader(request);
  const admin = ctx.user;

  const id = (request.headers.get('X-Studio-Id') || '').trim();
  if (!isFlatId(id)) throw bad('X-Studio-Id must match /^[A-Za-z0-9_-]{1,64}$/', 'X-Studio-Id');

  const m = readMeta(request, { requireName: true });
  // Unix SECONDS, integers. The desktop backend writes FLOAT seconds
  // (server/app.py time.time()), so tools/seed-d1.js floors them — and falls
  // back to the file mtime for the seed projects that carry no `updated` at
  // all, because `updated DESC` is the anonymous default order and that is the
  // very first thing a visitor sees.
  const created = intHeader(request, 'X-Studio-Created', 0, MAX_UNIX_SECONDS) || ctx.now;
  const updated = intHeader(request, 'X-Studio-Updated', 0, MAX_UNIX_SECONDS) || created;
  const ownerHeader = (request.headers.get('X-Studio-Owner') || '').trim();
  if (ownerHeader.length > MAX_OWNER_ID) throw bad('owner id too long', 'X-Studio-Owner');
  const ownerId = ownerHeader || admin.id;

  const got = await getProject(ctx.env.DB, id, { withPayload: false, includeDeleted: true });
  ctx.log('getProject', got);
  if (got.row) {
    // Same content re-imported (a re-run of the seed script): idempotent 200.
    if (m.sha && got.row.payload_sha && got.row.payload_sha === m.sha) {
      return ctx.json({ project: cardOf(got.row, ctx), version: got.row.version }, 200, {
        'X-Studio-Idempotent-Replay': '1'
      });
    }
    throw new HttpError(409, 'conflict', {
      detail: 'that id already exists with different content',
      serverVersion: got.row.version,
      serverSha: got.row.payload_sha || ''
    });
  }

  const payload = await readPayload(request);
  const res = await insertProject(ctx.env.DB, {
    id: id,
    // NULL client_key: imports may repeat per owner, because SQLite treats
    // NULLs as distinct in uq_projects_owner_key.
    clientKey: null,
    ownerId: ownerId,
    name: m.name,
    encoding: m.encoding,
    payloadB64: payload,
    payloadChecked: true,          // readPayload() just ran the base64 scan
    payloadBytes: m.bytes || bytesFromB64(payload),
    payloadSha: m.sha,
    youtubeUrl: m.youtubeUrl,
    hasSong: m.hasSong,
    trackCount: m.trackCount,
    instruments: m.instruments,
    forkOf: null,
    forkRoot: null,
    created: created,
    updated: updated
  });
  ctx.log('insertProject.import', res);

  if (!res.ok) {
    if (res.code === 'idempotent_replay') return replay(ctx, res.row, admin);
    throw writeFailure(res);
  }

  const row = withOwnerIdentity(res.row, ownerId === admin.id ? admin : null);
  return ctx.json({ project: cardOf(row, ctx) }, 201, { 'Location': '/api/projects/' + row.id });
}

/* ===========================================================================
 * the route table  —  [method, pattern, handler]
 *
 * worker/index.js compiles this once per isolate and matches on segment COUNT
 * first, so a literal segment ('head', 'fork', 'view', 'restore', 'transfer')
 * can never be shadowed by a ':id' at a different depth, and '/admin/...'
 * cannot collide with '/projects/...' because they differ in segment one.
 * Order here is for reading, not for precedence.
 * ======================================================================== */
export const ROUTES = [
  ['GET', '/me', meRoute],

  ['GET', '/projects', listRoute],
  ['POST', '/projects', createRoute],
  ['GET', '/projects/:id', getProjectRoute],
  ['PUT', '/projects/:id', saveRoute],
  ['PATCH', '/projects/:id', renameRoute],
  ['DELETE', '/projects/:id', deleteRoute],
  ['GET', '/projects/:id/head', headRoute],
  ['POST', '/projects/:id/fork', forkRoute],
  ['POST', '/projects/:id/view', viewRoute],

  // Two segments, like '/projects/:id' — but segment one is the literal
  // 'learn', so the router's segment walk separates them on the first compare
  // and neither can ever shadow the other.
  ['POST', '/learn/sessions', learnCreateSessionRoute],
  ['GET', '/learn/sessions', learnListSessionsRoute],

  ['GET', '/admin/projects', adminListRoute],
  ['POST', '/admin/import', adminImportRoute],
  ['DELETE', '/admin/projects/:id', adminHardDeleteRoute],
  ['POST', '/admin/projects/:id/restore', adminRestoreRoute],
  ['POST', '/admin/projects/:id/transfer', adminTransferRoute]
];
