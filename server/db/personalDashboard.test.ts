import { describe, expect, it } from "vitest";

import { normalizePersonalDashboardDailyState } from "./personalDashboard";

describe("personal dashboard daily state normalization", () => {
  it("returns stable empty state when no row exists", () => {
    expect(normalizePersonalDashboardDailyState(null, "2026-05-14")).toEqual({
      dateKey: "2026-05-14",
      dailyBriefStatus: "not_started",
      dailyBrief: null,
      todayPlanStatus: "not_started",
      todayPlan: null,
      commitments: [],
      outcomes: [],
      updatedAt: null,
    });
  });

  it("parses stored dashboard artifacts defensively", () => {
    const row = {
      id: "state-1",
      userId: 1,
      dateKey: "2026-05-14",
      dailyBriefStatus: "ready" as const,
      dailyBriefJson: JSON.stringify({
        headline: "Protect the client follow-up",
        summary: null,
        generatedAt: "2026-05-14T13:00:00.000Z",
        sourceRefs: [],
      }),
      todayPlanStatus: "ready" as const,
      todayPlanJson: JSON.stringify({
        topPriority: "Close proposal",
        notes: null,
        blocks: [],
        updatedAt: "2026-05-14T13:05:00.000Z",
      }),
      commitmentsJson: "not-json",
      outcomesJson: JSON.stringify([
        {
          id: "outcome-1",
          title: "Proposal sent",
          status: "active",
          metricLabel: "Sent",
          target: "Today",
          current: "Drafted",
        },
      ]),
      createdAt: new Date("2026-05-14T12:00:00.000Z"),
      updatedAt: new Date("2026-05-14T13:05:00.000Z"),
    };

    expect(normalizePersonalDashboardDailyState(row, "ignored")).toMatchObject({
      dateKey: "2026-05-14",
      dailyBriefStatus: "ready",
      dailyBrief: { headline: "Protect the client follow-up" },
      todayPlanStatus: "ready",
      todayPlan: { topPriority: "Close proposal" },
      commitments: [],
      outcomes: [{ id: "outcome-1", title: "Proposal sent" }],
      updatedAt: "2026-05-14T13:05:00.000Z",
    });
  });
});
