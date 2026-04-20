/**
 * One-shot migration runner for drizzle/0023_add_dock_items.sql.
 *
 * Mirrors applyKingOfDayMigration.ts — see that file's header for why
 * we bypass `pnpm db:push`. Idempotent: CREATE TABLE IF NOT EXISTS +
 * the post-failure swallow on duplicate-index keeps re-runs safe.
 *
 * Usage: pnpm tsx server/scripts/applyDockItemsMigration.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createConnection } from "mysql2/promise";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "drizzle/0023_add_dock_items.sql"
);

function splitSqlStatements(source: string): string[] {
  const stripped = source
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return stripped
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildConnectionOptions() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("DATABASE_URL must include a database name");

  const sslDisabled = ["false", "0", "off"].includes(
    (process.env.DATABASE_SSL ?? "").trim().toLowerCase()
  );
  const rejectUnauthorizedDisabled = ["false", "0", "off"].includes(
    (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? "").trim().toLowerCase()
  );

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database,
    multipleStatements: false,
    ...(sslDisabled
      ? {}
      : {
          ssl: {
            minVersion: "TLSv1.2",
            rejectUnauthorized: !rejectUnauthorizedDisabled,
          },
        }),
  };
}

async function main() {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new Error(`No statements parsed from ${MIGRATION_PATH}`);
  }

  console.log(`[migration] applying ${statements.length} statements from`);
  console.log(`            ${MIGRATION_PATH}`);

  const conn = await createConnection(buildConnectionOptions());
  try {
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const label = stmt.split("\n")[0].slice(0, 80);
      try {
        await conn.execute(stmt);
        console.log(`[migration] ✓  ${i + 1}/${statements.length}  ${label}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          /Duplicate key name|already exists/.test(msg) &&
          /^\s*CREATE (UNIQUE )?INDEX/i.test(stmt)
        ) {
          console.log(
            `[migration] ⤳  ${i + 1}/${statements.length}  ${label} (already exists — skipping)`
          );
          continue;
        }
        console.error(`[migration] ✗  ${i + 1}/${statements.length}  ${label}`);
        console.error(`            ${msg}`);
        throw err;
      }
    }
    console.log("[migration] done.");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("[migration] failed:", err);
  process.exit(1);
});
