/**
 * Task 10.1 (2026-04-28) — tests for the SignalActions
 * applicability matrix + supporting pure helpers.
 */
import { describe, expect, it } from "vitest";
import {
  applicableActions,
  dockSourceFor,
  rowTitle,
  rowUrl,
  SIGNAL_ACTION_LABELS,
  type SignalRow,
} from "./signalActions";

const gmailRow: SignalRow = {
  kind: "gmail",
  messageId: "msg-1",
  subject: "401k rebalance",
  threadUrl: "https://mail.google.com/mail/u/0/#inbox/abc",
};

const todoistRow: SignalRow = {
  kind: "todoist",
  taskId: "task-1",
  content: "Mail the contracts",
  taskUrl: "https://todoist.com/showTask?id=task-1",
};

const calendarRow: SignalRow = {
  kind: "calendar",
  eventId: "evt-1",
  title: "Stand-up",
  eventUrl: "https://calendar.google.com/calendar/u/0/r/eventedit/abc",
};

const genericRow: SignalRow = {
  kind: "generic",
  id: "x",
  title: "Read this",
  href: "https://example.com/article",
};

describe("applicableActions", () => {
  it("includes Drop to Dock + Pin as King for every kind", () => {
    for (const row of [gmailRow, todoistRow, calendarRow, genericRow]) {
      const actions = applicableActions(row);
      expect(actions).toContain("drop-to-dock");
      expect(actions).toContain("pin-as-king");
    }
  });

  it("includes Create Todoist Task for non-todoist kinds", () => {
    expect(applicableActions(gmailRow)).toContain("create-todoist-task");
    expect(applicableActions(calendarRow)).toContain("create-todoist-task");
    expect(applicableActions(genericRow)).toContain("create-todoist-task");
  });

  it("excludes Create Todoist Task for todoist rows (no point converting a task into itself)", () => {
    expect(applicableActions(todoistRow)).not.toContain("create-todoist-task");
  });

  it("includes Archive only for gmail rows", () => {
    expect(applicableActions(gmailRow)).toContain("archive-gmail");
    expect(applicableActions(todoistRow)).not.toContain("archive-gmail");
    expect(applicableActions(calendarRow)).not.toContain("archive-gmail");
    expect(applicableActions(genericRow)).not.toContain("archive-gmail");
  });

  it("includes Defer only for todoist rows", () => {
    expect(applicableActions(todoistRow)).toContain("defer-todoist");
    expect(applicableActions(gmailRow)).not.toContain("defer-todoist");
    expect(applicableActions(calendarRow)).not.toContain("defer-todoist");
    expect(applicableActions(genericRow)).not.toContain("defer-todoist");
  });

  it("orders generic actions before kind-specific ones", () => {
    const gmail = applicableActions(gmailRow);
    expect(gmail.indexOf("drop-to-dock")).toBeLessThan(
      gmail.indexOf("archive-gmail")
    );
    expect(gmail.indexOf("pin-as-king")).toBeLessThan(
      gmail.indexOf("archive-gmail")
    );
    expect(gmail.indexOf("create-todoist-task")).toBeLessThan(
      gmail.indexOf("archive-gmail")
    );
    const todoist = applicableActions(todoistRow);
    expect(todoist.indexOf("drop-to-dock")).toBeLessThan(
      todoist.indexOf("defer-todoist")
    );
  });
});

describe("dockSourceFor", () => {
  it("maps each row kind to a dock-supported source", () => {
    expect(dockSourceFor("gmail")).toBe("gmail");
    expect(dockSourceFor("todoist")).toBe("todoist");
    expect(dockSourceFor("calendar")).toBe("gcal");
    expect(dockSourceFor("generic")).toBe("url");
  });
});

describe("rowTitle / rowUrl", () => {
  it("rowTitle returns the per-kind title field", () => {
    expect(rowTitle(gmailRow)).toBe("401k rebalance");
    expect(rowTitle(todoistRow)).toBe("Mail the contracts");
    expect(rowTitle(calendarRow)).toBe("Stand-up");
    expect(rowTitle(genericRow)).toBe("Read this");
  });

  it("rowUrl returns the per-kind URL field", () => {
    expect(rowUrl(gmailRow)).toBe(
      "https://mail.google.com/mail/u/0/#inbox/abc"
    );
    expect(rowUrl(todoistRow)).toBe(
      "https://todoist.com/showTask?id=task-1"
    );
    expect(rowUrl(calendarRow)).toBe(
      "https://calendar.google.com/calendar/u/0/r/eventedit/abc"
    );
    expect(rowUrl(genericRow)).toBe("https://example.com/article");
  });
});

describe("SIGNAL_ACTION_LABELS", () => {
  it("provides a label for every action key", () => {
    // If a new action key is added, this test reminds the author
    // to add a label (the table is a Record, but the test catches
    // accidental empty strings or typos).
    for (const [, label] of Object.entries(SIGNAL_ACTION_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
