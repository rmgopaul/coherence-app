# Database migration repair — 2026-04-10 finding

## Context

User's automated review found on 2026-04-10:

> **[High] Migration ledger is out of sync with actual DB state**
> DB says applied migrations stop at 0011, but repo journal expects through 0015.
> Missing in `__drizzle_migrations`: 0012, 0013, 0014, 0015.
> Also confirmed partial drift:
> - `productionReadings` table (from 0012) is missing.
> - `supplementPriceLogs` table (from 0014) is missing.
> - `integrations.metadata` is still `text` (not `mediumtext` from 0013).

## Why this is dangerous

- **Future `drizzle-kit push` can behave unpredictably**. With the ledger
  reporting 0011 as the last applied migration, a fresh push will try to
  apply 0012-0015 from scratch. Some of them may succeed (0013 is an
  idempotent `ALTER`, 0015 creates tables that don't exist) but others
  may fail partway (0014 creates `supplementPriceLogs` which does not
  exist yet, fine; 0012 creates `productionReadings` which also does not
  exist yet, fine).
- **BUT** the `monitoringApiRuns` table was created by 0015 AND already
  exists in production (verified by `drizzle/schema.ts` referencing it
  and the server code using it). So 0015 was *partially* applied outside
  the migration ledger — someone ran the `CREATE TABLE monitoringApiRuns`
  manually or the `db.execute(sql`CREATE TABLE IF NOT EXISTS ...`)`
  path in `ensureScheduleBImportTables`-style runtime DDL created it.
- The mismatch between the ledger and the actual DB means `drizzle-kit`
  cannot be trusted to apply migrations correctly.

## What each migration does

| Migration | Contents | Current DB status |
|---|---|---|
| `0012_volatile_boomerang.sql` | `CREATE TABLE productionReadings` + 3 indexes | **Missing** per user's finding |
| `0013_jittery_viper.sql` | `ALTER TABLE integrations MODIFY COLUMN metadata mediumtext` | **Not applied** per user's finding — still `text` |
| `0014_curly_lockjaw.sql` | `CREATE TABLE supplementPriceLogs` + indexes | **Missing** per user's finding |
| `0015_useful_blonde_phantom.sql` | `CREATE TABLE monitoringApiRuns, monitoringBatchRuns, monitoringEventLog` + indexes | **Partially present** (user's finding says monitoringApiRuns exists but the ledger has no entry for 0015) |

## Additional change needed (2026-04-10)

A follow-up in the same session (this commit) changes the
`monitoringApiRuns` unique key from `(provider, siteId, dateKey)` to
`(provider, connectionId, siteId, dateKey)`. That's a **new** migration
that hasn't been generated yet (`0016_*.sql`). It will need to:

1. `DROP INDEX monitoring_api_runs_provider_site_date_idx ON monitoringApiRuns`
2. `CREATE UNIQUE INDEX monitoring_api_runs_provider_conn_site_date_idx
    ON monitoringApiRuns (provider, connectionId, siteId, dateKey)`

Before step 1 runs in production, verify there are no duplicate rows
under the new key — otherwise the unique index creation will fail.

## Safe repair sequence

**Do NOT run any of this in production without a DB snapshot first.**

### Phase 1: Take a backup

```sql
-- In TiDB or MySQL client:
-- 1. Dump the whole DB
mysqldump -h <host> -u <user> -p <dbname> > backup-before-repair-$(date +%Y%m%d).sql
-- OR use TiDB Cloud's point-in-time snapshot feature.
```

### Phase 2: Reconcile the migration ledger with actual state

For EACH of 0012, 0013, 0014, 0015, check what exists in the DB before
re-recording the migration:

```sql
-- 0012: productionReadings
SHOW TABLES LIKE 'productionReadings';
-- If row count is 0, run the SQL from drizzle/0012_volatile_boomerang.sql manually.
-- If row count is 1, skip to just recording the ledger entry.

-- 0013: integrations.metadata column type
SELECT DATA_TYPE
FROM information_schema.COLUMNS
WHERE table_schema = DATABASE()
  AND table_name = 'integrations'
  AND column_name = 'metadata';
-- If 'text', run:  ALTER TABLE integrations MODIFY COLUMN metadata mediumtext;
-- If 'mediumtext', skip to recording ledger.

-- 0014: supplementPriceLogs
SHOW TABLES LIKE 'supplementPriceLogs';
-- If missing, run drizzle/0014_curly_lockjaw.sql.

-- 0015: monitoringApiRuns + monitoringBatchRuns + monitoringEventLog
SHOW TABLES LIKE 'monitoringApiRuns';
SHOW TABLES LIKE 'monitoringBatchRuns';
SHOW TABLES LIKE 'monitoringEventLog';
-- If any are missing, run drizzle/0015_useful_blonde_phantom.sql incrementally
-- (skip any CREATE TABLE for tables that already exist).
```

### Phase 3: Record the migrations as applied

Each successful phase 2 step should end with a ledger update:

```sql
-- Check the current ledger first:
SELECT * FROM `__drizzle_migrations` ORDER BY id DESC LIMIT 10;

-- For each applied migration, insert a row. The `hash` column must match
-- what drizzle-kit computes. The easiest way to get the right hash is to
-- run `drizzle-kit migrate` LOCALLY against a fresh copy of production,
-- then read back the `__drizzle_migrations` entries it inserted.
-- Copy those hash values here and run:

INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES
  ('<hash_for_0012>', <unix_ms_from_journal_when>),
  ('<hash_for_0013>', <unix_ms_from_journal_when>),
  ('<hash_for_0014>', <unix_ms_from_journal_when>),
  ('<hash_for_0015>', <unix_ms_from_journal_when>);
```

The `when` values come from `drizzle/meta/_journal.json` (entries
`idx: 12` through `idx: 15`, `when` field).

### Phase 4: Generate 0016 for the monitoring uniqueness change

```bash
cd productivity-hub
pnpm drizzle-kit generate
# Review the generated 0016_*.sql before applying.
```

### Phase 5: Apply 0016 safely

Before applying the new unique index, scan for duplicates:

```sql
SELECT provider, connectionId, siteId, dateKey, COUNT(*) AS dup_count
FROM monitoringApiRuns
GROUP BY provider, connectionId, siteId, dateKey
HAVING COUNT(*) > 1;
```

If `dup_count > 1` rows exist, deduplicate by keeping the most recent
row per group BEFORE dropping the old unique index:

```sql
-- Deduplication query: keep row with max triggeredAt per key group
DELETE m FROM monitoringApiRuns m
INNER JOIN (
  SELECT MIN(id) as keep_id, provider, siteId, dateKey
  FROM monitoringApiRuns
  GROUP BY provider, siteId, dateKey
  HAVING COUNT(*) > 1
) keep ON keep.provider = m.provider
      AND keep.siteId = m.siteId
      AND keep.dateKey = m.dateKey
      AND m.id != keep.keep_id;
```

Then apply 0016.

## Rollback checkpoints

- **After Phase 1**: backup file exists. If anything in Phase 2-5 fails,
  restore from the backup.
- **After Phase 2** (each step is idempotent): if the DDL errors, stop
  and investigate. Do NOT record the migration in the ledger until the
  DDL succeeds.
- **After Phase 3**: drizzle-kit will now consider 0012-0015 applied. If
  phase 4/5 fails, you can DELETE those rows from `__drizzle_migrations`
  to revert the ledger and retry.

## Long-term prevention

- **Never run DDL directly against production.** Use `drizzle-kit push`
  or the migration runner exclusively.
- **If a runtime code path auto-creates tables** (like
  `ensureScheduleBImportTables` does for Schedule B), that path should
  also record a synthetic migration entry in `__drizzle_migrations` so
  the ledger stays honest.
- **Add a startup check**: on every server boot, compare the ledger to
  the actual DB schema and log a warning if they diverge.
