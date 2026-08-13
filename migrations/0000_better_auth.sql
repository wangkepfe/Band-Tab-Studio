-- ============================================================================
-- migrations/0000_better_auth.sql  —  Better Auth's four tables, hand-written.
--
-- APPLY THIS FIRST. Order is not a preference, it is a hard dependency:
--     0000  this file        -> user, session, account, verification
--     0001  worker/schema.sql -> projects, recent_views, app_meta
-- worker/db.js:252 builds every library read as
--     FROM projects p LEFT JOIN "user" u ON u.id = p.owner_id
-- so applying worker/schema.sql first leaves every list/read query failing with
-- "no such table: user" until this file lands. See migrations/README.md.
--
-- WHY THIS FILE IS HAND-WRITTEN AND NOT GENERATED.
--   worker/auth.js:358 wires Better Auth through drizzleAdapter. Run against a
--   Drizzle adapter, `npx @better-auth/cli generate` emits a Drizzle SCHEMA FILE
--   (TypeScript), not SQL — it will never produce this migration. The DDL below
--   is therefore transcribed BY HAND from the drizzle tables declared in
--   worker/auth.js:139-191 (userTable, sessionTable, accountTable,
--   verificationTable), which are what the running adapter actually binds
--   against, and cross-checked column-by-column against the core field
--   definitions in
--     worker/node_modules/@better-auth/core/dist/db/get-tables.mjs
--   for the pinned better-auth 1.6.27. Header comment, drizzle tables and the
--   core definitions all agree; where a future release disagrees, THE DRIZZLE
--   TABLES WIN, because they are the mapping the adapter executes.
--
-- CONVENTIONS (repo-wide, restated because a drift here is a production login
-- failure, not a test failure):
--  * COLUMN NAMES ARE snake_case. The drizzle property keys stay camelCase —
--    those keys are the Better Auth FIELD names — and the string argument to
--    text()/integer() is the SQL column name. `githubId` -> `github_id`.
--  * ALL timestamps are INTEGER UNIX SECONDS. Every date column here is
--    declared in drizzle as integer(..., { mode: 'timestamp' }), which is
--    SECONDS (mode 'timestamp_ms' would be milliseconds and is used nowhere in
--    this repo). The frontend does new Date(t * 1000) at app.js:710.
--  * Booleans are INTEGER 0/1 (drizzle mode: 'boolean').
--  * IDEMPOTENT: every statement is CREATE ... IF NOT EXISTS, so re-applying
--    this file by hand (`wrangler d1 execute --file=...`) is a no-op rather
--    than an error. See the README for the one case IF NOT EXISTS cannot fix:
--    a `user` table that already exists WITHOUT role / github_id.
--
-- NO `rateLimit` TABLE IS CREATED, deliberately. Better Auth can persist its
-- own limiter to a database table; worker/auth.js:265 sets
-- rateLimit: { enabled: false } and owns the limiting in code (guardAuthRateLimit),
-- weighted by which endpoints actually write D1 rows. Creating an unused table
-- here would only invite a future release to start writing to it.
--
-- VERIFY AFTER APPLYING — these are the exact four probes assertAuthSchema()
-- runs in front of every request (worker/auth.js:454-459); if they all return
-- an empty result set instead of an error, the Worker will boot:
--     SELECT id, name, image, email, role, github_id FROM user LIMIT 0;
--     SELECT id, user_id, account_id, provider_id FROM account LIMIT 0;
--     SELECT id, user_id, token, expires_at FROM session LIMIT 0;
--     SELECT id, identifier, value, expires_at FROM verification LIMIT 0;
-- ============================================================================


-- ---------------------------------------------------------------------------
-- user — one row per human. Created on the first GitHub callback.
--
-- `user` is quoted throughout because it is a reserved word in several SQL
-- dialects (worker/db.js:100 quotes it for the same reason). SQLite itself
-- accepts it bare, but the quoted form is what drizzle emits, so keeping the
-- two spellings identical removes a whole class of "works locally" surprise.
--
-- email is NOT NULL UNIQUE per the drizzle declaration (worker/auth.js:142).
-- That is why the GitHub provider requests the `user:email` scope
-- (worker/auth.js:372): an account whose primary address is private returns
-- email:null from /user, and without that scope the very first sign-in would
-- fail this constraint.
--
-- role / github_id are Better Auth `additionalFields`, both declared
-- input:false (worker/auth.js:214-217), so no client can ever POST role:'admin'
-- and promote itself. role defaults to 'user' in BOTH places (SQL DEFAULT here,
-- defaultValue there) so a row inserted by a path that bypasses the field
-- config still lands as a non-admin. github_id is nullable because it is
-- written from the OAuth profile and backfilled from account.account_id
-- (worker/auth.js:400-414); when it is missing, auth.js:505 resolveGithubId()
-- reads the account table instead, so a NULL here degrades to a query, never to
-- a wrong answer about who the admin is.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "user" (
  id             TEXT    NOT NULL PRIMARY KEY,
  name           TEXT    NOT NULL,           -- NOT NULL: mapProfileToUser falls
                                             -- back login -> 'GitHub user' so a
                                             -- nameless GitHub account can sign in
  email          TEXT    NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0, -- 0/1
  image          TEXT,                       -- avatar URL; NULL is rendered as
                                             -- the initials chip by the client
  created_at     INTEGER NOT NULL,           -- unix SECONDS
  updated_at     INTEGER NOT NULL,           -- unix SECONDS
  role           TEXT    NOT NULL DEFAULT 'user',  -- additionalFields, input:false
  github_id      TEXT                              -- additionalFields, input:false
);

-- NO index on github_id and NO index on role.
--   github_id: nothing filters by it. isAdmin() compares the value already on
--   the normalized session (auth.js:572); routes.js:995 looks an owner up by
--   user.id, which is the PK. An index would buy nothing and would add +1 row
--   written to the once-per-user backfill UPDATE at auth.js:407.
--   role: same, and it is read off the session too.
-- The UNIQUE on email is not optional — it is declared in drizzle
-- (auth.js:142) and Better Auth relies on it for account linking — but note it
-- costs +1 row written on the user INSERT.


-- ---------------------------------------------------------------------------
-- session — one row per signed-in browser. 30-day lifetime, refreshed at most
-- weekly (auth.js:127-128), with a 300 s cookie cache in front of it
-- (auth.js:257) so the vast majority of authenticated requests never read this
-- table at all.
--
-- The FK to "user" is declared here because drizzle declares it
-- (auth.js:160, onDelete: 'cascade'). This is the ONE place in the database
-- with foreign keys: worker/schema.sql deliberately has none, because projects
-- are public artifacts that must outlive their author's account. Sessions must
-- NOT outlive it, hence the cascade.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session (
  id         TEXT    NOT NULL PRIMARY KEY,
  expires_at INTEGER NOT NULL,               -- unix SECONDS
  token      TEXT    NOT NULL UNIQUE,        -- see the index note below
  created_at INTEGER NOT NULL,               -- unix SECONDS
  updated_at INTEGER NOT NULL,               -- unix SECONDS
  ip_address TEXT,
  user_agent TEXT,
  user_id    TEXT    NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

-- THE SESSION-BY-TOKEN LOOKUP NEEDS NO `CREATE INDEX`.
-- Every authenticated request that misses the cookie cache resolves the session
-- with findOne(session WHERE token = ?) — internal-adapter.mjs:265-271 in
-- better-auth 1.6.27. `token TEXT NOT NULL UNIQUE` above already creates the
-- unique index that serves it. Adding a second index on token would double the
-- write cost of every session INSERT for zero read benefit.
--
-- idx_session_user IS needed: findMany(session WHERE user_id = ?) backs
-- list-sessions and revoke-all-sessions (internal-adapter.mjs:135-144), and
-- SQLite needs it to find the child rows when a user row is deleted under the
-- ON DELETE CASCADE above. Better Auth's own core schema declares
-- `userId: { ..., index: true }` for exactly this reason.
-- WRITE COST: +1 row on session INSERT (roughly once per user per 30 days).
-- +0 on the weekly refresh, which touches only expires_at / updated_at —
-- neither is indexed, so a refresh is 1 row written, not 2.
CREATE INDEX IF NOT EXISTS idx_session_user ON session (user_id);


-- ---------------------------------------------------------------------------
-- account — one row per linked OAuth provider account. With GitHub as the only
-- provider (auth.js:364-375) that is exactly one row per user.
--
-- account_id IS THE GITHUB NUMERIC USER ID, as TEXT. It is the value compared
-- against ADMIN_GITHUB_ID = '21693187' (R5), and the fallback source of truth
-- for user.github_id when the session cookie predates the backfill. Never the
-- login string: GitHub logins are renameable and reclaimable, the numeric id is
-- not.
--
-- password is declared because Better Auth's core schema declares it, and is
-- always NULL here: emailAndPassword is disabled (auth.js:246), so this app has
-- no password to store, leak, or reset.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account (
  id                       TEXT    NOT NULL PRIMARY KEY,
  account_id               TEXT    NOT NULL,   -- provider's user id; for GitHub
                                               -- the NUMERIC id, as a string
  provider_id              TEXT    NOT NULL,   -- 'github' — the only one
  user_id                  TEXT    NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  INTEGER,            -- unix SECONDS, nullable
  refresh_token_expires_at INTEGER,            -- unix SECONDS, nullable
  scope                    TEXT,               -- 'read:user user:email'
  password                 TEXT,               -- always NULL: no email/password
                                               -- provider is configured
  created_at               INTEGER NOT NULL,   -- unix SECONDS
  updated_at               INTEGER NOT NULL    -- unix SECONDS
);

-- idx_account_user — findMany(account WHERE user_id = ?)
-- (internal-adapter.mjs:570-578), and the lookup auth.js:513-517
-- resolveGithubId() runs whenever a session arrives without a github_id:
--     WHERE user_id = ? AND provider_id = 'github'
-- user_id is the leading (and here only) column, so this index serves both.
-- Better Auth's core schema declares `userId: { ..., index: true }`.
-- WRITE COST: +1 row on the account INSERT, which happens once per user, ever.
-- Token-refresh UPDATEs touch access_token / refresh_token / *_expires_at only,
-- none of which is indexed, so they stay at 1 row.
CREATE INDEX IF NOT EXISTS idx_account_user ON account (user_id);

-- idx_account_provider — NOT declared by Better Auth's core schema, and NOT in
-- the DDL block in worker/auth.js's header. Added deliberately, because the
-- adapter call that runs on EVERY GitHub callback is
--     findAccountByProviderId(accountId, providerId)
--       -> findOne(account WHERE account_id = ? AND provider_id = ?)
--     (better-auth 1.6.27, dist/db/internal-adapter.mjs:558-569)
-- which without this index is a full table scan of `account` on the sign-in
-- path — the one path where a slow query is a user staring at a spinner mid
-- OAuth redirect. Column order is (provider_id, account_id) so the index is
-- also usable for any future "all github accounts" scan; either order serves
-- the equality-on-both lookup above.
-- NOT UNIQUE on purpose. It would be a reasonable invariant — one GitHub
-- account should map to one user — but Better Auth does not declare it, and a
-- surprise UNIQUE violation here would fail the login request outright rather
-- than degrade. Correctness of linking is Better Auth's job, not the schema's.
-- WRITE COST: +1 row on the account INSERT (once per user, ever); +0 on every
-- update, because both columns are immutable after insert.
CREATE INDEX IF NOT EXISTS idx_account_provider ON account (provider_id, account_id);


-- ---------------------------------------------------------------------------
-- verification — short-lived OAuth state. THIS IS THE APP'S ONLY
-- UNAUTHENTICATED WRITE SURFACE: POST /api/auth/sign-in/social inserts a row
-- here BEFORE any user exists, which is why auth.js runs an IP-keyed rate
-- limiter (guardAuthRateLimit) in front of the whole /api/auth/* prefix. D1
-- Free bills 100,000 rows written per DAY across the account; an unthrottled
-- sign-in initiation is a one-line denial-of-wallet on the whole library.
--
-- created_at / updated_at are NULLABLE, matching the drizzle declaration
-- (auth.js:189-190). better-auth 1.6.27 always supplies both (they are
-- `required: true` with a defaultValue in its core schema), so nullable here is
-- a strict superset of what the adapter writes — it costs nothing today and it
-- keeps the first OAuth initiation working on a release that omits them.
-- Do NOT tighten these to NOT NULL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification (
  id         TEXT    NOT NULL PRIMARY KEY,
  identifier TEXT    NOT NULL,               -- the OAuth `state` value
  value      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,               -- unix SECONDS
  created_at INTEGER,                        -- unix SECONDS, nullable on purpose
  updated_at INTEGER                         -- unix SECONDS, nullable on purpose
);

-- idx_verification_identifier — the callback consumes the state row with
-- findMany/consume(verification WHERE identifier = ?)
-- (internal-adapter.mjs:602-655, 677+). Better Auth's core schema declares
-- `identifier: { ..., index: true }`.
-- WRITE COST, and it is the one that matters: +1 row per sign-in INITIATION and
-- +1 per consume/delete, i.e. this index makes the unauthenticated write path 3
-- rows instead of 2. Accepted, because the alternative is a full scan of a
-- table that accumulates one abandoned row per initiated-but-never-completed
-- login and is only drained on expiry — an unindexed scan there gets worse
-- exactly under the abuse the rate limiter is defending against.
-- NO index on expires_at: nothing queries by it, and it changes on every row.
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification (identifier);


-- ============================================================================
-- INDEX / ROW-WRITTEN BUDGET (D1 Free: 100,000 rows written per day, account
-- wide, shared with everything worker/schema.sql does).
--
--   EVENT                                  STATEMENTS  ROWS WRITTEN
--   sign-in initiation (anonymous!)        1 INSERT    3   verification table
--                                                          + PK autoindex
--                                                          + idx_verification_identifier
--   callback: consume the state            1 DELETE    3   same three
--   callback: first-ever sign-in
--     user INSERT                          1 INSERT    3   table + PK + email UNIQUE
--     account INSERT                       1 INSERT    4   table + PK
--                                                          + idx_account_user
--                                                          + idx_account_provider
--     session INSERT                       1 INSERT    4   table + PK
--                                                          + token UNIQUE
--                                                          + idx_session_user
--     github_id / role backfill            1 UPDATE    1   neither column indexed
--   callback: returning user
--     session INSERT                       1 INSERT    4
--   weekly session refresh                 1 UPDATE    1   expires_at/updated_at
--                                                          are unindexed
--   ordinary authenticated request         0           0   cookie cache (300 s)
--
-- Worst case, a brand-new user signing in costs ~18 rows written once, ~7 on
-- every subsequent sign-in, and 0 thereafter for 30 days.
-- ============================================================================
