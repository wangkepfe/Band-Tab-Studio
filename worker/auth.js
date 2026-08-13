/* ============================================================================
 * worker/auth.js  —  identity + authorization for the Studio cloud Worker.
 *
 * Everything about "who is calling" and "are they allowed" lives here, and
 * NOTHING else does. Routes import the `can*` / `require*` helpers; they never
 * re-derive ownership or admin-ness themselves. worker/index.js hands the whole
 * /api/auth/* prefix to the handler exported below and otherwise only reads the
 * normalized session.
 *
 * Four things this module owns:
 *   1. The Better Auth instance — GitHub OAuth ONLY, no email/password, so this
 *      app has no password to store, leak, or reset. Built ONCE PER ISOLATE
 *      (see "why not per request" below), never per request.
 *   2. getSession(request, env) -> a small normalized object, or null.
 *   3. The authorization matrix — author OR admin may save/rename/delete in
 *      place; ANYONE (even logged out) may read; duplicating requires a session.
 *   4. An IP-keyed rate limiter for /api/auth/*, because OAuth *initiation*
 *      writes a `verification` row to D1 BEFORE any user exists. That makes it
 *      the app's only unauthenticated WRITE surface, and D1 Free bills a hard
 *      100,000 rows written per day across the whole account. An unthrottled
 *      /api/auth/sign-in/social is a one-line denial-of-wallet on the library.
 *
 * WHY THE INSTANCE IS BUILT ONCE PER ISOLATE, NOT AT LITERAL MODULE SCOPE.
 *   Workers only hand you `env` (and therefore the D1 binding) inside fetch();
 *   there is no binding to read at import time. So the split is: every option
 *   that does NOT depend on env is a frozen module-scope constant, evaluated
 *   exactly once when the isolate loads; createAuth(env) then does the single
 *   remaining construction and memoizes it in a module-level slot. A warm
 *   isolate serves thousands of requests off that one instance. Rebuilding
 *   betterAuth() per request is the classic way to turn a 1 ms handler into a
 *   10 ms one, and 10 ms of CPU per invocation is the entire Free-tier budget.
 *
 * WHY DRIZZLE AND NOT KYSELY.
 *   The adapter here is drizzle-orm/d1. Consequence the migration author MUST
 *   know: `npx @better-auth/cli generate` with a Drizzle adapter emits a Drizzle
 *   SCHEMA FILE, not SQL — it will not produce migrations/0000_better_auth.sql
 *   for you. The authoritative DDL is therefore written out in full below, and
 *   it is derived from the drizzle tables declared in this file. Column names
 *   are snake_case; the drizzle property keys stay camelCase because those keys
 *   are what Better Auth looks its field names up by.
 *
 * ---------------------------------------------------------------------------
 * migrations/0000_better_auth.sql MUST CREATE EXACTLY THIS. Any drift and the
 * adapter fails at runtime with a column-not-found, on the login path, in
 * production. assertAuthSchema(env) below probes for it at boot so the failure
 * is a clear message instead of a mystery 500 mid-OAuth.
 *
 *   CREATE TABLE IF NOT EXISTS user (
 *     id             TEXT    NOT NULL PRIMARY KEY,
 *     name           TEXT    NOT NULL,
 *     email          TEXT    NOT NULL UNIQUE,
 *     email_verified INTEGER NOT NULL DEFAULT 0,
 *     image          TEXT,
 *     created_at     INTEGER NOT NULL,
 *     updated_at     INTEGER NOT NULL,
 *     role           TEXT    NOT NULL DEFAULT 'user',   -- additionalFields
 *     github_id      TEXT                               -- additionalFields
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS session (
 *     id         TEXT    NOT NULL PRIMARY KEY,
 *     expires_at INTEGER NOT NULL,
 *     token      TEXT    NOT NULL UNIQUE,
 *     created_at INTEGER NOT NULL,
 *     updated_at INTEGER NOT NULL,
 *     ip_address TEXT,
 *     user_agent TEXT,
 *     user_id    TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_session_user ON session (user_id);
 *
 *   CREATE TABLE IF NOT EXISTS account (
 *     id                       TEXT    NOT NULL PRIMARY KEY,
 *     account_id               TEXT    NOT NULL,  -- <- THE GITHUB NUMERIC ID
 *     provider_id              TEXT    NOT NULL,  -- 'github'
 *     user_id                  TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 *     access_token             TEXT,
 *     refresh_token            TEXT,
 *     id_token                 TEXT,
 *     access_token_expires_at  INTEGER,
 *     refresh_token_expires_at INTEGER,
 *     scope                    TEXT,
 *     password                 TEXT,              -- always NULL here: no
 *                                                 -- email/password provider
 *     created_at               INTEGER NOT NULL,
 *     updated_at               INTEGER NOT NULL
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_account_user ON account (user_id);
 *
 *   CREATE TABLE IF NOT EXISTS verification (
 *     id         TEXT    NOT NULL PRIMARY KEY,
 *     identifier TEXT    NOT NULL,
 *     value      TEXT    NOT NULL,
 *     expires_at INTEGER NOT NULL,
 *     created_at INTEGER,      -- nullable on purpose: older Better Auth
 *     updated_at INTEGER       -- releases omit these on insert
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification (identifier);
 *
 * Timestamps are stored as INTEGER UNIX SECONDS (drizzle `mode: 'timestamp'`),
 * matching the repo-wide convention that app.js:710 fmtDate() depends on
 * (new Date(t * 1000)). Never milliseconds, anywhere, in this codebase.
 * ==========================================================================*/

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { and, eq } from 'drizzle-orm';

/* ---------------------------------------------------------------------------
 * ADMIN
 *
 * R5: the admin is GitHub user 21693187 (login "wangkepfe" today). This is the
 * NUMERIC id and it is deliberately never the login string — GitHub logins are
 * renameable and reclaimable, so keying admin off "wangkepfe" means a rename
 * silently drops admin and, worse, lets whoever grabs the freed login inherit
 * it. The numeric id is immutable for the life of the account.
 * -------------------------------------------------------------------------*/
export const ADMIN_GITHUB_ID = '21693187';

/* Session lifetimes. Both numbers are row-budget decisions as much as UX ones:
 * Better Auth rewrites the session row every `updateAge`, and every write eats
 * the 100k rows/day cap. 30-day sessions refreshed at most weekly means one
 * session UPDATE per user per week instead of one per day. cookieCache (300 s)
 * then keeps the *read* out of D1 entirely for ordinary requests. */
const SESSION_EXPIRES_IN = 60 * 60 * 24 * 30; // 30 days
const SESSION_UPDATE_AGE = 60 * 60 * 24 * 7;  // refresh at most weekly
const SESSION_COOKIE_CACHE = 300;             // seconds; see quotaBudget

/* ===========================================================================
 * DRIZZLE SCHEMA  (module scope — evaluated once when the isolate loads)
 *
 * Property keys are Better Auth FIELD names (camelCase); the string argument is
 * the SQL COLUMN name (snake_case). The Drizzle adapter resolves
 * schema[model][field] by property key, so those keys are not cosmetic — rename
 * one and Better Auth stops finding the column.
 * =========================================================================*/
export const userTable = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  // --- additionalFields (see USER_ADDITIONAL_FIELDS). Both are input:false. ---
  role: text('role').notNull().default('user'),
  githubId: text('github_id')
});

export const sessionTable = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => userTable.id, { onDelete: 'cascade' })
});

export const accountTable = sqliteTable('account', {
  id: text('id').primaryKey(),
  // accountId is the PROVIDER's id for this user. For providerId 'github' that
  // is the GitHub NUMERIC user id as a string — the value ADMIN_GITHUB_ID is
  // compared against, and the fallback source of truth for githubId.
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => userTable.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'), // never written: emailAndPassword is disabled
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
});

export const verificationTable = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  // Nullable on purpose — some Better Auth releases omit these on insert, and a
  // NOT NULL column here would fail the very first OAuth initiation.
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
});

const AUTH_SCHEMA = {
  user: userTable,
  session: sessionTable,
  account: accountTable,
  verification: verificationTable
};

/* ===========================================================================
 * MODULE-SCOPE OPTION FRAGMENTS
 *
 * Everything here is env-independent and is therefore built exactly once, when
 * the isolate loads. createAuth(env) only has to splice in the four secrets and
 * the D1 binding.
 * =========================================================================*/

/* input:false ON BOTH FIELDS IS A SECURITY REQUIREMENT, not a style choice.
 * Better Auth merges client-supplied fields into user create/update payloads;
 * without input:false a caller could POST role:'admin' and promote themselves.
 * With it, `role` is safe to live as a plain column instead of needing its own
 * table and join. Neither field is ever accepted from the client — githubId is
 * written from the OAuth profile, role is derived from githubId. */
const USER_ADDITIONAL_FIELDS = {
  githubId: { type: 'string', required: false, input: false },
  role: { type: 'string', required: false, defaultValue: 'user', input: false }
};

/* Runs during user CREATION on the first GitHub callback, so github_id and role
 * land in the SAME INSERT as the user row — no extra query, no post-hoc
 * promotion step, no bootstrap route, and no window in which the admin exists
 * as a normal user.
 *
 * `profile` is GitHub's /user response. profile.id is the numeric id (a JS
 * number in the JSON) — String() it, because github_id is TEXT and '21693187'
 * !== 21693187 under ===.
 *
 * The name fallback is not cosmetic: user.name is NOT NULL and a GitHub account
 * with no display name returns profile.name === null, which would otherwise
 * fail the insert on the user's very first sign-in. */
function mapProfileToUser(profile) {
  const gid = profile && profile.id != null ? String(profile.id) : '';
  return {
    name: (profile && (profile.name || profile.login)) || 'GitHub user',
    image: (profile && profile.avatar_url) || null,
    githubId: gid,
    role: gid === ADMIN_GITHUB_ID ? 'admin' : 'user'
  };
}

const BASE_OPTIONS = Object.freeze({
  appName: 'Band Tab Studio',
  basePath: '/api/auth',

  // No password exists anywhere in this app. Nothing to phish, nothing to reset.
  emailAndPassword: { enabled: false },

  user: { additionalFields: USER_ADDITIONAL_FIELDS },

  session: {
    expiresIn: SESSION_EXPIRES_IN,
    updateAge: SESSION_UPDATE_AGE,
    // Removes the D1 session read from ~every authenticated request: a large
    // rows_read and CPU saving under the 10 ms cap. Cost: a promoted role or a
    // backfilled github_id can be up to 300 s stale in the cookie — which is
    // exactly the hole resolveGithubId() below plugs.
    cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE }
  },

  // Better Auth ships its own limiter, defaulting to memory (per-isolate, same
  // blind spot as ours) or — depending on release — to a `rateLimit` DATABASE
  // table that migrations/0000 does not create, which would fail closed on the
  // login path. We turn it off and own the limiting explicitly below, where the
  // costs are weighted by which endpoints actually write D1 rows.
  rateLimit: { enabled: false }
});

/* ===========================================================================
 * HttpError — the single error currency between auth and the route layer.
 * worker/index.js catches it and renders {error:{code, ...extra}} at .status.
 * =========================================================================*/
export class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.name = 'HttpError';
    this.status = status | 0;
    this.code = String(code);
    this.extra = extra && typeof extra === 'object' ? extra : {};
  }

  /** The exact JSON body worker/index.js should emit. */
  body() {
    return { error: Object.assign({ code: this.code }, this.extra) };
  }

  toResponse(headers) {
    return new Response(JSON.stringify(this.body()), {
      status: this.status,
      headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {})
    });
  }
}

/* ===========================================================================
 * THE INSTANCE  (one per isolate)
 * =========================================================================*/

let _auth = null;      // the wrapped instance handed to callers
let _authRaw = null;   // the unwrapped Better Auth instance (for auth.api.*)
let _authDb = null;    // the D1 binding the cache was built against
let _drizzle = null;   // drizzle over the same binding, reused by our own reads

/* Per-isolate memo of userId -> githubId, for the (rare) case where a session
 * carries no githubId (see resolveGithubId). Declared here because the
 * account-create hook inside createAuth invalidates it. Bounded and TTL'd so a
 * long-lived isolate cannot grow it without limit. */
const _ghCache = new Map();
const GH_CACHE_TTL_MS = 60 * 60 * 1000;
const GH_CACHE_MAX = 500;

function drizzleFor(env) {
  if (!_drizzle || _authDb !== env.DB) _drizzle = drizzle(env.DB, { schema: AUTH_SCHEMA });
  return _drizzle;
}

/**
 * createAuth(env) -> Better Auth instance, cached per isolate.
 *
 * NOTE FOR worker/index.js: the returned object's `handler` is WRAPPED with the
 * /api/auth/* rate limiter (see guardAuthRateLimit). That is deliberate — the
 * contract has index.js call `createAuth(env).handler(request)` directly, and
 * the unauthenticated-write surface must not depend on a second call site
 * remembering to guard it. Everything else on the instance (`api`, `options`,
 * `$context`) passes through untouched via the prototype chain.
 *
 * THIS MODULE OWNS THE /api/auth/* LIMITER, AND IT IS THE ONLY CALL SITE.
 * index.js used to call guardAuthRateLimit() itself and *then* call this
 * handler, which double-charged a STATEFUL limiter: the OAuth-initiation
 * ceiling of RL_INIT_MAX/hour was really half that, and the burst bucket drained
 * at 2x the intended rate, so users behind one NAT or corporate egress IP hit
 * 429 on the login path at half the intended budget. index.js no longer guards;
 * and checkAuthRateLimit() is now memoized per Request object (see the WeakMap
 * below, the same pattern getSession uses) so a future second call site cannot
 * re-charge it either.
 */
export function createAuth(env) {
  if (_auth && _authDb === env.DB) return _auth;

  if (!env || !env.DB) throw new HttpError(500, 'auth_misconfigured', { detail: 'env.DB is not bound' });
  if (!env.BETTER_AUTH_SECRET) throw new HttpError(500, 'auth_misconfigured', { detail: 'BETTER_AUTH_SECRET is unset' });
  if (!env.BETTER_AUTH_URL) throw new HttpError(500, 'auth_misconfigured', { detail: 'BETTER_AUTH_URL is unset' });
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new HttpError(500, 'auth_misconfigured', { detail: 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are unset' });
  }

  _authDb = env.DB;
  _drizzle = null;
  const db = drizzleFor(env);

  // Same-origin app: the browser only ever calls /api/auth from the page that
  // Better Auth itself is mounted under, so the trusted-origin set is exactly
  // the deployment origin. `secure` is derived from that origin's protocol so a
  // plain-http `wrangler dev` can still set a cookie; in production
  // BETTER_AUTH_URL is https and this is `true`, as the contract requires.
  let origin = String(env.BETTER_AUTH_URL).replace(/\/+$/, '');
  let secureCookies = true;
  try {
    const u = new URL(env.BETTER_AUTH_URL);
    origin = u.origin;
    secureCookies = u.protocol === 'https:';
  } catch (_) { /* keep the string form; assume https */ }

  _authRaw = betterAuth(Object.assign({}, BASE_OPTIONS, {
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],

    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: AUTH_SCHEMA,
      usePlural: false
    }),

    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        // user:email is required because user.email is NOT NULL UNIQUE and a
        // GitHub account with a private primary address returns email:null from
        // /user — Better Auth then falls back to /user/emails, which needs this
        // scope. Without it the first sign-in of such an account fails.
        scope: ['read:user', 'user:email'],
        mapProfileToUser
      }
    },

    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax',   // blocks cross-site POST/PUT/PATCH/DELETE outright;
        secure: secureCookies,
        httpOnly: true     // requireClientHeader() is the second lock
      }
    },

    databaseHooks: {
      account: {
        create: {
          // BELT TO mapProfileToUser'S BRACES. mapProfileToUser is the primary
          // path and costs nothing, but it feeds a payload that Better Auth
          // runs through its input parser, and both fields are declared
          // input:false — so a release that tightens that parser would silently
          // drop them. The account row, by contrast, ALWAYS carries the GitHub
          // numeric id in account_id. Backfilling from it here guarantees
          // user.github_id is correct after the first sign-in regardless.
          //
          // Costs one UPDATE (1 row: neither column is indexed) once per linked
          // account, ever. Deliberately only ever PROMOTES: role is written
          // only for the admin id, so an admin promoted later by a manual SQL
          // UPDATE is never demoted by re-linking their GitHub account.
          after: async (account) => {
            try {
              if (!account || account.providerId !== 'github' || !account.userId) return;
              const gid = account.accountId != null ? String(account.accountId) : '';
              if (!gid) return;
              const patch = { githubId: gid, updatedAt: new Date() };
              if (gid === ADMIN_GITHUB_ID) patch.role = 'admin';
              await db.update(userTable).set(patch).where(eq(userTable.id, account.userId));
              _ghCache.delete(account.userId);
            } catch (err) {
              // A backfill failure must never break sign-in: resolveGithubId()
              // reads the account table directly and covers this case anyway.
              console.error('auth: github id backfill failed', err && err.message);
            }
          }
        }
      }
    }
  }));

  const rawHandler = _authRaw.handler.bind(_authRaw);
  const guardedHandler = async (request) => {
    const limited = await guardAuthRateLimit(request, env);
    if (limited) return limited;
    return rawHandler(request);
  };

  _auth = Object.create(_authRaw, {
    handler: { value: guardedHandler, enumerable: true, writable: false, configurable: true }
  });
  return _auth;
}

/**
 * handleAuth(request, env) -> Response
 * The whole /api/auth/* prefix, rate limited. Equivalent to
 * createAuth(env).handler(request); exported as the named, obvious entry point.
 */
export function handleAuth(request, env) {
  return createAuth(env).handler(request);
}

/* ===========================================================================
 * SCHEMA ASSERTION
 *
 * The generated-vs-hand-written schema seam is the one hard dependency between
 * this module and the migration. If `role` / `github_id` are missing, isAdmin()
 * quietly degrades (the admin still works via the githubId clause, but every
 * other user is stuck at 'user' with no visible error) — a failure that only
 * shows up as "why can't anyone save". Probe once per isolate and say so.
 *
 * `LIMIT 0` parses and plans the statement without reading a row, so the check
 * costs zero rows_read.
 *
 * ONE ROUND TRIP, NOT FOUR. This used to `await` the four probes below one after
 * another inside a for-of, which put four SERIALIZED D1 round trips in front of
 * the first request every isolate ever serves — and Free-plan isolates cold-start
 * often. The fast path is now a single statement that cross-joins all four
 * tables under LIMIT 0: preparing it resolves every table and column name (which
 * is the entire point of the check) and LIMIT 0 means the plan never reads a row.
 * The four single-table probes survive only to attribute a FAILURE to one table,
 * on a path that is already fatal and runs at most once per isolate.
 * =========================================================================*/
const SCHEMA_PROBES = [
  'SELECT id, name, image, email, role, github_id FROM "user" LIMIT 0',
  'SELECT id, user_id, account_id, provider_id FROM account LIMIT 0',
  'SELECT id, user_id, token, expires_at FROM session LIMIT 0',
  'SELECT id, identifier, value, expires_at FROM verification LIMIT 0'
];

/* Columns are aliased apart because the four tables share column names and a
 * duplicate-keyed result set is not a thing worth depending on — even though
 * LIMIT 0 guarantees there are no rows to build. */
const SCHEMA_PROBE_ALL =
  'SELECT u.id AS u_id, u.name AS u_name, u.image AS u_image, u.email AS u_email, ' +
  'u.role AS u_role, u.github_id AS u_github_id, ' +
  'a.id AS a_id, a.user_id AS a_user_id, a.account_id AS a_account_id, ' +
  'a.provider_id AS a_provider_id, ' +
  's.id AS s_id, s.user_id AS s_user_id, s.token AS s_token, s.expires_at AS s_expires_at, ' +
  'v.id AS v_id, v.identifier AS v_identifier, v.value AS v_value, ' +
  'v.expires_at AS v_expires_at ' +
  'FROM "user" u, account a, session s, verification v LIMIT 0';

let _schemaCheck = null;

export function assertAuthSchema(env) {
  if (_schemaCheck) return _schemaCheck;
  _schemaCheck = (async () => {
    try {
      await env.DB.prepare(SCHEMA_PROBE_ALL).all();
      return true;
    } catch (err) {
      // The combined probe only says THAT something is missing; the per-table
      // probes say WHICH. Four extra round trips, once, on a fatal path.
      const culprit = await firstFailingProbe(env);
      throw new HttpError(500, 'auth_schema_missing', {
        // detail / probe / hint are LOGGED by worker/index.js and never returned
        // to the caller — they would otherwise hand an anonymous client our
        // probe SQL. See errResponse() there.
        detail: (culprit && culprit.detail) || (err && err.message) || String(err),
        probe: (culprit && culprit.sql) || SCHEMA_PROBE_ALL,
        hint: 'migrations/0000_better_auth.sql must match the DDL in the header of worker/auth.js'
      });
    }
  })().catch((err) => {
    _schemaCheck = null; // let a later request retry after the migration lands
    throw err;
  });
  return _schemaCheck;
}

async function firstFailingProbe(env) {
  for (const sql of SCHEMA_PROBES) {
    try {
      await env.DB.prepare(sql).all();
    } catch (err) {
      return { sql: sql, detail: (err && err.message) || String(err) };
    }
  }
  return null;   // every table probes clean on its own: report the combined error
}

/* ===========================================================================
 * SESSION
 * =========================================================================*/

/**
 * HOW THE GITHUB NUMERIC ID IS READ.
 *
 * Two sources, in order:
 *   1. user.github_id — written at user creation by mapProfileToUser and
 *      re-asserted by the account-create hook. This is the fast path: the value
 *      is already on the session's user object, zero queries.
 *   2. account.account_id WHERE account.user_id = ? AND provider_id = 'github'
 *      — Better Auth stores the OAuth provider's own user id there, which for
 *      GitHub is the numeric id. This is the fallback, and it is what makes the
 *      design survive: a stale 300 s session cookie minted moments before the
 *      backfill, a Better Auth upgrade that drops additionalFields, or a
 *      migration applied without the two extra columns.
 *
 * Never, at any point, the login string.
 */
async function resolveGithubId(env, userId) {
  const hit = _ghCache.get(userId);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.gid;

  let gid = null;
  try {
    const db = drizzleFor(env);
    const rows = await db
      .select({ accountId: accountTable.accountId })
      .from(accountTable)
      .where(and(eq(accountTable.userId, userId), eq(accountTable.providerId, 'github')))
      .limit(1);
    if (rows && rows.length && rows[0].accountId != null) gid = String(rows[0].accountId);
  } catch (err) {
    console.error('auth: github id lookup failed', err && err.message);
    return null; // do not cache a lookup that failed for infrastructure reasons
  }

  if (_ghCache.size >= GH_CACHE_MAX) _ghCache.clear();
  _ghCache.set(userId, { gid, exp: now + GH_CACHE_TTL_MS }); // negative results cached too
  return gid;
}

/* One resolution per Request object, however many times routes ask. The
 * dispatcher resolves the session lazily and several route modules may each
 * touch ctx.session; without this, a request that hits the cookie-cache miss
 * path would pay for the D1 read more than once. */
const _reqSessions = new WeakMap();

/**
 * getSession(request, env) -> normalized session | null
 *
 * NEVER throws and never rejects — a malformed, expired, or forged cookie is
 * indistinguishable from "logged out", and GET /api/me must answer 200
 * {"user":null} rather than 500.
 *
 * The returned object satisfies BOTH shapes in play:
 *   flat  : { userId, githubId, name, avatar, isAdmin, email, role }
 *   nested: { user: {id,name,email,image,githubId,role}, session: {id,expiresAt} }
 * so a route written against either spelling works. `avatar` and `user.image`
 * are the same string. `session.expiresAt` is UNIX SECONDS, per repo convention.
 */
export function getSession(request, env) {
  const cached = _reqSessions.get(request);
  if (cached) return cached;
  const p = resolveSession(request, env);
  _reqSessions.set(request, p);
  return p;
}

async function resolveSession(request, env) {
  let raw = null;
  try {
    createAuth(env); // ensures _authRaw exists and is bound to this env
    raw = await _authRaw.api.getSession({ headers: request.headers });
  } catch (err) {
    console.error('auth: getSession failed', err && err.message);
    return null;
  }
  if (!raw || !raw.user || !raw.user.id) return null;

  const u = raw.user;
  let githubId = u.githubId != null && u.githubId !== '' ? String(u.githubId) : null;
  if (!githubId) githubId = await resolveGithubId(env, u.id);

  const role = u.role ? String(u.role) : 'user';
  const admin = role === 'admin' || (githubId != null && githubId === ADMIN_GITHUB_ID);
  const avatar = u.image || null;

  return {
    // flat, normalized
    userId: u.id,
    githubId: githubId,
    name: u.name || '',
    email: u.email || '',
    avatar: avatar,
    role: role,
    isAdmin: admin,
    // nested, as the route contract spells it
    user: {
      id: u.id,
      name: u.name || '',
      email: u.email || '',
      image: avatar,
      githubId: githubId,
      role: role,
      isAdmin: admin
    },
    session: raw.session
      ? { id: raw.session.id, expiresAt: toSec(raw.session.expiresAt) }
      : null
  };
}

/* Accepts a normalized session, a bare Better Auth user, or null, and returns
 * the flat viewer shape every authorization helper below works in. Exists so a
 * route can pass whichever spelling it happens to be holding. */
function viewerOf(sessionOrUser) {
  const s = sessionOrUser;
  if (!s) return null;
  if (s.userId) return s;                          // normalized session
  if (s.user && s.user.id) {                       // {user, session}
    return {
      userId: s.user.id,
      githubId: s.user.githubId || null,
      role: s.user.role || 'user',
      isAdmin: s.user.isAdmin === true || s.user.role === 'admin' ||
               (s.user.githubId != null && String(s.user.githubId) === ADMIN_GITHUB_ID)
    };
  }
  if (s.id) {                                      // bare Better Auth user
    return {
      userId: s.id,
      githubId: s.githubId || null,
      role: s.role || 'user',
      isAdmin: s.isAdmin === true || s.role === 'admin' ||
               (s.githubId != null && String(s.githubId) === ADMIN_GITHUB_ID)
    };
  }
  return null;
}

function toSec(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return isFinite(t) ? Math.floor(t / 1000) : null;
}

/* ===========================================================================
 * AUTHORIZATION  —  the authzMatrix, executable.
 *
 * Every helper takes (session, projectRow) and returns a boolean. `session` may
 * be null (anonymous). `projectRow` is a raw D1 row (owner_id, deleted) or an
 * already-built Card (ownerId, deleted) — both spellings are accepted so route
 * code never has to remember which side of the mapping it is on.
 * =========================================================================*/

function ownerIdOf(row) {
  if (!row) return null;
  const o = row.owner_id != null ? row.owner_id : row.ownerId;
  return o != null && o !== '' ? String(o) : null;
}

function isDeleted(row) {
  if (!row) return false;
  const d = row.deleted;
  return d === 1 || d === true || d === '1';
}

/** True for the admin. Belt and braces in BOTH directions, on purpose:
 *   - the githubId clause means a failed migration, a wiped column, or a Better
 *     Auth upgrade that drops additionalFields can never lock the admin out of
 *     his own instance;
 *   - the role clause means a second admin can be added later with one UPDATE,
 *     without redeploying the Worker. */
export function isAdmin(sessionOrUser) {
  const v = viewerOf(sessionOrUser);
  if (!v) return false;
  return v.isAdmin === true || v.role === 'admin' ||
         (v.githubId != null && String(v.githubId) === ADMIN_GITHUB_ID);
}

/** Is this the signed-in author of the row? Admin-ness is NOT folded in here —
 *  callers that need "author or admin" use canEdit; callers that need to render
 *  "your project" use this. */
export function isAuthor(sessionOrUser, row) {
  const v = viewerOf(sessionOrUser);
  const owner = ownerIdOf(row);
  return !!v && owner != null && owner === v.userId;
}

/** R2: every project is public. Anonymous reads are fine. The one exception is
 *  a soft-deleted row, which is invisible (404) to everyone but the admin. */
export function canRead(sessionOrUser, row) {
  if (!row) return false;
  if (!isDeleted(row)) return true;
  return isAdmin(sessionOrUser);
}

/** R4: save in place = author OR admin. A row the viewer cannot even see is not
 *  editable either, so a soft-deleted project reads as 404 rather than 403 for
 *  its own author — matching the CAS in updateProjectPayload(), which carries
 *  `AND deleted = 0`. */
export function canEdit(sessionOrUser, row) {
  if (!row || !canRead(sessionOrUser, row)) return false;
  return isAuthor(sessionOrUser, row) || isAdmin(sessionOrUser);
}

/** Rename is the same authority as save; it just skips the payload. */
export const canRename = canEdit;

/** Soft delete: author or admin. Same rule as edit, restated as its own name so
 *  route code reads as the matrix does. */
export function canDelete(sessionOrUser, row) {
  return canEdit(sessionOrUser, row);
}

/** R1: duplicating REQUIRES a session — this is the one read-shaped action that
 *  is gated. Any signed-in user may fork any project they can read, including
 *  their own (that is how you branch an arrangement). */
export function canDuplicate(sessionOrUser, row) {
  return !!viewerOf(sessionOrUser) && canRead(sessionOrUser, row);
}

/** Creating a brand-new project: any signed-in user. */
export function canCreate(sessionOrUser) {
  return !!viewerOf(sessionOrUser);
}

/** Recording a "recently viewed" row (R3) needs an identity to key on. */
export function canRecordView(sessionOrUser) {
  return !!viewerOf(sessionOrUser);
}

/* Admin-only actions. Separate names rather than bare isAdmin() calls at the
 * route sites so the matrix stays greppable and a future change to one of them
 * cannot accidentally change the others. */
export function canRestore(sessionOrUser) { return isAdmin(sessionOrUser); }
export function canHardDelete(sessionOrUser) { return isAdmin(sessionOrUser); }
export function canTransfer(sessionOrUser) { return isAdmin(sessionOrUser); }
export function canImport(sessionOrUser) { return isAdmin(sessionOrUser); }
export function canListDeleted(sessionOrUser) { return isAdmin(sessionOrUser); }
/** Only the admin may scope a listing to another user's projects (?owner=). */
export function canListOwner(sessionOrUser, ownerId) {
  const v = viewerOf(sessionOrUser);
  if (!v) return false;
  return isAdmin(v) || String(ownerId) === v.userId;
}

/* --- throwing forms, for route bodies --------------------------------------
 * These raise HttpError; worker/index.js's single try/catch turns them into the
 * exact status/code pairs the routes table documents. */

export function requireUser(sessionOrUser) {
  const v = viewerOf(sessionOrUser);
  if (!v) throw new HttpError(401, 'unauthenticated');
  return v;
}

export function requireAdmin(sessionOrUser) {
  const v = requireUser(sessionOrUser);
  if (!isAdmin(v)) throw new HttpError(403, 'admin_only');
  return v;
}

/**
 * requireEditor(session, row) — the save/rename/delete gate.
 * Order matters and is the matrix's, not convenience's:
 *   no session            -> 401 unauthenticated (client parks the doc + logs in)
 *   invisible row         -> 404 not_found      (soft-deleted, non-admin)
 *   visible, not the author -> 403 not_author, carrying {ownerId, ownerName} so
 *                             the client can offer "Save a copy" naming the real
 *                             author instead of a dead end.
 */
export function requireEditor(sessionOrUser, row) {
  const v = requireUser(sessionOrUser);
  if (!row) throw new HttpError(404, 'not_found');
  if (!canRead(v, row)) throw new HttpError(404, 'not_found');
  if (!canEdit(v, row)) {
    throw new HttpError(403, 'not_author', {
      ownerId: ownerIdOf(row),
      // ownerName only exists when the route joined `user`; omit rather than
      // invent, and let the client fall back to "the original author".
      ownerName: row.owner_name || row.ownerName || null
    });
  }
  return v;
}

/**
 * requireClientHeader(request) — second CSRF lock, on EVERY mutating route.
 * SameSite=Lax already stops a cross-site form from carrying our cookie on
 * POST/PUT/PATCH/DELETE. This adds a header that a simple cross-origin form
 * post cannot set at all without a successful CORS preflight, which this
 * same-origin-only Worker never grants.
 */
export function requireClientHeader(request) {
  if (request.headers.get('X-Studio-Client') !== '1') {
    throw new HttpError(403, 'bad_client');
  }
}

/* ===========================================================================
 * RATE LIMITING /api/auth/*
 *
 * WHY THIS EXISTS AT ALL. Starting an OAuth flow writes a `verification` row to
 * D1 before any user exists, so POST /api/auth/sign-in/social is an
 * UNAUTHENTICATED WRITE. D1 Free bills 100,000 rows written per day for the
 * whole account, and the realistic steady-state usage of this app is ~2,500/day
 * — i.e. a trivial script hitting that one endpoint could exhaust everybody's
 * save budget for the day, from a laptop, without an account.
 *
 * WHY IT IS IN-MEMORY AND NOT IN D1. A limiter that writes a row per check
 * would BE the attack. This is a token bucket in isolate memory: one Map lookup
 * and some integer arithmetic, zero I/O, zero rows, microseconds of CPU.
 *
 * WHAT IT HONESTLY DOES NOT DO. Cloudflare runs many isolates across many
 * colos, and each holds its own Map — a distributed attacker spread across
 * colos sees a limit that is effectively (isolates x per-IP limit). This is a
 * cost multiplier and a cheap-shot blocker, not a guarantee. Two upgrades, in
 * order of effort, when it matters: bind Cloudflare's Rate Limiting binding as
 * AUTH_LIMITER (already wired in below — bind it in wrangler.jsonc and it is
 * used automatically), or move the counter into a Durable Object.
 *
 * COSTS ARE WEIGHTED BY WHAT THE ENDPOINT WRITES:
 *   sign-in / sign-up (initiation) — writes a verification row  -> cost 5,
 *                                    plus a hard 20/hour ceiling per IP
 *   callback                       — writes user/account/session -> cost 3
 *   get-session / everything else  — reads only                  -> cost 1..2
 *
 * The hourly initiation ceiling is the number that actually bounds the damage:
 * 20/hour/IP is ~480 verification rows/day/IP, under 0.5% of the daily cap,
 * while being far more than any human clicking "Sign in with GitHub" can reach.
 * =========================================================================*/

const RL_CAPACITY = 60;          // burst tokens per IP
const RL_REFILL_PER_SEC = 0.2;   // 12 tokens/minute sustained
const RL_INIT_MAX = 20;          // OAuth initiations per IP...
const RL_INIT_WINDOW_MS = 3600e3; // ...per rolling hour (fixed window)
const RL_MAX_KEYS = 5000;        // memory ceiling
const RL_IDLE_MS = 900e3;        // sweep entries untouched for 15 min

const _buckets = new Map();

/* ONE CHARGE PER REQUEST, HOWEVER MANY CALLERS ASK.
 *
 * checkAuthRateLimit is STATEFUL — it spends tokens and increments the hourly
 * initiation counter — so calling it twice for one request halves every ceiling
 * declared above. That is exactly what happened while index.js guarded the auth
 * prefix and then called a handler that guards it again: RL_INIT_MAX became an
 * effective 10/hour and sign-in cost 10 burst tokens instead of 5, so a shared
 * NAT or corporate egress IP hit 429 on the login path at half the intended
 * budget. index.js no longer guards (auth.js owns the path), and these two
 * WeakMaps make that structural rather than a convention someone can break: the
 * verdict is computed once per Request object and replayed thereafter.
 *
 * WeakMap, so entries die with the Request. `let` so _resetRateLimiter() can
 * drop them wholesale. */
let _rlVerdicts = new WeakMap();   // Request -> verdict from the memory bucket
let _rlEdge = new WeakMap();       // Request -> did AUTH_LIMITER reject it?

/** CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the
 *  client; the other two only ever matter under `wrangler dev`. */
export function clientIp(request) {
  const h = request.headers;
  const direct = h.get('CF-Connecting-IP');
  if (direct) return direct;
  const fwd = h.get('X-Forwarded-For');
  if (fwd) return fwd.split(',')[0].trim();
  return h.get('X-Real-IP') || 'unknown';
}

function costFor(path) {
  // path is the pathname, e.g. /api/auth/sign-in/social
  if (path.indexOf('/sign-in') >= 0 || path.indexOf('/sign-up') >= 0) return { cost: 5, init: true };
  if (path.indexOf('/callback') >= 0) return { cost: 3, init: false };
  if (path.indexOf('/get-session') >= 0) return { cost: 1, init: false };
  return { cost: 2, init: false };
}

function sweep(now) {
  for (const [k, b] of _buckets) {
    if (now - b.seen > RL_IDLE_MS) _buckets.delete(k);
  }
  if (_buckets.size < RL_MAX_KEYS) return;
  // Still full of live entries: drop the oldest quarter. Map preserves insertion
  // order, so the leading keys are the least recently created. Bounded memory
  // beats perfect fairness under what is, by definition, an attack.
  let drop = Math.ceil(_buckets.size / 4);
  for (const k of _buckets.keys()) {
    _buckets.delete(k);
    if (--drop <= 0) break;
  }
}

/**
 * checkAuthRateLimit(request, env) -> {ok:true,key,remaining} | {ok:false,...}
 * Synchronous, allocation-light, no I/O. Exported for tests and for any route
 * that wants the same shield.
 *
 * IDEMPOTENT PER Request OBJECT: the first call spends the tokens, every later
 * call with the same Request replays the same verdict without spending anything.
 * A second call site therefore cannot silently halve the ceilings. (Tests that
 * want to spend twice must pass two Request objects, or call
 * _resetRateLimiter() in between.)
 */
export function checkAuthRateLimit(request, env, nowMs) {
  const memo = _rlVerdicts.get(request);
  if (memo) return memo;
  const verdict = spendAuthRateLimit(request, nowMs);
  _rlVerdicts.set(request, verdict);
  return verdict;
}

/** The stateful half: refill, then spend. Never call this directly — every
 *  caller goes through checkAuthRateLimit so the per-request memo applies. */
function spendAuthRateLimit(request, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const key = clientIp(request);
  let path = '/';
  try { path = new URL(request.url).pathname; } catch (_) { /* keep '/' */ }
  const { cost, init } = costFor(path);

  let b = _buckets.get(key);
  if (!b) {
    if (_buckets.size >= RL_MAX_KEYS) sweep(now);
    b = { tokens: RL_CAPACITY, ts: now, init: 0, initTs: now, seen: now };
    _buckets.set(key, b);
  }

  // Refill, then spend.
  const elapsed = (now - b.ts) / 1000;
  if (elapsed > 0) {
    b.tokens = Math.min(RL_CAPACITY, b.tokens + elapsed * RL_REFILL_PER_SEC);
    b.ts = now;
  }
  b.seen = now;

  if (init) {
    if (now - b.initTs >= RL_INIT_WINDOW_MS) { b.init = 0; b.initTs = now; }
    if (b.init >= RL_INIT_MAX) {
      return {
        ok: false,
        key: key,
        reason: 'oauth_init',
        retryAfter: Math.max(1, Math.ceil((RL_INIT_WINDOW_MS - (now - b.initTs)) / 1000))
      };
    }
  }

  if (b.tokens < cost) {
    return {
      ok: false,
      key: key,
      reason: 'burst',
      retryAfter: Math.max(1, Math.ceil((cost - b.tokens) / RL_REFILL_PER_SEC))
    };
  }

  b.tokens -= cost;
  if (init) b.init += 1;
  return { ok: true, key: key, remaining: Math.floor(b.tokens) };
}

function rateLimitedResponse(verdict) {
  return new HttpError(429, 'rate_limited', {
    reason: verdict.reason,
    retryAfter: verdict.retryAfter
  }).toResponse({
    'Retry-After': String(verdict.retryAfter),
    'Cache-Control': 'no-store'
  });
}

/**
 * guardAuthRateLimit(request, env) -> Response (429) | null
 *
 * The in-isolate bucket first, because it is free and rejects the common case.
 * Then, ONLY IF the optional Cloudflare Rate Limiting binding `AUTH_LIMITER` is
 * bound in wrangler.jsonc, a cross-isolate check. The binding is entirely
 * optional: unbound, this is the memory limiter alone; bound, the limit becomes
 * global. A binding failure is swallowed — an edge hiccup must never lock users
 * out of signing in.
 *
 * Called from exactly ONE place: the wrapped handler built in createAuth().
 * Both halves are memoized per Request (the edge binding is stateful too), and a
 * FRESH 429 Response is built each time rather than a cached one, because a
 * Response body can only be consumed once.
 */
export async function guardAuthRateLimit(request, env) {
  const verdict = checkAuthRateLimit(request, env);
  if (!verdict.ok) return rateLimitedResponse(verdict);

  const limiter = env && env.AUTH_LIMITER;
  if (limiter && typeof limiter.limit === 'function') {
    let blocked = _rlEdge.get(request);
    if (blocked === undefined) {
      blocked = false;
      try {
        const res = await limiter.limit({ key: verdict.key });
        blocked = !!(res && res.success === false);
      } catch (err) {
        console.error('auth: rate-limit binding failed', err && err.message);
      }
      _rlEdge.set(request, blocked);
    }
    if (blocked) return rateLimitedResponse({ reason: 'edge', retryAfter: 60 });
  }
  return null;
}

/** Test/ops seam: forget every bucket AND every per-request memo. Never called
 *  on a request path. */
export function _resetRateLimiter() {
  _buckets.clear();
  _rlVerdicts = new WeakMap();
  _rlEdge = new WeakMap();
}
