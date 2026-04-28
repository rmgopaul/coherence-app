import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be hoisted so `vi.mock` runs before the import below.
// We mock the upstream services + db helpers `unpinIfCompletedTodoistKing`
// reaches for so the throttle / taskId / completion-check logic can be
// exercised without real network or DB access.
const mocks = vi.hoisted(() => ({
  getIntegrationByProvider: vi.fn(),
  isTodoistTaskCompletedById: vi.fn(),
  deleteKingOfDay: vi.fn(),
}));

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db")>("../db");
  return {
    ...actual,
    getIntegrationByProvider: mocks.getIntegrationByProvider,
    deleteKingOfDay: mocks.deleteKingOfDay,
  };
});

vi.mock("../services/integrations/todoist", async () => {
  const actual = await vi.importActual<
    typeof import("../services/integrations/todoist")
  >("../services/integrations/todoist");
  return {
    ...actual,
    isTodoistTaskCompletedById: mocks.isTodoistTaskCompletedById,
  };
});

import { __test__ } from "./kingOfDay";
import type { UserKingOfDay } from "../../drizzle/schema";

const { daysOverdue, unpinIfCompletedTodoistKing } = __test__;

beforeEach(() => {
  mocks.getIntegrationByProvider.mockReset();
  mocks.isTodoistTaskCompletedById.mockReset();
  mocks.deleteKingOfDay.mockReset();
  mocks.deleteKingOfDay.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeKing(
  overrides: Partial<UserKingOfDay> = {}
): UserKingOfDay {
  return {
    id: "row-1",
    userId: 1,
    dateKey: "2026-04-28",
    source: "auto",
    title: "Mail the contracts",
    reason: "P1 · due today",
    taskId: "task-1",
    eventId: null,
    pinnedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(Date.now() - 5 * 60_000), // 5 min ago — past stale window
    ...overrides,
  } as UserKingOfDay;
}

function makeTask(
  due:
    | string
    | { date: string; datetime?: string; string?: string }
    | null,
  overrides: Record<string, unknown> = {}
) {
  const dueObj =
    typeof due === "string"
      ? { date: due, string: due }
      : due ?? undefined;
  return {
    id: "t-1",
    content: "task",
    description: "",
    projectId: "p-1",
    priority: 1,
    labels: [],
    ...overrides,
    due: dueObj,
  } as unknown as Parameters<typeof daysOverdue>[0];
}

describe("daysOverdue", () => {
  const fixedNow = new Date("2026-04-19T12:00:00-05:00"); // CST midday

  it("returns 0 for a task without a due date", () => {
    expect(daysOverdue(makeTask(null), fixedNow)).toBe(0);
  });

  it("returns 0 for today's due date", () => {
    expect(daysOverdue(makeTask("2026-04-19"), fixedNow)).toBe(0);
  });

  it("returns 0 for a future due date", () => {
    expect(daysOverdue(makeTask("2026-04-25"), fixedNow)).toBe(0);
  });

  it("returns the integer day count for past due dates", () => {
    expect(daysOverdue(makeTask("2026-04-18"), fixedNow)).toBe(1);
    expect(daysOverdue(makeTask("2026-04-12"), fixedNow)).toBe(7);
  });

  it("parses YYYY-MM-DD as local midnight (not UTC)", () => {
    // `new Date("2026-04-19")` is UTC midnight; in CST that's
    // 2026-04-18 19:00, which the naive implementation would flag
    // as overdue today. The parser must read the date-only string
    // as a local date so today's task is never overdue.
    expect(daysOverdue(makeTask("2026-04-19"), fixedNow)).toBe(0);
  });

  it("handles datetime-form due values", () => {
    expect(
      daysOverdue(
        makeTask({
          datetime: "2026-04-15T14:00:00Z",
          date: "2026-04-15",
          string: "",
        }),
        fixedNow
      )
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("unpinIfCompletedTodoistKing (Task 10.2)", () => {
  it("returns false when the King has no taskId", async () => {
    const king = makeKing({ taskId: null });
    const out = await unpinIfCompletedTodoistKing(1, "2026-04-28", king);
    expect(out).toBe(false);
    expect(mocks.isTodoistTaskCompletedById).not.toHaveBeenCalled();
    expect(mocks.deleteKingOfDay).not.toHaveBeenCalled();
  });

  it("returns false (throttled) when updatedAt is within the staleAfterMs window", async () => {
    const king = makeKing({
      // Just-updated row; the throttle should skip the API call.
      updatedAt: new Date(Date.now() - 1_000),
    });
    const out = await unpinIfCompletedTodoistKing(
      1,
      "2026-04-28",
      king,
      60_000
    );
    expect(out).toBe(false);
    expect(mocks.isTodoistTaskCompletedById).not.toHaveBeenCalled();
  });

  it("returns false when Todoist isn't connected", async () => {
    mocks.getIntegrationByProvider.mockResolvedValue(null);
    const king = makeKing();
    const out = await unpinIfCompletedTodoistKing(1, "2026-04-28", king);
    expect(out).toBe(false);
    expect(mocks.isTodoistTaskCompletedById).not.toHaveBeenCalled();
  });

  it("returns false when the task is still open", async () => {
    mocks.getIntegrationByProvider.mockResolvedValue({
      accessToken: "fake-token",
    });
    mocks.isTodoistTaskCompletedById.mockResolvedValue(false);
    const king = makeKing();
    const out = await unpinIfCompletedTodoistKing(1, "2026-04-28", king);
    expect(out).toBe(false);
    expect(mocks.deleteKingOfDay).not.toHaveBeenCalled();
  });

  it("returns true and deletes the row when the task is completed", async () => {
    mocks.getIntegrationByProvider.mockResolvedValue({
      accessToken: "fake-token",
    });
    mocks.isTodoistTaskCompletedById.mockResolvedValue(true);
    const king = makeKing();
    const out = await unpinIfCompletedTodoistKing(1, "2026-04-28", king);
    expect(out).toBe(true);
    expect(mocks.deleteKingOfDay).toHaveBeenCalledWith(1, "2026-04-28");
  });

  it("returns false on transient errors (fail-open)", async () => {
    mocks.getIntegrationByProvider.mockResolvedValue({
      accessToken: "fake-token",
    });
    mocks.isTodoistTaskCompletedById.mockRejectedValue(
      new Error("network down")
    );
    const king = makeKing();
    const out = await unpinIfCompletedTodoistKing(1, "2026-04-28", king);
    // Fail-open: King hangs around rather than mysteriously
    // disappearing on a transient blip.
    expect(out).toBe(false);
    expect(mocks.deleteKingOfDay).not.toHaveBeenCalled();
  });

  it("respects an explicit staleAfterMs=0 to force an immediate check", async () => {
    mocks.getIntegrationByProvider.mockResolvedValue({
      accessToken: "fake-token",
    });
    mocks.isTodoistTaskCompletedById.mockResolvedValue(true);
    const king = makeKing({ updatedAt: new Date(Date.now() - 100) });
    const out = await unpinIfCompletedTodoistKing(
      1,
      "2026-04-28",
      king,
      0
    );
    // With staleAfterMs=0, the throttle is skipped even though the
    // row was updated 100ms ago.
    expect(out).toBe(true);
  });
});
