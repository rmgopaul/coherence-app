import { describe, expect, it } from "vitest";
import { PLAN_ITEM_TITLE_CLASS } from "../client/src/components/todays-plan/PlanItem";
import {
  addOverrideItem,
  loadPlanOverrides,
  mergePlanWithOverrides,
  removePlanItemOverride,
  setPlanOrderOverride,
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
  it("removes timed calendar events that have already ended today", () => {
    const seed = buildDayPlanSeed({
      now: new Date("2026-03-01T14:00:00-06:00"),
      calendarEvents: [
        {
          id: "event-past",
          summary: "Morning standup",
          start: { dateTime: "2026-03-01T09:00:00-06:00" },
          end: { dateTime: "2026-03-01T09:30:00-06:00" },
        },
        {
          id: "event-upcoming",
          summary: "Afternoon sync",
          start: { dateTime: "2026-03-01T15:00:00-06:00" },
          end: { dateTime: "2026-03-01T15:30:00-06:00" },
        },
      ],
      todoistTasks: [],
      emails: [],
      habits: [],
    });

    expect(seed.autoItems.some((item) => item.id === "event:event-past")).toBe(false);
    expect(seed.autoItems.some((item) => item.id === "event:event-upcoming")).toBe(true);
  });

  it("shifts overdue due-time tasks forward to now window and labels as overdue", () => {
    const seed = buildDayPlanSeed({
      now: new Date("2026-03-01T14:07:00-06:00"),
      calendarEvents: [],
      todoistTasks: [
        {
          id: "task-overdue",
          content: "Submit report",
          labels: ["15m"],
          due: { datetime: "2026-03-01T13:00:00-06:00" },
        },
      ],
      emails: [],
      habits: [],
    });

    const task = seed.autoItems.find((item) => item.id === "task:task-overdue");
    const expectedRoundedNow = new Date("2026-03-01T14:10:00-06:00").getTime();

    expect(task).toBeTruthy();
    expect(task?.startMs).toBe(expectedRoundedNow);
    expect(task?.timeLabel.toLowerCase()).toContain("overdue");
  });

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
      emails: [],
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

  it("excludes Todoist tasks without due dates from Today's Plan", () => {
    const seed = buildDayPlanSeed({
      now: new Date("2026-03-01T09:00:00-06:00"),
      calendarEvents: [],
      todoistTasks: [
        {
          id: "task-dated",
          content: "Task with due date",
          labels: ["10m"],
          due: { date: "2026-03-01" },
        },
        {
          id: "task-undated",
          content: "Undated task should not appear",
          labels: ["5m"],
        },
      ],
      emails: [],
      habits: [],
    });

    expect(seed.autoItems.some((item) => item.id === "task:task-dated")).toBe(true);
    expect(seed.autoItems.some((item) => item.id === "task:task-undated")).toBe(false);
  });

  it("includes emails with explicit same-day deadlines and places them at deadline time", () => {
    const seed = buildDayPlanSeed({
      now: new Date("2026-03-01T09:00:00-06:00"),
      calendarEvents: [],
      todoistTasks: [
        {
          id: "task-1",
          content: "Prep docs",
          due: { date: "2026-03-01" },
        },
      ],
      emails: [
        {
          id: "gmail-1",
          threadId: "thread-1",
          snippet: "Need this by 3:30 PM today.",
          payload: {
            headers: [
              { name: "Subject", value: "Submit contract update" },
              { name: "From", value: "Client Team" },
            ],
          },
        },
      ],
      habits: [],
    });

    const emailItem = seed.autoItems.find((item) => item.id === "email:gmail-1");
    expect(emailItem).toBeTruthy();
    expect(emailItem?.source).toBe("email");
    expect(emailItem?.timeLabel).toContain("Due");
    const expected = new Date("2026-03-01T15:30:00-06:00").getTime();
    expect(emailItem?.startMs).toBe(expected);
  });

  it("applies habit placement rules (Floss early, BTAN late, no alcohol/no 420 hidden)", () => {
    const seed = buildDayPlanSeed({
      now: new Date("2026-03-01T08:00:00-06:00"),
      calendarEvents: [],
      todoistTasks: [],
      emails: [],
      habits: [
        { id: "habit-floss", name: "Floss", completed: false },
        { id: "habit-btan", name: "BTAN", completed: false },
        { id: "habit-avoid1", name: "No alcohol", completed: false },
        { id: "habit-avoid2", name: "No 420", completed: false },
      ],
    });

    const floss = seed.autoItems.find((item) => item.id === "habit:habit-floss");
    const btan = seed.autoItems.find((item) => item.id === "habit:habit-btan");
    const noAlcohol = seed.autoItems.find((item) => item.id === "habit:habit-avoid1");
    const no420 = seed.autoItems.find((item) => item.id === "habit:habit-avoid2");

    expect(floss).toBeTruthy();
    expect(btan).toBeTruthy();
    expect(noAlcohol).toBeUndefined();
    expect(no420).toBeUndefined();
    expect((floss?.startMs || 0) < (btan?.startMs || Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("keeps sibling subtasks together using parent relationship when time allows", () => {
    const seed = buildDayPlanSeed({
      now: new Date("2026-03-01T09:00:00-06:00"),
      calendarEvents: [],
      todoistTasks: [
        {
          id: "child-1",
          parentId: "parent-1",
          projectId: "project-a",
          content: "ABP prep packet",
          labels: ["10m"],
          due: { date: "2026-03-01" },
        },
        {
          id: "child-2",
          parentId: "parent-1",
          projectId: "project-a",
          content: "ABP send packet",
          labels: ["15m"],
          due: { date: "2026-03-01" },
        },
      ],
      emails: [],
      habits: [],
    });

    const first = seed.autoItems.find((item) => item.id === "task:child-1");
    const second = seed.autoItems.find((item) => item.id === "task:child-2");

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second?.startMs).toBe((first?.startMs || 0) + 10 * 60 * 1000);
  });

  it("groups similar tasks by project and shared wording token", () => {
    const seed = buildDayPlanSeed({
      now: new Date("2026-03-01T09:00:00-06:00"),
      calendarEvents: [],
      todoistTasks: [
        {
          id: "contract-1",
          projectId: "project-abp",
          content: "ABP contract review",
          labels: ["10m"],
          due: { date: "2026-03-01" },
        },
        {
          id: "contract-2",
          projectId: "project-abp",
          content: "ABP contract update",
          labels: ["10m"],
          due: { date: "2026-03-01" },
        },
      ],
      emails: [],
      habits: [],
    });

    const first = seed.autoItems.find((item) => item.id === "task:contract-1");
    const second = seed.autoItems.find((item) => item.id === "task:contract-2");

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second?.startMs).toBe((first?.startMs || 0) + 10 * 60 * 1000);
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

    const removed = removePlanItemOverride({ addedItems: [], removedIds: [], orderedIds: [] }, "task:base");
    const merged = mergePlanWithOverrides(autoItems, removed);
    expect(merged.find((item) => item.id === "task:base")).toBeUndefined();
  });

  it("respects persisted manual order across reload", () => {
    const dateKey = "2026-03-01";
    const storage = createMemoryStorage();
    const autoItems: PlanItemData[] = [
      {
        id: "task:first",
        type: "task",
        source: "todoist",
        title: "First task",
        timeLabel: "10:00 AM • 30m",
        sortMs: 10,
        startMs: 10,
        durationMinutes: 30,
        dueTime: false,
        dateKey,
      },
      {
        id: "task:second",
        type: "task",
        source: "todoist",
        title: "Second task",
        timeLabel: "10:30 AM • 30m",
        sortMs: 20,
        startMs: 20,
        durationMinutes: 30,
        dueTime: false,
        dateKey,
      },
    ];

    const initial = loadPlanOverrides(dateKey, storage);
    const reordered = setPlanOrderOverride(initial, ["task:second", "task:first"]);
    savePlanOverrides(dateKey, reordered, storage);
    const loaded = loadPlanOverrides(dateKey, storage);
    const merged = mergePlanWithOverrides(autoItems, loaded);

    expect(merged[0]?.id).toBe("task:second");
    expect(merged[1]?.id).toBe("task:first");
  });
});

describe("Plan item text wrapping", () => {
  it("uses wrapping classes so long titles do not overflow", () => {
    expect(PLAN_ITEM_TITLE_CLASS).toContain("whitespace-normal");
    expect(PLAN_ITEM_TITLE_CLASS).toContain("break-words");
  });
});
