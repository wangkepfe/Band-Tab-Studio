# migrations/ — D1 schema for the Studio cloud Worker

The D1 database is named **`studio`** and is bound to the Worker as **`env.DB`**
(`wrangler.jsonc` → `d1_databases[0]`). Wrangler looks for migrations in
`./migrations` by default, which is this folder, so no `migrations_dir` setting
is needed.

Everything below is run from the repo root (`E:\tab-creator`), where
`wrangler.jsonc` lives. All examples use `npx wrangler`; wrangler 4.122.0 is a
devDependency of the root `package.json`, so no global install is required.

---

## The two files, and the order they MUST be applied in

| # | File | Owns | How it is applied |
|---|------|------|-------------------|
| 0000 | `migrations/0000_better_auth.sql` | `user`, `session`, `account`, `verification` | `wrangler d1 migrations apply` |
| 0001 | `worker/schema.sql` | `projects`, `recent_views`, `app_meta` | `wrangler d1 execute --file=` |

**0000 first. This is a hard dependency, not a convention.** `worker/db.js:252`
builds every library read as

```sql
FROM projects p LEFT JOIN "user" u ON u.id = p.owner_id
```

so applying `worker/schema.sql` to a database without `user` leaves every list
and read query failing with `no such table: user`.

Independently of that: `worker/index.js` runs `assertAuthSchema(env)`
(`worker/auth.js:463`) in front of **every** request, and that probe throws
`500 auth_schema_missing` until 0000 has been applied. A deployed Worker with no
0000 answers 100% of `/api/*` with a 500 — no sign-in, no library, nothing.

Both files are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
EXISTS`, `INSERT OR REPLACE`), so re-applying either one is a no-op rather than
an error. Verified by applying each twice against a local D1.

`worker/schema.sql` is *not* in this folder because it is the Worker module's
own file and is referenced by that path from its header comment and from the
release scripts. If it is ever moved here as `0001_studio.sql`, wrangler will
enforce the ordering for you — and re-applying it on a database where it was
already run via `d1 execute` is safe, for the idempotency reason above.

---

## Fresh database — full sequence

### Local (`.wrangler/state`, no network, no Cloudflare account needed)

```bash
npx wrangler d1 migrations apply studio --local
npx wrangler d1 execute studio --local --file=worker/schema.sql
```

### Remote (the real database behind https://band-tab-studio.wangkepfe.workers.dev)

```bash
npx wrangler d1 migrations apply studio --remote
npx wrangler d1 execute studio --remote --file=worker/schema.sql
```

`--remote` needs credentials: either an interactive `npx wrangler login`, or
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` in the environment.

Apply the remote pair **before** `npx wrangler deploy`, or at minimum before
sending traffic — see the `assertAuthSchema` note above. The probe caches its
result per isolate but clears the cache on failure (`worker/auth.js:479`), so a
Worker that 500s because the migration was late recovers on the next request
once it lands; no redeploy is required.

Seeding the six committed projects (`tools/seed-d1.js`, `POST /api/admin/import`)
runs **after** both files, and after the admin has signed in once — it needs a
`user` row to own the imported projects.

### Which migrations are pending?

```bash
npx wrangler d1 migrations list studio --local
npx wrangler d1 migrations list studio --remote
```

Applied migrations are recorded in the `d1_migrations` table, per database.
Local and remote track this separately.

---

## Applying 0000 without the migrations bookkeeping

`d1 migrations apply` is preferred because it records what ran. If you need to
run the file directly — repairing a database whose `d1_migrations` row exists
but whose tables do not, for instance — this is equivalent and safe to repeat:

```bash
npx wrangler d1 execute studio --local  --file=migrations/0000_better_auth.sql
npx wrangler d1 execute studio --remote --file=migrations/0000_better_auth.sql
```

---

## Verifying an applied database

These four statements are exactly the probes `assertAuthSchema()` runs
(`worker/auth.js:454-459`). If all four return an empty result set instead of an
error, the Worker will boot:

```bash
npx wrangler d1 execute studio --local --command "SELECT id, name, image, email, role, github_id FROM user LIMIT 0; SELECT id, user_id, account_id, provider_id FROM account LIMIT 0; SELECT id, user_id, token, expires_at FROM session LIMIT 0; SELECT id, identifier, value, expires_at FROM verification LIMIT 0;"
```

To confirm the Studio side too (`worker/db.js` `assertSchema()`), the join that
every library read depends on:

```bash
npx wrangler d1 execute studio --local --command "SELECT p.id, u.name AS owner_name FROM projects p LEFT JOIN \"user\" u ON u.id = p.owner_id LIMIT 1;"
```

Full object inventory after both files — our 7 tables and 6 explicit indexes,
plus wrangler's own `d1_migrations` and D1's internal `_cf_METADATA`:

```bash
npx wrangler d1 execute studio --local --command "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY tbl_name, type, name;"
```

| Table | Explicit indexes | Implicit (from UNIQUE / PK) |
|-------|------------------|-----------------------------|
| `user` | — | PK `id`, UNIQUE `email` |
| `session` | `idx_session_user` | PK `id`, UNIQUE `token` ← the session-by-token lookup |
| `account` | `idx_account_user`, `idx_account_provider` | PK `id` |
| `verification` | `idx_verification_identifier` | PK `id` |
| `projects` | `idx_projects_recent`, `uq_projects_owner_key` | PK `id` |
| `recent_views` | — (WITHOUT ROWID, PK is the table) | — |
| `app_meta` | — (WITHOUT ROWID) | — |

Every index costs +1 row written whenever a write touches its columns, against
D1 Free's 100,000 rows/day. The per-index justification and the full write
budget are in the comments of the two SQL files; do not add indexes without
reading them.

---

## The one thing `IF NOT EXISTS` cannot fix

If a `user` table already exists but was created **without** the two
`additionalFields` columns — e.g. by an earlier `@better-auth/cli`-generated
schema — `CREATE TABLE IF NOT EXISTS` silently skips it and the columns stay
missing. The symptom is `assertAuthSchema` failing on its first probe, or (if
only `role` is absent) every user being stuck at role `user` with no visible
error. SQLite has no `ADD COLUMN IF NOT EXISTS`, so this cannot be expressed
idempotently in the migration. Repair it by hand:

```bash
npx wrangler d1 execute studio --remote --command "ALTER TABLE user ADD COLUMN role TEXT NOT NULL DEFAULT 'user';"
npx wrangler d1 execute studio --remote --command "ALTER TABLE user ADD COLUMN github_id TEXT;"
```

Then backfill the admin (GitHub numeric id `21693187`, R5) from the account row
that already carries it:

```bash
npx wrangler d1 execute studio --remote --command "UPDATE user SET github_id = (SELECT account_id FROM account WHERE account.user_id = user.id AND provider_id = 'github') WHERE github_id IS NULL;"
npx wrangler d1 execute studio --remote --command "UPDATE user SET role = 'admin' WHERE github_id = '21693187';"
```

Admin status does not actually depend on that backfill —
`worker/auth.js:505 resolveGithubId()` reads `account.account_id` directly when
a session carries no `github_id` — but every *other* role assignment does.

---

## Recovery

D1 Time Travel keeps 7 days of history on the Free plan and is the escape hatch
for a bad migration or an admin hard-delete:

```bash
npx wrangler d1 time-travel info studio
npx wrangler d1 time-travel restore studio --timestamp=<unix-seconds-or-ISO>
```
