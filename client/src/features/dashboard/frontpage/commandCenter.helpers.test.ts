import { describe, expect, it } from "vitest";

import type { PersonalDashboardDailyProgress } from "@shared/personalDashboard";
import { buildWorkflowReviewPrompts } from "./commandCenter.helpers";

const baseProgress: PersonalDashboardDailyProgress = {
  dailyBriefStatus: "ready",
  todayPlanStatus: "ready",
  headline: "Morning brief",
  topPriority: "Close proposal",
  updatedAt: "2026-05-14T14:00:00.000Z",
  commitments: {
    total: 2,
    open: 1,
    waiting: 0,
    blocked: 0,
    done: 1,
  },
  outcomes: {
    total: 1,
    active: 1,
    paused: 0,
    won: 0,
    missed: 0,
  },
  tone: "planned",
};

describe("commandCenter helpers", () => {
  it("prioritizes missing workflow setup prompts", () => {
    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        dailyBriefStatus: "not_started",
        todayPlanStatus: "not_started",
      })
    ).toEqual(["Draft today's brief", "Set today's plan"]);
  });

  it("surfaces failed daily brief review before setup prompts", () => {
    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        dailyBriefStatus: "failed",
        todayPlanStatus: "not_started",
      })
    ).toEqual(["Review failed daily brief", "Set today's plan"]);
  });

  it("summarizes blocked, waiting, and missed review prompts", () => {
    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        commitments: {
          total: 4,
          open: 0,
          waiting: 2,
          blocked: 1,
          done: 1,
        },
        outcomes: {
          total: 3,
          active: 0,
          paused: 0,
          won: 1,
          missed: 2,
        },
      })
    ).toEqual([
      "Review 1 blocked commitment",
      "Check 2 waiting commitments",
      "Review 2 missed outcomes",
    ]);
  });

  it("surfaces end-of-day closure prompts", () => {
    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        todayPlanStatus: "completed",
        tone: "complete",
      })
    ).toEqual(["Close 1 active outcome"]);

    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        todayPlanStatus: "completed",
        outcomes: {
          total: 1,
          active: 0,
          paused: 0,
          won: 1,
          missed: 0,
        },
        tone: "complete",
      })
    ).toEqual(["Ready for end-of-day review"]);
  });
});
