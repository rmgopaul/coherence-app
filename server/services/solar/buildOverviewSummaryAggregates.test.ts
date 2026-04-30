import { describe, expect, it } from "vitest";
import {
  buildOverviewSummary,
  extractSnapshotSystemsForSummary,
  type SnapshotSystemForSummary,
} from "./buildOverviewSummaryAggregates";

type CsvRow = Record<string, string | undefined>;

function abpRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP-1",
    system_id: "SYS-1",
    PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON100",
    tracking_system_ref_id: "",
    Project_Name: "Acme Solar",
    system_name: "",
    Part_2_App_Verification_Date: "2025-03-15",
    ...overrides,
  };
}

function system(overrides: Partial<SnapshotSystemForSummary> = {}): SnapshotSystemForSummary {
  return {
    key: "sys-1",
    systemId: "SYS-1",
    stateApplicationRefId: "APP-1",
    trackingSystemRefId: "NON100",
    systemName: "Acme Solar",
    sizeBucket: ">10 kW AC",
    isReporting: true,
    isTransferred: false,
    isTerminated: false,
    ownershipStatus: "Not Transferred and Reporting",
    contractType: "Standard",
    contractStatusText: "Active",
    latestReportingDate: new Date("2026-04-01"),
    contractedDate: new Date("2024-01-01"),
    zillowStatus: null,
    zillowSoldDate: null,
    totalContractAmount: 100_000,
    contractedValue: null,
    deliveredValue: 25_000,
    ...overrides,
  };
}

describe("buildOverviewSummary", () => {
  it("returns zero counts + empty rows for empty input", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [],
      systems: [],
    });
    expect(out.totalSystems).toBe(0);
    expect(out.reportingSystems).toBe(0);
    expect(out.reportingPercent).toBeNull();
    expect(out.ownershipRows).toEqual([]);
    expect(out.totalContractedValue).toBe(0);
  });

  it("classifies a matched-system row into Not Transferred and Reporting", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [abpRow()],
      systems: [system()],
    });
    expect(out.totalSystems).toBe(1);
    expect(out.reportingSystems).toBe(1);
    expect(out.reportingPercent).toBe(100);
    expect(out.ownershipOverview.notTransferredReporting).toBe(1);
    expect(out.ownershipOverview.reportingOwnershipTotal).toBe(1);
    expect(out.ownershipRows).toHaveLength(1);
    expect(out.ownershipRows[0]!.source).toBe("Matched System");
    expect(out.ownershipRows[0]!.ownershipStatus).toBe(
      "Not Transferred and Reporting"
    );
  });

  it("emits a Part II Unmatched row when no system matches", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [abpRow()],
      systems: [],
    });
    expect(out.totalSystems).toBe(1);
    expect(out.reportingSystems).toBe(0);
    expect(out.ownershipOverview.notTransferredNotReporting).toBe(1);
    expect(out.ownershipRows).toHaveLength(1);
    expect(out.ownershipRows[0]!.source).toBe("Part II Unmatched");
    expect(out.ownershipRows[0]!.systemName).toBe("Acme Solar");
  });

  it("dedupes part-2 rows via resolvePart2ProjectIdentity", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [
        abpRow({ Application_ID: "APP-1" }),
        // Same portalSystemId → same dedupe key, even with a different
        // application ID.
        abpRow({ Application_ID: "APP-1-DUP" }),
      ],
      systems: [system()],
    });
    expect(out.totalSystems).toBe(1);
    expect(out.ownershipRows).toHaveLength(1);
  });

  it("classifies Terminated overrides Transferred overrides Reporting", () => {
    // Three matched scenarios on three rows → counts each into the
    // appropriate ownership-overview bucket. Distinct
    // tracking IDs + project names so the systems don't cross-match
    // through the trackingId/name indices.
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-A",
          system_id: "SYS-A",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-A",
          Project_Name: "Project A",
        }),
        abpRow({
          Application_ID: "APP-B",
          system_id: "SYS-B",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-B",
          Project_Name: "Project B",
        }),
        abpRow({
          Application_ID: "APP-C",
          system_id: "SYS-C",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-C",
          Project_Name: "Project C",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "Project A",
          isReporting: true,
          isTransferred: false,
          isTerminated: false,
          ownershipStatus: "Not Transferred and Reporting",
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "Project B",
          isReporting: true,
          isTransferred: true,
          isTerminated: false,
          ownershipStatus: "Transferred and Reporting",
        }),
        system({
          key: "sys-c",
          systemId: "SYS-C",
          stateApplicationRefId: "APP-C",
          trackingSystemRefId: "NON-C",
          systemName: "Project C",
          isReporting: false,
          isTransferred: true,
          isTerminated: true,
          ownershipStatus: "Terminated and Not Reporting",
        }),
      ],
    });
    expect(out.ownershipOverview.notTransferredReporting).toBe(1);
    expect(out.ownershipOverview.transferredReporting).toBe(1);
    expect(out.ownershipOverview.terminatedNotReporting).toBe(1);
    expect(out.ownershipOverview.terminatedTotal).toBe(1);
    expect(out.totalSystems).toBe(3);
    expect(out.reportingSystems).toBe(2);
  });

  it("counts size buckets from scopedPart2Systems", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-A",
          system_id: "SYS-A",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-A",
          Project_Name: "Project A",
        }),
        abpRow({
          Application_ID: "APP-B",
          system_id: "SYS-B",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-B",
          Project_Name: "Project B",
        }),
        abpRow({
          Application_ID: "APP-C",
          system_id: "SYS-C",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-C",
          Project_Name: "Project C",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "Project A",
          sizeBucket: "<=10 kW AC",
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "Project B",
          sizeBucket: ">10 kW AC",
        }),
        system({
          key: "sys-c",
          systemId: "SYS-C",
          stateApplicationRefId: "APP-C",
          trackingSystemRefId: "NON-C",
          systemName: "Project C",
          sizeBucket: "Unknown",
        }),
      ],
    });
    expect(out.smallSystems).toBe(1);
    expect(out.largeSystems).toBe(1);
    expect(out.unknownSizeSystems).toBe(1);
  });

  it("sums contracted/delivered value from scoped systems with non-zero values", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-A",
          system_id: "SYS-A",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-A",
          Project_Name: "Project A",
        }),
        abpRow({
          Application_ID: "APP-B",
          system_id: "SYS-B",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-B",
          Project_Name: "Project B",
        }),
        // System with all zeros — excluded from withValueData
        abpRow({
          Application_ID: "APP-Z",
          system_id: "SYS-Z",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-Z",
          Project_Name: "Project Z",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "Project A",
          totalContractAmount: 100_000,
          deliveredValue: 30_000,
          isReporting: true,
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "Project B",
          totalContractAmount: 50_000,
          deliveredValue: 0,
          isReporting: false,
        }),
        system({
          key: "sys-z",
          systemId: "SYS-Z",
          stateApplicationRefId: "APP-Z",
          trackingSystemRefId: "NON-Z",
          systemName: "Project Z",
          totalContractAmount: 0,
          contractedValue: 0,
          deliveredValue: 0,
        }),
      ],
    });
    expect(out.withValueDataCount).toBe(2);
    expect(out.totalContractedValue).toBe(150_000);
    expect(out.totalDeliveredValue).toBe(30_000);
    expect(out.totalGap).toBe(120_000);
    expect(out.contractedValueReporting).toBe(100_000);
    expect(out.contractedValueNotReporting).toBe(50_000);
  });

  it("falls back to contractedValue when totalContractAmount is null", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [abpRow()],
      systems: [
        system({
          totalContractAmount: null,
          contractedValue: 75_000,
          deliveredValue: 0,
          isReporting: true,
        }),
      ],
    });
    expect(out.totalContractedValue).toBe(75_000);
  });
});

describe("extractSnapshotSystemsForSummary", () => {
  it("skips entries that are not objects or lack a key", () => {
    const out = extractSnapshotSystemsForSummary([
      null,
      undefined,
      "string-not-allowed",
      { key: "" }, // empty key fails the guard
      {
        key: "sys-1",
        systemId: "SYS-1",
        systemName: "Solar A",
        sizeBucket: "<=10 kW AC",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("sys-1");
    expect(out[0]!.sizeBucket).toBe("<=10 kW AC");
  });

  it("falls back to safe defaults for missing/wrong-typed fields", () => {
    const [extracted] = extractSnapshotSystemsForSummary([
      { key: "sys-1" },
    ]);
    expect(extracted!.systemId).toBeNull();
    expect(extracted!.sizeBucket).toBe("Unknown");
    expect(extracted!.ownershipStatus).toBe(
      "Not Transferred and Not Reporting"
    );
    expect(extracted!.isReporting).toBe(false);
    expect(extracted!.totalContractAmount).toBeNull();
    expect(extracted!.latestReportingDate).toBeNull();
  });

  it("parses ISO date strings into Date objects", () => {
    const [extracted] = extractSnapshotSystemsForSummary([
      {
        key: "sys-1",
        latestReportingDate: "2026-04-15T00:00:00.000Z",
        contractedDate: "2024-06-01T00:00:00.000Z",
      },
    ]);
    expect(extracted!.latestReportingDate).toBeInstanceOf(Date);
    expect(extracted!.contractedDate?.getUTCFullYear()).toBe(2024);
  });
});
