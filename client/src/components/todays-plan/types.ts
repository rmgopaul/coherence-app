export type PlanItemType = "event" | "task" | "habit";

export type PlanItemData = {
  id: string;
  type: PlanItemType;
  title: string;
  timeLabel: string;
  sortMs: number;
  sourceUrl?: string;
};
