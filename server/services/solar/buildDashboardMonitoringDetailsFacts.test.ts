/**
 * Tests for the dashboard monitoring-details fact-table builder
 * (Phase 2 PR-C-2).
 *
 * Two layers tested:
 *   1. Pure transformation `buildMonitoringDetailsFactRows` —
 *      aggregate maps → InsertSolarRecDashboardMonitoringDetailsFact[].
 *      Unit tests, no mocks needed.
 *   2. Runner step + registration — uses `vi.hoisted` mocks for the
 *      DB upsert/delete helpers + the existing offline-monitoring
 *      aggregator. Tests assert the orchestration order
 *      (aggregate → upsert → orphan-sweep) without spinning up a
 *      real DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertMonitoringDetailsFacts: vi.fn(),
  deleteOrphanedMonitoringDetailsFacts: vi.fn(),
  getOrBuildOfflineMonitoringAggregates: vi.fn(),
}));

vi.mock("../../db/dashboardMonitoringDetailsFacts", () => ({
  upsertMonitoringDetailsFacts: mocks.upsertMonitoringDetailsFacts,
  deleteOrphanedMonitoringDetailsFacts:
    mocks.deleteOrphanedMonitoringDetailsFacts,
  // Other exports unused by the builder; provide stubs.
  getMonitoringDetailsFactsPage: vi.fn(),
  getMonitoringDetailsFactsBySystemKeys: vi.fn(),
  getMonitoringDetailsFactsCount: vi.fn(),
}));

vi.mock("./buildOfflineMonitoringAggregates", async () => {
  const actual = await vi.importActual<
    typeof import("./buildOfflineMonitoringAggregates")
  >("./buildOfflineMonitoringAggregates");
  return {
    ...actual,
    getOrBuildOfflineMonitoringAggregates:
      mocks.getOrBuildOfflineMonitoringAggregates,
  };
});

import {
  __resetMonitoringDetailsBuildStepRegistrationForTests,
  buildMonitoringDetailsFactRows,
  monitoringDetailsBuildStep,
  registerMonitoringDetailsBuildStep,
} from "./buildDashboardMonitoringDetailsFacts";
import {
  getDashboardBuildSteps,
  setDashboardBuildSteps,
} from "./dashboardBuildJobRunner";

beforeEach(() => {
  for (const key of Object.keys(mocks) as (keyof typeof mocks)[]) {
    mocks[key].mockReset();
  }
  mocks.upsertMonitoringDetailsFacts.mockResolvedValue(undefined);
  mocks.deleteOrphanedMonitoringDetailsFacts.mockResolvedValue(0);
  setDashboardBuildSteps([]);
  __resetMonitoringDetailsBuildStepRegistrationForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  setDashboardBuildSteps([]);
  __resetMonitoringDetailsBuildStepRegistrationForTests();
});

// ────────────────────────────────────────────────────────────────────
// Pure transformation tests
// ────────────────────────────────────────────────────────────────────

const EMPTY_DETAILS = {
  online_monitoring_access_type: "",
  online_monitoring: "",
  online_monitoring_granted_username: "",
  online_monitoring_username: "",
  online_monitoring_system_name: "",
  online_monitoring_system_id: "",
  online_monitoring_password: "",
  online_monitoring_website_api_link: "",
  online_monitoring_entry_method: "",
  online_monitoring_notes: "",
  online_monitoring_self_report: "",
  online_monitoring_rgm_info: "",
  online_monitoring_no_submit_generation: "",
  system_online: "",
  last_reported_online_date: "",
};

describe("buildMonitoringDetailsFactRows (pure transformation)", () => {
  it("returns one row per systemKey in monitoringDetailsBySystemKey", () => {
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "scope-1",
      buildId: "bld-1",
      monitoringDetailsBySystemKey: {
        "id:abc": EMPTY_DETAILS,
        "tracking:tr-001": EMPTY_DETAILS,
        "name:acme solar": EMPTY_DETAILS,
      },
      abpApplicationIdBySystemKey: {},
      abpAcSizeKwBySystemKey: {},
    });
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.systemKey).sort()).toEqual(
      ["id:abc", "name:acme solar", "tracking:tr-001"].sort()
    );
  });

  it("stamps every row with the supplied scopeId + buildId", () => {
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "scope-X",
      buildId: "bld-Y",
      monitoringDetailsBySystemKey: { "id:a": EMPTY_DETAILS },
      abpApplicationIdBySystemKey: {},
      abpAcSizeKwBySystemKey: {},
    });
    expect(rows[0].scopeId).toBe("scope-X");
    expect(rows[0].buildId).toBe("bld-Y");
  });

  it("maps the 15 monitoringDetails fields 1:1 (camelCase column names)", () => {
    const detailsAllSet = {
      online_monitoring_access_type: "Granted",
      online_monitoring: "Yes",
      online_monitoring_granted_username: "team@acme",
      online_monitoring_username: "user@acme",
      online_monitoring_system_name: "Acme #1",
      online_monitoring_system_id: "sys-001",
      online_monitoring_password: "secret",
      online_monitoring_website_api_link: "https://api.example.com",
      online_monitoring_entry_method: "Email",
      online_monitoring_notes: "rooftop",
      online_monitoring_self_report: "No",
      online_monitoring_rgm_info: "Solar+",
      online_monitoring_no_submit_generation: "No",
      system_online: "Yes",
      last_reported_online_date: "2026-05-01",
    };
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "s",
      buildId: "b",
      monitoringDetailsBySystemKey: { "id:abc": detailsAllSet },
      abpApplicationIdBySystemKey: {},
      abpAcSizeKwBySystemKey: {},
    });
    const row = rows[0];
    expect(row.onlineMonitoringAccessType).toBe("Granted");
    expect(row.onlineMonitoring).toBe("Yes");
    expect(row.onlineMonitoringGrantedUsername).toBe("team@acme");
    expect(row.onlineMonitoringUsername).toBe("user@acme");
    expect(row.onlineMonitoringSystemName).toBe("Acme #1");
    expect(row.onlineMonitoringSystemId).toBe("sys-001");
    expect(row.onlineMonitoringPassword).toBe("secret");
    expect(row.onlineMonitoringWebsiteApiLink).toBe("https://api.example.com");
    expect(row.onlineMonitoringEntryMethod).toBe("Email");
    expect(row.onlineMonitoringNotes).toBe("rooftop");
    expect(row.onlineMonitoringSelfReport).toBe("No");
    expect(row.onlineMonitoringRgmInfo).toBe("Solar+");
    expect(row.onlineMonitoringNoSubmitGeneration).toBe("No");
    expect(row.systemOnline).toBe("Yes");
    expect(row.lastReportedOnlineDate).toBe("2026-05-01");
  });

  it("converts empty-string fields to null (DB nullability)", () => {
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "s",
      buildId: "b",
      monitoringDetailsBySystemKey: { "id:abc": EMPTY_DETAILS },
      abpApplicationIdBySystemKey: {},
      abpAcSizeKwBySystemKey: {},
    });
    const row = rows[0];
    expect(row.onlineMonitoringAccessType).toBeNull();
    expect(row.onlineMonitoring).toBeNull();
    expect(row.lastReportedOnlineDate).toBeNull();
    expect(row.systemOnline).toBeNull();
  });

  it("attaches abpApplicationId from the cross-reference map", () => {
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "s",
      buildId: "b",
      monitoringDetailsBySystemKey: {
        "id:abc": EMPTY_DETAILS,
        "tracking:tr-001": EMPTY_DETAILS,
      },
      abpApplicationIdBySystemKey: {
        "id:abc": "APP-100",
        "tracking:tr-001": "APP-100",
      },
      abpAcSizeKwBySystemKey: {},
    });
    expect(rows.find(r => r.systemKey === "id:abc")?.abpApplicationId).toBe(
      "APP-100"
    );
    expect(
      rows.find(r => r.systemKey === "tracking:tr-001")?.abpApplicationId
    ).toBe("APP-100");
  });

  it("leaves abpApplicationId null when the system isn't in the cross-reference map", () => {
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "s",
      buildId: "b",
      monitoringDetailsBySystemKey: { "id:no-abp": EMPTY_DETAILS },
      abpApplicationIdBySystemKey: {},
      abpAcSizeKwBySystemKey: {},
    });
    expect(rows[0].abpApplicationId).toBeNull();
  });

  it("converts numeric abpAcSizeKw to its string form (Drizzle decimal contract)", () => {
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "s",
      buildId: "b",
      monitoringDetailsBySystemKey: { "id:abc": EMPTY_DETAILS },
      abpApplicationIdBySystemKey: {},
      abpAcSizeKwBySystemKey: { "id:abc": 7.523 },
    });
    expect(rows[0].abpAcSizeKw).toBe("7.523");
  });

  it("nullifies non-finite abpAcSizeKw values (NaN / Infinity)", () => {
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "s",
      buildId: "b",
      monitoringDetailsBySystemKey: {
        "id:nan": EMPTY_DETAILS,
        "id:inf": EMPTY_DETAILS,
      },
      abpApplicationIdBySystemKey: {},
      abpAcSizeKwBySystemKey: { "id:nan": NaN, "id:inf": Infinity },
    });
    expect(rows.find(r => r.systemKey === "id:nan")?.abpAcSizeKw).toBeNull();
    expect(rows.find(r => r.systemKey === "id:inf")?.abpAcSizeKw).toBeNull();
  });

  it("leaves abpAcSizeKw null when the system isn't in the size map", () => {
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "s",
      buildId: "b",
      monitoringDetailsBySystemKey: { "id:no-size": EMPTY_DETAILS },
      abpApplicationIdBySystemKey: {},
      abpAcSizeKwBySystemKey: {},
    });
    expect(rows[0].abpAcSizeKw).toBeNull();
  });

  it("returns [] when the input map is empty", () => {
    const rows = buildMonitoringDetailsFactRows({
      scopeId: "s",
      buildId: "b",
      monitoringDetailsBySystemKey: {},
      abpApplicationIdBySystemKey: {},
      abpAcSizeKwBySystemKey: {},
    });
    expect(rows).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Runner-step orchestration tests
// ────────────────────────────────────────────────────────────────────

function makeFakeAggregate() {
  return {
    eligiblePart2ApplicationIds: [],
    eligiblePart2PortalSystemIds: [],
    eligiblePart2TrackingIds: [],
    abpApplicationIdBySystemKey: { "id:abc": "APP-1" },
    monitoringDetailsBySystemKey: {
      "id:abc": { ...EMPTY_DETAILS, online_monitoring: "Yes" },
      "tracking:tr-1": EMPTY_DETAILS,
    },
    abpAcSizeKwBySystemKey: { "id:abc": 5.0 },
    abpAcSizeKwByApplicationId: {},
    abpPart2VerificationDateByApplicationId: {},
    part2VerifiedSystemIds: [],
    part2VerifiedAbpRowsCount: 0,
    abpEligibleTotalSystemsCount: 0,
  };
}

describe("monitoringDetailsBuildStep — orchestration", () => {
  it("aggregator → upsert → orphan-sweep order with correct args", async () => {
    mocks.getOrBuildOfflineMonitoringAggregates.mockResolvedValue({
      result: makeFakeAggregate(),
      fromCache: false,
    });
    mocks.deleteOrphanedMonitoringDetailsFacts.mockResolvedValue(7);

    await monitoringDetailsBuildStep.run({
      scopeId: "scope-A",
      buildId: "bld-1",
      signal: new AbortController().signal,
    });

    // Aggregator called with the scope.
    expect(
      mocks.getOrBuildOfflineMonitoringAggregates
    ).toHaveBeenCalledWith("scope-A");
    // Upsert receives 2 rows (the aggregate has 2 entries in
    // monitoringDetailsBySystemKey).
    expect(mocks.upsertMonitoringDetailsFacts).toHaveBeenCalledTimes(1);
    const [upsertedRows] = mocks.upsertMonitoringDetailsFacts.mock.calls[0];
    expect(upsertedRows).toHaveLength(2);
    expect(upsertedRows[0].buildId).toBe("bld-1");
    expect(upsertedRows[0].scopeId).toBe("scope-A");
    // Orphan sweep called with current build's id.
    expect(mocks.deleteOrphanedMonitoringDetailsFacts).toHaveBeenCalledWith(
      "scope-A",
      "bld-1"
    );
    // Order check: upsert BEFORE orphan-sweep.
    const upsertOrder =
      mocks.upsertMonitoringDetailsFacts.mock.invocationCallOrder[0];
    const sweepOrder =
      mocks.deleteOrphanedMonitoringDetailsFacts.mock.invocationCallOrder[0];
    expect(upsertOrder).toBeLessThan(sweepOrder);
  });

  it("propagates upsert failures (runner converts to errorMessage)", async () => {
    mocks.getOrBuildOfflineMonitoringAggregates.mockResolvedValue({
      result: makeFakeAggregate(),
      fromCache: false,
    });
    mocks.upsertMonitoringDetailsFacts.mockRejectedValue(
      new Error("upsert blew up")
    );

    await expect(
      monitoringDetailsBuildStep.run({
        scopeId: "scope-A",
        buildId: "bld-1",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/upsert blew up/);
    // Orphan sweep NOT called when upsert fails.
    expect(mocks.deleteOrphanedMonitoringDetailsFacts).not.toHaveBeenCalled();
  });

  it("aborts before aggregate fetch when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      monitoringDetailsBuildStep.run({
        scopeId: "s",
        buildId: "b",
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/);
    expect(mocks.getOrBuildOfflineMonitoringAggregates).not.toHaveBeenCalled();
    expect(mocks.upsertMonitoringDetailsFacts).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// Step registration
// ────────────────────────────────────────────────────────────────────

describe("registerMonitoringDetailsBuildStep", () => {
  it("appends the step to the runner's empty steps array on first call", async () => {
    expect(getDashboardBuildSteps()).toEqual([]);
    await registerMonitoringDetailsBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("monitoringDetailsFacts");
    expect(steps[0]).toBe(monitoringDetailsBuildStep);
  });

  it("is idempotent: subsequent calls do NOT duplicate the step", async () => {
    await registerMonitoringDetailsBuildStep();
    await registerMonitoringDetailsBuildStep();
    await registerMonitoringDetailsBuildStep();
    expect(getDashboardBuildSteps()).toHaveLength(1);
  });

  it("preserves prior steps already in the array", async () => {
    const priorStep = {
      name: "priorStep",
      run: vi.fn().mockResolvedValue(undefined),
    };
    setDashboardBuildSteps([priorStep]);
    await registerMonitoringDetailsBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toBe(priorStep);
    expect(steps[1].name).toBe("monitoringDetailsFacts");
  });

  it("does NOT re-append even if the steps array was reset and another caller already added the step", async () => {
    // Edge case: someone manually called setDashboardBuildSteps with
    // an array that already contains a step named "monitoringDetailsFacts"
    // (different identity, same name). Registration should detect and
    // skip.
    setDashboardBuildSteps([
      {
        name: "monitoringDetailsFacts",
        run: async () => {},
      },
    ]);
    await registerMonitoringDetailsBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(1);
  });
});
