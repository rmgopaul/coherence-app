export type PlanItemType = "event" | "task" | "habit";
export type PlanItemSource = "calendar" | "todoist" | "habit" | "suggestion";

export type PlanItemData = {
  id: string;
  type: PlanItemType;
  source: PlanItemSource;
  title: string;
  timeLabel: string;
  sortMs: number;
  startMs?: number;
  durationMinutes?: number;
  dueTime: boolean;
  dateKey?: string;
  sourceUrl?: string;
};
