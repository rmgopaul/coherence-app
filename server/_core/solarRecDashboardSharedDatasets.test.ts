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

describe("solarRecDashboard shared dataset write paths", () => {
  it("Schedule B apply activates deliveryScheduleBase through the canonical row-table writer", () => {
    const proc = sliceProcedure("applyScheduleBToDeliveryObligations");
    expect(proc).not.toBeNull();
    expect(proc!).toContain("loadCanonicalDeliveryScheduleBaseDataset");
    expect(proc!).toContain("persistDeliveryScheduleBaseCanonical");
    expect(proc!).toContain("batchId: persistence.batchId");
    expect(proc!).toContain("_runnerVersion: persistence._runnerVersion");
  });

  it("manual delivery schedule CSV fallback writes the active row-table batch", () => {
    const proc = sliceProcedure("uploadDeliveryScheduleCsv");
    expect(proc).not.toBeNull();
    expect(proc!).toContain("loadCanonicalDeliveryScheduleBaseDataset");
    expect(proc!).toContain("persistDeliveryScheduleBaseCanonical");
    expect(proc!).toContain("batchId: persistence.batchId");
  });

  it("contract-ID mapping patches the canonical deliveryScheduleBase batch", () => {
    const proc = sliceProcedure("applyScheduleBContractIdMapping");
    expect(proc).not.toBeNull();
    expect(proc!).toContain("loadCanonicalDeliveryScheduleBaseDataset");
    expect(proc!).toContain("persistDeliveryScheduleBaseCanonical");
    expect(proc!).toContain("rowTableStatus: persistence.rowTableStatus");
  });

  it("exposes a safe cloud-to-row-table backfill path for storage-only production state", () => {
    const proc = sliceProcedure("backfillDeliveryScheduleBaseFromCloud");
    expect(proc).not.toBeNull();
    expect(proc!).toContain("loadDeliveryScheduleBaseDataset");
    expect(proc!).toContain("persistDeliveryScheduleBaseCanonical");
    expect(proc!).toContain("active-batch-exists");
  });
});
