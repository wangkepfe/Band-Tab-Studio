/* ============================================================================
 * worker/index.js  —  the Cloudflare Worker entry point for Studio's cloud
 * library: a small hand-rolled router over /api/*, the Better Auth passthrough,
 * and the cron handler that prunes recent_views.
 *
 * WHY HAND-ROLLED. Every Worker invocation gets 10 ms of CPU on the Free plan,
 * and MODULE-SCOPE WORK COUNTS AGAINST IT. A router library rebuilds its trie
 * (and drags in its middleware machinery) on every cold start, on every isolate,
 * forever. The table below is ~15 string splits done once per isolate and a
 * linear walk of ~15 entries per request — both unmeasurable next to the single
 * D1 round trip that follows.
 *
 * Module layout. The contract splits routes across worker/routes/*.js; this
 * build consolidates them into ONE worker/routes.js, which exports the same
 * handler shapes plus the ROUTES table compiled below.
 *
 *   index.js   routing + the cross-cutting concerns: schema assertion, session,
 *              security headers, the error envelope, the request log line, cron.
 *   routes.js  the handlers themselves.
 *   db.js      every SQL statement, and the rows_written / rows_read accounting.
 *   auth.js    Better Auth, the authorization predicates, the auth rate limiter.
 *
 * ASSETS. wrangler's `assets.run_worker_first: ["/api/*"]` means only /api/*
 * ever reaches this script, which is what keeps static assets billing ZERO
 * requests. The ASSETS fallback at the bottom is therefore defensive only — and
 * the JSON 404 above it is load-bearing: with run_worker_first scoped to /api/*
 * we can NOT fall through to `not_found_handling`, so an unmatched API path must
 * produce an explicit JSON error here or the client gets an HTML SPA shell where
 * it expected an error envelope.
 * ========================================================================== */
// guardAuthRateLimit is deliberately NOT imported: handleAuth() is already the
// rate-limited handler, and a second charge halves every ceiling. See the
// /api/auth/* block in fetch().
import { handleAuth, assertAuthSchema, getSession, isAdmin } from './auth.js';
import { assertSchema, getMeta, setMeta } from './db.js';
import { ROUTES } from './routes.js';

/* ---------------------------------------------------------------------------
 * tuning constants
 * ------------------------------------------------------------------------ */
const API_PREFIX = '/api/';

// recent_views prune (see scheduled(), at the bottom). All three are hard caps
// PER CRON INVOCATION — a Free-plan cron gets the same 10 ms CPU as an HTTP
// request — and they are sized so the job can actually keep up with the table
// size that justifies enabling it.
//
// THE ARITHMETIC, because the first cut of these numbers (200 scanned / 45
// deleted per nightly run) was safe and useless: the documented trigger to ship
// the cron is COUNT(*) FROM recent_views above 100,000, and at 200 rows scanned
// per day one full pass of a 100,000-row table takes 500 days while the drain
// rate tops out at 45 rows/day. Both caps are now ~an order of magnitude higher,
// and CADENCE is the free lever — each run is bounded and cursor-resumed, so a
// more frequent schedule simply drains faster:
//
//   CADENCE          full pass over 100k rows   max drain      rows WRITTEN/day
//   "17 4 * * *"     100 days                   450 rows/day   450   (0.45% cap)
//   "17 * * * *"     ~4.2 days                  10,800/day     10,800 (11% cap)
//   "*/10 * * * *"   ~17 hours                  64,800/day     64,800 (65% cap!)
//
// Deleted rows ARE rows written, so */10 is a denial-of-wallet on your own D1
// budget unless the table is genuinely runaway. Start hourly, read the
// {scanned, deleted, wrapped} log line, and stop there.
const PRUNE_SCAN = 1000;         // rows examined by the one indexed SELECT
const PRUNE_DELETE = 450;        // rows removed per run, across the batch below
const PRUNE_DELETE_CHUNK = 45;   // pairs per DELETE statement
                                 // (45 x 2 = 90 bound params, under D1's 100)
const PRUNE_CURSOR_KEY = 'prune_cursor';
const DEFAULT_RETENTION_DAYS = 90;

/* ---------------------------------------------------------------------------
 * route table — compiled once per isolate
 *
 * ROUTES entries are [method, pattern, handler]; ':name' segments become
 * ctx.params.name. Matching compares segment COUNT first (an integer compare
 * that rejects most of the table immediately) and only then walks segments.
 * ------------------------------------------------------------------------ */
const TABLE = ROUTES.map(function (r) {
  const segs = r[1].split('/').filter(Boolean);
  return { method: r[0], segs: segs, n: segs.length, handler: r[2], name: r[0] + ' ' + r[1] };
});

const NO_PARAMS = Object.freeze({});

function matchRoute(method, segs) {
  let allow = null;
  for (let i = 0; i < TABLE.length; i++) {
    const e = TABLE[i];
    if (e.n !== segs.length) continue;
    let ok = true, params = null;
    for (let j = 0; j < e.n; j++) {
      const p = e.segs[j];
      if (p.charCodeAt(0) === 58 /* ':' */) { (params || (params = {}))[p.slice(1)] = segs[j]; }
      else if (p !== segs[j]) { ok = false; break; }
    }
    if (!ok) continue;
    // The path shape matches but the verb does not: remember it, so we can
    // answer 405 + Allow rather than a misleading 404.
    if (e.method !== method) { (allow || (allow = [])).push(e.method); continue; }
    return { entry: e, params: params || NO_PARAMS };
  }
  return allow ? { allow: allow } : null;
}

/* ---------------------------------------------------------------------------
 * responses — security headers go on EVERY response this Worker emits.
 *
 * dist/_headers only covers static assets; anything the Worker returns
 * (our JSON, Better Auth's cookies and redirects, the asset fallback) is
 * hardened here instead. The choices, and why:
 *   nosniff                  a JSON error must never be sniffed as HTML
 *   Referrer-Policy          no API URL leaks to github.com on the OAuth hop
 *   X-Frame-Options / CSP    nothing under /api/* is ever a framed document
 *   CORP: same-origin        blocks cross-origin no-cors embedding of replies
 *   Vary: Cookie             EVERY card carries canEdit/isMine, so every
 *                            response is session-shaped; without this an
 *                            intermediary could hand one user's canEdit:true
 *                            to another user
 *   Cache-Control: no-store  the default. Routes that want revalidation
 *                            (GET /api/projects/:id sets no-cache + ETag) win,
 *                            because this only fills in a missing value.
 * ------------------------------------------------------------------------ */
const OWN_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

function applySecurity(h) {
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  const v = h.get('Vary');
  if (!v) h.set('Vary', 'Cookie');
  else if (!/(^|,)\s*cookie\s*(,|$)/i.test(v)) h.set('Vary', v + ', Cookie');
}

// Harden a Response this module did not build (Better Auth's, the auth
// limiter's, or ASSETS'). Mutating the header list IN PLACE is the safe path
// for Better Auth: rebuilding a Response risks collapsing its multiple
// Set-Cookie headers. Responses that came out of a fetcher (ASSETS) have
// immutable headers, so those fall through to a rebuild — where no Set-Cookie
// is in play anyway.
function harden(res) {
  try {
    applySecurity(res.headers);
    return res;
  } catch (e) {
    const h = new Headers(res.headers);
    applySecurity(h);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
}

// Build one of OUR responses: the same hardening plus the strict CSP, which is
// applied only to bodies we authored (Better Auth may legitimately return HTML).
function mkResponse(body, status, headers) {
  const h = new Headers(headers || undefined);
  h.set('Content-Security-Policy', OWN_CSP);
  applySecurity(h);
  return new Response(body, { status: status || 200, headers: h });
}

function jsonResponse(obj, status, headers) {
  const h = new Headers(headers || undefined);
  h.set('Content-Type', 'application/json; charset=utf-8');
  return mkResponse(JSON.stringify(obj), status || 200, h);
}

/* The one error envelope: { "error": { "code": "...", ...extra } }. Identical
 * to HttpError#body() in auth.js, which is where most of these originate.
 *
 * 5xx EXTRAS ARE LOGGED, NEVER RETURNED. auth.js throws
 * HttpError(500,'auth_misconfigured',{detail:'BETTER_AUTH_SECRET is unset'}) and
 * HttpError(500,'auth_schema_missing',{detail, probe, hint}) — forwarding those
 * verbatim hands any anonymous caller the names of our unset secrets and the
 * exact SQL of our schema probes. The filter lives HERE, in the one function
 * every error path funnels through, rather than in the three catch blocks, so a
 * future fourth catch cannot reintroduce the leak. 4xx extras are the client's
 * own business (which field was malformed, how long to wait) and pass through. */
const PRIVATE_EXTRA_KEYS = { detail: 1, probe: 1, hint: 1, stack: 1, sql: 1 };

function errResponse(status, code, extra) {
  let publicExtra = extra;
  if (extra && status >= 500) {
    publicExtra = null;
    let hidden = null;
    for (const k in extra) {
      if (PRIVATE_EXTRA_KEYS[k]) (hidden || (hidden = {}))[k] = extra[k];
      else (publicExtra || (publicExtra = {}))[k] = extra[k];
    }
    if (hidden) {
      console.log(JSON.stringify({ t: 'err', s: status, code: code, hidden: hidden }));
    }
  }
  const err = { code: code };
  if (publicExtra) for (const k in publicExtra) err[k] = publicExtra[k];
  const h = new Headers();
  if (publicExtra && publicExtra.retryAfter) h.set('Retry-After', String(publicExtra.retryAfter));
  return jsonResponse({ error: err }, status, h);
}

/* ---------------------------------------------------------------------------
 * boot assertion — openRisks #1, the one hard dependency between two modules
 * written in parallel.
 *
 * migrations/0000_better_auth.sql is GENERATED from the auth config. If it was
 * generated before user.additionalFields (githubId, role) existed, NOTHING
 * errors at runtime: isAdmin() quietly falls back to its github_id clause for
 * the one hard-coded admin, and every other user is stuck at role 'user' with
 * no visible symptom except "why can't anyone save". So probe once per isolate
 * and refuse to serve instead.
 *
 * Both probe sets are LIMIT 0 — they parse and plan without reading a row, so
 * this costs zero rows_read — and they run CONCURRENTLY, so a cold start pays
 * one round trip's latency rather than seven.
 *
 * Fails CLOSED on a definitively wrong schema and OPEN on a transient D1 error:
 * a blip during a deploy must not latch a whole isolate into 503.
 * ------------------------------------------------------------------------ */
let dbSchemaState = null;

async function ensureDbSchema(env) {
  if (dbSchemaState) return dbSchemaState;
  const res = await assertSchema(env.DB);
  if (res.ok) { dbSchemaState = { ok: true }; return dbSchemaState; }
  const detail = (res.missing || []).join(' | ');
  if (/no such table|no such column/i.test(detail)) {
    dbSchemaState = { ok: false, detail: detail };
    return dbSchemaState;
  }
  return { ok: true };   // transient: do not cache, let the request through
}

/* ---------------------------------------------------------------------------
 * fetch
 * ------------------------------------------------------------------------ */
export default {
  async fetch(request, env, execCtx) {
    const started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;

    // Not an API path: only reachable if run_worker_first is misconfigured.
    if (path !== '/api' && path.indexOf(API_PREFIX) !== 0) {
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') return harden(await env.ASSETS.fetch(request));
      return errResponse(404, 'not_found');
    }

    if (!env.DB) {
      return errResponse(503, 'db_unbound', { detail: 'wrangler.jsonc must bind the D1 database as "DB"' });
    }

    // Schema gate, in front of BOTH the auth prefix and the route table —
    // a missing `user` table breaks sign-in worst of all.
    try {
      const [dbState] = await Promise.all([ensureDbSchema(env), assertAuthSchema(env)]);
      if (!dbState.ok) return errResponse(503, 'schema_not_ready', { detail: dbState.detail });
    } catch (e) {
      const status = e && typeof e.status === 'number' ? e.status : 500;
      console.log(JSON.stringify({ t: 'err', p: path, m: 'schema', e: String((e && e.message) || e) }));
      return errResponse(status, (e && e.code) || 'schema_not_ready', e && e.extra);
    }

    // ---- Better Auth owns its whole prefix, behind its own rate limiter (the
    // OAuth start writes a `verification` row before any user exists, so it is
    // an UNAUTHENTICATED WRITE against a 100,000 rows/day account budget). The
    // response is returned verbatim apart from security headers: its cookie and
    // redirect protocol must not be wrapped or rewritten.
    //
    // DO NOT CALL guardAuthRateLimit() HERE. handleAuth() IS the guarded handler
    // (auth.js:createAuth wraps it), and the limiter is STATEFUL — it spends
    // burst tokens and increments the hourly OAuth-initiation counter on every
    // check. Guarding here as well charged every /api/auth/* request twice,
    // which made the 20/hour initiation ceiling an effective 10/hour and drained
    // the 60-token burst bucket at 10 per sign-in instead of 5: real users
    // behind a shared NAT or a corporate egress IP got 429 on the login path at
    // half the intended budget. auth.js owns this path and owns its limiter;
    // checkAuthRateLimit is additionally memoized per Request object there, so
    // re-adding a call here would now be inert rather than harmful — but it
    // would still be wrong, so don't.
    if (path === '/api/auth' || path.indexOf('/api/auth/') === 0) {
      try {
        return harden(await handleAuth(request, env));
      } catch (e) {
        const status = e && typeof e.status === 'number' ? e.status : 0;
        if (status >= 400 && status < 600) return errResponse(status, (e && e.code) || 'error', e && e.extra);
        console.log(JSON.stringify({ t: 'err', p: path, m: 'auth', e: String((e && e.stack) || e) }));
        return errResponse(500, 'internal');
      }
    }

    // ---- route lookup. HEAD is served by the GET handler with the body
    // dropped, so `HEAD /api/projects` is a cheap liveness probe, not a 405.
    const isHead = request.method === 'HEAD';
    const method = isHead ? 'GET' : request.method;
    const segs = path.slice(API_PREFIX.length).split('/').filter(Boolean);
    const m = matchRoute(method, segs);

    if (!m) return errResponse(404, 'not_found', { detail: method + ' ' + path });
    if (!m.entry) return jsonResponse({ error: { code: 'method_not_allowed' } }, 405, { 'Allow': m.allow.join(', ') });

    // ---- session. The contract calls for lazy resolution; in practice EVERY
    // route below reads the viewer (canEdit / isMine / order=recent / authz), so
    // it is resolved once here instead. getSession() memoizes per request and
    // never throws — a broken or expired cookie is "anonymous", not a 500 — and
    // with session.cookieCache (300 s) it usually costs no D1 read at all.
    const session = await getSession(request, env);
    const user = (session && session.user) || null;
    // Through isAdmin(), never off a raw field: it is belt and braces in both
    // directions — the github_id clause means a failed migration cannot lock
    // the admin out of his own instance, and the role clause means a second
    // admin can be added with one UPDATE and no redeploy.
    const admin = isAdmin(session);

    const ctx = {
      env: env,
      execCtx: execCtx,
      url: url,
      method: method,
      path: path,
      params: m.params,
      session: session,          // the shape auth.js's require*/can* helpers take
      user: user,                // {id, name, image, githubId, role, isAdmin}
      isAdmin: admin,
      viewer: user ? { id: user.id, isAdmin: admin } : null,   // toCard()'s argument
      now: Math.floor(started / 1000),                          // unix SECONDS
      rowsWritten: 0,
      rowsRead: 0,
      ops: [],
      json: function (body, status, headers) { return jsonResponse(body, status, headers); },
      text: function (body, status, headers) {
        const h = new Headers(headers || undefined);
        if (!h.has('Content-Type')) h.set('Content-Type', 'text/plain; charset=utf-8');
        return mkResponse(body, status || 200, h);
      },
      // Raw body + status: the string-concatenated project payload, and the
      // empty 204/304 replies.
      raw: function (body, status, headers) { return mkResponse(body, status, headers); },
      err: function (status, code, extra) { return errResponse(status, code, extra); },
      // Every db.js call reports meta.rows_written / meta.rows_read; funnelling
      // them through here is what makes the quota budget MEASURED in production
      // rather than assumed. If daily rows written passes 30,000, the next lever
      // is raising the client-side save floor — a one-constant change.
      log: function (op, meta) {
        if (meta) {
          if (meta.rowsWritten) ctx.rowsWritten += meta.rowsWritten;
          if (meta.rowsRead) ctx.rowsRead += meta.rowsRead;
        }
        ctx.ops.push(op);
      }
    };

    let res;
    try {
      res = await m.entry.handler(request, ctx);
      if (!res) res = errResponse(404, 'not_found');
    } catch (e) {
      // HttpError (worker/auth.js) carries {status, code, extra}. Anything else
      // is a bug: log the detail, return none of it.
      const status = e && typeof e.status === 'number' ? e.status : 0;
      if (status >= 400 && status < 600) {
        res = errResponse(status, (e && e.code) || 'error', e && e.extra);
      } else {
        console.log(JSON.stringify({ t: 'err', r: m.entry.name, e: String((e && e.stack) || e) }));
        res = errResponse(500, 'internal');
      }
    }

    console.log(JSON.stringify({
      t: 'req', r: m.entry.name, s: res.status, ms: Date.now() - started,
      rw: ctx.rowsWritten, rr: ctx.rowsRead,
      u: user ? user.id : null, ops: ctx.ops.join(',')
    }));

    // A HEAD reply must carry no body; the headers (ETag, cache directives) stay.
    return isHead ? new Response(null, { status: res.status, headers: res.headers }) : res;
  },

  /* -------------------------------------------------------------------------
   * scheduled — prune recent_views past the retention window.
   *
   * NOT WIRED AT LAUNCH: wrangler.jsonc declares no `triggers.crons`, so this
   * never fires until someone adds one. Ship the handler, not the behaviour —
   * per the contract the trigger to enable it is COUNT(*) FROM recent_views
   * above 100,000, or the p99 rows_read of the recently-viewed read above 200,
   * both observable from the `rr` field of the request log line. When that day
   * comes, start at  "triggers": { "crons": ["17 * * * *"] }  (hourly) and read
   * the cadence table beside PRUNE_SCAN before going faster: every cadence is
   * SAFE for CPU because each run is capped and cursor-resumed, but deleted rows
   * are ROWS WRITTEN, so cadence spends the daily D1 budget.
   * Kill switch that needs no cron-config change: set PRUNE_VIEWS = "0".
   *
   * STRICTLY BOUNDED, because a Free-plan cron gets the same 10 ms CPU as an
   * HTTP request and there is deliberately NO index on recent_views.viewed:
   *   • ONE index-driven SELECT over a LIMIT-ed window of the PRIMARY KEY,
   *     resumed from a cursor in app_meta — so no run walks the whole table,
   *     however few rows happen to be expired;
   *   • ONE db.batch of at most ceil(PRUNE_DELETE / PRUNE_DELETE_CHUNK) = 10
   *     bulk DELETEs (one round trip, one transaction, 90 bound params each);
   *   • the expiry test itself runs in JS, over that bounded window.
   * Cost per run: 1 + 1 + 10 + 1 = 13 statements (D1 caps an invocation at 50),
   * PRUNE_SCAN rows read, at most PRUNE_DELETE + 1 rows written. This is also
   * why the whole-table DELETE the contract sketches is NOT used: it stops
   * fitting in 10 ms somewhere north of 500,000 rows, and nobody should discover
   * that as a 3 AM cron failure.
   *
   * SECOND JOB, since hardDeleteProject() no longer touches recent_views (that
   * DELETE was a full table scan — project_id is the TRAILING column of the only
   * index): this is what eventually reaps history rows pointing at hard-deleted
   * projects. They are invisible until then, because hydrateCards() filters to
   * live projects.
   * ---------------------------------------------------------------------- */
  async scheduled(event, env, execCtx) {
    if (env.PRUNE_VIEWS === '0') return;
    if (!env.DB) { console.log(JSON.stringify({ t: 'cron', skipped: 'db_unbound' })); return; }
    try {
      const stats = await pruneViews(env);
      console.log(JSON.stringify(Object.assign({ t: 'cron', job: 'prune_views' }, stats)));
    } catch (e) {
      // Never rethrow: a thrown scheduled() is retried and re-billed, and a
      // prune is by definition retryable on the next tick anyway.
      console.log(JSON.stringify({ t: 'cron', job: 'prune_views', e: String((e && e.message) || e) }));
    }
  }
};

async function pruneViews(env) {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  let days = parseInt(env.VIEW_RETENTION_DAYS || '', 10);
  if (!(days >= 7 && days <= 3650)) days = DEFAULT_RETENTION_DAYS;
  const cutoff = now - days * 86400;

  // Resume where the last run stopped. The cursor is the last PRIMARY KEY we
  // examined; an empty cursor restarts at the beginning of the b-tree.
  let from = ['', ''];
  const saved = await getMeta(db, PRUNE_CURSOR_KEY);
  if (saved) {
    try {
      const p = JSON.parse(saved);
      if (Array.isArray(p) && p.length === 2) from = [String(p[0]), String(p[1])];
    } catch (e) { /* corrupt cursor: start over. Costs one extra pass, nothing else. */ }
  }

  // THE one SELECT. Row-value comparison against the composite PRIMARY KEY is
  // an index seek followed by an ordered scan — no filesort, no full-table walk,
  // and recent_views is WITHOUT ROWID so the PK *is* the table.
  const sel = await db.prepare(
    'SELECT user_id, project_id, viewed FROM recent_views ' +
    'WHERE (user_id, project_id) > (?1, ?2) ' +
    'ORDER BY user_id, project_id LIMIT ?3'
  ).bind(from[0], from[1], PRUNE_SCAN).all();
  const rows = (sel && sel.results) || [];
  const scanned = rows.length;

  if (!scanned) {
    // End of table: rewind so the next tick starts a fresh pass.
    if (saved) await setMeta(db, PRUNE_CURSOR_KEY, '');
    return { scanned: 0, deleted: 0, wrapped: true, cutoff: cutoff };
  }

  const expired = [];
  for (let i = 0; i < rows.length && expired.length < PRUNE_DELETE; i++) {
    if (rows[i].viewed < cutoff) expired.push(rows[i]);
  }

  // If the delete cap was hit, this window is only partly handled: the cursor
  // stops at the last row we actually removed and the remainder is re-scanned
  // next tick. Otherwise the whole window is done and we advance past it.
  const capped = expired.length === PRUNE_DELETE;
  const last = capped ? expired[expired.length - 1] : rows[rows.length - 1];
  const atEnd = !capped && scanned < PRUNE_SCAN;

  let deleted = 0;
  if (expired.length) {
    // Chunked at PRUNE_DELETE_CHUNK pairs per statement because D1 caps a
    // statement at 100 BOUND PARAMETERS and each pair spends two; every chunk
    // goes in ONE db.batch, so this is one round trip and one transaction.
    // Row-value IN over a VALUES list: one indexed lookup per pair, and ~270
    // characters of SQL text per chunk — nowhere near D1's 100 KB statement cap.
    const stmts = [];
    for (let i = 0; i < expired.length; i += PRUNE_DELETE_CHUNK) {
      const chunk = expired.slice(i, i + PRUNE_DELETE_CHUNK);
      const tuples = [];
      const binds = [];
      for (let j = 0; j < chunk.length; j++) {
        tuples.push('(?,?)');
        binds.push(chunk[j].user_id, chunk[j].project_id);
      }
      stmts.push(db.prepare(
        'DELETE FROM recent_views WHERE (user_id, project_id) IN (VALUES ' + tuples.join(',') + ')'
      ).bind(...binds));
    }
    const dels = await db.batch(stmts);
    for (let i = 0; i < (dels ? dels.length : 0); i++) {
      const meta = (dels[i] && dels[i].meta) || {};
      const n = meta.rows_written != null ? meta.rows_written : meta.changes;
      deleted += (typeof n === 'number' && isFinite(n)) ? n : 0;
    }
    // A D1 response that omitted both counters must not report a no-op run, or
    // the log line would suggest the cursor is stuck.
    if (!deleted) deleted = expired.length;
  }

  await setMeta(db, PRUNE_CURSOR_KEY, atEnd ? '' : JSON.stringify([last.user_id, last.project_id]));
  return { scanned: scanned, deleted: deleted, wrapped: atEnd, cutoff: cutoff };
}
