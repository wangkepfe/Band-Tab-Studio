-- ============================================================================
-- migrations/0005_ear_context_tonic.sql  —  widen ear_sessions.context to admit
-- the new 'tonic' key context (/learn): a single reference note, the 1, instead
-- of a chord progression.
--
-- WHY A WHOLE TABLE REBUILD FOR ONE ENUM VALUE. 0004 declares
--     CHECK (context IN ('cadence', 'ii-V-I', 'drone'))
-- and SQLite has no ALTER TABLE ... DROP CONSTRAINT. The only supported way to
-- change a CHECK is the documented 12-step rebuild (sqlite.org/lang_altertable),
-- which for THIS table collapses to four statements, because 0004 deliberately
-- left nothing else to carry across:
--     * NO secondary indexes ("NO SECONDARY INDEXES. NONE.")
--     * NO triggers, NO views
--     * NO foreign key IN or OUT — nothing references ear_sessions and it
--       references nothing, so the PRAGMA foreign_keys dance the SQLite recipe
--       opens and closes with is a no-op here and is omitted rather than cargoed
--
-- The alternative — leaving the CHECK alone and coercing 'tonic' to 'cadence' on
-- the way in — was rejected outright. The column's job is to record what was
-- actually practised; a row that says the user drilled against I-IV-V-I when
-- they drilled against a bare tonic is not a narrower record, it is a false one,
-- and every per-context comparison built on it afterwards would be wrong.
--
-- APPLY THIS BEFORE DEPLOYING THE WORKER THAT ACCEPTS 'tonic'. In the wrong
-- order the failure is not a 400 but a 500: worker/routes.js validates against
-- LEARN_CONTEXTS and would pass 'tonic' through to an INSERT the old CHECK then
-- aborts. Nothing is lost when that happens — /learn writes the session to
-- localStorage before it ever POSTs (design Part I s13) and EarStore.sync()
-- re-sends later — but the user's history sits unsent until this file lands.
--
--     npx wrangler d1 migrations apply studio --local
--     npx wrangler d1 migrations apply studio --remote
--   (or, without the d1_migrations bookkeeping:
--     npx wrangler d1 execute studio --remote --file=migrations/0005_ear_context_tonic.sql)
--
-- IDEMPOTENT, and worth spelling out because "rebuild" and "safe to repeat" do
-- not usually go together. On a second run the four statements simply do the
-- rebuild again from the already-rebuilt table: CREATE IF NOT EXISTS finds or
-- makes the scratch table, INSERT OR IGNORE copies rows that are already there
-- (every one collides on the PK and writes nothing), DROP removes the current
-- table and RENAME puts the copy back. Same rows, same shape, no error.
--
-- THE ONE UNSAFE WINDOW is between statement 3 and statement 4: a run killed
-- exactly there leaves the data in `ear_sessions_new` and no `ear_sessions` at
-- all. Nothing is lost — finish it by hand and the database is whole:
--     npx wrangler d1 execute studio --remote --command "ALTER TABLE ear_sessions_new RENAME TO ear_sessions;"
-- D1 batches a file's statements into one implicit transaction, so this window
-- should not be reachable through wrangler; the recovery is written down anyway
-- because the cost of not knowing it, at that moment, is a table that looks lost.
--
-- ROWS WRITTEN: one per existing session row, once. At the scale 0004 budgets
-- for (~365 rows per active user per year) this is a rounding error against
-- D1 Free's 100,000/day, and it is a one-time cost — the steady-state write path
-- is untouched and still writes exactly 1 row per finished session.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The new shape. IDENTICAL to 0004 in every column, type, default, key and
--    CHECK except the one line marked below — WITHOUT ROWID included, which is
--    load-bearing (0004: the table IS the PK b-tree, so an insert writes exactly
--    one row). Copy any future change to 0004's DDL into this file too, or a
--    database rebuilt by this migration stops matching the one 0004 creates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ear_sessions_new (
  user_id      TEXT    NOT NULL,
  started      INTEGER NOT NULL,
  duration_sec INTEGER NOT NULL,
  level        INTEGER NOT NULL,
  mode         TEXT    NOT NULL,
  context      TEXT    NOT NULL,             -- 'tonic' | 'cadence' | 'ii-V-I'
                                             -- | 'drone'
  taper        INTEGER NOT NULL,
  sing_gate    INTEGER NOT NULL DEFAULT 0,
  questions    INTEGER NOT NULL DEFAULT 0,
  correct      INTEGER NOT NULL DEFAULT 0,
  assists      INTEGER NOT NULL DEFAULT 0,
  cents_sum    INTEGER NOT NULL DEFAULT 0,
  cents_n      INTEGER NOT NULL DEFAULT 0,
  detail       TEXT    NOT NULL DEFAULT '',

  PRIMARY KEY (user_id, started),

  CHECK (user_id <> ''),
  CHECK (started > 0),
  CHECK (duration_sec BETWEEN 0 AND 86400),
  CHECK (level BETWEEN 1 AND 7),
  CHECK (mode IN ('identify', 'produce')),
  -- >>> THE ONLY CHANGE IN THIS FILE. 'tonic' is the plainest context on the
  -- ladder: one reference note and no harmony at all, added because a four-chord
  -- cadence is more than a beginner can hold while also naming a degree. It is
  -- listed FIRST for the same reason it is first in the settings menu — the list
  -- reads easiest-to-hardest. Mirrored in worker/routes.js LEARN_CONTEXTS,
  -- worker/db.js normEarContext() and web/learn/ear-store.js; CHANGE ALL FOUR.
  CHECK (context IN ('tonic', 'cadence', 'ii-V-I', 'drone')),
  CHECK (taper IN (0, 1, 2, 4, 8)),
  CHECK (sing_gate IN (0, 1)),
  CHECK (questions >= 0),
  CHECK (correct BETWEEN 0 AND questions),
  CHECK (assists >= 0),
  CHECK (cents_n BETWEEN 0 AND questions),
  CHECK (cents_sum >= 0),
  CHECK (cents_sum <= cents_n * 1200),
  CHECK (length(detail) <= 2000)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 2. Copy. Columns are NAMED on both sides rather than `SELECT *`, so the copy
--    is checked by the database instead of by whoever last edited the DDL: a
--    column that ever moved would fail loudly here rather than silently shifting
--    every value one place to the left. OR IGNORE is what makes a re-run a
--    no-op — the second time, every row collides on (user_id, started) and
--    writes nothing.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO ear_sessions_new (
  user_id, started, duration_sec, level, mode, context, taper, sing_gate,
  questions, correct, assists, cents_sum, cents_n, detail
)
SELECT
  user_id, started, duration_sec, level, mode, context, taper, sing_gate,
  questions, correct, assists, cents_sum, cents_n, detail
FROM ear_sessions;

-- ---------------------------------------------------------------------------
-- 3. and 4. Swap. IF EXISTS on the DROP is belt-and-braces only: 0004 always
--    runs first (wrangler applies migrations in filename order) and statement 2
--    would already have failed on a database where it had not, so this can only
--    matter to a hand-repaired database that got as far as the copy.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS ear_sessions;
ALTER TABLE ear_sessions_new RENAME TO ear_sessions;
