/**
 * DoD lock for Task 4.4: nothing outside shared/dateKey.ts should
 * manually format a YYYY-MM-DD date key. Catches the inline
 * `${y}-${m}-${d}` and multi-line `const y = d.getFullYear(); …`
 * patterns that used to proliferate across 30+ files.
 *
 * To verify the lint fires, add
 *   return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
 * to any source file and re-run vitest.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..");

const SCAN_ROOTS = ["server", "client/src", "shared"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "drizzle",
  "__snapshots__",
]);

function collectSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (absDir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = join(absDir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!(entry.endsWith(".ts") || entry.endsWith(".tsx"))) continue;
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
      out.push(abs.replace(`${REPO_ROOT}/`, ""));
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

/** Files that are allowed to contain the pattern. */
const ALLOWED_FILES = new Set([
  "shared/dateKey.ts",
  "server/_lint/noManualDateKey.test.ts", // this file
]);

/**
 * Inline template literal with all three parts on one line:
 *   `${year}-${String(…getMonth…).padStart(2, "0")}-${String(…getDate…).padStart(2, "0")}`
 */
const INLINE_PATTERN =
  /\$\{[^}]*get(?:UTC)?FullYear[^}]*\}-\$\{[^}]*get(?:UTC)?Month[^}]*\}-\$\{[^}]*get(?:UTC)?Date[^}]*\}/;

/**
 * Multi-line constant-then-return pattern:
 *   const y = d.getFullYear();
 *   const m = String(d.getMonth() + 1).padStart(2, "0");
 *   const d = String(d.getDate()).padStart(2, "0");
 *   return `${y}-${m}-${d}`;
 *
 * Detected by the signature sequence of `getMonth` padStart followed
 * shortly by `getDate` padStart on a subsequent line.
 */
const MULTILINE_PATTERN =
  /get(?:UTC)?Month\(\)\s*\+\s*1\)\.padStart\(2,\s*"0"\)[\s\S]{0,200}get(?:UTC)?Date\(\)\)\.padStart\(2,\s*"0"\)[\s\S]{0,200}\$\{[^}]+\}-\$\{[^}]+\}-\$\{[^}]+\}/;

describe("no manual YYYY-MM-DD formatting outside shared/dateKey.ts", () => {
  it("scanned source files contain no inline dateKey templates", () => {
    const files = collectSourceFiles();

    const violations: string[] = [];
    for (const rel of files) {
      if (ALLOWED_FILES.has(rel)) continue;
      const content = readFileSync(join(REPO_ROOT, rel), "utf8");
      if (INLINE_PATTERN.test(content)) {
        violations.push(
          `${rel}: inline YYYY-MM-DD template found. Use toDateKey / formatTodayKey / formatDateInput from @shared/dateKey.`,
        );
      }
      if (MULTILINE_PATTERN.test(content)) {
        violations.push(
          `${rel}: multi-line YYYY-MM-DD formatter found. Use toDateKey / formatTodayKey / formatDateInput from @shared/dateKey.`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});
