/**
 * One-off utility: mark a drizzle migration as already-applied in the
 * `__drizzle_migrations` table without running its SQL.
 *
 * Use case: a migration's DDL was applied to the database by some
 * out-of-band path (manual ops, a different tool, a prior version of
 * drizzle-kit that committed differently), but the corresponding row
 * in `__drizzle_migrations` never got written. Subsequent runs of
 * `drizzle-kit migrate` then try to re-apply the DDL and fail with
 * "Duplicate key name" / "Table already exists".
 *
 * Drizzle's migrator skip-check (mysql-core/dialect.js) compares the
 * latest `__drizzle_migrations.created_at` vs each migration's
 * `folderMillis` (the `when` field in `drizzle/meta/_journal.json`).
 * Inserting a marker row with `created_at >= folderMillis` causes
 * drizzle to skip that migration (and every earlier one) on the
 * next run.
 *
 * Usage:
 *   tsx server/scripts/markMigrationApplied.ts <tag>
 *   tsx server/scripts/markMigrationApplied.ts 0019_add_computed_artifacts
 *
 * The script looks up the `when` timestamp from the journal so you
 * don't have to pass it. Idempotent — running twice just inserts a
 * second marker row, which is harmless.
 */
import { readFileSync } from "node:fs";
import { createConnection } from "mysql2/promise";
import "dotenv/config";

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

function parseArgs(argv: string[]): { tag: string } {
  const tag = argv[0]?.trim();
  if (!tag) {
    console.error(
      "usage: tsx server/scripts/markMigrationApplied.ts <tag>\n" +
        '  e.g. "0019_add_computed_artifacts"'
    );
    process.exit(2);
  }
  return { tag };
}

function findMigrationMillis(tag: string): number {
  const raw = readFileSync("drizzle/meta/_journal.json", "utf8");
  const journal = JSON.parse(raw) as { entries: JournalEntry[] };
  const entry = journal.entries.find((e) => e.tag === tag);
  if (!entry) {
    console.error(
      `Tag "${tag}" not found in drizzle/meta/_journal.json.\n` +
        `Available tags: ${journal.entries.map((e) => e.tag).join(", ")}`
    );
    process.exit(1);
  }
  return entry.when;
}

async function main() {
  const { tag } = parseArgs(process.argv.slice(2));
  const folderMillis = findMigrationMillis(tag);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set in the environment.");
  const parsed = new URL(url);

  const sslEnabled = !["false", "0", "off"].includes(
    (process.env.DATABASE_SSL ?? "").trim().toLowerCase()
  );
  const sslRejectUnauthorized = !["false", "0", "off"].includes(
    (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? "").trim().toLowerCase()
  );

  const conn = await createConnection({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined,
    database: parsed.pathname.replace(/^\//, ""),
    ...(sslEnabled
      ? {
          ssl: {
            minVersion: "TLSv1.2",
            rejectUnauthorized: sslRejectUnauthorized,
          },
        }
      : {}),
  });

  try {
    await conn.query(
      "CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (`id` serial primary key, `hash` text not null, `created_at` bigint)"
    );
    await conn.query(
      "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
      [`manual-marker-${tag}`, folderMillis]
    );
    console.log(
      `Marked migration "${tag}" applied (created_at=${folderMillis}).`
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
