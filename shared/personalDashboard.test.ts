import { describe, expect, it } from "vitest";
import {
  choosePersonalDashboardRightNow,
  makePersonalDashboardIntegrationHealth,
} from "./personalDashboard";

describe("personalDashboard shared helpers", () => {
  it("builds consistent integration health rows", () => {
    expect(
      makePersonalDashboardIntegrationHealth({
        key: "todoist",
        connected: true,
        lastSeenAt: new Date("2026-05-13T10:00:00.000Z"),
      })
    ).toEqual({
      key: "todoist",
      label: "Todoist",
      status: "connected",
      reason: null,
      connected: true,
      lastSeenAt: "2026-05-13T10:00:00.000Z",
      actionHref: "/settings",
    });
  });

  it("defaults missing integrations to actionable missing rows", () => {
    expect(
      makePersonalDashboardIntegrationHealth({
        key: "whoop",
        connected: false,
      })
    ).toMatchObject({
      key: "whoop",
      label: "WHOOP",
      status: "missing",
      connected: false,
      actionHref: "/settings",
    });
  });

  it("prioritizes right-now work by task, then meeting, then email", () => {
    const selected = choosePersonalDashboardRightNow({
      priorityTask: { id: "task-1", title: "Close proposal" },
      nextMeeting: { id: "event-1", title: "Standup" },
      urgentEmail: { id: "email-1", title: "Reply to approval" },
    });

    expect(selected).toMatchObject({
      kind: "todoist",
      sourceId: "task-1",
      title: "Close proposal",
    });
  });

  it("falls back to calendar when no task is urgent", () => {
    const selected = choosePersonalDashboardRightNow({
      nextMeeting: { id: "event-1", title: "Standup" },
      urgentEmail: { id: "email-1", title: "Reply to approval" },
    });

    expect(selected).toMatchObject({
      kind: "calendar",
      sourceId: "event-1",
    });
  });
});
