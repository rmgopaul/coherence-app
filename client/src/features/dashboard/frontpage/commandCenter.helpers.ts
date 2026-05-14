import type { PersonalDashboardDailyProgress } from "@shared/personalDashboard";

export function buildWorkflowReviewPrompts(
  progress: PersonalDashboardDailyProgress
): string[] {
  const prompts: string[] = [];

  if (progress.dailyBriefStatus === "failed") {
    prompts.push("Review failed daily brief");
  } else if (progress.dailyBriefStatus === "not_started") {
    prompts.push("Draft today's brief");
  }
  if (progress.todayPlanStatus === "not_started") {
    prompts.push("Set today's plan");
  }
  if (progress.commitments.blocked > 0) {
    prompts.push(
      `Review ${formatCountedLabel(
        progress.commitments.blocked,
        "blocked commitment"
      )}`
    );
  }
  if (progress.commitments.waiting > 0) {
    prompts.push(
      `Check ${formatCountedLabel(
        progress.commitments.waiting,
        "waiting commitment"
      )}`
    );
  }
  if (progress.outcomes.missed > 0) {
    prompts.push(
      `Review ${formatCountedLabel(progress.outcomes.missed, "missed outcome")}`
    );
  }
  if (
    progress.outcomes.active > 0 &&
    progress.todayPlanStatus === "completed"
  ) {
    prompts.push(
      `Close ${formatCountedLabel(progress.outcomes.active, "active outcome")}`
    );
  }
  if (prompts.length === 0 && progress.tone === "complete") {
    prompts.push("Ready for end-of-day review");
  }

  return prompts.slice(0, 3);
}

function formatCountedLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}
