-- ============================================================================
-- migrations/0004_ear_sessions.sql  —  one row per COMPLETED ear-training
-- session (/learn). Purely additive: nothing in worker/schema.sql changes, and
-- no existing query plan moves.
--
-- WHY THIS FILE IS 0004 AND NOT 0002 OR 0003. Those two numbers are already
-- NAMED AND RESERVED at the foot of worker/schema.sql:
--     0002_prune_views     — no schema change at all; the cron handler is
--                            already shipped (worker/index.js scheduled()) and
--                            enabling it is one line of wrangler.jsonc.
--     0003_fork_index.sql  — CREATE INDEX idx_projects_fork_root, deferred
--                            until "show all forks of X" becomes a requirement.
-- A migration number is a claim about IDENTITY, not about ordering: wrangler
-- records what it applied in the `d1_migrations` table by name, so taking 0002
-- here would make `wrangler d1 migrations list` report the prune migration as
-- applied on every database that ever ran this file — and the day someone
-- writes the real 0002, it silently never runs. 0004 costs nothing and keeps
-- both reservations honest. (0001 is worker/schema.sql, which lives outside
-- this folder and is applied with `d1 execute`; see migrations/README.md.)
--
-- APPLY ORDER. This file depends on NOTHING. It declares no foreign key and
-- joins to no other table (see below), so unlike worker/schema.sql it carries
-- no apply-order guard SELECT — there is no wrong order in which it could be
-- applied, and a guard that can never fire is just noise.
--
-- It IS a hard dependency of the WORKER, though, and that ordering is enforced
-- in code rather than in SQL: worker/db.js assertSchema() probes ear_sessions
-- once per isolate, so a deploy that lands before this migration answers every
-- /api/* request with 503 schema_not_ready. That is the whole point — the
-- alternative is a Worker that serves the library happily and then throws "no
-- such table: ear_sessions" at the first user who finishes a drill, hours later,
-- on the one path nobody is watching.
--
--     npx wrangler d1 execute studio --local  --file=migrations/0004_ear_sessions.sql
--     npx wrangler d1 execute studio --remote --file=migrations/0004_ear_sessions.sql
--   (or `npx wrangler d1 migrations apply studio --remote`, which additionally
--    records it in d1_migrations. This file is idempotent either way:
--    CREATE TABLE IF NOT EXISTS, so a re-run is a no-op, not an error.)
--
-- CONVENTIONS, restated because a drift here is silent data corruption rather
-- than a failed test:
--  * ALL timestamps are UNIX SECONDS as INTEGER. `started` is the CLIENT's
--    clock (the session is written locally first and POSTed afterwards, design
--    Part I s13), so worker/routes.js rejects anything outside a sane window
--    around the server's now. A millisecond value would land ~55,000 years in
--    the future and sort every real row underneath it forever.
--  * Booleans are INTEGER 0/1 — here just `sing_gate`.
--  * ACCURACY IS NEVER STORED. It is correct / questions, derived on read
--    (design Part I s13, "Accuracy is derived, never stored"). A stored copy is
--    a second source of truth that can disagree with the two columns it came
--    from, and there is no index that would want it.
--  * `detail` is OPAQUE TEXT. The Worker never JSON.parses it, exactly as it
--    never parses projects.payload_b64 (worker/routes.js house rule 1). It is
--    the client's compact per-degree tally, and it comes back byte-for-byte.
--
-- NO FOREIGN KEY on user_id, matching worker/schema.sql's blanket rule — but
-- for a narrower reason than "projects must outlive their author". This
-- migration must not couple itself to the naming of a table we do not own:
-- Better Auth owns `user`, and an upgrade that re-creates it would break this
-- migration or silently cascade-delete rows out of it. Referential integrity is
-- enforced in worker/routes.js, which only ever binds ctx.user.id — an id the
-- session has already proved exists. An orphaned row after an account deletion
-- is invisible: every read is WHERE user_id = <the caller>, and a deleted
-- account never calls again.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ear_sessions — the /learn write path, and the ONLY table this feature adds.
--
-- WITHOUT ROWID is mandatory here, not stylistic, and it is the same reasoning
-- worker/schema.sql gives for recent_views: the rows are small and fixed-shape
-- apart from one short TEXT, and the composite PK is the ONLY access path.
-- WITHOUT ROWID stores the row IN the PK b-tree, so there is NO separate PK
-- autoindex — an insert writes EXACTLY 1 ROW instead of 2. One row is the floor
-- for "persist a session" and nothing in this design does better.
--
-- The read path falls out of the same key:
--     SELECT ... FROM ear_sessions WHERE user_id = ?1 ORDER BY started DESC
--      LIMIT ?2;
-- user_id is the leading column (equality seek) and `started` is the trailing
-- one (already ordered inside that user's slice), so this is a PURE REVERSE
-- INDEX SCAN over the primary key: no filesort, no temp b-tree, and exactly
-- `limit` rows read. worker/db.js listEarSessions() is that statement.
--
-- (recent_views has to filesort its slice because it orders by `viewed`, which
-- is NOT in the key. Here the ordering column IS the key's second column, so
-- this table gets the same 1-row-per-write floor AND avoids the sort. That is
-- luck of the access pattern, not cleverness: a session is identified by when
-- it started, and "when it started" is also the only order anyone wants it in.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ear_sessions (
  -- identity ------------------------------------------------------------------
  user_id      TEXT    NOT NULL,             -- user.id (Better Auth). No FK.
  started      INTEGER NOT NULL,             -- unix SECONDS, client clock,
                                             -- validated server-side; a
                                             -- duplicate is retried at +1s
                                             -- rather than overwritten
  -- what was practised (design Part I s13) -------------------------------------
  duration_sec INTEGER NOT NULL,             -- wall time of the session
  level        INTEGER NOT NULL,             -- 1..7, the level ladder (s3)
  mode         TEXT    NOT NULL,             -- 'identify' | 'produce'
  context      TEXT    NOT NULL,             -- 'cadence' | 'ii-V-I' | 'drone'
  taper        INTEGER NOT NULL,             -- re-establish the key every N
                                             -- questions; 0 = once per session
  sing_gate    INTEGER NOT NULL DEFAULT 0,   -- 0/1
  -- what happened --------------------------------------------------------------
  questions    INTEGER NOT NULL DEFAULT 0,
  correct      INTEGER NOT NULL DEFAULT 0,   -- accuracy = correct / questions,
                                             -- derived on read, never stored
  assists      INTEGER NOT NULL DEFAULT 0,   -- "Hear it again" uses (s4)
  cents_sum    INTEGER NOT NULL DEFAULT 0,   -- sum of |cents|, MIC TRIALS ONLY
  cents_n      INTEGER NOT NULL DEFAULT 0,   -- count of those trials, so the
                                             -- mean is a division and not a
                                             -- second stored number
  detail       TEXT    NOT NULL DEFAULT '',  -- compact JSON: per-degree
                                             -- {asked, correct} + confusions.
                                             -- OPAQUE — never parsed here.

  PRIMARY KEY (user_id, started),

  -- CHECKs are a BACKSTOP, not control flow (worker/routes.js house rule 2):
  -- every one of these is validated in learnCreateSessionRoute first, so a bad
  -- request is a 400 that costs 0 rows written. These exist so that a future
  -- route, a repair script, or a hand-typed `wrangler d1 execute` cannot leave a
  -- row that the /learn end screen would then render as nonsense.
  CHECK (user_id <> ''),
  CHECK (started > 0),
  CHECK (duration_sec BETWEEN 0 AND 86400),  -- 24 h. A session is time-boxed to
                                             -- 10-20 min; the real upper bound
                                             -- is 'endless' mode in a forgotten
                                             -- tab, and a day is past absurd.
  CHECK (level BETWEEN 1 AND 7),             -- the 7 rungs of the ladder
  CHECK (mode IN ('identify', 'produce')),
  CHECK (context IN ('cadence', 'ii-V-I', 'drone')),
  CHECK (taper IN (0, 1, 2, 4, 8)),          -- the setting's whole domain
  CHECK (sing_gate IN (0, 1)),
  CHECK (questions >= 0),
  CHECK (correct BETWEEN 0 AND questions),   -- you cannot be right more often
                                             -- than you were asked
  CHECK (assists >= 0),                      -- deliberately NOT bounded by
                                             -- questions: one trial may be
                                             -- replayed several times
  CHECK (cents_n BETWEEN 0 AND questions),   -- mic trials are a subset
  CHECK (cents_sum >= 0),                    -- it is a sum of ABSOLUTE cents
  CHECK (cents_sum <= cents_n * 1200),       -- and therefore a mean of at most
                                             -- an octave per trial; anything
                                             -- above that is a client bug, and
                                             -- it also forces cents_sum = 0
                                             -- when cents_n = 0
  -- THE ONLY UNBOUNDED COLUMN, so it is the only one that needs a length cap:
  -- everything else is a fixed-width integer or an enum. 2,000 characters is
  -- ~3x the most verbose plausible detail blob (12 degrees x {asked, correct}
  -- plus a confusion list is ~250 chars compact, ~600 spelled out), and it is
  -- mirrored as MAX_DETAIL_CHARS in worker/db.js — CHANGE BOTH. Without this a
  -- hand-written client could park megabytes per session in a table nothing
  -- prunes.
  CHECK (length(detail) <= 2000)
) WITHOUT ROWID;

-- NO SECONDARY INDEXES. NONE. This is stated as loudly as recent_views states
-- it, for the same reason and with the same finality:
--
--  * There is nothing left to index. The one query is
--    `WHERE user_id = ? ORDER BY started DESC LIMIT n`, and the PRIMARY KEY
--    serves it end to end (see the reverse-scan note above). An index that
--    duplicates the key is pure write amplification.
--  * NO index on `level`, `mode` or `context`. The obvious future feature —
--    "how am I doing at level 5?" — does NOT want one: worker/routes.js already
--    holds the caller's whole recent window (<=100 rows) in memory and can
--    bucket it in microseconds. Indexing any of them would add +1 row written
--    to EVERY insert to save a scan of rows we already fetched.
--  * NO index on `started` alone. Nothing queries across users; there is no
--    global "recent activity" feed and no cross-user leaderboard, deliberately
--    (design Part I s15 — this is a practice log, not a social product).
--  * NO aggregate columns and NO per-user totals row. Either would turn one
--    insert into two writes, and the aggregate the end screen wants is computed
--    from the rows it already has.
--
-- COROLLARY, stated because it is not obvious: nothing may query this table BY
-- started ALONE. `started` is the trailing column of the only b-tree, so
-- `WHERE started < ?` is a full table scan — precisely the trap that made
-- hardDeleteProject() stop touching recent_views (worker/db.js). If a retention
-- prune is ever wanted here, walk the PRIMARY KEY in cursor-resumed windows the
-- way worker/index.js pruneViews() does, and delete by (user_id, started) pair.
--
-- REVISIT THRESHOLD: none is expected. At one 10-minute session per user per
-- day this table gains ~365 rows per active user per year. The trigger to think
-- again is COUNT(*) FROM ear_sessions above 1,000,000, or a GET whose rows_read
-- (the `rr` field of the request log line) exceeds the limit it asked for —
-- which would mean the reverse scan stopped being a reverse scan.

-- ============================================================================
-- ROW-WRITTEN BUDGET (D1 Free: 100,000 rows written per DAY, ACCOUNT WIDE —
-- shared with everything migrations/0000_better_auth.sql and worker/schema.sql
-- already spend).
--
--   EVENT                                   STATEMENTS  ROWS WRITTEN
--   POST /api/learn/sessions                1 INSERT    1   the table IS the PK
--                                                           b-tree (WITHOUT
--                                                           ROWID) and there are
--                                                           no other indexes
--   ...same second, second browser tab      2-3 INSERT  1   the losing INSERTs
--                                                           fail on the PK and
--                                                           write NOTHING; the
--                                                           retry lands at
--                                                           started + 1
--   ...3 collisions in a row                3 INSERT    0   409 conflict
--   GET  /api/learn/sessions                1 SELECT    0   <= limit rows READ
--
-- THE CEILING, in the units that matter. worker/routes.js guardLearnRate()
-- allows 10/min and 60/hour per user; at 1 row per insert that is
--     60/hour x 24 = 1,440 rows/day = 1.4% of the 100,000/day account cap
-- for a single pathological client, and the same 1.4% is the figure the view
-- route's 60/hour ceiling produces (worker/routes.js). A REAL user writes one
-- row per practice session: 1-3 rows/day. The ceiling is set far above any
-- human rate because its job is to stop a stuck retry loop from eating
-- everybody else's save budget, not to pace a musician.
--
-- STORAGE. A row is 13 integers and enums plus `detail`: ~200 bytes typical,
-- ~2.2 KB at the CHECK cap. Ten active users at one session/day is ~1,300
-- rows/year, well under a megabyte — D1's 500 MB database cap is not the
-- constraint here and never will be. Rows WRITTEN is the binding constraint in
-- this app, and this table costs the minimum possible per event.
-- ============================================================================
