/**
 * 2026-05-08 (Phase H wrap-up) — pin the contract for `saveState`'s
 * tightened validation and the new `cleanupLegacyStatePayload` admin
 * proc. Source-text tests so we don't need to spin up tRPC + DB
 * harnesses just to assert a `.max()` literal and a permission tier.
 *
 * The wrap-up moves three contract guarantees:
 *   - `saveState.payload` is capped at 64 KB (down from the H-0
 *     interim 50 MB; reflects the heartbeat-only writes the client
 *     actually emits after Phase 5e PR-D).
 *   - `saveState.payload` rejects payloads carrying the legacy
 *     `datasetManifest` key (rogue/older clients).
 *   - `cleanupLegacyStatePayload` is admin-tier and overwrites a
 *     legacy blob with the heartbeat shape, idempotent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTER_FILE = resolve(__dirname, "solarRecDashboardRouter.ts");
const source = readFileSync(ROUTER_FILE, "utf8");

function sliceProcedure(name: string): string | null {
  const start = source.indexOf(`${name}: dashboardProcedure`);
  if (start === -1) return null;
  const nextProcedure = /\n  [A-Za-z0-9_]+: dashboardProcedure/g;
  nextProcedure.lastIndex = start + 1;
  const next = nextProcedure.exec(source);
  return source.slice(start, next?.index ?? source.length);
}

describe("saveState — Phase H wrap-up validation contract", () => {
  it("caps payload at 64 KB (down from the H-0 interim 50 MB)", () => {
    const proc = sliceProcedure("saveState");
    expect(proc).not.toBeNull();
    // 64 KB — the post-cleanup heartbeat is 12 bytes; this gives ample
    // headroom for a future small typed-slice payload while keeping the
    // wire bound tight.
    expect(proc!).toContain("z.string().max(64_000)");
    // The pre-wrap-up 50 MB cap is gone — if any future PR re-introduces
    // a number that big without an inline rationale, the regression
    // test below should catch it.
    expect(proc!).not.toContain("max(50_000_000)");
  });

  it("rejects payloads carrying the legacy datasetManifest key", () => {
    const proc = sliceProcedure("saveState");
    expect(proc).not.toBeNull();
    // The structural check uses superRefine + `"datasetManifest" in
    // parsed`. Pin both; a future refactor that swaps to .refine() or
    // drops the structural gate breaks this assertion.
    expect(proc!).toMatch(/superRefine\(/);
    expect(proc!).toContain('"datasetManifest" in');
    expect(proc!).toMatch(/legacy datasetManifest key/);
  });

  it("uses the dashboard 'edit' permission tier (unchanged)", () => {
    const proc = sliceProcedure("saveState");
    expect(proc).not.toBeNull();
    expect(proc!).toContain(
      'dashboardProcedure("solar-rec-dashboard", "edit")'
    );
  });
});

describe("cleanupLegacyStatePayload — Phase H wrap-up cleanup contract", () => {
  it("is registered as an admin-only mutation", () => {
    const proc = sliceProcedure("cleanupLegacyStatePayload");
    expect(proc).not.toBeNull();
    expect(proc!).toContain(
      'dashboardProcedure(\n    "solar-rec-dashboard",\n    "admin"\n  ).mutation('
    );
  });

  it("rewrites only when the payload carries the legacy datasetManifest key (idempotent)", () => {
    const proc = sliceProcedure("cleanupLegacyStatePayload");
    expect(proc).not.toBeNull();
    // Three early-return branches: no payload, non-JSON, already
    // clean. Only the fourth path actually rewrites. Pin all four so
    // a future refactor that flattens the logic still preserves the
    // idempotency guarantee.
    expect(proc!).toMatch(/no-existing-payload/);
    expect(proc!).toMatch(/non-json-existing/);
    expect(proc!).toMatch(/already-clean/);
    expect(proc!).toMatch(/rewrote-legacy-manifest/);
  });

  it("writes the canonical heartbeat payload to BOTH DB and S3", () => {
    const proc = sliceProcedure("cleanupLegacyStatePayload");
    expect(proc).not.toBeNull();
    expect(proc!).toContain('const heartbeat = \'{"logs":[]}\'');
    // DB write — the canonical surface that getState reads first.
    expect(proc!).toContain("saveSolarRecDashboardPayload(");
    // S3 write — defense in depth so a future DB-row prune cannot
    // resurrect the legacy datasetManifest via the
    // storage-fallback path (`loadDashboardPayload` reads DB, falls
    // back to S3). Pin the storagePut call so a future refactor
    // that drops the second-tier write breaks loud.
    expect(proc!).toContain('storagePut(key, heartbeat, "application/json")');
  });

  it("does NOT fail the cleanup when the S3 write throws", () => {
    const proc = sliceProcedure("cleanupLegacyStatePayload");
    expect(proc).not.toBeNull();
    // The S3 write is best-effort; the DB row is canonical. A
    // failed storagePut should log + return storageSynced:false,
    // not throw — otherwise an S3 outage breaks the only mitigation
    // for the legacy blob. Pin the try/catch around the storagePut
    // so this property holds across future edits.
    expect(proc!).toMatch(/try\s*\{[\s\S]*?await storagePut\(/);
    expect(proc!).toMatch(/catch \(storageError\)/);
    expect(proc!).toContain("storageSynced");
  });

  it("logs every rewrite via [dashboard:state-payload-cleanup] including storageSynced", () => {
    const proc = sliceProcedure("cleanupLegacyStatePayload");
    expect(proc).not.toBeNull();
    expect(proc!).toContain("[dashboard:state-payload-cleanup]");
    expect(proc!).toMatch(/priorBytes:\s*existing\.length/);
    expect(proc!).toMatch(/nextBytes:\s*heartbeat\.length/);
    // The S3 sync flag is part of the audit trail for the
    // post-cleanup state.
    expect(proc!).toMatch(/storageSynced/);
  });
});
