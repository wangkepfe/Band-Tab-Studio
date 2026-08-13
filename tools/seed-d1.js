#!/usr/bin/env node
/* ============================================================================
 * tools/seed-d1.js — land the six COMMITTED projects in D1 on their EXISTING
 * ids, so the urls that are already in the wild keep resolving.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A MIGRATION.
 * seed-bolan-shanghai alone is ~78,000 base64 characters. An INSERT literal
 * carrying it would be a ~78 KB SQL statement — under D1's 100 KB statement-text
 * cap, but with no headroom and in violation of the bind-as-a-parameter rule
 * that the whole schema is built around. So the payload travels the same way it
 * does from the browser: gzip -> base64 -> the raw request BODY of
 * POST /api/admin/import, where the Worker binds it as one TEXT parameter and
 * never parses it.
 *
 * WHAT IT TALKS TO (verified against worker/routes.js at the time of writing —
 * routes.js is under concurrent edit, so these are stated exactly):
 *   POST /api/admin/import              routes.js:1022 adminImportRoute
 *     requireAdmin(session) + requireClientHeader(request)
 *     headers: X-Studio-Client:1, X-Studio-Id, X-Studio-Name (percent-encoded),
 *              X-Studio-Encoding, X-Studio-Bytes, X-Studio-Sha,
 *              X-Studio-Youtube (percent-encoded), X-Studio-Has-Song,
 *              X-Studio-Track-Count, X-Studio-Instruments,
 *              X-Studio-Created, X-Studio-Updated, X-Studio-Owner (optional)
 *     body: the base64 payload and nothing else (no JSON envelope)
 *     201 {project}                     -> inserted
 *     200 + X-Studio-Idempotent-Replay  -> same id, same payload_sha: no write
 *     409 conflict {serverVersion,...}  -> same id, DIFFERENT content
 *   GET  /api/projects/:id/head         routes.js:490  headRoute   (version)
 *   PUT  /api/projects/:id              routes.js:572  saveRoute   (the update
 *                                       path for a 409; If-Match is REQUIRED)
 *   POST /api/admin/projects/:id/restore routes.js:927 adminRestoreRoute
 *                                       (no-op and zero rows written when the
 *                                        row is already live — routes.js:937)
 *   GET  /api/me                        routes.js:376  meRoute     (preflight)
 *
 * IDEMPOTENT BY CONSTRUCTION. Re-running never duplicates: the id is
 * caller-chosen, so a second run either replays (identical payload_sha) or
 * UPDATEs in place through PUT. Nothing here ever mints a second row.
 *
 * CREDENTIALS. Better Auth is cookie-only (worker/auth.js:377-383, httpOnly +
 * sameSite lax); there is no bearer-token or API-key path into the admin routes.
 * So the credential is a session cookie, taken from --cookie / --cookie-file /
 * $STUDIO_ADMIN_COOKIE. Nothing is hardcoded and .dev.vars is NEVER read.
 *
 * CONVENTIONS THIS SCRIPT IS RESPONSIBLE FOR UPHOLDING:
 *  * ALL timestamps are UNIX SECONDS as INTEGERS. The desktop backend writes
 *    FLOAT seconds (server/app.py time.time()), e.g. seed-private-eyes carries
 *    updated = 1785264878.68923 — floor() it. A project with no `updated` key
 *    falls back to the file's mtime. Milliseconds are never emitted.
 *  * The payload is encoded EXACTLY as tab-studio/web/api.js:152 encodePayload
 *    does it: sha256 over the pre-gzip UTF-8 JSON, gzip, then base64. The
 *    library-card fields are derived by the same rules as api.js:184 metaFacts,
 *    so a seeded row and a browser-saved row are indistinguishable.
 *
 * USAGE
 *   node tools/seed-d1.js --url https://band-tab-studio.example.workers.dev \
 *                         --cookie-file .seed-cookie.txt
 *   node tools/seed-d1.js --dry-run            # encode only, no network at all
 *
 * Runs on plain Node 24 with no dependencies (global fetch + node: builtins).
 * NOTE: this file is CommonJS because the ROOT package.json declares no
 * "type": "module" (worker/package.json does, but tools/ is not under it).
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

/* ---------------------------------------------------------------------------
 * limits and constants — mirrored from the code they must agree with
 * ------------------------------------------------------------------------ */
const MAX_PAYLOAD_CHARS = 1500000;   // worker/db.js:65, api.js:29 — the 413 ceiling
const MAX_NAME_CHARS = 200;          // routes.js:63 MAX_NAME
const MAX_UNIX_SECONDS = 4102444800; // routes.js:77 — 2100-01-01, the header clamp
const FLAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ADMIN_GITHUB_ID = '21693187';  // R5, worker/auth.js:120
const SAVE_FLOOR_SEC = 3;            // routes.js:76 — PUT is 429 inside this window
const REQUEST_TIMEOUT_MS = 90000;
const MAX_ATTEMPTS = 3;              // per request, for 429 / 5xx / network blips

// Advisory only: the six ids that already appear in deployed urls. A seventh
// project directory is seeded too; a MISSING one is a warning, not a filter.
const EXPECTED_IDS = [
  'df07094f72b2',
  'on-the-fly-daniel-hayn',
  'seed-bolan-shanghai',
  'seed-private-eyes',
  'seed-too-many-kicks',
  'seed-too-many-kicks-live'
];

/* ---------------------------------------------------------------------------
 * argv / env
 * ------------------------------------------------------------------------ */
const HELP = [
  'tools/seed-d1.js — import the committed projects/ into D1 via POST /api/admin/import',
  '',
  'Options (argv wins over env):',
  '  --url <base>          Worker origin, e.g. https://band-tab-studio.example.workers.dev',
  '                        env: STUDIO_BASE_URL',
  '  --cookie <value>      Admin session cookie, the raw Cookie header value',
  '                        (e.g. "__Secure-better-auth.session_token=abc...").',
  '                        env: STUDIO_ADMIN_COOKIE',
  '  --cookie-file <path>  Read that value from a file instead (keeps the secret',
  '                        out of your shell history and the process list).',
  '                        env: STUDIO_ADMIN_COOKIE_FILE',
  '  --projects <dir>      Project root (default: <repo>/projects)',
  '  --only a,b            Seed only these ids',
  '  --owner <userId>      Better Auth user id to own the rows',
  '                        (default: the authenticated admin, which is what R5 wants)',
  '  --dry-run             Encode and report; make no network request at all',
  '  -h, --help',
  '',
  'Getting the cookie: sign in to the deployment with the admin GitHub account',
  '(numeric id ' + ADMIN_GITHUB_ID + '), then copy the session cookie from the',
  "browser's devtools (Application -> Cookies) into a file and pass",
  '--cookie-file. This script never reads .dev.vars and never stores the value.',
  '',
  'Exit code is 0 only when every project landed.'
].join('\n');

function parseArgs(argv) {
  const o = {
    url: process.env.STUDIO_BASE_URL || '',
    cookie: process.env.STUDIO_ADMIN_COOKIE || '',
    cookieFile: process.env.STUDIO_ADMIN_COOKIE_FILE || '',
    projects: '',
    only: null,
    owner: '',
    dryRun: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(a + ' needs a value');
      return v;
    };
    if (a === '--url') o.url = next();
    else if (a === '--cookie') o.cookie = next();
    else if (a === '--cookie-file') o.cookieFile = next();
    else if (a === '--projects') o.projects = next();
    else if (a === '--only') o.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--owner') o.owner = next();
    else if (a === '--dry-run' || a === '--dry') o.dryRun = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error('unknown option: ' + a);
  }
  return o;
}

/* ---------------------------------------------------------------------------
 * payload codec — the Node twin of tab-studio/web/api.js:152 encodePayload
 *
 * The sha is taken over the PRE-GZIP UTF-8 bytes (schema.sql: "client-declared
 * sha256 hex of the pre-gzip UTF-8 JSON"), which is what makes a re-run
 * idempotent regardless of the gzip implementation: two machines with different
 * zlib builds produce different compressed bytes but the SAME sha, so the
 * import route's replay check (routes.js:1046) still fires.
 *
 * We gzip the file's own bytes rather than a re-serialized JSON.stringify of the
 * parsed object, so the payload round-trips to exactly the committed file.
 * ------------------------------------------------------------------------ */
function encodePayload(jsonText) {
  const raw = Buffer.from(jsonText, 'utf8');
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  // level 9, unlike the browser's CompressionStream default: the compression
  // level is invisible to every reader (gunzip does not care) and it is what the
  // storage ceiling in the schema notes was measured at — seed-bolan-shanghai
  // lands on 77,688 base64 characters here against the 77,888 recorded there.
  // These six rows are written once and read forever; buy the smaller row.
  const gz = zlib.gzipSync(raw, { level: 9 });
  return {
    payloadB64: gz.toString('base64'),
    rawBytes: raw.length,
    bytes: gz.length,          // the PRE-base64 byte count, per schema.sql
    sha: sha,
    encoding: 'gzip+b64'       // Node always has zlib; api.js's identity+b64
  };                           // fallback exists only for Safari < 16.4
}

// api.js:184 metaFacts — the library card fields the list route can never derive
// itself, because the Worker never parses the payload.
function metaFacts(meta) {
  const tracks = (meta && meta.tracks) || [];
  const seen = Object.create(null);
  const insts = [];
  for (let i = 0; i < tracks.length; i++) {
    const id = (tracks[i] && tracks[i].instrument) || '';
    if (id && !seen[id]) { seen[id] = 1; insts.push(id); }
  }
  return {
    youtubeUrl: (meta && meta.youtubeUrl) || '',
    hasSong: (meta && meta.song) ? 1 : 0,
    trackCount: tracks.length,
    instruments: insts.join(',')
  };
}

// api.js:86 clampName. readMeta(requireName:true) rejects an empty name, and the
// six committed projects all have one — 'Untitled' is the same backstop the
// browser client uses.
function clampName(n) {
  const s = String(n == null ? '' : n).trim() || 'Untitled';
  return s.length > MAX_NAME_CHARS ? s.slice(0, MAX_NAME_CHARS) : s;
}

// Header values are latin-1 on the wire and one of the six names is CJK
// ("波兰首都是上海"), so free text is percent-encoded exactly as api.js:83 pct()
// does it; routes.js:131 decodeHeader() reverses it.
function pct(s) { return encodeURIComponent(String(s == null ? '' : s)); }

/* ---------------------------------------------------------------------------
 * timestamps — UNIX SECONDS, INTEGER, always
 *
 * Three shapes have to be handled and only one of them is clean:
 *   1785264878.68923  float seconds  (seed-private-eyes; server/app.py writes
 *                                     time.time() straight out)  -> floor
 *   1735689600        integer seconds (already correct)           -> as-is
 *   absent            -> the file's mtime, floored
 * Anything past 2100-01-01 is assumed to be MILLISECONDS that leaked in from a
 * Date.now() somewhere and is divided down rather than sent to a route that
 * would 400 it (routes.js:1036 clamps to MAX_UNIX_SECONDS).
 * ------------------------------------------------------------------------ */
function toUnixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const secs = n > MAX_UNIX_SECONDS ? n / 1000 : n;   // milliseconds guard
  const floored = Math.floor(secs);
  if (floored <= 0 || floored > MAX_UNIX_SECONDS) return null;
  return floored;
}

function stampsFor(meta, stat) {
  const mtime = toUnixSeconds(stat.mtimeMs / 1000) || Math.floor(Date.now() / 1000);
  const updated = toUnixSeconds(meta && meta.updated) || mtime;
  // No committed project carries `created`; falling back to `updated` keeps the
  // card honest ("created" is never later than "updated") without inventing a
  // date. `updated DESC` is the anonymous default library order, so it is the
  // one of the two that a visitor actually sees.
  const created = toUnixSeconds(meta && meta.created) || updated;
  return {
    created: Math.min(created, updated),
    updated: updated,
    updatedFromMtime: !toUnixSeconds(meta && meta.updated)
  };
}

/* ---------------------------------------------------------------------------
 * reading projects/
 * ------------------------------------------------------------------------ */
function repoRoot() { return path.resolve(__dirname, '..'); }

function listProjectDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    throw new Error('cannot read the projects folder ' + root + ': ' + e.message);
  }
  // projects/.seeded is a FILE, not a project — withFileTypes filtering is not
  // optional here.
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'project.json')))
    .map((e) => e.name)
    .sort();
}

function loadProject(root, id) {
  const file = path.join(root, id, 'project.json');
  const stat = fs.statSync(file);
  const buf = fs.readFileSync(file);
  // Strip a UTF-8 BOM if one ever appears: JSON.parse rejects it in both Node
  // and the browser, so the stripped text is what we parse AND what we ship.
  const text = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    ? buf.slice(3).toString('utf8')
    : buf.toString('utf8');

  let meta;
  try {
    meta = JSON.parse(text);
  } catch (e) {
    throw new Error(id + '/project.json is not valid JSON: ' + e.message);
  }
  if (!meta || typeof meta !== 'object') throw new Error(id + '/project.json is not an object');
  if (!FLAT_ID.test(id)) throw new Error('folder name "' + id + '" is not a flat id /^[A-Za-z0-9_-]{1,64}$/');

  const enc = encodePayload(text);
  if (enc.payloadB64.length > MAX_PAYLOAD_CHARS) {
    throw new Error(id + ' encodes to ' + enc.payloadB64.length + ' base64 chars, over the ' +
      MAX_PAYLOAD_CHARS + ' ceiling the Worker answers with 413');
  }

  const stamps = stampsFor(meta, stat);
  return {
    id: id,                          // the FOLDER name is the deployed url id
    file: file,
    name: clampName(meta.name),
    innerId: typeof meta.id === 'string' ? meta.id : '',
    facts: metaFacts(meta),
    enc: enc,
    created: stamps.created,
    updated: stamps.updated,
    updatedFromMtime: stamps.updatedFromMtime
  };
}

/* ---------------------------------------------------------------------------
 * http
 * ------------------------------------------------------------------------ */
function isHtml(res) {
  return /text\/html/i.test(res.headers.get('content-type') || '');
}

function httpError(status, code, detail, body) {
  const e = new Error(detail ? code + ': ' + detail : code);
  e.status = status;
  e.code = code;
  e.body = body || null;
  return e;
}

// One call. Returns { status, headers, json, text }. Rejects only on a transport
// failure or an unusable response shape — an HTTP error status comes back as
// data, because every caller here switches on it.
async function once(ctx, method, apiPath, headers, body) {
  const url = ctx.base + '/api' + apiPath;
  const h = Object.assign({ 'Cookie': ctx.cookie, 'Accept': 'application/json' }, headers || {});

  let res;
  try {
    res = await fetch(url, {
      method: method,
      headers: h,
      body: body,
      redirect: 'manual',                        // a 301 http->https would silently
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)   // drop the Cookie header
    });
  } catch (e) {
    throw httpError(0, 'network', method + ' ' + url + ' — ' + ((e && e.message) || e));
  }

  if (res.status >= 300 && res.status < 400) {
    throw httpError(res.status, 'redirected',
      'the server redirected to ' + (res.headers.get('location') || '?') +
      ' — use that origin in --url (a redirect drops the Cookie header)');
  }
  // The SPA fallback answers a MISSING route with index.html at HTTP 200, so a
  // 200 alone never proves the route exists. Same trap api.js:56 guards.
  if (isHtml(res)) {
    throw httpError(res.status, 'not_json',
      method + ' ' + apiPath + ' returned HTML, not JSON — the Worker is probably not ' +
      'deployed, or wrangler.jsonc is missing assets.run_worker_first ["/api", "/api/*"]');
  }

  const text = await res.text().catch(() => '');
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
  return { status: res.status, headers: res.headers, json: json, text: text };
}

function errorOf(r) {
  const env = (r.json && r.json.error) || {};
  return {
    code: env.code || ('http_' + r.status),
    detail: env.detail || env.message || (r.text ? r.text.slice(0, 200) : ''),
    extra: env
  };
}

// Retries only what is worth retrying: a transport blip, a 429 (Retry-After is
// honoured — saveRoute's 3 s floor is the one we actually expect to hit), and a
// 5xx. A 4xx is a decision, not an accident.
async function api(ctx, method, apiPath, headers, body) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let r;
    try {
      r = await once(ctx, method, apiPath, headers, body);
    } catch (e) {
      last = e;
      if (e.code !== 'network' || attempt === MAX_ATTEMPTS) throw e;
      await sleep(attempt * 1000);
      continue;
    }
    if ((r.status === 429 || r.status >= 500) && attempt < MAX_ATTEMPTS) {
      const ra = parseInt(r.headers.get('Retry-After') || '', 10);
      const waitSec = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) : SAVE_FLOOR_SEC;
      await sleep(waitSec * 1000 + 500);
      last = r;
      continue;
    }
    return r;
  }
  throw last instanceof Error ? last : httpError(last.status, errorOf(last).code, errorOf(last).detail, last.json);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------------------------------------------------------------------
 * the per-project state machine
 * ------------------------------------------------------------------------ */
function writeHeaders(p) {
  // Same header set api.js:198 writeHeaders() builds, so a seeded row is
  // byte-for-byte the shape a browser save produces.
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Studio-Client': '1',                       // CSRF lock, auth.js:783
    'X-Studio-Name': pct(p.name),
    'X-Studio-Encoding': p.enc.encoding,
    'X-Studio-Bytes': String(p.enc.bytes),
    'X-Studio-Sha': p.enc.sha,
    'X-Studio-Youtube': pct(p.facts.youtubeUrl),
    'X-Studio-Has-Song': p.facts.hasSong ? '1' : '0',
    'X-Studio-Track-Count': String(p.facts.trackCount),
    'X-Studio-Instruments': p.facts.instruments
  };
}

function importHeaders(ctx, p) {
  const h = writeHeaders(p);
  h['X-Studio-Id'] = p.id;                        // the ONLY route that takes one
  h['X-Studio-Created'] = String(p.created);
  h['X-Studio-Updated'] = String(p.updated);
  if (ctx.owner) h['X-Studio-Owner'] = ctx.owner; // else the route uses the admin
  return h;
}

// A tombstoned row is invisible to the library and PUT answers it with 404
// (routes.js:592). Restore is a no-op that writes nothing when the row is
// already live (routes.js:937), so calling it unconditionally on a row that
// already existed is cheap and makes the script converge on "all six visible".
async function ensureLive(ctx, id) {
  const r = await api(ctx, 'POST', '/admin/projects/' + id + '/restore', { 'X-Studio-Client': '1' });
  if (r.status === 200) return r.json && r.json.version;
  const e = errorOf(r);
  throw httpError(r.status, e.code, 'restore failed: ' + e.detail, r.json);
}

async function currentVersion(ctx, id, fallback) {
  const r = await api(ctx, 'GET', '/projects/' + id + '/head');
  if (r.status === 200 && r.json && typeof r.json.version === 'number') return r.json.version;
  // The 409 body carries serverVersion (routes.js:1053); use it if head failed.
  if (fallback != null) return fallback;
  const e = errorOf(r);
  throw httpError(r.status, e.code, 'could not read the current version: ' + e.detail, r.json);
}

async function seedOne(ctx, p) {
  const imp = await api(ctx, 'POST', '/admin/import', importHeaders(ctx, p), p.enc.payloadB64);

  if (imp.status === 201) {
    const v = (imp.json && imp.json.project && imp.json.project.version) || 1;
    return { action: 'created', version: v };
  }

  if (imp.status === 200) {
    // Identical payload_sha already stored: zero rows written. The row may still
    // be soft-deleted, which the replay response cannot tell us, so restore.
    const was = (imp.json && (imp.json.version || (imp.json.project && imp.json.project.version))) || null;
    const now = await ensureLive(ctx, p.id);
    const undeleted = was != null && now != null && now !== was;   // setDeleted bumps the version
    return {
      action: 'unchanged',
      version: undeleted ? now : was,
      note: undeleted ? 'restored from soft-delete' : ''
    };
  }

  if (imp.status === 409) {
    // Same id, different content — the update path. PUT is the only route that
    // replaces a payload, and it is allowed here because R5 gives the admin
    // save-in-place on every project (requireEditor, routes.js:594).
    const err = errorOf(imp);
    const was = err.extra && err.extra.serverVersion;
    const restored = await ensureLive(ctx, p.id);
    const version = await currentVersion(ctx, p.id, restored != null ? restored : was);
    const undeleted = was != null && restored != null && restored !== was;

    const h = writeHeaders(p);
    h['If-Match'] = '"' + version + '"';
    const put = await api(ctx, 'PUT', '/projects/' + p.id, h, p.enc.payloadB64);
    if (put.status === 200) {
      return {
        action: 'updated',
        version: (put.json && put.json.version) || null,
        // saveRoute stamps `updated` with ctx.now; there is no route that
        // replaces a payload AND preserves a historical timestamp.
        note: (undeleted ? 'restored from soft-delete; ' : '') + 'updated stamp reset to now'
      };
    }
    const pe = errorOf(put);
    throw httpError(put.status, pe.code, 'PUT failed: ' + pe.detail, put.json);
  }

  const e = errorOf(imp);
  throw httpError(imp.status, e.code, 'import failed: ' + e.detail, imp.json);
}

/* ---------------------------------------------------------------------------
 * reporting
 * ------------------------------------------------------------------------ */
function n(x) { return Number(x).toLocaleString('en-US'); }
function iso(sec) { return new Date(sec * 1000).toISOString().replace('.000Z', 'Z'); }
function pad(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }

function describe(p) {
  return pad(p.id, 26) + ' ' +
    pad(n(p.enc.rawBytes) + ' B json', 16) + ' -> ' +
    pad(n(p.enc.bytes) + ' gz', 13) + ' -> ' +
    pad(n(p.enc.payloadB64.length) + ' b64', 14) + ' ' +
    'updated ' + iso(p.updated) + ' (' + p.updated + ')' +
    (p.updatedFromMtime ? ' [from mtime]' : '') +
    '  ' + p.facts.trackCount + ' tracks' +
    (p.facts.instruments ? ' [' + p.facts.instruments + ']' : '') +
    (p.facts.hasSong ? ' +song' : '');
}

/* ---------------------------------------------------------------------------
 * target + credential
 *
 * Returns the request context, or null after printing why it could not be
 * built. The credential is a Better Auth SESSION COOKIE because that is the only
 * thing the admin routes accept: worker/auth.js configures GitHub OAuth with
 * httpOnly cookies (auth.js:377-383) and exposes no bearer-token or API-key
 * path, so there is nothing else to send.
 * ------------------------------------------------------------------------ */
function resolveTarget(opt) {
  let base = String(opt.url || '').trim().replace(/\/+$/, '');
  if (!base) {
    console.error('seed-d1: --url (or $STUDIO_BASE_URL) is required.\n');
    console.error(HELP);
    return null;
  }
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    base = u.origin;
  } catch (e) {
    console.error('seed-d1: --url must be an http(s) origin, got "' + opt.url + '"');
    return null;
  }

  let cookie = String(opt.cookie || '').trim();
  if (!cookie && opt.cookieFile) {
    try {
      cookie = fs.readFileSync(path.resolve(opt.cookieFile), 'utf8').trim();
    } catch (e) {
      console.error('seed-d1: cannot read --cookie-file ' + opt.cookieFile + ': ' + e.message);
      return null;
    }
  }
  // Deliberately NOT read: .dev.vars. It holds the Worker's own secrets, it is
  // not a session, and silently harvesting a secrets file is not this script's
  // business.
  if (!cookie) {
    console.error('seed-d1: an admin session cookie is required ' +
      '(--cookie, --cookie-file or $STUDIO_ADMIN_COOKIE).\n');
    console.error(HELP);
    return null;
  }
  if (cookie.indexOf('=') < 0) {
    console.error('seed-d1: the credential does not look like a Cookie header value ' +
      '(expected "<name>=<value>"). Paste the whole cookie, not just its value.');
    return null;
  }
  // A stray newline from a --cookie-file would be an invalid header value and
  // undici rejects the whole request for it.
  cookie = cookie.replace(/[\r\n]+/g, ' ').trim();

  return { base: base, cookie: cookie, owner: String(opt.owner || '').trim() };
}

/* ---------------------------------------------------------------------------
 * main
 * ------------------------------------------------------------------------ */
async function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('seed-d1: ' + e.message + '\n');
    console.error(HELP);
    return 2;
  }
  if (opt.help) { console.log(HELP); return 0; }

  /* ---- resolve the target and the credential FIRST: a forgotten flag must not
   * cost the user a full gzip pass over 1.5 MB of json before it says so.
   * --dry-run needs neither. ----------------------------------------------- */
  const ctx = opt.dryRun ? { base: '', cookie: '', owner: String(opt.owner || '').trim() } : resolveTarget(opt);
  if (!ctx) return 2;

  /* ---- load and encode everything BEFORE touching the network, so a bad file
   * is reported without having half-seeded the database. ------------------- */
  const root = path.resolve(opt.projects || path.join(repoRoot(), 'projects'));
  let ids = listProjectDirs(root);
  if (!ids.length) {
    console.error('seed-d1: no <id>/project.json found under ' + root);
    return 1;
  }
  if (opt.only) {
    const wanted = new Set(opt.only);
    const missing = opt.only.filter((id) => !ids.includes(id));
    if (missing.length) console.error('seed-d1: --only names unknown project(s): ' + missing.join(', '));
    ids = ids.filter((id) => wanted.has(id));
    if (!ids.length) return 1;
  }

  const projects = [];
  const loadFailures = [];
  for (const id of ids) {
    try {
      projects.push(loadProject(root, id));
    } catch (e) {
      loadFailures.push({ id: id, message: e.message });
    }
  }

  console.log('seed-d1: ' + projects.length + ' project(s) from ' + root);
  for (const p of projects) {
    console.log('  ' + describe(p));
    if (p.innerId && p.innerId !== p.id) {
      console.log('    ! project.json declares id "' + p.innerId + '" but the folder is "' + p.id +
        '" — seeding under the FOLDER name, which is what deployed urls use');
    }
  }
  for (const f of loadFailures) console.error('  [fail] ' + pad(f.id, 26) + ' ' + f.message);

  if (!opt.only) {
    const seen = new Set(projects.map((p) => p.id));
    const absent = EXPECTED_IDS.filter((id) => !seen.has(id));
    if (absent.length) {
      console.error('  ! expected seed id(s) not present on disk: ' + absent.join(', ') +
        ' — urls already in the wild will 404');
    }
  }

  if (opt.dryRun) {
    console.log('\ndry run: nothing was sent. Headers that WOULD be sent for ' +
      (projects[0] ? projects[0].id : '(none)') + ':');
    if (projects[0]) {
      const h = importHeaders(ctx, projects[0]);
      for (const k of Object.keys(h)) console.log('  ' + k + ': ' + h[k]);
      console.log('  (body: ' + n(projects[0].enc.payloadB64.length) + ' base64 characters)');
    }
    return loadFailures.length ? 1 : 0;
  }

  /* ---- preflight: are we actually the admin? ----------------------------- */
  let me;
  try {
    me = await api(ctx, 'GET', '/me', { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('seed-d1: cannot reach ' + ctx.base + '/api/me — ' + e.message);
    return 1;
  }
  const user = me.json && me.json.user;
  if (!user) {
    console.error('seed-d1: the session cookie is not valid (GET /api/me returned {user:null}). ' +
      'Sign in again and copy a fresh cookie.');
    return 1;
  }
  if (!user.isAdmin) {
    console.error('seed-d1: signed in as ' + (user.name || user.id) + ' (githubId ' +
      (user.githubId || '?') + '), who is NOT an admin. /api/admin/import answers 403 admin_only.');
    return 1;
  }
  if (String(user.githubId || '') !== ADMIN_GITHUB_ID) {
    console.error('seed-d1: ! signed in as an admin whose GitHub id is ' + (user.githubId || '?') +
      ', not the documented ' + ADMIN_GITHUB_ID + ' — continuing, but ownership will differ from R5.');
  }
  console.log('\nseed-d1: ' + ctx.base + ' as ' + (user.name || user.id) +
    ' (id ' + user.id + ', githubId ' + (user.githubId || '?') + ', admin)');
  if (ctx.owner) console.log('seed-d1: rows will be owned by ' + ctx.owner + ' (--owner)');

  /* ---- seed, one at a time ---------------------------------------------- */
  const tally = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  const failures = loadFailures.map((f) => ({ id: f.id, message: 'not loaded: ' + f.message }));
  tally.failed += loadFailures.length;

  for (const p of projects) {
    const t0 = Date.now();
    try {
      const r = await seedOne(ctx, p);
      tally[r.action]++;
      console.log('  [ok]   ' + pad(p.id, 26) + ' ' + pad(r.action, 10) +
        ' v' + pad(r.version == null ? '?' : r.version, 4) +
        pad(n(p.enc.payloadB64.length) + ' b64', 14) +
        (Date.now() - t0) + ' ms' + (r.note ? '  (' + r.note + ')' : ''));
    } catch (e) {
      tally.failed++;
      failures.push({ id: p.id, message: (e.status ? e.status + ' ' : '') + e.message });
      console.error('  [fail] ' + pad(p.id, 26) + ' ' + (e.status ? e.status + ' ' : '') + e.message);
    }
  }

  /* ---- summary ----------------------------------------------------------- */
  console.log('\nseed-d1: ' + tally.created + ' created, ' + tally.updated + ' updated, ' +
    tally.unchanged + ' unchanged, ' + tally.failed + ' failed.');
  for (const f of failures) console.log('  - ' + f.id + ': ' + f.message);

  if (!tally.failed && !opt.only) {
    // app_meta.seeded is the contract's one-shot marker, but NO route reads or
    // writes app_meta: worker/db.js:1082-1098 has getMeta/setMeta and nothing in
    // worker/routes.js ROUTES exposes them. Rather than invent an endpoint (or
    // shell out to wrangler behind the operator's back), print the exact
    // statement — it is one row, written once, by hand.
    console.log('\nMark the database as seeded — no API route writes app_meta, so run this ' +
      'yourself\n(the database name comes from d1_databases[0].database_name in wrangler.jsonc):');
    console.log('  npx wrangler d1 execute studio --remote --command "INSERT INTO app_meta (k, v) ' +
      "VALUES ('seeded', '1') ON CONFLICT (k) DO UPDATE SET v = excluded.v\"");
  }

  return tally.failed ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    console.error('seed-d1: ' + ((e && e.stack) || e));
    process.exitCode = 1;
  }
);
