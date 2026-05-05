/**
 * Phase 3.1 cross-tab parity test.
 *
 * The headline DoD of PR #318 was that Overview / Offline Monitoring /
 * Change of Ownership all derive their reporting + Part II Verified
 * counts from the same canonical source (the foundation), eliminating
 * the 21,038 / 21,065 / 21,050 cross-tab drift that prompted the
 * foundation work.
 *
 * Each tab measures a different slice of the same canonical state
 * (Overview's `summary.reportingSystems`, OfflineMonitoring's
 * `part2VerifiedSystemIds.length`, ChangeOwnership's
 * `summary.reporting`). Parity = each slice agrees with the foundation
 * value it's derived from.
 *
 * The fixture deliberately constructs snapshot systems whose legacy
 * `isReporting` / `isTerminated` / `ownershipStatus` flags DISAGREE
 * with the foundation's. Two assertions:
 *
 *   1. After the overlay, every tab's count matches the foundation
 *      (proves cross-tab parity).
 *   2. Without the overlay (running the pure builders against
 *      snapshot-only systems), counts disagree with the foundation
 *      (proves the overlay is doing real work — a regression that
 *      stripped the overlay would fail this).
 */

import { describe, expect, it } from "vitest";
import {
  buildFoundationFromInputs,
  type FoundationBuilderInputs,
} from "./buildFoundationArtifact";
import {
  buildChangeOwnership,
  buildChangeOwnershipWithFoundationOverlay,
  extractSnapshotSystemsForChangeOwnership,
} from "./buildChangeOwnershipAggregates";
import { buildOfflineMonitoringAggregatesWithFoundationOverlay } from "./buildOfflineMonitoringAggregates";
import {
  buildOverviewSummary,
  buildOverviewSummaryWithFoundationOverlay,
  extractSnapshotSystemsForSummary,
} from "./buildOverviewSummaryAggregates";
import { isPart2VerifiedAbpRow } from "./aggregatorHelpers";
import { DATASET_KEYS, type DatasetKey } from "../../../shared/datasetUpload.helpers";

type CsvRow = Record<string, string | undefined>;

const FIXED_BUILT_AT = new Date("2026-04-30T00:00:00.000Z");

function makeInputVersions(): FoundationBuilderInputs["inputVersions"] {
  return Object.fromEntries(
    DATASET_KEYS.map((k) => [k, { batchId: `batch-${k}`, rowCount: 1 }])
  ) as FoundationBuilderInputs["inputVersions"];
}

/**
 * Synthetic 5-CSG fixture chosen to expose every dimension the
 * tabs disagree on. The foundation's canonical answer differs
 * meaningfully from the snapshot's legacy answer for each system.
 *
 *   CSG-A: foundation reporting=true,  snapshot reporting=true   → A reports
 *   CSG-B: foundation reporting=true,  snapshot reporting=FALSE  → B reports (overlay rescues it)
 *   CSG-C: foundation reporting=FALSE, snapshot reporting=true   → C does NOT report (overlay corrects)
 *   CSG-D: foundation reporting=true,  snapshot reporting=true,
 *          terminated=true                                       → D excluded (terminated)
 *   CSG-E: foundation transferred,    snapshot active            → E shows in COO tab via overlay
 */
function buildFixture() {
  const inputs: FoundationBuilderInputs = {
    scopeId: "scope-parity",
    inputVersions: makeInputVersions(),
    solarApplications: [
      {
        csgId: "CSG-A",
        applicationId: "APP-A",
        systemName: "System A",
        installedKwAc: 8,
        installedKwDc: 9,
        totalContractAmount: 1000,
        contractType: "IL ABP - Active",
        statusText: "Active",
        trackingSystemRefId: "TR-A",
        zillowSoldDate: null,
        zillowStatus: null,
      },
      {
        csgId: "CSG-B",
        applicationId: "APP-B",
        systemName: "System B",
        installedKwAc: 8,
        installedKwDc: 9,
        totalContractAmount: 1000,
        contractType: "IL ABP - Active",
        statusText: "Active",
        trackingSystemRefId: "TR-B",
        zillowSoldDate: null,
        zillowStatus: null,
      },
      {
        csgId: "CSG-C",
        applicationId: "APP-C",
        systemName: "System C",
        installedKwAc: 8,
        installedKwDc: 9,
        totalContractAmount: 1000,
        contractType: "IL ABP - Active",
        statusText: "Active",
        trackingSystemRefId: "TR-C",
        zillowSoldDate: null,
        zillowStatus: null,
      },
      {
        csgId: "CSG-D",
        applicationId: "APP-D",
        systemName: "System D",
        installedKwAc: 8,
        installedKwDc: 9,
        totalContractAmount: 1000,
        // Terminated: foundation excludes from part2EligibleCsgIds + reportingCsgIds.
        contractType: "IL ABP - Terminated",
        statusText: "Active",
        trackingSystemRefId: "TR-D",
        zillowSoldDate: null,
        zillowStatus: null,
      },
      {
        csgId: "CSG-E",
        applicationId: "APP-E",
        systemName: "System E",
        installedKwAc: 8,
        installedKwDc: 9,
        totalContractAmount: 1000,
        // Transferred: foundation flags ownershipStatus=transferred.
        contractType: "IL ABP - Transferred",
        statusText: "Active",
        trackingSystemRefId: "TR-E",
        zillowSoldDate: null,
        zillowStatus: null,
      },
    ],
    abpCsgSystemMapping: [
      { csgId: "CSG-A", abpId: "APP-A" },
      { csgId: "CSG-B", abpId: "APP-B" },
      { csgId: "CSG-C", abpId: "APP-C" },
      { csgId: "CSG-D", abpId: "APP-D" },
      { csgId: "CSG-E", abpId: "APP-E" },
    ],
    abpReport: [
      { applicationId: "APP-A", part2AppVerificationDate: "2024-06-01", projectName: "System A" },
      { applicationId: "APP-B", part2AppVerificationDate: "2024-06-01", projectName: "System B" },
      { applicationId: "APP-C", part2AppVerificationDate: "2024-06-01", projectName: "System C" },
      { applicationId: "APP-D", part2AppVerificationDate: "2024-06-01", projectName: "System D" },
      { applicationId: "APP-E", part2AppVerificationDate: "2024-06-01", projectName: "System E" },
    ],
    accountSolarGeneration: [
      // Anchor at 2024-04 — A and B report inside the window. C, D, E
      // either have no positive readings or are terminated.
      { gatsGenId: "TR-A", monthOfGeneration: null, lastMeterReadDate: "2024-04-15", lastMeterReadKwh: 1500 },
      { gatsGenId: "TR-B", monthOfGeneration: null, lastMeterReadDate: "2024-04-10", lastMeterReadKwh: 1200 },
      // C had a reading in Jan, well before the [Feb-2024, May-2024) window.
      { gatsGenId: "TR-C", monthOfGeneration: null, lastMeterReadDate: "2024-01-05", lastMeterReadKwh: 800 },
      // D is terminated AND outside the reporting window — keeps the
      // tabs' "reporting" semantic clean (Overview counts terminated-
      // AND-reporting in its top-line reportingSystems, foundation
      // excludes terminated entirely; aligning both to "D is not
      // reporting" sidesteps that legacy semantic divergence so this
      // test focuses on overlay parity, not on a separate reportable
      // / not-reportable enum cleanup).
      { gatsGenId: "TR-D", monthOfGeneration: null, lastMeterReadDate: "2023-12-01", lastMeterReadKwh: 1100 },
      // E is transferred, no recent positive reading.
      { gatsGenId: "TR-E", monthOfGeneration: null, lastMeterReadDate: "2023-11-01", lastMeterReadKwh: 600 },
    ],
    generationEntry: [],
    transferUnitIds: new Set<string>(),
    contractedDate: [],
  };

  const foundation = buildFoundationFromInputs(inputs, FIXED_BUILT_AT);

  /**
   * Snapshot systems with deliberately-wrong legacy reporting flags.
   * The shape mirrors `extractSnapshotSystemsForSummary` /
   * `extractSnapshotSystemsForChangeOwnership` consumers — extra fields
   * are ignored by the validators.
   */
  const snapshotSystems = [
    {
      key: "CSG-A",
      systemId: "CSG-A",
      stateApplicationRefId: "APP-A",
      trackingSystemRefId: "TR-A",
      systemName: "System A",
      sizeBucket: ">10 kW AC",
      isReporting: true, // matches foundation
      isTransferred: false,
      isTerminated: false,
      ownershipStatus: "Not Transferred and Reporting",
      contractType: "IL ABP - Active",
      contractStatusText: "Active",
      latestReportingDate: new Date("2024-04-15"),
      contractedDate: null,
      zillowStatus: null,
      zillowSoldDate: null,
      totalContractAmount: 1000,
      contractedValue: null,
      deliveredValue: null,
      installedKwAc: 8,
      hasChangedOwnership: false,
      changeOwnershipStatus: null,
    },
    {
      key: "CSG-B",
      systemId: "CSG-B",
      stateApplicationRefId: "APP-B",
      trackingSystemRefId: "TR-B",
      systemName: "System B",
      sizeBucket: ">10 kW AC",
      isReporting: false, // foundation says true (overlay rescues)
      isTransferred: false,
      isTerminated: false,
      ownershipStatus: "Not Transferred and Not Reporting",
      contractType: "IL ABP - Active",
      contractStatusText: "Active",
      latestReportingDate: null,
      contractedDate: null,
      zillowStatus: null,
      zillowSoldDate: null,
      totalContractAmount: 1000,
      contractedValue: null,
      deliveredValue: null,
      installedKwAc: 8,
      hasChangedOwnership: false,
      changeOwnershipStatus: null,
    },
    {
      key: "CSG-C",
      systemId: "CSG-C",
      stateApplicationRefId: "APP-C",
      trackingSystemRefId: "TR-C",
      systemName: "System C",
      sizeBucket: ">10 kW AC",
      isReporting: true, // foundation says false (overlay corrects)
      isTransferred: false,
      isTerminated: false,
      ownershipStatus: "Not Transferred and Reporting",
      contractType: "IL ABP - Active",
      contractStatusText: "Active",
      latestReportingDate: new Date("2024-01-05"),
      contractedDate: null,
      zillowStatus: null,
      zillowSoldDate: null,
      totalContractAmount: 1000,
      contractedValue: null,
      deliveredValue: null,
      installedKwAc: 8,
      hasChangedOwnership: false,
      changeOwnershipStatus: null,
    },
    {
      key: "CSG-D",
      systemId: "CSG-D",
      stateApplicationRefId: "APP-D",
      trackingSystemRefId: "TR-D",
      systemName: "System D",
      sizeBucket: ">10 kW AC",
      isReporting: true, // snapshot says reporting; foundation excludes (terminated)
      isTransferred: false,
      isTerminated: true,
      ownershipStatus: "Terminated and Reporting",
      contractType: "IL ABP - Terminated",
      contractStatusText: "Active",
      latestReportingDate: new Date("2024-04-01"),
      contractedDate: null,
      zillowStatus: null,
      zillowSoldDate: null,
      totalContractAmount: 1000,
      contractedValue: null,
      deliveredValue: null,
      installedKwAc: 8,
      hasChangedOwnership: true,
      changeOwnershipStatus: "Terminated and Reporting",
    },
    {
      key: "CSG-E",
      systemId: "CSG-E",
      stateApplicationRefId: "APP-E",
      trackingSystemRefId: "TR-E",
      systemName: "System E",
      sizeBucket: ">10 kW AC",
      // Snapshot has wrong: not transferred. Foundation flags transferred via contract type.
      isReporting: false,
      isTransferred: false,
      isTerminated: false,
      ownershipStatus: "Not Transferred and Not Reporting",
      contractType: "IL ABP - Transferred",
      contractStatusText: "Active",
      latestReportingDate: null,
      contractedDate: null,
      zillowStatus: null,
      zillowSoldDate: null,
      totalContractAmount: 1000,
      contractedValue: null,
      deliveredValue: null,
      installedKwAc: 8,
      hasChangedOwnership: false,
      changeOwnershipStatus: null,
    },
  ];

  const abpReportRows: CsvRow[] = inputs.abpReport.map((row) => ({
    Application_ID: row.applicationId ?? undefined,
    system_id: row.applicationId ?? undefined,
    PJM_GATS_or_MRETS_Unit_ID_Part_2: undefined,
    tracking_system_ref_id: undefined,
    Project_Name: row.projectName ?? undefined,
    system_name: undefined,
    Part_2_App_Verification_Date: row.part2AppVerificationDate ?? undefined,
  }));

  const solarApplicationsRows: CsvRow[] = inputs.solarApplications.map(
    (row) => ({
      Application_ID: row.applicationId ?? undefined,
      system_id: row.csgId ?? undefined,
      tracking_system_ref_id: row.trackingSystemRefId ?? undefined,
      reporting_entity_ref_id: undefined,
      PJM_GATS_or_MRETS_Unit_ID_Part_2: undefined,
      system_name: row.systemName ?? undefined,
      Project_Name: undefined,
    })
  );

  return { foundation, snapshotSystems, abpReportRows, solarApplicationsRows };
}

describe("Phase 3.1 cross-tab parity", () => {
  it("foundation has the expected canonical state for the fixture", () => {
    // Sanity check on the fixture itself before asserting parity.
    const { foundation } = buildFixture();
    // A + B report; C is outside the window; D is terminated (excluded);
    // E has no recent positive reading.
    expect(foundation.reportingCsgIds).toEqual(["CSG-A", "CSG-B"]);
    expect(foundation.summaryCounts.reporting).toBe(2);
    // A + B + C + E are Part II Verified (D is terminated → excluded).
    expect(foundation.part2EligibleCsgIds).toEqual([
      "CSG-A",
      "CSG-B",
      "CSG-C",
      "CSG-E",
    ]);
    expect(foundation.summaryCounts.part2Verified).toBe(4);
    expect(foundation.summaryCounts.part2VerifiedAndReporting).toBe(2);
  });

  it("Overview summary reporting count matches foundation Part-II reporting after overlay", () => {
    const { foundation, snapshotSystems, abpReportRows } = buildFixture();
    const result = buildOverviewSummaryWithFoundationOverlay(
      foundation,
      snapshotSystems,
      abpReportRows
    );
    expect(result.totalSystems).toBe(foundation.summaryCounts.part2Verified);
    expect(result.reportingSystems).toBe(
      foundation.summaryCounts.part2VerifiedAndReporting
    );
  });

  it("Offline Monitoring part2VerifiedSystemIds count matches foundation Part II Verified count", () => {
    const { foundation, abpReportRows, solarApplicationsRows } = buildFixture();
    const result = buildOfflineMonitoringAggregatesWithFoundationOverlay(
      foundation,
      abpReportRows,
      solarApplicationsRows
    );
    expect(result.part2VerifiedSystemIds.length).toBe(
      foundation.summaryCounts.part2Verified
    );
    expect(result.part2VerifiedAbpRowsCount).toBe(
      foundation.summaryCounts.part2Verified
    );
  });

  it("Change of Ownership reporting count matches foundation transferred-and-reporting", () => {
    const { foundation, snapshotSystems, abpReportRows } = buildFixture();
    const result = buildChangeOwnershipWithFoundationOverlay(
      foundation,
      snapshotSystems,
      abpReportRows
    );
    // The foundation has E as transferred (not reporting) and D as
    // terminated (not reporting after fixture adjustment). The
    // ChangeOwnership tab shows ANY system with hasChangedOwnership=true,
    // regardless of reporting state, so we expect 2 rows (D + E).
    expect(result.summary.total).toBe(2);
    // The COO logic emits the bare label "Terminated" when every
    // matched system is terminated (see buildChangeOwnershipAggregates
    // ~L516); the reporting-suffixed labels are reserved for mixed
    // matches. E's "Transferred and Not Reporting" label proves the
    // overlay surfaced E (snapshot had it as Not Transferred — without
    // the overlay E would be excluded from this tab entirely).
    const dRow = result.rows.find((r) => r.systemId === "CSG-D");
    const eRow = result.rows.find((r) => r.systemId === "CSG-E");
    expect(dRow?.changeOwnershipStatus).toBe("Terminated");
    expect(eRow?.changeOwnershipStatus).toBe("Transferred and Not Reporting");
  });

  it("CONTROL: snapshot-only build (no overlay) DISAGREES with foundation — proves overlay matters", () => {
    // If a future refactor strips the overlay step, this assertion
    // would flip and the parity tests above would silently start
    // disagreeing with the foundation. This guards against that.
    const { snapshotSystems, abpReportRows } = buildFixture();
    const part2VerifiedAbpRows = abpReportRows.filter(isPart2VerifiedAbpRow);
    const baseSystems = extractSnapshotSystemsForSummary(snapshotSystems);
    const snapshotOnly = buildOverviewSummary({
      part2VerifiedAbpRows,
      systems: baseSystems,
    });
    // Snapshot reports A + C + D = 3 reporting projects (snapshot
    // flags are intentionally wrong vs. foundation's 2). If the
    // overlay step accidentally became a no-op, every other test in
    // this file would silently start agreeing with this number —
    // this assertion guards against that regression.
    expect(snapshotOnly.reportingSystems).toBe(3);
  });

  it("CONTROL: ChangeOwnership snapshot-only build differs from foundation-overlaid build", () => {
    const { snapshotSystems, abpReportRows } = buildFixture();
    const part2VerifiedAbpRows = abpReportRows.filter(isPart2VerifiedAbpRow);
    const baseSystems = extractSnapshotSystemsForChangeOwnership(snapshotSystems);
    const snapshotOnly = buildChangeOwnership({
      part2VerifiedAbpRows,
      systems: baseSystems,
    });
    // Snapshot only has D as having changed ownership (terminated).
    // Foundation overlay adds E (transferred). The overlay surfaces
    // 1 more COO row.
    expect(snapshotOnly.summary.total).toBe(1);
  });
});
