import { describe, expect, it } from "vitest";
import { PLAN_ITEM_TITLE_CLASS } from "../client/src/components/todays-plan/PlanItem";
import {
  addOverrideItem,
  loadPlanOverrides,
  mergePlanWithOverrides,
  removePlanItemOverride,
  savePlanOverrides,
} from "../client/src/components/todays-plan/persistence";
import {
  DEFAULT_TASK_DURATION_MINUTES,
  buildDayPlanSeed,
  parseDurationMinutesFromTask,
} from "../client/src/components/todays-plan/scheduler";
import type { PlanItemData } from "../client/src/components/todays-plan/types";

describe("Todoist duration parsing", () => {
  it("parses 5m/10m/15m-style labels", () => {
    expect(parseDurationMinutesFromTask({ labels: ["5m"] })).toBe(5);
    expect(parseDurationMinutesFromTask({ labels: ["focus", "10m"] })).toBe(10);
    expect(parseDurationMinutesFromTask({ labels: ["15min"] })).toBe(15);
  });

  it("falls back when no duration label exists", () => {
    expect(parseDurationMinutesFromTask({ labels: ["deep-work"] })).toBe(DEFAULT_TASK_DURATION_MINUTES);
  });
});

describe("Today plan scheduling", () => {
  it("keeps due-time tasks at their exact due time, even when overlapping an event", () => {
    const seed = buildDayPlanSeed({
      now: new Date("2026-03-01T09:00:00-06:00"),
      calendarEvents: [
        {
          id: "event-1",
          summary: "Submit report review meeting",
          start: { dateTime: "2026-03-01T15:00:00-06:00" },
          end: { dateTime: "2026-03-01T16:00:00-06:00" },
        },
      ],
      todoistTasks: [
        {
          id: "task-1",
          content: "Submit report",
          labels: ["15m"],
          due: { datetime: "2026-03-01T15:00:00-06:00" },
        },
      ],
      habits: [],
    });

    const event = seed.autoItems.find((item) => item.id === "event:event-1");
    const task = seed.autoItems.find((item) => item.id === "task:task-1");

    expect(event).toBeTruthy();
    expect(task).toBeTruthy();
    expect(task?.dueTime).toBe(true);
    expect(task?.startMs).toBe(event?.startMs);
    expect(task?.timeLabel.toLowerCase()).toContain("due");
  });
});

describe("Today plan persistence", () => {
  const createMemoryStorage = () => {
    const backing = new Map<string, string>();
    return {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
    };
  };

  it("persists added items across reload via overrides merge", () => {
    const storage = createMemoryStorage();
    const dateKey = "2026-03-01";

    const autoItems: PlanItemData[] = [
      {
        id: "task:base",
        type: "task",
        source: "todoist",
        title: "Base task",
        timeLabel: "10:00 AM • 30m",
        sortMs: 10,
        startMs: 10,
        durationMinutes: 30,
        dueTime: false,
        dateKey,
      },
    ];

    const suggested: PlanItemData = {
      id: "suggestion:walk-break",
      type: "task",
      source: "suggestion",
      title: "15-min recovery walk",
      timeLabel: "10:30 AM • 15m",
      sortMs: 20,
      startMs: 20,
      durationMinutes: 15,
      dueTime: false,
      dateKey,
    };

    const firstLoad = loadPlanOverrides(dateKey, storage);
    const afterAdd = addOverrideItem(firstLoad, suggested);
    savePlanOverrides(dateKey, afterAdd, storage);

    const secondLoad = loadPlanOverrides(dateKey, storage);
    const merged = mergePlanWithOverrides(autoItems, secondLoad);
    expect(merged.some((item) => item.id === "suggestion:walk-break")).toBe(true);
  });

  it("removing an item updates overrides and hides it from merged plan", () => {
    const dateKey = "2026-03-01";
    const autoItems: PlanItemData[] = [
      {
        id: "task:base",
        type: "task",
        source: "todoist",
        title: "Base task",
        timeLabel: "10:00 AM • 30m",
        sortMs: 10,
        startMs: 10,
        durationMinutes: 30,
        dueTime: false,
        dateKey,
      },
    ];

    const removed = removePlanItemOverride({ addedItems: [], removedIds: [] }, "task:base");
    const merged = mergePlanWithOverrides(autoItems, removed);
    expect(merged.find((item) => item.id === "task:base")).toBeUndefined();
  });
});

describe("Plan item text wrapping", () => {
  it("uses wrapping classes so long titles do not overflow", () => {
    expect(PLAN_ITEM_TITLE_CLASS).toContain("whitespace-normal");
    expect(PLAN_ITEM_TITLE_CLASS).toContain("break-words");
  });
});

