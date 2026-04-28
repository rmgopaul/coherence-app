/**
 * Phase E (2026-04-28) — tests for the feedback-review pipeline
 * helpers introduced alongside the admin dashboard:
 *
 *   - `isFeedbackStatus`        — type guard over the recognized enum
 *   - `summarizeFeedbackByStatus` — count rollup used by the dashboard
 *     pipeline chips and exposed on the `feedback.listRecent`
 *     response shape
 *   - `updateUserFeedbackStatus` — admin-only DB write; returns true
 *     when a row was actually updated, false otherwise (so the proc
 *     layer can surface a 404 for an unknown id)
 *
 * Mocks `_core` getDb + withDbRetry + ensureUserFeedbackTable so the
 * UPDATE chain runs without spinning up MySQL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
  ensureUserFeedbackTable: vi.fn(),
}));

vi.mock("./_core", async () => {
  const actual = await vi.importActual<typeof import("./_core")>("./_core");
  return {
    ...actual,
    getDb: mocks.getDb,
    withDbRetry: mocks.withDbRetry,
    ensureUserFeedbackTable: mocks.ensureUserFeedbackTable,
  };
});

import {
  FEEDBACK_STATUSES,
  isFeedbackStatus,
  summarizeFeedbackByStatus,
  updateUserFeedbackStatus,
} from "./feedback";

beforeEach(() => {
  mocks.getDb.mockReset();
  mocks.withDbRetry.mockReset();
  mocks.ensureUserFeedbackTable.mockReset();
  mocks.withDbRetry.mockImplementation(async (_label, fn) => fn());
  mocks.ensureUserFeedbackTable.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isFeedbackStatus", () => {
  it("returns true for every recognized status", () => {
    for (const status of FEEDBACK_STATUSES) {
      expect(isFeedbackStatus(status)).toBe(true);
    }
  });

  it("returns false for an unknown status", () => {
    expect(isFeedbackStatus("WIP")).toBe(false);
    expect(isFeedbackStatus("done")).toBe(false);
    expect(isFeedbackStatus("")).toBe(false);
  });

  it("is case-sensitive — 'OPEN' is not a recognized status", () => {
    // The DB column is varchar(32). Letting "OPEN" through would let
    // duplicates accumulate (open vs OPEN). The proc layer relies on
    // strict matching to keep the column tidy.
    expect(isFeedbackStatus("OPEN")).toBe(false);
    expect(isFeedbackStatus("Open")).toBe(false);
  });
});

describe("summarizeFeedbackByStatus", () => {
  it("returns zero counts for every status when given an empty list", () => {
    const counts = summarizeFeedbackByStatus([]);
    expect(counts).toEqual({
      open: 0,
      triaged: 0,
      "in-progress": 0,
      resolved: 0,
      "wont-fix": 0,
    });
  });

  it("counts each row under its declared status", () => {
    const rows = [
      { status: "open" },
      { status: "open" },
      { status: "triaged" },
      { status: "in-progress" },
      { status: "resolved" },
      { status: "resolved" },
      { status: "resolved" },
      { status: "wont-fix" },
    ];
    const counts = summarizeFeedbackByStatus(rows);
    expect(counts).toEqual({
      open: 2,
      triaged: 1,
      "in-progress": 1,
      resolved: 3,
      "wont-fix": 1,
    });
  });

  it("ignores rows with an unrecognized status (defensive)", () => {
    // A migrated row with an old/typo status shouldn't crash the
    // dashboard or leak into one of the official buckets.
    const rows = [
      { status: "open" },
      { status: "WIP" },
      { status: "" },
      { status: "resolved" },
    ];
    const counts = summarizeFeedbackByStatus(rows);
    expect(counts.open).toBe(1);
    expect(counts.resolved).toBe(1);
    // Sum of all official statuses equals the count of recognized rows.
    const recognized = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(recognized).toBe(2);
  });
});

interface UpdateCall {
  setValue?: Record<string, unknown>;
  whereCalled: number;
}

function makeUpdateStub(opts: {
  affectedRows?: number;
  rowCount?: number;
  result?: Record<string, unknown>;
}) {
  const calls: UpdateCall[] = [];
  return {
    update: () => {
      const call: UpdateCall = { whereCalled: 0 };
      calls.push(call);
      const chain: Record<string, unknown> = {
        set: (value: Record<string, unknown>) => {
          call.setValue = value;
          return chain;
        },
        where: () => {
          call.whereCalled += 1;
          return chain;
        },
        then: (resolve: (out: unknown) => unknown) => {
          const out =
            opts.result ??
            (opts.affectedRows !== undefined
              ? { affectedRows: opts.affectedRows }
              : opts.rowCount !== undefined
              ? { rowCount: opts.rowCount }
              : {});
          return Promise.resolve(out).then(resolve);
        },
      };
      return chain;
    },
    calls,
  };
}

describe("updateUserFeedbackStatus", () => {
  it("returns false when the database is unavailable", async () => {
    mocks.getDb.mockResolvedValue(null);
    const ok = await updateUserFeedbackStatus("abc", "resolved");
    expect(ok).toBe(false);
  });

  it("returns false when the table can't be ensured", async () => {
    mocks.getDb.mockResolvedValue(makeUpdateStub({ affectedRows: 1 }));
    mocks.ensureUserFeedbackTable.mockResolvedValue(false);
    const ok = await updateUserFeedbackStatus("abc", "resolved");
    expect(ok).toBe(false);
  });

  it("issues a single UPDATE with the new status + a fresh updatedAt", async () => {
    const stub = makeUpdateStub({ affectedRows: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await updateUserFeedbackStatus("row-1", "in-progress");
    expect(ok).toBe(true);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].whereCalled).toBe(1);
    expect(stub.calls[0].setValue?.status).toBe("in-progress");
    expect(stub.calls[0].setValue?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns false when no row matched the id (so the proc can 404)", async () => {
    const stub = makeUpdateStub({ affectedRows: 0 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await updateUserFeedbackStatus("missing", "resolved");
    expect(ok).toBe(false);
  });

  it("falls back to rowCount when affectedRows is absent (driver variance)", async () => {
    const stub = makeUpdateStub({ rowCount: 1 });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await updateUserFeedbackStatus("row-2", "triaged");
    expect(ok).toBe(true);
  });

  it("returns false when the driver reports neither affectedRows nor rowCount", async () => {
    // Some drivers may return an empty header on a no-op update. We
    // treat that as "did not update anything," which is the safer
    // default than optimistically returning true.
    const stub = makeUpdateStub({ result: {} });
    mocks.getDb.mockResolvedValue(stub);
    const ok = await updateUserFeedbackStatus("row-3", "resolved");
    expect(ok).toBe(false);
  });
});
