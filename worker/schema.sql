-- ============================================================================
-- worker/schema.sql  —  Studio cloud library, D1 schema (schema_version 1).
--
-- APPLY ORDER. This file is applied AFTER the Better Auth schema, which is
-- GENERATED, not hand-written:
--     npx @better-auth/cli generate --config worker/auth.config.js
-- That generated file owns the tables `user`, `session`, `account`,
-- `verification`. DO NOT restate or hand-edit those tables here. The two extra
-- columns we need on `user` (role, github_id) are declared in Better Auth's
-- user.additionalFields config so the CLI emits them for us. For reference the
-- generated schema will contain, among others:
--     ALTER TABLE user ADD COLUMN role      TEXT NOT NULL DEFAULT 'user';
--     ALTER TABLE user ADD COLUMN github_id TEXT;
--   (Better Auth maps the camelCase field `githubId` to snake_case in SQL.)
-- If the generated file is applied WITHOUT additionalFields, isAdmin() silently
-- falls back to its github_id clause and nobody else can ever be promoted, so
-- worker/db.js exports assertSchema() for the Worker to check at boot.
--
--     wrangler d1 execute studio --remote --file=worker/schema.sql
--
-- CONVENTIONS ENFORCED THROUGHOUT:
--  * ALL timestamps are UNIX SECONDS as INTEGER. The frontend does
--    new Date(t * 1000)  (app.js:710 fmtDate). Never store milliseconds.
--    Note the desktop backend writes FLOAT seconds (server/app.py:740
--    time.time(); seed-private-eyes' project.json carries 1785264878.68923),
--    so the import path MUST floor() them to INTEGER.
--  * Ids are FLAT: /^[A-Za-z0-9_-]{1,64}$/  (server/app.py:652 _safe_pid), so a
--    project can round-trip through the desktop backend unharmed.
--  * payload_b64 is ALWAYS written as a BOUND PARAMETER, never inlined into SQL
--    text (D1's 100 KB statement-text cap), and it is TEXT and not BLOB because
--    D1 converts ArrayBuffer/ArrayBufferView params via Array.from — a 60 KB
--    blob would become a 60,000-element JS array under a 10 ms CPU budget.
--  * The Worker NEVER JSON.parses payload_b64. Every field the library list
--    needs is denormalized into its own column, supplied by the client.
--
-- NO FOREIGN KEYS ANYWHERE, deliberately:
--  * projects.owner_id has no FK to user(id) because all projects are public
--    artifacts and must SURVIVE their author's account being deleted. An
--    orphaned owner_id renders as "unknown author" and the project stays
--    browsable.
--  * recent_views.user_id has no FK either, which additionally decouples this
--    migration from Better Auth's table naming — we do not own that table, and
--    an FK would break this migration (or silently cascade-delete rows) if a
--    Better Auth upgrade re-created it.
--  Referential integrity is enforced in worker/db.js, which runs after the
--  session has already told us the user exists.
--
--  (The contract specified a documentary `PRAGMA foreign_keys = OFF;` here. It
--   is written as this comment instead: D1 rejects `PRAGMA foreign_keys` —
--   `PRAGMA defer_foreign_keys` is the only escape hatch it accepts — and a
--   statement that aborts the whole migration is a poor way to carry a note
--   about constraints we never declare in the first place.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- APPLY-ORDER GUARD — this is the FIRST statement in the file on purpose.
--
-- The apply order above was documentation only, and documentation does not stop
-- anyone running this file against an empty database. If it lands first, every
-- table below is created and everything LOOKS fine — until the first library
-- listing, because worker/db.js's card projection LEFT JOINs "user" for
-- owner_name / owner_image, and worker/auth.js cannot resolve a session at all.
-- The failure would surface as a blanket 500 with no hint about ordering.
--
-- This SELECT reads no rows (LIMIT 0) and costs nothing when the order is
-- right. When it is wrong it fails HERE, as the first statement, with SQLite's
-- own "no such table: user" (or "no such column: role") — before a single object
-- in this file has been created, so a re-run after applying 0000 is clean.
--
--   RIGHT: wrangler d1 execute studio --remote --file=migrations/0000_better_auth.sql
--          wrangler d1 execute studio --remote --file=worker/schema.sql
--
-- The columns named are exactly the ones we depend on: `user.role` and
-- `user.github_id` come from Better Auth's user.additionalFields, so this also
-- catches a 0000 generated BEFORE those fields were declared — the silent
-- failure worker/db.js assertSchema() exists to refuse at boot.
SELECT id, name, image, role, github_id FROM "user" LIMIT 0;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- projects — one row per project. All rows are PUBLIC (R2). Author-owned (R4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  -- identity -----------------------------------------------------------------
  id             TEXT    NOT NULL PRIMARY KEY,   -- server-minted, flat, global
  owner_id       TEXT    NOT NULL,               -- user.id (Better Auth). No FK.
  client_key     TEXT,                           -- Idempotency-Key of the create
                                                 -- request; NULL for imports.
  -- display / library-card fields (denormalized: the list route must never
  -- touch payload_b64, and the Worker must never parse it) -------------------
  name           TEXT    NOT NULL,
  name_lc        TEXT    NOT NULL,               -- name.toLowerCase(), for search
  youtube_url    TEXT    NOT NULL DEFAULT '',
  has_song       INTEGER NOT NULL DEFAULT 0,     -- 0/1
  track_count    INTEGER NOT NULL DEFAULT 0,
  instruments    TEXT    NOT NULL DEFAULT '',    -- comma-joined, e.g. 'bass,drums'
  -- payload ------------------------------------------------------------------
  encoding       TEXT    NOT NULL DEFAULT 'gzip+b64',
  payload_b64    TEXT    NOT NULL,               -- base64(gzip(project.json))
  payload_bytes  INTEGER NOT NULL DEFAULT 0,     -- length of the PRE-base64 bytes
  payload_sha    TEXT    NOT NULL DEFAULT '',    -- client-declared sha256 hex of
                                                 -- the pre-gzip UTF-8 JSON.
                                                 -- ADVISORY ONLY (cache/no-op
                                                 -- hint), never a trust boundary.
  -- concurrency / lifecycle --------------------------------------------------
  version        INTEGER NOT NULL DEFAULT 1,     -- monotonic; CAS counter
  created        INTEGER NOT NULL,               -- unix SECONDS
  updated        INTEGER NOT NULL,               -- unix SECONDS
  deleted        INTEGER NOT NULL DEFAULT 0,     -- 0/1 soft delete
  -- fork lineage -------------------------------------------------------------
  fork_of        TEXT,                           -- immediate parent id, NULL=original
  fork_root      TEXT,                           -- oldest ancestor id, NULL=original

  CHECK (length(id) BETWEEN 1 AND 64),
  CHECK (id NOT GLOB '*[^A-Za-z0-9_-]*'),        -- flat-id guard; the '-' is last
                                                 -- inside the class so it is literal
  CHECK (owner_id <> ''),
  CHECK (deleted IN (0, 1)),
  CHECK (has_song IN (0, 1)),
  CHECK (version >= 1),
  CHECK (encoding IN ('gzip+b64', 'identity+b64'))
);

-- INDEX 1 of 2 (plus the implicit PK autoindex, which is 3 indexes total).
-- Serves: the DEFAULT anonymous library order, the `order=updated` page, and the
-- keyset cursor. Partial on deleted=0 so soft-deleted rows leave the index
-- entirely (smaller index, and the listing needs no `deleted` predicate).
--
-- WRITE COST: `updated` moves on every save -> +1 row written per save (a save
-- is 2 rows, not 1). This is the ONE index we pay for on the save path and it
-- is load-bearing: without it every library open is a full table scan billed as
-- rows_read. Rejected alternative: (deleted, updated DESC) — same write cost,
-- larger index, keeps tombstones in it. The partial form strictly wins.
CREATE INDEX IF NOT EXISTS idx_projects_recent
  ON projects (updated DESC, id DESC)
  WHERE deleted = 0;

-- INDEX 2 of 2. Dual purpose, deliberately:
--   (a) UNIQUE (owner_id, client_key) makes create/fork IDEMPOTENT — a retried
--       or double-tapped create collides instead of minting a duplicate project;
--       worker/db.js catches the violation and returns the EXISTING row.
--       Multiple NULL client_key rows per owner are allowed (SQLite treats NULLs
--       as distinct in a UNIQUE index), which is what admin imports need.
--   (b) its LEADING COLUMN owner_id serves the "My projects" filter (R2), so we
--       do NOT need a separate owner index.
--
-- WRITE COST: both columns are immutable after INSERT -> +0 rows on save,
-- +1 row on insert. Folding the owner index into this one saves 1 row per save.
-- A dedicated (owner_id, updated DESC) index would remove the "My projects"
-- filesort but would cost +1 row on EVERY save because `updated` moves — not
-- worth it, a user's project count is in the tens.
-- The one write that DOES touch this index is the admin ownership transfer,
-- which is therefore 3 rows instead of 2.
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_owner_key
  ON projects (owner_id, client_key);

-- NO index on name / name_lc. Search is `name_lc LIKE '%q%' ESCAPE '\'`, which
-- no B-tree can serve, so an index would be dead weight that still bills +1 row
-- on every rename. Search is a deliberate scan with payload_b64 NOT in the
-- projection.
-- THE ARITHMETIC, corrected — the first cut of this comment was off by 2x in the
-- app's favour. Budget is 5M rows read/day. A search that matches nothing scans
-- every live project, so at N projects one search reads ~N rows (the LEFT JOIN
-- on "user" adds one row per row RETURNED, i.e. at most limit+1 = 41 more, not
-- one per row scanned). At 2,000 projects that is ~2,000 rows read per search:
-- 2,500 searches/day is the WHOLE daily read budget, not half of it. Half the
-- budget is ~1,250 searches/day at that size.
-- REVISIT THRESHOLD, recalibrated to that number: when COUNT(*) FROM projects
-- exceeds 5,000 (where half the read budget buys only ~500 searches/day), or
-- when daily rows_read attributable to the search route exceeds 1M, add a prefix
-- index on name_lc and switch to prefix search, or move to FTS5 and accept its
-- write amplification. Both are observable from the rows_read that worker/db.js
-- returns on every statement and logs in the `rr` field of each request line.
-- NO index on fork_of / fork_root. "List the forks of X" is not a requirement;
-- a card shows its own parent, which is already on the row we read. See the
-- deferred migration at the foot of this file.
-- NO FTS5 table: its shadow tables write many rows per insert, and rows written
-- is the binding constraint here, not rows read.
-- NO fork_count / view_count column: either would turn a READ action into a
-- WRITE on the parent row, and sorting by one would need an index on a counter
-- that changes on every open — taking a view from 1 row written to 3.

-- ---------------------------------------------------------------------------
-- recent_views — per-user "most recently viewed" (R3). THE HOT WRITE PATH.
--
-- WITHOUT ROWID is mandatory here, not stylistic: the rows are tiny and fixed
-- width, and the composite PK is the only access path. WITHOUT ROWID stores the
-- row IN the PK b-tree, so there is NO separate PK autoindex — an upsert writes
-- EXACTLY 1 row instead of 2. That halves the cost of the hottest action in the
-- app, and 1 row is the floor; nothing in this design does better.
--
-- There is deliberately NO index on `viewed`, and this is the single most
-- important index decision in the schema. `viewed` is the column that changes
-- on every single view; indexing it would add +1 row written to every view — a
-- permanent 100% surcharge on the hottest path — in exchange for avoiding a
-- filesort over one user's slice of a few dozen rows. DO NOT ADD IT.
--
-- Read path (worker/db.js listRecentForUser) uses the PK's leading column:
--   SELECT project_id, viewed FROM recent_views
--    WHERE user_id = ?1 AND viewed > ?2 ORDER BY viewed DESC LIMIT 60;
-- The `viewed > now - 90 days` predicate caps what can appear, so stale history
-- cannot degrade the result even before the (deferred) prune deletes it.
--
-- COROLLARY OF THE MISSING INDEX, stated here because it is not obvious: nothing
-- may query this table BY project_id. project_id is the TRAILING column of the
-- only b-tree, so `WHERE project_id = ?` is a full table scan — at the 100,000
-- rows that trigger the prune cron, that is 100,000 rows read per call, growing
-- without bound. The admin hard-delete path used to do exactly that to clean up
-- a deleted project's history; it no longer does (worker/db.js
-- hardDeleteProject). Orphaned rows are invisible, because hydrateCards() joins
-- to projects and filters deleted = 0, and the prune cron reaps them by age.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recent_views (
  user_id    TEXT    NOT NULL,
  project_id TEXT    NOT NULL,
  viewed     INTEGER NOT NULL,          -- unix SECONDS
  PRIMARY KEY (user_id, project_id)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- app_meta — tiny ops key/value. Used for the one-shot seed marker and for
-- recording the schema revision the Worker expects. WITHOUT ROWID for the same
-- reason: no PK autoindex, so a write is 1 row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_meta (
  k TEXT NOT NULL PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID;

INSERT OR REPLACE INTO app_meta (k, v) VALUES ('schema_version', '1');
INSERT OR REPLACE INTO app_meta (k, v) VALUES ('admin_github_id', '21693187');

-- ============================================================================
-- SEEDING THE SIX COMMITTED PROJECTS IS NOT PART OF THIS FILE.
-- seed-bolan-shanghai alone is 77,888 base64 characters, and an INSERT literal
-- carrying it would be a ~78 KB SQL statement — under D1's 100 KB statement-text
-- cap today but with no headroom, and in violation of the bind-as-parameter
-- rule. tools/seed-d1.js runs on the developer's machine, authenticates as the
-- admin, and POSTs each project to /api/admin/import with its EXISTING id so
-- deployed URLs stay stable. It sets app_meta.seeded='1' and refuses to run
-- twice.
--
-- STORAGE CEILING, measured on those six projects (raw -> gzip -> base64):
--   df07094f72b2              379,455 -> 33,365 -> 44,488
--   on-the-fly-daniel-hayn    205,289 -> 19,629 -> 26,172
--   seed-bolan-shanghai       385,784 -> 58,415 -> 77,888   <- worst case
--   seed-private-eyes         140,984 -> 18,248 -> 24,332
--   seed-too-many-kicks-live  192,184 -> 27,290 -> 36,388
--   seed-too-many-kicks       171,281 -> 19,913 -> 26,552
-- Mean base64 ~39 KB, worst 78 KB. D1's 2 MB row cap is 25x the worst case, and
-- its 500 MB database cap holds roughly 12,000 projects at the mean. The Worker
-- additionally enforces a hard 700,000-character ceiling on payload_b64
-- (worker/db.js MAX_PAYLOAD_CHARS: 9x the worst measured project, ~1.4x the
-- Safari <16.4 identity+b64 fallback worst case) and returns 413 above it, so a
-- runaway drum track can never produce a row D1 refuses to store — the failure
-- is a clean HTTP error, not a corrupt save.
-- ============================================================================

-- ============================================================================
-- DEFERRED — apply only if the stated trigger fires. Not part of launch.
--
-- 0002_prune_views — there is no schema change, and the cron HANDLER IS ALREADY
--   SHIPPED (worker/index.js scheduled()). Enabling it is one line of
--   wrangler.jsonc:  "triggers": { "crons": ["17 * * * *"] }.
--   TRIGGER TO ENABLE: SELECT COUNT(*) FROM recent_views exceeds 100,000, or the
--   p99 rows_read of listRecentForUser exceeds 200.
--   The handler does NOT run the single statement this comment used to sketch —
--   `DELETE FROM recent_views WHERE viewed < :cutoff` has no index to drive it
--   (`viewed` is deliberately unindexed) and so scans the whole table, which
--   stops fitting in 10 ms somewhere north of 500,000 rows. It instead walks the
--   PRIMARY KEY in cursor-resumed windows and deletes by key pair, capped per
--   run. See the cadence table beside PRUNE_SCAN: pruned rows are ROWS WRITTEN,
--   so the schedule spends the daily D1 budget and hourly is the sane start.
--
-- 0003_fork_index.sql — only if "show all forks of X" becomes a requirement.
--   CREATE INDEX idx_projects_fork_root ON projects (fork_root)
--     WHERE fork_root IS NOT NULL;
--   Costs +1 row on INSERT only (fork_root is immutable); +0 on save. fork_root
--   is denormalized precisely so this answers a whole subtree in one equality
--   lookup instead of a recursive CTE the Worker has no CPU for.
-- ============================================================================
