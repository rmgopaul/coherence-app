import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DASHBOARD_FILE = resolve(
  __dirname,
  "..",
  "..",
  "features",
  "solar-rec",
  "SolarRecDashboard.tsx"
);

const SCHEDULE_B_IMPORT_FILE = resolve(
  __dirname,
  "..",
  "components",
  "ScheduleBImport.tsx"
);

const dashboardSource = readFileSync(DASHBOARD_FILE, "utf8");
const scheduleBImportSource = readFileSync(SCHEDULE_B_IMPORT_FILE, "utf8");

function sliceFn(source: string, name: string): string | null {
  const declRegex = new RegExp(
    `const\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=\\s*(?:async|useCallback\\s*\\()`
  );
  const declMatch = declRegex.exec(source);
  if (!declMatch) return null;
  const arrowIdx = source.indexOf("=>", declMatch.index);
  if (arrowIdx === -1) return null;
  const openBrace = source.indexOf("{", arrowIdx);
  if (openBrace === -1) return null;
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(declMatch.index, i + 1);
    }
  }
  return null;
}

describe("Solar REC shared dataset invalidation", () => {
  it("central helper invalidates shared dataset consumers without hard-coding every upload to every aggregate", () => {
    const helper = sliceFn(dashboardSource, "invalidateSharedDatasetConsumers");
    expect(helper).not.toBeNull();

    for (const procedure of [
      "getDatasetSummariesAll",
      "getDatasetCloudStatuses",
      "getActiveDatasetVersions",
      "getSystemSnapshot",
      "getSystemSnapshotHash",
      "getTransferDeliveryLookup",
      "getDashboardDeliveryTrackerAggregates",
      "getDashboardContractVintageAggregates",
      "getDashboardPerformanceSourceRows",
      "getDashboardForecast",
    ]) {
      expect(helper!).toContain(`${procedure}.invalidate`);
    }
    expect(helper!).toContain("changedKey?: DatasetKey");
    expect(helper!).toContain("shouldRefreshSharedAggregates");
    expect(helper!).toContain("SHARED_DELIVERY_AGGREGATE_DATASET_KEYS.has(changedKey)");
    expect(helper!).toContain("if (shouldRefreshSharedAggregates)");
    expect(helper!).toContain('changedKey === "transferHistory"');
    expect(helper!).toContain("if (shouldRefreshTransferLookup)");
    expect(dashboardSource).toContain("SHARED_DELIVERY_AGGREGATE_DATASET_KEYS");
    for (const key of [
      "deliveryScheduleBase",
      "transferHistory",
      "annualProductionEstimates",
      "generationEntry",
      "accountSolarGeneration",
      "abpReport",
    ]) {
      expect(dashboardSource).toContain(`"${key}"`);
    }
  });

  it("v2 dataset upload success passes the changed dataset key to the central invalidation helper", () => {
    const start = dashboardSource.indexOf("<DatasetUploadV2Button\n");
    expect(start).toBeGreaterThan(-1);
    const block = dashboardSource.slice(start, start + 2500);
    expect(block).toMatch(
      /onSuccess=\{\(\)\s*=>\s*\{[\s\S]{0,1600}invalidateServerDerivedSolarData\(key\)/
    );
  });

  it("Schedule B apply paths notify the parent after server dataset changes", () => {
    expect(dashboardSource).toMatch(/onServerDataChanged=\{invalidateServerDerivedSolarData\}/);
    expect(scheduleBImportSource).toMatch(/onServerDataChanged\?:/);
    expect(scheduleBImportSource).toMatch(/notifyServerDataChanged\("auto-apply"\)/);
    expect(scheduleBImportSource).toMatch(
      /notifyServerDataChanged\("contract-id mapping"\)/
    );
    expect(scheduleBImportSource).toMatch(/notifyServerDataChanged\("manual apply"\)/);
    expect(scheduleBImportSource).toMatch(
      /notifyServerDataChanged\("manual CSV upload"\)/
    );
  });
});
