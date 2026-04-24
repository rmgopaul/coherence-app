/**
 * Cross-import lint per docs/architectural-split.md.
 *
 * Personal-side code (main `/` router, personal db modules, personal
 * services) must not import from solar-rec surface. Keeps future
 * features on the right side of the split so Phase 5's migration
 * doesn't keep growing.
 *
 * This is a vitest test rather than an ESLint rule because the repo
 * has no ESLint config and wiring one up is out of scope; a test runs
 * in CI via `pnpm test` today.
 *
 * To seed a violation and verify the lint fires, add a forbidden
 * import to any file in `PERSONAL_ROUTER_FILES` and re-run vitest.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Files that serve the personal main (`/`) router. Adding new files
 * here locks them into the personal side.
 */
const PERSONAL_ROUTER_FILES = [
  "server/routers/auth.ts",
  "server/routers/kingOfDay.ts",
  "server/routers/news.ts",
  "server/routers/personalData.ts",
  "server/routers/productivity.ts",
  "server/routers/weather.ts",
  "server/routers/helpers.ts",
  "server/routers/helpers/constants.ts",
  "server/routers/helpers/providerMetadata.ts",
  "server/routers/helpers/supplements.ts",
  "server/routers/helpers/utils.ts",
  // NOTE: server/routers/helpers/providerContexts.ts is intentionally
  // omitted — it manages solar vendor OAuth contexts and is therefore
  // solar-rec surface, due to relocate in Phase 5 Task 5.4 alongside
  // the meter-read migration.
];

/**
 * Import patterns that personal-side code must not use. These are
 * all solar-rec surface: vendor services, the dedicated solar db
 * modules, and the solar scheduler.
 *
 * NOTE: `server/routers.ts` (the top-level appRouter composition)
 * and `server/routers/solarRecDashboard.ts` are intentionally absent
 * from PERSONAL_ROUTER_FILES because they carry solar-rec features
 * today pending Phase 5 migration. See docs/architectural-split.md
 * for the per-task schedule.
 */
const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from\s+["']\.\.\/(?:\.\.\/)?db\/monitoring["']/,
  /from\s+["']\.\.\/(?:\.\.\/)?db\/solarRec/,
  /from\s+["']\.\.\/(?:\.\.\/)?db\/scheduleB["']/,
  /from\s+["']\.\.\/(?:\.\.\/)?db\/contractScans["']/,
  /from\s+["']\.\.\/(?:\.\.\/)?db\/dinScrapes["']/,
  /from\s+["']\.\.\/(?:\.\.\/)?services\/solar\//,
  /from\s+["']\.\.\/(?:\.\.\/)?solar\//,
];

describe("cross-import lint", () => {
  it("personal-side router files do not import from solar-rec surface", () => {
    const violations: string[] = [];

    for (const relPath of PERSONAL_ROUTER_FILES) {
      const full = join(REPO_ROOT, relPath);
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch (error) {
        violations.push(
          `Could not read ${relPath} — has the file moved? Update PERSONAL_ROUTER_FILES. (${
            (error as Error).message
          })`,
        );
        continue;
      }

      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          violations.push(
            `${relPath} has forbidden solar-rec import: ${match[0]}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
