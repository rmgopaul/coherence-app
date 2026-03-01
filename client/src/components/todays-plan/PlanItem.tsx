import { Calendar, CheckSquare, GripVertical, Target } from "lucide-react";
import type { PlanItemData } from "./types";

type PlanItemProps = {
  item: PlanItemData;
  onDragStart: (id: string) => void;
  onDragOver: () => void;
  onDrop: (targetId: string) => void;
};

export function PlanItem({ item, onDragStart, onDragOver, onDrop }: PlanItemProps) {
  const isEvent = item.type === "event";
  const isTask = item.type === "task";

  return (
    <li
      draggable
      onDragStart={() => onDragStart(item.id)}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(item.id);
      }}
      className="group flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 transition hover:bg-slate-50"
      aria-label={`${isEvent ? "Calendar event" : "Task"} ${item.title}`}
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
        ) : isTask ? (
          <CheckSquare className="h-4 w-4" />
        ) : (
          <Target className="h-4 w-4" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
        <p className="text-xs text-slate-500">{item.timeLabel}</p>
      </div>
    </li>
  );
}
