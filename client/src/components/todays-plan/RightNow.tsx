import { Button } from "@/components/ui/button";
import { Calendar, CheckSquare, PlayCircle, Target } from "lucide-react";
import type { PlanItemData } from "./types";

type RightNowProps = {
  item: PlanItemData | null;
  onPrimaryAction: (item: PlanItemData) => void;
};

export function RightNow({ item, onPrimaryAction }: RightNowProps) {
  if (!item) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Right now</p>
        <p className="mt-1 text-sm text-slate-700">No scheduled items yet. Add a task or event to start your plan.</p>
      </div>
    );
  }

  const isTask = item.type === "task";
  const isEvent = item.type === "event";
  const buttonLabel = isTask ? "Start Focus Session" : isEvent ? "Join Meeting" : "Start Habit";

  return (
    <div className="rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 via-white to-slate-50 p-4 shadow-[0_10px_24px_rgba(16,185,129,0.14)]">
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Right now</p>
      <div className="mt-2 flex items-start gap-3">
        <span className="rounded-md bg-white p-2 text-emerald-700">
          {isTask ? (
            <CheckSquare className="h-5 w-5" />
          ) : isEvent ? (
            <Calendar className="h-5 w-5" />
          ) : (
            <Target className="h-5 w-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold text-slate-900">{item.title}</p>
          <p className="text-sm text-slate-600">{item.timeLabel}</p>
        </div>
      </div>
      <div className="mt-3">
        <Button onClick={() => onPrimaryAction(item)} className="gap-2">
          <PlayCircle className="h-4 w-4" />
          {buttonLabel}
        </Button>
      </div>
    </div>
  );
}
