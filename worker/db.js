/* ============================================================================
 * worker/db.js  —  the D1 data layer for Studio's cloud library.
 *
 * This module knows about TABLES and knows NOTHING about routes, sessions, HTTP
 * or Better Auth. Routes call it, it returns plain objects. Its job is to be the
 * one place where the quota rules that make this app fit on D1's free tier are
 * actually enforced, so no downstream route can accidentally violate them:
 *
 *   1. THE PAYLOAD IS OPAQUE. `payload_b64` goes in and comes out as base64
 *      TEXT. Nothing here ever JSON.parses it, gunzips it, or looks inside it.
 *      Every field the library card needs is a denormalized column the client
 *      supplied.
 *   2. THE PAYLOAD IS ALWAYS A BOUND PARAMETER, never interpolated into SQL
 *      text (D1 caps statement text at 100 KB and the worst measured project is
 *      78 KB of base64 — no headroom). It is TEXT and never BLOB because D1
 *      converts ArrayBuffer/ArrayBufferView params with Array.from, which would
 *      turn a 60 KB payload into a 60,000-element JS array under a 10 ms CPU
 *      budget.
 *   3. EVERY STATEMENT REPORTS ITS COST. Read helpers return `rowsRead`, write
 *      helpers return `rowsWritten`, both lifted straight off D1's `meta`. The
 *      100,000-rows-written/day budget is therefore MEASURED in production
 *      rather than assumed — ctx.log() accumulates these per request.
 *   4. ALL TIMESTAMPS ARE UNIX SECONDS. The frontend does new Date(t * 1000)
 *      (app.js:710 fmtDate). Callers pass `at`; nowSec() is the only clock.
 *   5. QUERY COUNT STAYS WELL UNDER D1's 50-per-invocation cap. The most
 *      expensive call in here is a signed-in library page at 3 statements.
 *
 * THE SAVE IS A COMPARE-AND-SWAP. updateProjectPayload() issues exactly ONE
 * conditional UPDATE whose WHERE carries the version the client loaded. D1
 * reports meta.changes; 1 means we won (200), 0 means either someone else moved
 * the row (409) or it is gone (404), and exactly one follow-up SELECT tells
 * those two apart. There is no read-then-write race here because there is no
 * read-then-write.
 *
 * ASSUMPTIONS ABOUT MODULES OWNED BY OTHERS (per the contract):
 *  · routes.js readPayload() has ALREADY enforced MAX_PAYLOAD_CHARS (413) and
 *    B64_RE (400) before a payload reaches us. We re-check the cheap O(1) parts
 *    anyway and return code 'bad_payload' rather than corrupting a row, but that
 *    is a can't-happen backstop, not the primary gate — which is why callers
 *    that came through readPayload pass `payloadChecked: true` to skip the
 *    O(n) base64 re-scan of a string up to MAX_PAYLOAD_CHARS long.
 *  · Better Auth owns the `user` table and, per its snake_case mapping, the
 *    columns `role` and `github_id`. We only ever read `u.name` and `u.image`
 *    from it, which are single words and so spelled identically under either
 *    naming convention — that is the only coupling, and it is deliberate that
 *    it is this small. assertSchema() below checks it once at boot.
 *  · worker/index.js's catch-all maps a thrown error carrying a numeric
 *    `.status` and a string `.code` onto the error envelope. DbError has
 *    exactly that shape (as does auth.js's HttpError), so a single catch
 *    handles both. Only genuine caller bugs throw; expected outcomes (conflict,
 *    not_found, idempotent replay) are RETURNED as result codes.
 *
 * ROWS WRITTEN PER OPERATION — the contract, restated as code comments on each
 * function. D1 bills one extra row per index whose column the write TOUCHES.
 * Final index set: projects has 3 (PK autoindex, idx_projects_recent,
 * uq_projects_owner_key); recent_views has 0 (WITHOUT ROWID folds the PK into
 * the table); app_meta has 0; ear_sessions has 0, for the same WITHOUT ROWID
 * reason (migrations/0004_ear_sessions.sql).
 * ========================================================================== */

// ---------------------------------------------------------------------------
// Constants and limits
// ---------------------------------------------------------------------------

/** Hard ceiling on payload_b64. 700,000 base64 chars = ~525 KB of stored bytes,
 *  which at the ~6.6x gzip ratio measured on the six committed projects is ~3.5
 *  MB of raw project.json. D1's row cap is 2 MB, so this fails as a clean 413
 *  rather than a rejected write.
 *
 *  WHY NOT HIGHER. The previous 1,500,000 was 19x the worst measured real
 *  project (77,888 chars) but only ~3x the Safari <16.4 identity+b64 fallback
 *  worst case (~514 KB), and NOBODY HAS MEASURED A SAVE AT THAT SIZE. A save at
 *  the cap costs, inside ONE 10 ms CPU invocation: request.text()'s UTF-8
 *  decode, the anchored base64 scan, and D1's serialization of the bound
 *  parameter. If that overruns, the request is killed with no partial write and
 *  no useful error. 700,000 keeps 9x headroom over the real worst case and ~1.4x
 *  over the Safari fallback, and it is the number to raise — after measuring a
 *  real save at the cap with `wrangler tail` — not to guess at.
 *
 *  THE CLIENT MIRRORS THIS CONSTANT (tab-studio/web/api.js) so an oversized doc
 *  fails locally with a useful message instead of as a 413. Change both. */
export const MAX_PAYLOAD_CHARS = 700000;

/** Hard ceiling on ear_sessions.detail — the /learn per-degree tally. Three
 *  orders of magnitude below MAX_PAYLOAD_CHARS and that gap is the point: a
 *  practice session is a dozen integers plus a small compact-JSON blob, and it
 *  is the only free-form TEXT the feature stores.
 *
 *  THE ARITHMETIC. `detail` carries {asked, correct} for at most 12 degrees plus
 *  a confusion list; compact that is ~250 characters, and spelled out with
 *  degree labels ~600. 2,000 is ~3x the verbose case, which leaves room for the
 *  shape to grow without leaving room for abuse — this table has no prune cron,
 *  so a row written today is a row stored forever.
 *
 *  MIRRORED IN TWO OTHER PLACES, and all three must move together:
 *  migrations/0004_ear_sessions.sql declares CHECK (length(detail) <= 2000) so a
 *  bypassed route still cannot store a blob, and worker/routes.js validates it
 *  first so the failure is a 400 naming the field rather than a constraint
 *  error. This constant is the middle backstop, exactly as checkPayload() is for
 *  MAX_PAYLOAD_CHARS. */
export const MAX_DETAIL_CHARS = 2000;

/** The base64 alphabet. This gate is what makes the read path's string-concat
 *  JSON response provably safe: no character in this set needs JSON escaping,
 *  so the Worker can emit '"payload":"' + row.payload_b64 + '"' without
 *  spending CPU on JSON.stringify over an 80 KB string. */
export const B64_RE = /^[A-Za-z0-9+/=]*$/;

/** Flat ids only — server/app.py:652 _safe_pid, so a project can round-trip
 *  through the desktop backend. Mirrors the CHECK constraint in schema.sql. */
export const FLAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** How many history entries the recently-viewed head is built from. Bounded by
 *  D1's 100-bound-param cap (we spend 60 of them on the IN list). */
export const RECENT_HISTORY_LIMIT = 60;

/** 90 days. Older history cannot appear in a listing even before the deferred
 *  nightly prune deletes it, so stale rows can never degrade the result. */
export const RECENT_MAX_AGE_SEC = 7776000;

/** The re-view suppression window. Re-opening the same project inside 10
 *  minutes writes ZERO rows, and unlike the client-side dedupe this one cannot
 *  be defeated by clearing localStorage. */
export const VIEW_FLOOR_SEC = 600;

const MAX_IN_PARAMS = 90;      // D1 allows 100 bound params; leave 10 spare.
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 40;
const MAX_NAME_CHARS = 200;
const MAX_Q_CHARS = 80;
const MINT_ATTEMPTS = 3;

/* ear_sessions bounds. The limit ceiling is 100 for the same reason MAX_LIMIT is
 * — it is the largest page this Worker will assemble inside a 10 ms budget —
 * and 100 sessions is over three months of daily practice, which is more than
 * any streak or trend the client draws needs. The default is 60 because that is
 * what the /learn client asks for (design Part I s14). */
const MAX_EAR_LIMIT = 100;
const DEFAULT_EAR_LIMIT = 60;
/* Attempts to place a session at `started`, `started + 1`, `started + 2` before
 * giving up. See insertEarSession() for why this is not INSERT OR REPLACE. */
const EAR_STARTED_ATTEMPTS = 3;
/* Backstop bounds mirroring the CHECK constraints in
 * migrations/0004_ear_sessions.sql. routes.js is the real gate. */
const MAX_EAR_DURATION_SEC = 86400;
const MAX_EAR_QUESTIONS = 1000000;
const MAX_EAR_ASSISTS = 1000000;
const MAX_ABS_CENTS = 1200;      // one octave of |deviation| per mic trial

/** Better Auth's user table. Quoted because `user` is a keyword in several SQL
 *  dialects, and named once so the coupling to a table we do not own is
 *  greppable. */
const USER_TABLE = '"user"';

/**
 * Thrown ONLY for caller bugs that have no sensible result value — currently
 * just a malformed pagination cursor. Carries the same {status, code, extra}
 * shape as auth.js's HttpError so worker/index.js's single catch maps both.
 *
 * `extra` is a PROPERTY, not spread onto `this`. It used to be
 * Object.assign(this, extra), which meant index.js's `e.extra` read undefined
 * and every DbError detail (`{detail:'bad_cursor'}`) was silently dropped from
 * the 400 response — the two error types were documented as interchangeable and
 * were not. Mirrored field-for-field on HttpError, body() included.
 */
export class DbError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.name = 'DbError';
    this.status = status | 0;
    this.code = String(code);
    this.extra = extra && typeof extra === 'object' ? extra : {};
  }

  /** The exact JSON body worker/index.js emits. */
  body() {
    return { error: Object.assign({ code: this.code }, this.extra) };
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** The only clock in the module. UNIX SECONDS, never milliseconds. */
export function nowSec() { return Math.floor(Date.now() / 1000); }

export function isFlatId(id) { return typeof id === 'string' && FLAT_ID.test(id); }

/** Cheap on short strings, and the strings it guards are up to 1.5 MB — but a
 *  linear anchored regex over base64 is a few hundred microseconds, well inside
 *  the 10 ms budget, and it is the check that lets the read path skip
 *  JSON.stringify entirely. */
export function isB64(s) { return typeof s === 'string' && B64_RE.test(s); }

/**
 * 'p_' + 22 base64url chars = 24 chars, 128 bits of entropy.
 * base64url's alphabet is A-Za-z0-9-_ so the id is FLAT by construction and
 * needs no post-hoc sanitising. Ids are minted SERVER-side because the primary
 * key is global and every project is public: a client-chosen id would let
 * anyone squat 'seed-private-eyes' or front-run another user's id. Entropy
 * handles accidental collision; server minting handles deliberate squatting.
 */
export function mintProjectId() {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  let bin = '';
  for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
  return 'p_' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = (t.length % 4) === 0 ? '' : '===='.slice(t.length % 4);
  const bin = atob(t + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** D1 result meta, defensively. */
function metaOf(res) { return (res && res.meta) || {}; }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
/** rows read, lifted off D1 meta. */
function rr(res) { return num(metaOf(res).rows_read); }
/** rows written, lifted off D1 meta. */
function rw(res) { return num(metaOf(res).rows_written); }
/** Rows the statement actually modified — the CAS verdict. */
function changesOf(res) { return num(metaOf(res).changes); }

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return dflt;
  return n < lo ? lo : (n > hi ? hi : n);
}

/** Names are validated upstream (400 on empty or >200 chars); this is the
 *  backstop that keeps a bad name from becoming a bad row. */
function normName(name) {
  const s = String(name == null ? '' : name).trim();
  return (s.length > MAX_NAME_CHARS ? s.slice(0, MAX_NAME_CHARS) : s) || 'Untitled';
}

/** Accepts the array the client models instruments as, or the comma-joined
 *  string the column stores. Commas inside an entry would corrupt the split on
 *  the way out, so they are stripped. */
function normInstruments(v) {
  const parts = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const s = String(parts[i] == null ? '' : parts[i]).trim().replace(/,/g, '');
    if (s) out.push(s);
  }
  return out.join(',');
}

function normQuery(q) {
  const s = String(q == null ? '' : q).trim();
  if (!s) return null;
  return s.length > MAX_Q_CHARS ? s.slice(0, MAX_Q_CHARS) : s;
}

/** Substring search, matching what app.js:676 already ships
 *  ((p.name||'').toLowerCase().indexOf(q) >= 0). The user's own %, _ and \ are
 *  escaped so a query of "100%" does not turn into a wildcard. */
function likeContains(q) {
  return '%' + String(q).toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
}

/**
 * SQLite reports which UNIQUE index a failed INSERT hit, and the three we care
 * about are distinguishable by name:
 *    "UNIQUE constraint failed: projects.id"
 *    "UNIQUE constraint failed: projects.owner_id, projects.client_key"
 *    "UNIQUE constraint failed: ear_sessions.user_id, ear_sessions.started"
 * (all verified against SQLite). Anything else is not ours to interpret.
 *
 * ear_sessions is classified HERE rather than in a second little classifier of
 * its own precisely because of the `cause` subtlety documented below: that bug
 * cost us a wrong status code once already, and duplicating the fix is how it
 * comes back on the path that gets less traffic.
 *
 * BOTH `message` AND `cause.message` ARE INSPECTED. D1 frequently wraps the
 * driver error and surfaces the SQLite constraint text only on `err.cause`,
 * leaving `err.message` as a generic "D1_ERROR". Reading message alone made this
 * return null on those responses, so insertWithIdRetry() rethrew: a genuinely
 * racing duplicate create/fork answered 500 instead of the idempotent replay the
 * contract promises, and a minted-id PK collision aborted instead of retrying —
 * exactly the cases uq_projects_owner_key exists to absorb.
 */
function classifyConstraint(err) {
  const m = String((err && err.message) || '') + ' ' +
            String((err && err.cause && err.cause.message) || '');
  if (!/constraint failed/i.test(m)) return null;
  if (/CHECK constraint/i.test(m)) return 'check';
  // Checked before the projects clauses only for reading order; the table names
  // are disjoint, so the tests cannot shadow one another.
  if (/ear_sessions\.(user_id|started)/i.test(m)) return 'ear_pk';
  if (/projects\.client_key|projects\.owner_id/i.test(m)) return 'client_key';
  if (/projects\.id/i.test(m)) return 'pk';
  return 'constraint';
}

// ---------------------------------------------------------------------------
// Card projection
// ---------------------------------------------------------------------------

/**
 * The EXACT select list every list route uses. It exists as a constant so no
 * downstream route can accidentally pull payload_b64 into a listing — which is
 * the difference between a 4 KB library response and a 3 MB one.
 *
 * owner_name / owner_image come from Better Auth's user table via a LEFT JOIN;
 * LEFT (not INNER) because projects deliberately have no FK to `user` and must
 * survive their author's account being deleted, rendering as "unknown author"
 * rather than vanishing.
 */
export const CARD_COLS = [
  'p.id', 'p.owner_id', 'p.client_key', 'p.name',
  'p.youtube_url', 'p.has_song', 'p.track_count', 'p.instruments',
  'p.encoding', 'p.payload_bytes', 'p.payload_sha',
  'p.version', 'p.created', 'p.updated', 'p.deleted',
  'p.fork_of', 'p.fork_root',
  'u.name AS owner_name', 'u.image AS owner_image'
].join(', ');

/* THE JOIN COSTS ONE EXTRA ROW READ PER ROW RETURNED, and the budgets in this
 * file are written with that included. It is an equality seek on user's PK, so
 * it is charged per OUTPUT row, not per row scanned: a 40-card listing is ~82
 * rows read (41 projects + 41 users), while a search that scans 2,000 projects
 * and matches nothing is ~2,000 — the filter runs before the join.
 * Alternative considered and rejected: denormalize owner_name/owner_image onto
 * projects at insert time and drop the join. It would halve listing reads, but
 * rows READ is not the binding constraint here (5M/day vs 100k written/day), and
 * it would freeze a user's display name and avatar at the moment they first
 * saved. LEFT, not INNER: projects deliberately have no FK to `user` and must
 * survive their author's account being deleted, rendering as "unknown author"
 * rather than vanishing. */
const CARD_FROM = 'FROM projects p LEFT JOIN ' + USER_TABLE + ' u ON u.id = p.owner_id';

/**
 * Pure. Row -> the wire shape the client renders. Never reads payload_b64
 * (it is not even selected by CARD_COLS).
 *
 *   viewer  {id, isAdmin} | null   — drives isMine / canEdit (R4 + R5)
 *   extra   {viewedAt, admin}      — viewedAt falls back to row.viewed_at,
 *                                    which listProjects() stamps onto rows that
 *                                    came from the caller's own history;
 *                                    admin:true adds the two fields the admin
 *                                    listing needs (deleted, payloadBytes).
 * Quota cost: none, this touches no database.
 */
export function toCard(row, viewer, extra) {
  if (!row) return null;
  const ex = extra || {};
  const isMine = !!(viewer && viewer.id && viewer.id === row.owner_id);
  const viewedAt = (ex.viewedAt != null) ? ex.viewedAt
    : (row.viewed_at != null ? row.viewed_at : null);
  const card = {
    id: row.id,
    name: row.name,
    updated: num(row.updated),
    created: num(row.created),
    youtubeUrl: row.youtube_url || '',
    hasSong: !!num(row.has_song),
    instruments: String(row.instruments || '').split(',').filter(Boolean),
    trackCount: num(row.track_count),
    version: num(row.version),
    ownerId: row.owner_id,
    ownerName: row.owner_name || null,
    ownerImage: row.owner_image || null,
    isMine: isMine,
    canEdit: isMine || !!(viewer && viewer.isAdmin),
    forkOf: row.fork_of || null,
    forkRoot: row.fork_root || null,
    viewedAt: viewedAt
  };
  if (ex.admin) {
    card.deleted = !!num(row.deleted);
    card.payloadBytes = num(row.payload_bytes);
  }
  return card;
}

// ---------------------------------------------------------------------------
// Cursors
//
// Keyset, never OFFSET: `updated < ?u OR (updated = ?u AND id < ?i)` lets
// idx_projects_recent drive pagination with no scan of skipped rows.
// Each cursor carries a one-letter ORDER TAG so a cursor minted under one sort
// cannot be silently misread under another when the user changes the sort
// mid-pagination — that mismatch is a 400, not a corrupted page.
// ---------------------------------------------------------------------------

function encodeCursor(c, order) {
  if (order === 'name') return b64urlEncode('n:' + c.nameLc + '\u0000' + c.id);
  if (order === 'recent') {
    return c.phase === 'head'
      ? b64urlEncode('r:h:' + c.offset)
      : b64urlEncode('r:t:' + c.updated + ':' + c.id);
  }
  return b64urlEncode('u:' + c.updated + ':' + c.id);
}

function parseCursor(cursor, order) {
  let s;
  try { s = b64urlDecode(cursor); }
  catch (e) { throw new DbError(400, 'bad_request', { detail: 'bad_cursor' }); }
  const bad = () => { throw new DbError(400, 'bad_request', { detail: 'bad_cursor' }); };
  if (order === 'name') {
    if (s.slice(0, 2) !== 'n:') bad();
    const rest = s.slice(2);
    const nul = rest.indexOf('\u0000');
    if (nul < 0) bad();
    const id = rest.slice(nul + 1);
    if (!isFlatId(id)) bad();
    return { nameLc: rest.slice(0, nul), id: id };
  }
  if (order === 'recent') {
    if (s.slice(0, 4) === 'r:h:') {
      const off = Math.floor(Number(s.slice(4)));
      if (!isFinite(off) || off < 0) bad();
      return { phase: 'head', offset: off };
    }
    if (s.slice(0, 4) === 'r:t:') {
      const rest = s.slice(4);
      const colon = rest.indexOf(':');
      if (colon < 0) bad();
      const updated = Math.floor(Number(rest.slice(0, colon)));
      const id = rest.slice(colon + 1);
      if (!isFinite(updated) || !isFlatId(id)) bad();
      return { phase: 'tail', updated: updated, id: id };
    }
    return bad();
  }
  if (s.slice(0, 2) !== 'u:') bad();
  const rest = s.slice(2);
  const colon = rest.indexOf(':');
  if (colon < 0) bad();
  const updated = Math.floor(Number(rest.slice(0, colon)));
  const id = rest.slice(colon + 1);
  if (!isFinite(updated) || !isFlatId(id)) bad();
  return { updated: updated, id: id };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One project by id, with or without its payload.
 *
 *   opts.withPayload     also select payload_b64 (the GET /:id route only)
 *   opts.includeDeleted  admin: see soft-deleted rows, which are 404 to
 *                        everyone else
 *
 * Quota: 1 statement, 1 row read. Zero rows written.
 */
export async function getProject(db, id, opts) {
  const o = opts || {};
  if (!isFlatId(id)) return { row: null, rowsRead: 0 };
  const cols = CARD_COLS + (o.withPayload ? ', p.payload_b64' : '');
  const where = o.includeDeleted ? 'WHERE p.id = ?' : 'WHERE p.id = ? AND p.deleted = 0';
  const res = await db.prepare(
    'SELECT ' + cols + ' ' + CARD_FROM + ' ' + where + ' LIMIT 1'
  ).bind(id).all();
  const rows = res.results || [];
  return { row: rows.length ? rows[0] : null, rowsRead: rr(res) };
}

/**
 * Does this project exist and is it live? A yes/no question, answered as a
 * yes/no question.
 *
 * Exists because the view route (R3's hot path, POST /api/projects/:id/view)
 * needs an existence check before it writes a history row — recent_views has no
 * foreign key by design — and calling getProject() for that pulled all 19
 * CARD_COLS through the LEFT JOIN on `user`: 2 rows read and a join to learn one
 * bit. This is 1 row read, no join, and no columns.
 *
 * Quota: 1 statement, ≤1 row read, zero written.
 */
export async function getProjectExists(db, id) {
  if (!isFlatId(id)) return { exists: false, rowsRead: 0 };
  const res = await db.prepare(
    'SELECT 1 AS ok FROM projects WHERE id = ? AND deleted = 0 LIMIT 1'
  ).bind(id).all();
  const rows = res.results || [];
  return { exists: rows.length > 0, rowsRead: rr(res) };
}

/**
 * Internal: one page of the column-ordered listing. Returns raw rows; cursor
 * bookkeeping happens in the wrapper so the recently-viewed tail can reuse this
 * without paying for it.
 */
async function queryPage(db, o) {
  const where = [];
  const binds = [];
  if (o.deletedOnly) where.push('p.deleted = 1');
  else if (!o.includeDeleted) where.push('p.deleted = 0');   // uses the partial index
  if (o.ownerId) { where.push('p.owner_id = ?'); binds.push(o.ownerId); }
  if (o.q) { where.push("p.name_lc LIKE ? ESCAPE '\\'"); binds.push(likeContains(o.q)); }
  if (o.cursorObj) {
    if (o.order === 'name') {
      where.push('(p.name_lc > ? OR (p.name_lc = ? AND p.id > ?))');
      binds.push(o.cursorObj.nameLc, o.cursorObj.nameLc, o.cursorObj.id);
    } else {
      where.push('(p.updated < ? OR (p.updated = ? AND p.id < ?))');
      binds.push(o.cursorObj.updated, o.cursorObj.updated, o.cursorObj.id);
    }
  }
  const orderBy = (o.order === 'name')
    ? 'ORDER BY p.name_lc ASC, p.id ASC'
    : 'ORDER BY p.updated DESC, p.id DESC';
  const sql = 'SELECT ' + CARD_COLS + ' ' + CARD_FROM +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ' + orderBy + ' LIMIT ?';
  binds.push(o.sqlLimit);
  const res = await db.prepare(sql).bind(...binds).all();
  return { rows: res.results || [], rowsRead: rr(res) };
}

/**
 * The library listing.
 *
 *   order   'updated' (default) | 'name' | 'recent'
 *   q       substring, case-insensitive, over name_lc
 *   ownerId "My projects" (R2), or admin scoping to another user
 *   viewerId  whose recently-viewed history to order by
 *   includeDeleted / deletedOnly   admin tombstone views
 *   limit   1..100, default 40
 *   cursor  opaque keyset cursor from a previous page
 *
 * ORDER DEGRADATION. 'recent' needs a per-user history to sort by, so it
 * degrades to 'updated' and reports degraded:true whenever there is none or
 * something else already owns the ordering: an anonymous caller, a search
 * (the contract sorts search results by updated), a "My projects" filter, or an
 * admin tombstone view. The route surfaces this as orderDegraded so the UI can
 * label the list "Recently updated" honestly instead of lying.
 *
 * ANONYMOUS DEFAULT IS `updated DESC` because it is the only ordering already
 * backed by a maintained index, so it adds ZERO write cost; because "recently
 * edited" is the best available proxy for "worth looking at" in a transcription
 * library; and because it matches server/app.py:702, so the library looks
 * identical in the desktop app and in a logged-out browser.
 *
 * Quota: ZERO rows written. Rows read, WITH the LEFT JOIN on `user` counted (it
 * costs one extra row per row RETURNED — see CARD_FROM):
 *   column order  2 x (limit + 1)   — 82 at the default limit of 40
 *   'recent'      ~380 at limit 40, ~502 at limit 100: 60 history rows, then
 *                 up to 60 hydrated cards + their 60 joined users, then a padded
 *                 page of up to limit+60+1 projects + the same number of users
 *   search        the scanned projects (no join for rows the LIKE rejects) plus
 *                 2 x (limit + 1) for what matches
 * Statements: 1 for a column order, at most 3 for 'recent'. Search is a
 * deliberate full scan — see schema.sql for the arithmetic and the threshold.
 */
export async function listProjects(db, opts) {
  const o = opts || {};
  const asked = (o.order === 'name' || o.order === 'recent') ? o.order : 'updated';
  const viewerId = o.viewerId || null;
  const q = normQuery(o.q);
  const ownerId = o.ownerId || null;
  const includeDeleted = !!o.includeDeleted;
  const deletedOnly = !!o.deletedOnly;
  const limit = clampInt(o.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);

  const recentUsable = asked === 'recent' && !!viewerId &&
    !q && !ownerId && !includeDeleted && !deletedOnly;

  if (recentUsable) return listRecentPage(db, viewerId, limit, o.cursor);

  const order = asked === 'name' ? 'name' : 'updated';
  const cursorObj = o.cursor ? parseCursor(o.cursor, order) : null;
  // limit + 1 is how we learn whether another page exists without a COUNT(*).
  const page = await queryPage(db, {
    order, q, ownerId, includeDeleted, deletedOnly, cursorObj,
    sqlLimit: limit + 1
  });
  const more = page.rows.length > limit;
  const rows = more ? page.rows.slice(0, limit) : page.rows;
  let nextCursor = null;
  if (more && rows.length) {
    const last = rows[rows.length - 1];
    nextCursor = (order === 'name')
      ? encodeCursor({ nameLc: String(last.name || '').toLowerCase(), id: last.id }, 'name')
      : encodeCursor({ updated: num(last.updated), id: last.id }, 'updated');
  }
  return {
    rows: rows,
    nextCursor: nextCursor,
    rowsRead: page.rowsRead,
    orderUsed: order,
    degraded: asked === 'recent'
  };
}

/**
 * Internal: the signed-in default page — "your history, then the same
 * updated-ordered list as the tail".
 *
 * A short history must not produce a nearly empty library, so once the head is
 * exhausted the page PADS from idx_projects_recent, excluding ids already
 * shown. Head rows carry row.viewed_at; padded rows carry null, so the UI can
 * draw a truthful "Recently viewed" / "More projects" divider.
 *
 * Paging is a two-phase cursor: an offset within the (small, fully
 * materialized, ≤60-row) head, then a keyset over the padded tail. The history
 * is re-read on every page because it is also the exclusion set for the tail —
 * that keeps the pages disjoint without stuffing 60 ids into a cursor.
 */
async function listRecentPage(db, viewerId, limit, cursor) {
  const cur = cursor ? parseCursor(cursor, 'recent') : { phase: 'head', offset: 0 };
  let rowsRead = 0;

  // (A) the user's own history. PK's leading column, so this scans only their
  //     slice; the filesort is over tens of rows, which is exactly the trade
  //     that lets us keep `viewed` unindexed and a view at 1 row written.
  const hist = await listRecentForUser(db, viewerId, RECENT_HISTORY_LIMIT, RECENT_MAX_AGE_SEC);
  rowsRead += hist.rowsRead;

  const viewedAt = new Map();
  const ids = [];
  for (let i = 0; i < hist.entries.length && ids.length < MAX_IN_PARAMS; i++) {
    const e = hist.entries[i];
    if (viewedAt.has(e.projectId)) continue;
    viewedAt.set(e.projectId, e.viewed);
    ids.push(e.projectId);
  }

  // (B) hydrate those ids into cards. Soft-deleted and hard-deleted projects
  //     drop out here, which is why stale history rows are harmless.
  let head = [];
  if (ids.length) {
    const h = await hydrateCards(db, ids, viewerId);
    rowsRead += h.rowsRead;
    head = h.rows;
    for (let i = 0; i < head.length; i++) head[i].viewed_at = viewedAt.get(head[i].id) || null;
    head.sort(function (a, b) {
      const d = num(b.viewed_at) - num(a.viewed_at);
      if (d) return d;
      return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0);
    });
  }

  const headIds = new Set();
  for (let i = 0; i < head.length; i++) headIds.add(head[i].id);

  const offset = cur.phase === 'head' ? Math.min(cur.offset, head.length) : head.length;
  const page = head.slice(offset, offset + limit);
  let nextCursor = null;

  if (offset + page.length < head.length) {
    nextCursor = encodeCursor({ phase: 'head', offset: offset + page.length }, 'recent');
  } else {
    const need = limit - page.length;
    if (need > 0) {
      // Over-fetch by the head size so that, even if every row in the window is
      // already in the head, we still learn whether a further page exists.
      const over = Math.min(need + head.length + 1, MAX_LIMIT + RECENT_HISTORY_LIMIT + 1);
      const pad = await queryPage(db, {
        order: 'updated',
        cursorObj: cur.phase === 'tail' ? { updated: cur.updated, id: cur.id } : null,
        sqlLimit: over
      });
      rowsRead += pad.rowsRead;
      const fresh = [];
      for (let i = 0; i < pad.rows.length; i++) {
        if (!headIds.has(pad.rows[i].id)) fresh.push(pad.rows[i]);
      }
      const take = fresh.slice(0, need);
      for (let i = 0; i < take.length; i++) {
        take[i].viewed_at = null;
        page.push(take[i]);
      }
      if (fresh.length > need && take.length) {
        const last = take[take.length - 1];
        nextCursor = encodeCursor(
          { phase: 'tail', updated: num(last.updated), id: last.id }, 'recent');
      }
    }
  }

  return { rows: page, nextCursor, rowsRead, orderUsed: 'recent', degraded: false };
}

/**
 * One user's recently-viewed slice, newest first.
 *
 * Uses the PRIMARY KEY's leading column and filesorts the result. That filesort
 * is the whole point: it is what buys us NOT indexing `viewed`, which would add
 * +1 row written to every project open — a permanent 100% surcharge on the
 * hottest path in the app — to sort a few dozen rows.
 *
 * Quota: 1 statement, ≤ limit rows read, zero written.
 */
export async function listRecentForUser(db, userId, limit, maxAgeSec) {
  if (!userId) return { entries: [], rowsRead: 0 };
  const lim = clampInt(limit, 1, MAX_IN_PARAMS, RECENT_HISTORY_LIMIT);
  const age = clampInt(maxAgeSec, 60, 31536000 * 5, RECENT_MAX_AGE_SEC);
  const res = await db.prepare(
    'SELECT project_id, viewed FROM recent_views ' +
    'WHERE user_id = ? AND viewed > ? ORDER BY viewed DESC LIMIT ?'
  ).bind(userId, nowSec() - age, lim).all();
  const out = [];
  const rows = res.results || [];
  for (let i = 0; i < rows.length; i++) {
    out.push({ projectId: rows[i].project_id, viewed: num(rows[i].viewed) });
  }
  return { entries: out, rowsRead: rr(res) };
}

/**
 * Cards for an explicit id list, live projects only. Order is NOT preserved —
 * the caller re-orders (listRecentPage sorts by `viewed`), which is a sort of
 * ≤60 items and costs microseconds.
 *
 * ids.length must be ≤ 90 (D1 caps bound params at 100); longer lists are
 * truncated rather than throwing, because the only caller already caps at 60.
 * `viewerId` is accepted per the contract but does not appear in the SQL — the
 * viewer only affects toCard()'s isMine/canEdit, not which rows are visible,
 * because every project is public (R2).
 *
 * Quota: 1 statement, ≤ ids.length rows read, zero written.
 */
export async function hydrateCards(db, ids, viewerId) {
  const list = [];
  for (let i = 0; i < (ids ? ids.length : 0) && list.length < MAX_IN_PARAMS; i++) {
    if (isFlatId(ids[i])) list.push(ids[i]);
  }
  if (!list.length) return { rows: [], rowsRead: 0 };
  const holes = new Array(list.length).fill('?').join(',');
  const res = await db.prepare(
    'SELECT ' + CARD_COLS + ' ' + CARD_FROM +
    ' WHERE p.deleted = 0 AND p.id IN (' + holes + ')'
  ).bind(...list).all();
  return { rows: res.results || [], rowsRead: rr(res) };
}

/**
 * Idempotency lookup: has this owner already created a project with this
 * client key? NULL keys never match — SQLite treats NULLs as distinct in a
 * UNIQUE index, which is exactly what admin imports rely on.
 *
 * Quota: 1 statement, ≤1 row read, zero written.
 */
export async function findByClientKey(db, ownerId, clientKey) {
  if (!ownerId || !clientKey) return { row: null, rowsRead: 0 };
  const res = await db.prepare(
    'SELECT ' + CARD_COLS + ' ' + CARD_FROM +
    ' WHERE p.owner_id = ? AND p.client_key = ? LIMIT 1'
  ).bind(ownerId, clientKey).all();
  const rows = res.results || [];
  return { row: rows.length ? rows[0] : null, rowsRead: rr(res) };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Shared payload validation. Upstream (routes.js readPayload) is the real gate;
 *  this is the backstop that prevents a corrupt row if it is ever bypassed.
 *
 *  `alreadyValidated` is what keeps the backstop from being a second O(n) scan
 *  of up to MAX_PAYLOAD_CHARS on the hottest write path: readPayload() ran the
 *  identical anchored regex over this exact string moments earlier and passes
 *  payloadChecked:true to say so. The length and type tests are O(1) and always
 *  run. Any caller that did NOT come through readPayload — a future route, a
 *  test, a tool — simply omits the flag and pays for the scan. */
function checkPayload(payloadB64, alreadyValidated) {
  if (typeof payloadB64 !== 'string' || !payloadB64.length) return 'bad_payload';
  if (payloadB64.length > MAX_PAYLOAD_CHARS) return 'payload_too_large';
  if (alreadyValidated !== true && !isB64(payloadB64)) return 'bad_payload';
  return null;
}

function normEncoding(e) {
  return e === 'identity+b64' ? 'identity+b64' : 'gzip+b64';
}

/**
 * Internal: run an INSERT that may collide, minting a fresh id and retrying
 * when the collision is on the PRIMARY KEY and the id was ours to choose.
 *
 * Three layers keep ids safe, and they are separate concerns:
 *   1. 128 bits of entropy — accidental collision is a ~2^64-project event.
 *   2. The PK constraint is the authority: a collision FAILS the insert rather
 *      than silently overwriting, and we retry with a new id (max 3 attempts).
 *   3. Idempotency is handled by uq_projects_owner_key, not by the PK, so a
 *      retried create returns the FIRST row instead of minting a second id.
 */
async function insertWithIdRetry(db, explicitId, ownerId, clientKey, makeStmt) {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const id = explicitId || mintProjectId();
    try {
      const res = await makeStmt(id);
      return { ok: true, id: id, res: res };
    } catch (err) {
      const kind = classifyConstraint(err);
      if (kind === 'client_key') {
        // A retried or double-tapped create. Return the row that already exists.
        const found = await findByClientKey(db, ownerId, clientKey);
        if (found.row) {
          return { ok: false, code: 'idempotent_replay', row: found.row, rowsRead: found.rowsRead };
        }
        return { ok: false, code: 'id_taken' };
      }
      if (kind === 'pk') {
        if (explicitId) return { ok: false, code: 'id_taken' };
        continue;                       // minted id lost a race; mint another.
      }
      if (kind === 'check') return { ok: false, code: 'bad_payload' };
      throw err;                        // not ours — let index.js log a 500.
    }
  }
  return { ok: false, code: 'id_exhausted' };
}

const INSERT_COLS =
  '(id, owner_id, client_key, name, name_lc, youtube_url, has_song, track_count, ' +
  'instruments, encoding, payload_b64, payload_bytes, payload_sha, version, ' +
  'created, updated, deleted, fork_of, fork_root)';

/**
 * Create a project (POST /api/projects, POST /api/projects/:id/fork carrying a
 * local payload, POST /api/admin/import).
 *
 * `id` null mints one server-side; a non-null id is the ADMIN IMPORT path only,
 * which is what keeps clients from squatting memorable ids. name_lc is derived
 * here and never accepted from the client.
 *
 * ROWS WRITTEN: 4 — 1 table + 1 PK autoindex + 1 idx_projects_recent
 * + 1 uq_projects_owner_key. 0 on an idempotent replay.
 * Statements: 1 INSERT, plus 1 SELECT to return the joined row with its
 * owner_name (creates are rare; the listing path never pays this).
 */
export async function insertProject(db, p) {
  const bad = checkPayload(p.payloadB64, p.payloadChecked);
  if (bad) return { ok: false, code: bad, rowsWritten: 0 };
  if (p.id != null && !isFlatId(p.id)) return { ok: false, code: 'bad_id', rowsWritten: 0 };
  if (!p.ownerId) return { ok: false, code: 'bad_owner', rowsWritten: 0 };

  const at = num(p.updated) || nowSec();
  const created = num(p.created) || at;
  const name = normName(p.name);
  const sql = 'INSERT INTO projects ' + INSERT_COLS +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,0,?,?)';

  const out = await insertWithIdRetry(db, p.id || null, p.ownerId, p.clientKey || null,
    function (id) {
      return db.prepare(sql).bind(
        id,
        p.ownerId,
        p.clientKey || null,
        name,
        name.toLowerCase(),
        String(p.youtubeUrl || ''),
        p.hasSong ? 1 : 0,
        clampInt(p.trackCount, 0, 1e6, 0),
        normInstruments(p.instruments),
        normEncoding(p.encoding),
        p.payloadB64,                       // BOUND PARAMETER, never inlined
        clampInt(p.payloadBytes, 0, 1e9, 0),
        String(p.payloadSha || ''),
        created,
        at,
        p.forkOf || null,
        p.forkRoot || null
      ).run();
    });

  if (!out.ok) {
    if (out.code === 'idempotent_replay') {
      return { ok: false, code: 'idempotent_replay', row: out.row, rowsWritten: 0 };
    }
    return { ok: false, code: out.code, rowsWritten: 0 };
  }
  const rowsWritten = rw(out.res);
  const got = await getProject(db, out.id, { includeDeleted: true });
  return { ok: true, row: got.row, rowsWritten: rowsWritten, rowsRead: got.rowsRead };
}

/**
 * Fork WITHOUT moving the bytes. INSERT ... SELECT copies payload_b64 inside
 * D1, so an 80 KB payload never enters the Worker's heap and never crosses the
 * wire — used when the caller sends X-Studio-Fork-Source: server (i.e. the
 * forker has no local edits worth keeping).
 *
 * fork_root is denormalized to COALESCE(source.fork_root, source.id) so lineage
 * is one equality lookup rather than a recursive CTE the Worker has no CPU for.
 *
 * ROWS WRITTEN: 4, on the NEW row only. The SOURCE ROW IS NEVER WRITTEN —
 * there is deliberately no fork counter, because that would turn a read action
 * into a write on a row many users share.
 * Statements: 1 INSERT..SELECT + 1 SELECT for the returned card.
 */
export async function forkProjectServerSide(db, p) {
  if (!isFlatId(p.sourceId)) return { ok: false, code: 'not_found', rowsWritten: 0 };
  if (p.newId != null && !isFlatId(p.newId)) return { ok: false, code: 'bad_id', rowsWritten: 0 };
  if (!p.ownerId) return { ok: false, code: 'bad_owner', rowsWritten: 0 };

  const at = num(p.at) || nowSec();
  const name = normName(p.name);
  const sql = 'INSERT INTO projects ' + INSERT_COLS + ' SELECT ' +
    '?, ?, ?, ?, ?, s.youtube_url, s.has_song, s.track_count, s.instruments, ' +
    's.encoding, s.payload_b64, s.payload_bytes, s.payload_sha, 1, ?, ?, 0, ' +
    's.id, COALESCE(s.fork_root, s.id) ' +
    'FROM projects s WHERE s.id = ? AND s.deleted = 0';

  const out = await insertWithIdRetry(db, p.newId || null, p.ownerId, p.clientKey || null,
    function (id) {
      return db.prepare(sql).bind(
        id, p.ownerId, p.clientKey || null, name, name.toLowerCase(),
        at, at, p.sourceId
      ).run();
    });

  if (!out.ok) {
    if (out.code === 'idempotent_replay') {
      return { ok: false, code: 'idempotent_replay', row: out.row, rowsWritten: 0 };
    }
    return { ok: false, code: out.code, rowsWritten: 0 };
  }
  // An INSERT..SELECT whose SELECT matched nothing is a SUCCESSFUL statement
  // that inserted no row — that is how a missing or soft-deleted source
  // surfaces, and it must not be mistaken for a created fork.
  if (changesOf(out.res) === 0) {
    return { ok: false, code: 'not_found', rowsWritten: rw(out.res) };
  }
  const rowsWritten = rw(out.res);
  const got = await getProject(db, out.id, {});
  return { ok: true, row: got.row, rowsWritten: rowsWritten, rowsRead: got.rowsRead };
}

/**
 * THE SAVE. One conditional UPDATE implementing compare-and-swap on `version`.
 *
 *   UPDATE ... SET version = version + 1 WHERE id = ? AND version = ? AND deleted = 0
 *
 * meta.changes === 1 means we won: the caller answers 200 with version + 1.
 * changes === 0 means we lost, and exactly ONE follow-up SELECT distinguishes
 * "someone else moved it" (409, with the server's version/updated/sha so the
 * client can offer keep-mine / save-a-copy / take-theirs) from "it is gone"
 * (404). No transaction, no read-then-write, no lost update.
 *
 * payloadB64 is a BOUND PARAMETER. At up to 1.5 M characters it would blow
 * D1's 100 KB statement-text cap if it were ever interpolated.
 *
 * ROWS WRITTEN: 2 — 1 table + 1 idx_projects_recent (because `updated` moves).
 * owner_id and client_key are immutable, so uq_projects_owner_key is untouched
 * and costs nothing on this, the hottest write path. 0 rows on a 409 or 404.
 * Statements: 1, or 2 when the CAS fails.
 */
export async function updateProjectPayload(db, p) {
  const bad = checkPayload(p.payloadB64, p.payloadChecked);
  if (bad) return { ok: false, code: bad, rowsWritten: 0 };
  if (!isFlatId(p.id)) return { ok: false, code: 'not_found', rowsWritten: 0 };
  const expected = Math.floor(Number(p.expectedVersion));
  if (!isFinite(expected) || expected < 1) {
    return { ok: false, code: 'conflict', serverVersion: null, rowsWritten: 0 };
  }
  const at = num(p.at) || nowSec();
  const name = normName(p.name);

  const res = await db.prepare(
    'UPDATE projects SET ' +
    'name = ?, name_lc = ?, youtube_url = ?, has_song = ?, track_count = ?, ' +
    'instruments = ?, encoding = ?, payload_b64 = ?, payload_bytes = ?, ' +
    'payload_sha = ?, version = version + 1, updated = ? ' +
    'WHERE id = ? AND version = ? AND deleted = 0'
  ).bind(
    name,
    name.toLowerCase(),
    String(p.youtubeUrl || ''),
    p.hasSong ? 1 : 0,
    clampInt(p.trackCount, 0, 1e6, 0),
    normInstruments(p.instruments),
    normEncoding(p.encoding),
    p.payloadB64,                          // BOUND PARAMETER
    clampInt(p.payloadBytes, 0, 1e9, 0),
    String(p.payloadSha || ''),
    at,
    p.id,
    expected
  ).run();

  if (changesOf(res) === 1) {
    return { ok: true, version: expected + 1, updated: at, rowsWritten: rw(res) };
  }
  return withCasFailureReason(db, p.id, rw(res));
}

/**
 * Internal: the single follow-up SELECT that tells 409 from 404 after a lost
 * CAS. Deliberately one statement and deliberately only issued on failure, so
 * the winning path stays at exactly one query.
 */
async function withCasFailureReason(db, id, rowsWritten) {
  const res = await db.prepare(
    'SELECT version, updated, payload_sha, deleted FROM projects WHERE id = ? LIMIT 1'
  ).bind(id).all();
  const rows = res.results || [];
  if (!rows.length || num(rows[0].deleted) === 1) {
    return { ok: false, code: 'not_found', rowsWritten: rowsWritten, rowsRead: rr(res) };
  }
  return {
    ok: false,
    code: 'conflict',
    serverVersion: num(rows[0].version),
    serverUpdated: num(rows[0].updated),
    serverSha: rows[0].payload_sha || '',
    rowsWritten: rowsWritten,
    rowsRead: rr(res)
  };
}

/**
 * Rename, same CAS discipline as a save. This route exists SO THAT renaming
 * never re-uploads the payload: an 80 KB round trip becomes a ~40 byte one.
 *
 * ROWS WRITTEN: 2 — 1 table + 1 idx_projects_recent. name and name_lc are
 * deliberately unindexed (a substring search cannot use a B-tree anyway), so
 * they add nothing. Statements: 1, or 2 when the CAS fails.
 */
export async function renameProject(db, p) {
  if (!isFlatId(p.id)) return { ok: false, code: 'not_found', rowsWritten: 0 };
  const expected = Math.floor(Number(p.expectedVersion));
  if (!isFinite(expected) || expected < 1) {
    return { ok: false, code: 'conflict', serverVersion: null, rowsWritten: 0 };
  }
  const at = num(p.at) || nowSec();
  const name = normName(p.name);
  const res = await db.prepare(
    'UPDATE projects SET name = ?, name_lc = ?, version = version + 1, updated = ? ' +
    'WHERE id = ? AND version = ? AND deleted = 0'
  ).bind(name, name.toLowerCase(), at, p.id, expected).run();

  if (changesOf(res) === 1) {
    return { ok: true, version: expected + 1, updated: at, name: name, rowsWritten: rw(res) };
  }
  return withCasFailureReason(db, p.id, rw(res));
}

/**
 * Soft delete (author or admin) and restore (admin only).
 *
 * Unconditional on `version` by design: deleting is not an edit and must not
 * fail because an autosave moved the row a second earlier. It IS conditional on
 * the current state, so a second delete reports 'noop' rather than silently
 * bumping the version again.
 *
 * ROWS WRITTEN: 2 — 1 table + 1 idx_projects_recent, as the row LEAVES the
 * partial index on delete and RE-ENTERS it on restore. The project's
 * recent_views rows are intentionally left behind: they are three tiny columns,
 * removing them would be N writes, and hydrateCards already filters to live
 * projects so tombstoned history is invisible.
 * Statements: 1, or 2 when nothing changed.
 */
export async function setDeleted(db, p) {
  if (!isFlatId(p.id)) return { ok: false, code: 'not_found', rowsWritten: 0 };
  const want = p.deleted ? 1 : 0;
  const at = num(p.at) || nowSec();
  const res = await db.prepare(
    'UPDATE projects SET deleted = ?, version = version + 1, updated = ? ' +
    'WHERE id = ? AND deleted = ?'
  ).bind(want, at, p.id, want ? 0 : 1).run();

  if (changesOf(res) === 1) {
    const cur = await db.prepare('SELECT version FROM projects WHERE id = ? LIMIT 1')
      .bind(p.id).all();
    const rows = cur.results || [];
    return {
      ok: true,
      deleted: !!want,
      version: rows.length ? num(rows[0].version) : null,
      updated: at,
      rowsWritten: rw(res),
      rowsRead: rr(cur)
    };
  }
  const probe = await db.prepare('SELECT version, deleted FROM projects WHERE id = ? LIMIT 1')
    .bind(p.id).all();
  const rows = probe.results || [];
  if (!rows.length) {
    return { ok: false, code: 'not_found', rowsWritten: 0, rowsRead: rr(probe) };
  }
  return {
    ok: false,
    code: 'noop',                       // already in the requested state
    deleted: !!num(rows[0].deleted),
    version: num(rows[0].version),
    rowsWritten: 0,
    rowsRead: rr(probe)
  };
}

/**
 * Hard delete, admin only and irreversible outside D1 Time Travel's 7 days.
 *
 * THE PROJECT'S recent_views ROWS ARE DELIBERATELY NOT TOUCHED HERE. This used
 * to run `DELETE FROM recent_views WHERE project_id = ?` alongside the project
 * delete, which reads like a tidy cleanup and is in fact a FULL TABLE SCAN:
 * recent_views is WITHOUT ROWID with PRIMARY KEY (user_id, project_id) and — by
 * the schema's single most deliberate decision — no secondary index, so
 * project_id is the TRAILING column and nothing can seek on it. At the 100,000
 * rows that are the stated trigger for even shipping the prune cron, every admin
 * hard delete would scan and bill 100,000 rows read inside a D1 transaction
 * under a 10 ms CPU budget, growing without bound as the table grows. Adding an
 * index on project_id would fix the scan and cost +1 row written on EVERY
 * project open, which is the trade the schema exists to refuse.
 *
 * Orphaned history is harmless and invisible: hydrateCards() joins to projects
 * and filters `deleted = 0`, so a history row pointing at a vanished id simply
 * never renders. The rows are three tiny columns each and the prune cron
 * (worker/index.js scheduled()) reaps them once they age past the retention
 * window.
 *
 * ROWS WRITTEN: 4 — 1 table + 3 indexes (PK autoindex, idx_projects_recent,
 * uq_projects_owner_key). Statements: 1. `viewsRemoved` stays in the result
 * shape, and is now always 0, so the admin route's response does not change
 * shape on an old client.
 */
export async function hardDeleteProject(db, id) {
  if (!isFlatId(id)) return { ok: false, code: 'not_found', rowsWritten: 0, viewsRemoved: 0 };
  const res = await db.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
  const rowsWritten = rw(res);
  if (changesOf(res) === 0) {
    return { ok: false, code: 'not_found', rowsWritten: rowsWritten, viewsRemoved: 0 };
  }
  return { ok: true, rowsWritten: rowsWritten, viewsRemoved: 0 };
}

/**
 * Transfer ownership, admin only. An author cannot hand a project off; they can
 * only be a fork source.
 *
 * ROWS WRITTEN: 3 — 1 table + 1 idx_projects_recent + 1 uq_projects_owner_key.
 * This is the ONLY write in the app that touches the owner index, which is
 * precisely why that index is safe to carry: every other write leaves owner_id
 * and client_key alone and pays nothing for it.
 *
 * `version` bumps so every cached ETag for this project is invalidated —
 * canEdit just changed for two different people, and a stale editor should be
 * told to reload rather than allowed to save.
 * Statements: 1, plus 1 SELECT for the returned card.
 */
export async function transferOwner(db, p) {
  if (!isFlatId(p.id)) return { ok: false, code: 'not_found', rowsWritten: 0 };
  if (!p.ownerId) return { ok: false, code: 'bad_owner', rowsWritten: 0 };
  const at = num(p.at) || nowSec();
  let res;
  try {
    res = await db.prepare(
      'UPDATE projects SET owner_id = ?, version = version + 1, updated = ? WHERE id = ?'
    ).bind(p.ownerId, at, p.id).run();
  } catch (err) {
    // Vanishingly unlikely: the target owner already has a row carrying this
    // project's client_key (a 30-char random draft id). Report it rather than
    // letting a 500 look like a server fault.
    if (classifyConstraint(err) === 'client_key') {
      return { ok: false, code: 'client_key_conflict', rowsWritten: 0 };
    }
    throw err;
  }
  if (changesOf(res) === 0) {
    return { ok: false, code: 'not_found', rowsWritten: rw(res) };
  }
  const got = await getProject(db, p.id, { includeDeleted: true });
  return { ok: true, row: got.row, rowsWritten: rw(res), rowsRead: got.rowsRead };
}

/**
 * Record a project open (R3). THE HOTTEST WRITE PATH IN THE APP, and the reason
 * several other decisions in this schema look austere.
 *
 * One upsert. The WHERE on the DO UPDATE is the SERVER-SIDE FLOOR: re-opening
 * the same project inside `floorSec` writes ZERO rows. That holds against a
 * user who reloads the tab twenty times while fiddling with a tab layout, and
 * unlike the client-side dedupe it cannot be defeated by clearing localStorage.
 *
 * ROWS WRITTEN: 1, or 0 when the floor suppresses it. That is the FLOOR for
 * this operation and nothing does better: recent_views is WITHOUT ROWID (so the
 * PK is the table, not a second b-tree) and carries NO secondary index (so the
 * `viewed` column that moves on every view costs nothing to move).
 *
 * Budget check: at 1 row per open, a maximally pathological single user capped
 * by the 10-minute floor across 40 projects reaches 5,760 rows/day — 5.8% of
 * the 100,000/day cap. The realistic ten-user profile is ~300 rows/day, 0.3%.
 * Statements: 1.
 */
export async function recordView(db, p) {
  const userId = p.userId;
  const projectId = p.projectId;
  if (!userId || !isFlatId(projectId)) return { recorded: false, rowsWritten: 0 };
  const at = num(p.at) || nowSec();
  const floor = clampInt(p.floorSec, 0, 86400, VIEW_FLOOR_SEC);
  // ?3 is bound twice; the cutoff is computed in JS so no arithmetic runs in SQL.
  const res = await db.prepare(
    'INSERT INTO recent_views (user_id, project_id, viewed) VALUES (?1, ?2, ?3) ' +
    'ON CONFLICT (user_id, project_id) DO UPDATE SET viewed = ?3 ' +
    'WHERE recent_views.viewed < ?4'
  ).bind(userId, projectId, at, at - floor).run();
  const written = rw(res);
  // rows_written is the contract's signal; changes is the fallback for a D1
  // response that omits it.
  const recorded = written > 0 || changesOf(res) > 0;
  return { recorded: recorded, rowsWritten: written };
}

// ---------------------------------------------------------------------------
// ear_sessions — the /learn practice log (migrations/0004_ear_sessions.sql).
//
// The whole feature is LOCAL FIRST: every completed session is already in the
// browser's localStorage before this table hears about it, and the cloud copy
// is additive (design Part I s13). That shapes both functions below — a failed
// write is a code the route can turn into a status, never an exception and
// never a lost session, because the authoritative copy is elsewhere.
//
// ROWS WRITTEN: 1 per session, which is the floor. ear_sessions is WITHOUT
// ROWID with PRIMARY KEY (user_id, started) and NO secondary indexes, so the
// table IS the only b-tree and an insert touches it once. Nothing here ever
// updates or deletes a row: a practice session is an immutable fact.
// ---------------------------------------------------------------------------

/* The column order every statement in this section uses. Named once so the
 * INSERT's 14 placeholders and listEarSessions()'s projection cannot drift
 * apart — they are the same 14 columns in the same order. */
const EAR_COLS =
  'user_id, started, duration_sec, level, mode, context, taper, sing_gate, ' +
  'questions, correct, assists, cents_sum, cents_n, detail';

/** Enum backstops. routes.js rejects anything outside these with a 400 naming
 *  the field; these decide what a bypassed caller's row looks like instead of
 *  letting a CHECK constraint abort the insert. */
function normEarMode(v) { return v === 'produce' ? 'produce' : 'identify'; }
function normEarContext(v) {
  return (v === 'ii-V-I' || v === 'drone') ? v : 'cadence';
}
/** taper ∈ {1,2,4,8} questions, or 0 for "establish the key once per session".
 *  0 is the safe default: it is the only value that cannot overstate how often
 *  the key was re-established. */
function normEarTaper(v) {
  const t = Math.floor(Number(v));
  return (t === 1 || t === 2 || t === 4 || t === 8) ? t : 0;
}

/**
 * Pure. Row -> the wire shape the /learn client reads back. The mirror of
 * toCard() for this table, and it exists for the same reason: the insert path
 * and the list path must hand the client identical objects, and they would
 * drift within a week if each built its own.
 *
 * ACCURACY IS ABSENT ON PURPOSE — it is correct / questions, computed by
 * whoever is rendering (design Part I s13). singGate stays 0/1 rather than
 * becoming a boolean so a record round-trips byte-identical to the localStorage
 * copy it was merged with.
 *
 * Quota cost: none, this touches no database.
 */
export function toEarSession(row) {
  if (!row) return null;
  return {
    started: num(row.started),
    durationSec: num(row.duration_sec),
    level: num(row.level),
    mode: normEarMode(row.mode),
    context: normEarContext(row.context),
    taper: normEarTaper(row.taper),
    singGate: num(row.sing_gate) ? 1 : 0,
    questions: num(row.questions),
    correct: num(row.correct),
    assists: num(row.assists),
    centsSum: num(row.cents_sum),
    centsN: num(row.cents_n),
    detail: String(row.detail == null ? '' : row.detail)
  };
}

/**
 * Record one completed session. THE ONLY WRITE THIS FEATURE HAS.
 *
 * THE DUPLICATE-START PROBLEM, and why the answer is a retry and not an upsert.
 * `started` is the CLIENT's clock, and two tabs of /learn on the same machine
 * can genuinely finish two sessions in the same second — the primary key then
 * collides on a pair of rows that describe DIFFERENT PRACTICE. The obvious
 * one-liner, INSERT OR REPLACE, resolves that collision by DESTROYING the first
 * session: silently, with a 200, and with no way for anyone to notice that ten
 * minutes of a user's practice log evaporated. So does ON CONFLICT DO UPDATE.
 * Both trade a visible, rare, retryable error for permanent invisible data loss,
 * which is the wrong side of that trade for a log whose entire purpose is
 * "what have I actually done".
 *
 * Instead: shift `started` forward one second and try again, up to
 * EAR_STARTED_ATTEMPTS times, then report 'conflict' and let the route answer
 * 409. One second of drift on a timestamp that is already the client's own
 * clock is beneath the resolution of anything that reads it (the streak buckets
 * by day; the list orders by second), whereas a lost session is not. Three
 * attempts covers the real case — a human cannot finish four sessions inside
 * three seconds, so a fourth collision is a stuck client, and that deserves an
 * error rather than an ever-advancing timestamp.
 *
 * A FAILED INSERT WRITES ZERO ROWS: SQLite rolls the statement back on the
 * constraint violation, so the retries are free in quota terms and cost only
 * their round trip. rowsWritten therefore reports 1 on success and 0 on every
 * failure path, which is what ctx.log() adds to the request line.
 *
 * All the p.* values are re-normalized here rather than trusted. routes.js has
 * already validated every one of them and returned 400 for anything out of
 * range; this is the backstop that prevents a future caller (a repair script, a
 * test, a second route) from turning a bad value into a CHECK-constraint 500.
 *
 * ROWS WRITTEN: 1, or 0 on any failure. Statements: 1, up to 3 on collision.
 */
export async function insertEarSession(db, p) {
  const o = p || {};
  if (!o.userId) return { ok: false, code: 'bad_owner', rowsWritten: 0 };
  const detail = String(o.detail == null ? '' : o.detail);
  if (detail.length > MAX_DETAIL_CHARS) {
    return { ok: false, code: 'detail_too_large', rowsWritten: 0 };
  }

  let started = Math.floor(Number(o.started));
  if (!isFinite(started) || started <= 0) started = nowSec();

  // Derived bounds, in dependency order: the mic-trial count cannot exceed the
  // question count, and the cents total cannot exceed one octave per mic trial —
  // which also pins cents_sum to 0 when no mic was used.
  const questions = clampInt(o.questions, 0, MAX_EAR_QUESTIONS, 0);
  const centsN = clampInt(o.centsN, 0, questions, 0);
  const rec = {
    user_id: String(o.userId),
    started: started,
    duration_sec: clampInt(o.durationSec, 0, MAX_EAR_DURATION_SEC, 0),
    level: clampInt(o.level, 1, 7, 1),
    mode: normEarMode(o.mode),
    context: normEarContext(o.context),
    taper: normEarTaper(o.taper),
    sing_gate: o.singGate ? 1 : 0,
    questions: questions,
    correct: clampInt(o.correct, 0, questions, 0),
    assists: clampInt(o.assists, 0, MAX_EAR_ASSISTS, 0),
    cents_sum: clampInt(o.centsSum, 0, centsN * MAX_ABS_CENTS, 0),
    cents_n: centsN,
    detail: detail
  };

  const sql = 'INSERT INTO ear_sessions (' + EAR_COLS + ') ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

  for (let attempt = 0; attempt < EAR_STARTED_ATTEMPTS; attempt++) {
    try {
      const res = await db.prepare(sql).bind(
        rec.user_id, rec.started, rec.duration_sec, rec.level, rec.mode,
        rec.context, rec.taper, rec.sing_gate, rec.questions, rec.correct,
        rec.assists, rec.cents_sum, rec.cents_n, rec.detail
      ).run();
      // The stored row IS `rec` — every value was bound from it — so the route
      // can answer without a follow-up SELECT. Note rec.started may have moved.
      return { ok: true, row: rec, started: rec.started, rowsWritten: rw(res) };
    } catch (err) {
      const kind = classifyConstraint(err);
      if (kind === 'ear_pk') { rec.started += 1; continue; }
      // A CHECK failure means the normalization above has a hole. Report it as
      // a bad request rather than a 500: the row was never going to be storable.
      if (kind === 'check') return { ok: false, code: 'bad_request', rowsWritten: 0 };
      throw err;                        // not ours — let index.js log a 500.
    }
  }
  return { ok: false, code: 'conflict', rowsWritten: 0 };
}

/**
 * One user's own recent sessions, newest first.
 *
 * A PURE REVERSE INDEX SCAN, and that is the whole design of the table:
 * `user_id` is the PRIMARY KEY's leading column (equality seek) and `started`
 * is its trailing column (already ordered within that user's slice), so this
 * reads exactly `limit` rows with NO filesort and NO temp b-tree. Contrast
 * listRecentForUser() above, which DOES filesort because recent_views orders by
 * a column that is deliberately not in its key.
 *
 * No age predicate, unlike listRecentForUser(): the practice log is the point of
 * the feature and a session from last year is still yours. LIMIT is the only
 * bound, and it is what keeps this from ever becoming a scan.
 *
 * WORST-CASE RESPONSE SIZE, because the route JSON.stringifies what it gets
 * back: 100 rows x (13 small numbers + up to MAX_DETAIL_CHARS) is ~215 KB, and
 * the realistic figure at a ~200-byte detail is ~25 KB. That is the reason
 * MAX_EAR_LIMIT is 100 and not "however many you like".
 *
 * Quota: 1 statement, <= limit rows read, ZERO written.
 */
export async function listEarSessions(db, userId, limit) {
  if (!userId) return { rows: [], rowsRead: 0 };
  // null and '' are checked BEFORE clampInt, and that is not defensive noise:
  // Number(null) and Number('') are both 0, which is finite, so clampInt would
  // skip its default and return the FLOOR — a caller that omitted the limit
  // would silently get ONE session instead of sixty. (undefined survives it,
  // because Number(undefined) is NaN.) routes.js resolves the default before
  // calling, so this only bites a direct caller — a test, a tool, a future
  // route — which is exactly the caller who would never notice.
  const lim = (limit === null || limit === '')
    ? DEFAULT_EAR_LIMIT
    : clampInt(limit, 1, MAX_EAR_LIMIT, DEFAULT_EAR_LIMIT);
  const res = await db.prepare(
    'SELECT ' + EAR_COLS + ' FROM ear_sessions ' +
    'WHERE user_id = ? ORDER BY started DESC LIMIT ?'
  ).bind(String(userId), lim).all();
  return { rows: res.results || [], rowsRead: rr(res) };
}

// ---------------------------------------------------------------------------
// app_meta — tiny ops key/value (seed marker, schema revision, admin id)
// ---------------------------------------------------------------------------

/** Quota: 1 statement, 1 row read, zero written. */
export async function getMeta(db, k) {
  const res = await db.prepare('SELECT v FROM app_meta WHERE k = ? LIMIT 1').bind(k).all();
  const rows = res.results || [];
  return rows.length ? rows[0].v : null;
}

/** ROWS WRITTEN: 1. app_meta is WITHOUT ROWID with no secondary index, so the
 *  upsert touches exactly one b-tree. */
export async function setMeta(db, k, v) {
  const res = await db.prepare(
    'INSERT INTO app_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'
  ).bind(String(k), String(v)).run();
  return { rowsWritten: rw(res) };
}

// ---------------------------------------------------------------------------
// Boot assertion
// ---------------------------------------------------------------------------

/**
 * Called ONCE PER ISOLATE by worker/index.js. Guards the one hard ordering
 * dependency in this build: migrations/0000_better_auth.sql must have been
 * generated against the FINAL auth config (with user.additionalFields carrying
 * githubId and role) and applied BEFORE worker/schema.sql.
 *
 * If someone hand-writes the user table, or generates it before
 * additionalFields exists, nothing errors at runtime — isAdmin() quietly falls
 * back to its github_id clause for the one hard-coded admin and every future
 * promotion silently fails. That is a bug you find months later, so we refuse
 * to start instead.
 *
 * ONE ROUND TRIP ON THE HAPPY PATH. This used to await three probes one after
 * another, which — together with auth.js's four — put SEVEN serialized D1 round
 * trips in front of the first request of every isolate, and Free-plan isolates
 * cold-start often. The fast path is a single statement that cross-joins all
 * three tables under LIMIT 0: preparing it resolves every table and column name
 * (the whole point of the check) and LIMIT 0 means the plan reads no rows. The
 * three individual probes still run, but only to attribute a FAILURE, on a path
 * that is already fatal.
 *
 * Quota: 1 statement (4 when something is wrong), ZERO rows read (LIMIT 0
 * matches nothing) and zero written. Runs once per isolate, not per request.
 */
const SCHEMA_PROBES = [
  [
    'SELECT role, github_id FROM ' + USER_TABLE + ' LIMIT 0',
    'user.role / user.github_id — run migrations/0000_better_auth.sql generated by ' +
    '`npx @better-auth/cli generate` against an auth config that declares ' +
    'user.additionalFields { githubId, role }'
  ],
  [
    'SELECT id, owner_id, payload_b64, version, deleted FROM projects LIMIT 0',
    'projects — apply worker/schema.sql'
  ],
  [
    'SELECT user_id, project_id, viewed FROM recent_views LIMIT 0',
    'recent_views — apply worker/schema.sql'
  ],
  /* ear_sessions is probed for the same reason the other three are: without it
   * NOTHING errors until a user finishes a ten-minute drill and the POST throws
   * "no such table: ear_sessions" — hours after the deploy, on the one path
   * nobody is watching, and with the client already showing the session as
   * saved (it is: locally). Refusing to serve is louder and cheaper.
   * `detail` is named explicitly so a hand-created table missing the column
   * fails here rather than at the first insert. */
  [
    'SELECT user_id, started, level, questions, detail FROM ear_sessions LIMIT 0',
    'ear_sessions — apply migrations/0004_ear_sessions.sql'
  ]
];

/* Aliased apart: the four tables share column names (user_id three ways) and a
 * duplicate-keyed result set is not worth depending on, even under LIMIT 0.
 *
 * Still ONE round trip with ear_sessions added. The cross join grows a fourth
 * term, but LIMIT 0 means the planner never produces a row from it — preparing
 * the statement is what resolves the table and column names, which is the
 * entire point of the probe. */
const SCHEMA_PROBE_ALL =
  'SELECT u.role AS u_role, u.github_id AS u_github_id, ' +
  'p.id AS p_id, p.owner_id AS p_owner_id, p.payload_b64 AS p_payload_b64, ' +
  'p.version AS p_version, p.deleted AS p_deleted, ' +
  'r.user_id AS r_user_id, r.project_id AS r_project_id, r.viewed AS r_viewed, ' +
  'e.user_id AS e_user_id, e.started AS e_started, ' +
  'e.questions AS e_questions, e.detail AS e_detail ' +
  'FROM ' + USER_TABLE + ' u, projects p, recent_views r, ear_sessions e LIMIT 0';

export async function assertSchema(db) {
  try {
    await db.prepare(SCHEMA_PROBE_ALL).all();
    return { ok: true, missing: [] };
  } catch (e) { /* fall through and find out WHICH */ }

  const missing = [];
  for (let i = 0; i < SCHEMA_PROBES.length; i++) {
    try { await db.prepare(SCHEMA_PROBES[i][0]).all(); }
    catch (e) { missing.push(SCHEMA_PROBES[i][1] + ' [' + ((e && e.message) || e) + ']'); }
  }
  // Every table probes clean on its own but the combined statement did not:
  // treat that as transient (index.js fails OPEN on anything it cannot read as
  // a definite "no such table / no such column") rather than latching the
  // isolate into 503 over a D1 blip.
  return { ok: missing.length === 0, missing: missing };
}
