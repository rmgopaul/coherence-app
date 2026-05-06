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

function sliceTopLevelFunction(name: string): string | null {
  const start = source.indexOf(`function ${name}`);
  const asyncStart = source.indexOf(`async function ${name}`);
  const actualStart =
    start === -1 ? asyncStart : asyncStart === -1 ? start : Math.min(start, asyncStart);
  if (actualStart === -1) return null;
  const nextFunction = /\n(?:async\s+)?function\s+[A-Za-z0-9_]+\(/g;
  nextFunction.lastIndex = actualStart + 1;
  const next = nextFunction.exec(source);
  const routerStart = source.indexOf("\nexport const solarRecDashboardRouter", actualStart);
  const endCandidates = [next?.index, routerStart].filter(
    (value): value is number => typeof value === "number" && value > actualStart
  );
  return source.slice(actualStart, Math.min(...endCandidates));
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

  it("Schedule B apply reads delivered history from the canonical transferHistory row table", () => {
    const proc = sliceProcedure("applyScheduleBToDeliveryObligations");
    expect(proc).not.toBeNull();
    expect(proc!).toContain("buildTransferDeliveryLookupForScope");
    expect(proc!).toContain("reviveTransferDeliveryLookup");
    expect(proc!).toContain("buildTransferDeliveryLookupForScope(ctx.scopeId)");
    expect(proc!).not.toContain('loadDatasetPayloadByKey("transferHistory")');
    expect(proc!).not.toContain("parseRemoteCsvDataset(transferHistoryPayload)");
  });

  it("canonical deliveryScheduleBase loads reject partial row-table drift", () => {
    const helper = sliceTopLevelFunction("loadCanonicalDeliveryScheduleBaseDataset");
    expect(helper).not.toBeNull();
    expect(helper!).toContain("expectedRows !== rows.length");
    expect(helper!).toContain("persist the partial set forward");
    expect(helper!).not.toContain("rows.length === 0");
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
    expect(proc!).toContain("const mappingTextSaved = await saveSolarRecDashboardPayload");
    expect(proc!).toContain("Failed to save the Schedule B contract-ID mapping");
    expect(proc!).toContain("mappingText: input.mappingText");
  });

  it("dataset summaries include server-managed Converted Reads sources", () => {
    const proc = sliceProcedure("getDatasetSummariesAll");
    expect(proc).not.toBeNull();
    expect(proc!).toContain("summarizeServerManagedConvertedReadsSources");
    expect(proc!).toContain('getSolarRecDashboardPayload(ownerUserId, "dataset:convertedReads")');
    expect(proc!).toContain("uploadSourcesByDataset.set(");
    expect(proc!).toContain('"convertedReads",');
  });

  it("exposes a safe cloud-to-row-table backfill path for storage-only production state", () => {
    const proc = sliceProcedure("backfillDeliveryScheduleBaseFromCloud");
    expect(proc).not.toBeNull();
    expect(proc!).toContain("loadDeliveryScheduleBaseFromStorage");
    expect(proc!).toContain("persistDeliveryScheduleBaseCanonical");
    expect(proc!).toContain("active-batch-exists");

    const loader = sliceTopLevelFunction("loadDeliveryScheduleBaseFromStorage");
    expect(loader).not.toBeNull();
    expect(loader!).toContain("loadDashboardPayload");
    expect(loader!).toContain("legacyStoragePath");
  });
});
