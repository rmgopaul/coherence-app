/**
 * Task 8.2 (2026-04-27) — pure-function tests for the jobs index
 * helpers. The DB-touching `listRecentJobsAcrossRunners` is
 * exercised end-to-end by manual smoke from the page; here we
 * verify the logic that's deterministic without a database.
 */
import { describe, expect, it } from "vitest";
import {
  isLiveJobStatus,
  compareJobsIndexRows,
  type JobsIndexRow,
} from "./jobsIndex";

function makeRow(overrides: Partial<JobsIndexRow>): JobsIndexRow {
  return {
    id: "job-x",
    runnerKind: "contract-scan",
    status: "queued",
    total: 0,
    successCount: 0,
    failureCount: 0,
    currentItem: null,
    error: null,
    startedAt: null,
    stoppedAt: null,
    completedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("isLiveJobStatus", () => {
  it("returns true for queued/running/stopping", () => {
    expect(isLiveJobStatus("queued")).toBe(true);
    expect(isLiveJobStatus("running")).toBe(true);
    expect(isLiveJobStatus("stopping")).toBe(true);
  });

  // 2026-05-10 — extended for dataset-upload state machine. The
  // upload runner walks queued → uploading → parsing → preparing →
  // writing → done; all the intermediate states are "live" for
  // polling purposes.
  it("returns true for dataset-upload intermediate states", () => {
    expect(isLiveJobStatus("uploading")).toBe(true);
    expect(isLiveJobStatus("parsing")).toBe(true);
    expect(isLiveJobStatus("preparing")).toBe(true);
    expect(isLiveJobStatus("writing")).toBe(true);
  });

  it("returns false for terminal statuses across all runner kinds", () => {
    expect(isLiveJobStatus("completed")).toBe(false); // contract / din / schedule-b
    expect(isLiveJobStatus("succeeded")).toBe(false); // dashboard-build / csv-export
    expect(isLiveJobStatus("done")).toBe(false); // dataset-upload
    expect(isLiveJobStatus("failed")).toBe(false);
    expect(isLiveJobStatus("stopped")).toBe(false);
    // Defensive: any future status that isn't in the live set is
    // treated as not-live so the UI never polls forever on a typo.
    expect(isLiveJobStatus("garbage")).toBe(false);
  });
});

describe("compareJobsIndexRows", () => {
  it("orders rows by createdAt descending (newest first)", () => {
    const older = makeRow({
      id: "older",
      createdAt: new Date("2026-04-01T00:00:00Z"),
    });
    const newer = makeRow({
      id: "newer",
      createdAt: new Date("2026-04-27T00:00:00Z"),
    });
    const sorted = [older, newer].sort(compareJobsIndexRows);
    expect(sorted.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  it("falls back to updatedAt when createdAt ties", () => {
    const same = new Date("2026-04-27T00:00:00Z");
    const stale = makeRow({
      id: "stale",
      createdAt: same,
      updatedAt: new Date("2026-04-27T00:01:00Z"),
    });
    const fresh = makeRow({
      id: "fresh",
      createdAt: same,
      updatedAt: new Date("2026-04-27T00:05:00Z"),
    });
    const sorted = [stale, fresh].sort(compareJobsIndexRows);
    expect(sorted.map((r) => r.id)).toEqual(["fresh", "stale"]);
  });

  it("treats null timestamps as epoch (sorts to bottom)", () => {
    const real = makeRow({
      id: "real",
      createdAt: new Date("2026-04-27T00:00:00Z"),
    });
    const ghost = makeRow({ id: "ghost", createdAt: null });
    const sorted = [ghost, real].sort(compareJobsIndexRows);
    expect(sorted.map((r) => r.id)).toEqual(["real", "ghost"]);
  });

  it("interleaves runners by createdAt, not by runner kind", () => {
    const t = (iso: string) => new Date(iso);
    const rows = [
      makeRow({
        id: "din-old",
        runnerKind: "din-scrape",
        createdAt: t("2026-04-01T00:00:00Z"),
      }),
      makeRow({
        id: "contract-mid",
        runnerKind: "contract-scan",
        createdAt: t("2026-04-15T00:00:00Z"),
      }),
      makeRow({
        id: "schedule-b-new",
        runnerKind: "schedule-b-import",
        createdAt: t("2026-04-26T00:00:00Z"),
      }),
    ];
    const sorted = [...rows].sort(compareJobsIndexRows);
    expect(sorted.map((r) => r.id)).toEqual([
      "schedule-b-new",
      "contract-mid",
      "din-old",
    ]);
  });
});
