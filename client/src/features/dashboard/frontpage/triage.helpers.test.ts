import { describe, expect, it } from "vitest";
import {
  dueLabel,
  priorityClass,
  priorityLabel,
  projectLabel,
  splitTriageBands,
} from "./triage.helpers";
import type { TodoistTask } from "../types";

const NOW = new Date(2026, 3, 20, 10, 0, 0); // 2026-04-20 10:00 local

function task(
  id: string,
  content: string,
  priority: 1 | 2 | 3 | 4,
  due?: string | null,
  extras: Partial<TodoistTask> & { projectName?: string } = {}
): TodoistTask {
  return {
    id,
    content,
    priority,
    due: due ? { date: due } : null,
    ...extras,
  } as unknown as TodoistTask;
}

describe("splitTriageBands", () => {
  it("partitions overdue from today by due date", () => {
    const bands = splitTriageBands(
      [
        task("a", "yesterday P3", 2, "2026-04-19"),
        task("b", "today P1", 4, "2026-04-20"),
        task("c", "today P3", 2, "2026-04-20"),
      ],
      NOW
    );
    expect(bands.overdue.map((t) => t.id)).toEqual(["a"]);
    expect(bands.today.map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("sorts each band by priority (P1 first)", () => {
    const bands = splitTriageBands(
      [
        task("low", "low", 1, "2026-04-20"),
        task("high", "high", 4, "2026-04-20"),
        task("mid", "mid", 3, "2026-04-20"),
      ],
      NOW
    );
    expect(bands.today.map((t) => t.id)).toEqual(["high", "mid", "low"]);
  });

  it("caps overdue at 6 and today at 8 by default", () => {
    const overdueTasks = Array.from({ length: 10 }, (_, i) =>
      task(`o${i}`, `overdue ${i}`, 4, "2026-04-19")
    );
    const todayTasks = Array.from({ length: 12 }, (_, i) =>
      task(`t${i}`, `today ${i}`, 2, "2026-04-20")
    );
    const bands = splitTriageBands([...overdueTasks, ...todayTasks], NOW);
    expect(bands.overdue).toHaveLength(6);
    expect(bands.today).toHaveLength(8);
  });

  it("respects custom caps", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      task(`o${i}`, `t${i}`, 4, "2026-04-19")
    );
    const bands = splitTriageBands(tasks, NOW, { overdue: 2, today: 3 });
    expect(bands.overdue).toHaveLength(2);
  });

  it("returns empty bands for an empty list", () => {
    expect(splitTriageBands([], NOW)).toEqual({ overdue: [], today: [] });
  });
});

describe("priorityLabel", () => {
  it("maps Todoist priority numbers to P1-P4", () => {
    expect(priorityLabel(task("a", "x", 4))).toBe("P1");
    expect(priorityLabel(task("a", "x", 3))).toBe("P2");
    expect(priorityLabel(task("a", "x", 2))).toBe("P3");
    expect(priorityLabel(task("a", "x", 1))).toBe("P4");
  });

  it("defaults missing priority to P4", () => {
    const t = { id: "x", content: "y", due: null } as unknown as TodoistTask;
    expect(priorityLabel(t)).toBe("P4");
  });
});

describe("priorityClass", () => {
  it("maps the highest two priorities to filled / striped", () => {
    expect(priorityClass(task("a", "x", 4))).toBe("fp-triage-row__bx--p1");
    expect(priorityClass(task("a", "x", 3))).toBe("fp-triage-row__bx--p2");
  });

  it("everything else falls into --p3", () => {
    expect(priorityClass(task("a", "x", 2))).toBe("fp-triage-row__bx--p3");
    expect(priorityClass(task("a", "x", 1))).toBe("fp-triage-row__bx--p3");
  });
});

describe("projectLabel", () => {
  it("returns the trimmed projectName when present", () => {
    expect(
      projectLabel(task("a", "x", 1, null, { projectName: "  Inbox  " }))
    ).toBe("Inbox");
  });

  it("returns null when projectName is empty / whitespace / missing", () => {
    expect(projectLabel(task("a", "x", 1))).toBeNull();
    expect(projectLabel(task("a", "x", 1, null, { projectName: "" }))).toBeNull();
    expect(projectLabel(task("a", "x", 1, null, { projectName: "   " }))).toBeNull();
  });
});

describe("dueLabel", () => {
  it("returns 'today' for a date-only string", () => {
    expect(dueLabel(task("a", "x", 1, "2026-04-20"))).toBe("today");
  });

  it("returns a localized clock time for date+time", () => {
    const out = dueLabel(task("a", "x", 1, "2026-04-20T13:45:00"));
    // The exact format depends on Intl, but it must contain the hour and minute.
    expect(out).toMatch(/1:45/);
  });

  it("returns null when due is missing", () => {
    expect(dueLabel(task("a", "x", 1))).toBeNull();
  });

  it("returns null for a malformed datetime that LOOKS like a time", () => {
    // Has Tdd:dd → triggers the parsing branch → invalid Date → null.
    expect(dueLabel(task("a", "x", 1, "2026-99-99T99:99:99"))).toBeNull();
  });

  it("treats anything without Thh:mm as a bare date → 'today'", () => {
    // Note: this is the existing (intentional) shape — a bare date
    // means "due today" because Todoist's date-only field has no clock
    // component to render.
    expect(dueLabel(task("a", "x", 1, "not-a-date"))).toBe("today");
  });
});
