import { Calendar, CheckSquare, GripVertical, Mail, Target, X } from "lucide-react";
import type { PlanItemData } from "./types";

type PlanItemProps = {
  item: PlanItemData;
  onDragStart: (id: string) => void;
  onDragEnd?: () => void;
  onDrop: (targetId: string) => void;
  hideTimeLabel?: boolean;
  onRemove?: (id: string) => void;
  onOpenSource?: (item: PlanItemData) => void;
  onCompleteHabit?: (item: PlanItemData) => void;
};

export const PLAN_ITEM_TITLE_CLASS = "whitespace-normal break-words text-sm font-semibold text-slate-900";

export function PlanItem({
  item,
  onDragStart,
  onDragEnd,
  onDrop,
  hideTimeLabel = false,
  onRemove,
  onOpenSource,
  onCompleteHabit,
}: PlanItemProps) {
  const isEvent = item.type === "event";
  const isEmailDeadline = item.source === "email";
  const isTask = item.type === "task" && !isEmailDeadline;
  const isHabit = item.type === "habit";
  const canOpenSource = Boolean(item.sourceUrl) && !isHabit;
  const sourceStyles = isEvent
    ? "border-blue-200 bg-blue-50/40"
    : isEmailDeadline
      ? "border-amber-200 bg-amber-50/50"
      : isTask
        ? "border-emerald-200 bg-emerald-50/30"
        : "border-violet-200 bg-violet-50/30";

  return (
    <div
      draggable
      onDragStart={(event) => {
        // Some browsers require a transfer payload for drag-and-drop to activate.
        event.dataTransfer.setData("text/plain", item.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart(item.id);
      }}
      onDragEnd={() => onDragEnd?.()}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(item.id);
      }}
      className={`group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition hover:bg-white ${sourceStyles}`}
      aria-label={`${isEvent ? "Calendar event" : isEmailDeadline ? "Email deadline" : isTask ? "Task" : "Habit"} ${item.title}`}
    >
      <span
        className="cursor-grab rounded p-1 text-slate-400 transition group-hover:text-slate-600"
        aria-hidden="true"
        title="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </span>

      <span className="rounded-md bg-slate-100 p-1.5 text-slate-700" aria-hidden="true">
        {isEvent ? (
          <Calendar className="h-4 w-4" />
        ) : isEmailDeadline ? (
          <Mail className="h-4 w-4" />
        ) : isTask ? (
          <CheckSquare className="h-4 w-4" />
        ) : (
          <Target className="h-4 w-4" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className={PLAN_ITEM_TITLE_CLASS}>{item.title}</p>
        {!hideTimeLabel ? <p className="text-xs text-slate-500">{item.timeLabel}</p> : null}
      </div>

      <div className="flex items-center gap-1.5">
        {canOpenSource && onOpenSource ? (
          <button
            type="button"
            className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label={`Open ${item.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSource(item);
            }}
          >
            Open
          </button>
        ) : null}
        {isHabit && onCompleteHabit ? (
          <button
            type="button"
            className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label={`Mark ${item.title} done`}
            onClick={(event) => {
              event.stopPropagation();
              onCompleteHabit(item);
            }}
          >
            Mark done
          </button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label={`Remove ${item.title} from plan`}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(item.id);
            }}
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
