import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar, CheckSquare, RefreshCw, Target } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PlanItem } from "./PlanItem";
import { RightNow } from "./RightNow";
import { SuggestedAction } from "./SuggestedAction";
import type { PlanItemData } from "./types";

type TodaysPlanProps = {
  calendarEvents: any[];
  todoistTasks: any[];
  habits: any[];
};

type SuggestedPlanAction = {
  id: string;
  description: string;
  title: string;
  timeLabel: string;
};

const toDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getTaskDateKey = (task: any): string | null => {
  if (typeof task?.due?.date === "string" && task.due.date.length >= 10) {
    return task.due.date.slice(0, 10);
  }
  if (typeof task?.due?.datetime === "string") {
    const date = new Date(task.due.datetime);
    if (!Number.isNaN(date.getTime())) return toDateKey(date);
  }
  return null;
};

const getEventDateKey = (event: any): string | null => {
  if (typeof event?.start?.date === "string" && event.start.date.length >= 10) {
    return event.start.date.slice(0, 10);
  }
  if (typeof event?.start?.dateTime === "string") {
    const date = new Date(event.start.dateTime);
    if (!Number.isNaN(date.getTime())) return toDateKey(date);
  }
  return null;
};

const formatEventTime = (event: any): string => {
  const raw = event?.start?.dateTime || event?.start?.date;
  if (!raw) return "Time not set";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "Time not set";
  if (event?.start?.date) return `${date.toLocaleDateString("en-US", { weekday: "short" })} all-day`;
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};

const formatTaskTime = (task: any): string => {
  const dueDateTime = task?.due?.datetime || task?.due?.date;
  if (!dueDateTime) return "No due time";
  const date = new Date(dueDateTime);
  if (Number.isNaN(date.getTime())) return "No due time";
  if (task?.due?.datetime) return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `Due ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
};

const sortTimestampForEvent = (event: any): number => {
  const raw = event?.start?.dateTime || event?.start?.date;
  const ms = raw ? new Date(raw).getTime() : Number.MAX_SAFE_INTEGER - 10;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER - 10;
};

const sortTimestampForTask = (task: any): number => {
  const raw = task?.due?.datetime || task?.due?.date;
  const ms = raw ? new Date(raw).getTime() : Number.MAX_SAFE_INTEGER;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
};

const sortTimestampForHabit = (index: number): number => Number.MAX_SAFE_INTEGER - 1000 + index;

function reorderPlan(items: PlanItemData[], fromId: string, toId: string): PlanItemData[] {
  const fromIndex = items.findIndex((item) => item.id === fromId);
  const toIndex = items.findIndex((item) => item.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

const allocateGapItems = (queue: PlanItemData[], gapMinutes: number): PlanItemData[] => {
  if (queue.length === 0) return [];
  const slots = Math.min(queue.length, Math.max(0, Math.floor(gapMinutes / 45)));
  if (slots <= 0) return [];
  return queue.splice(0, slots);
};

export function TodaysPlan({ calendarEvents, todoistTasks, habits }: TodaysPlanProps) {
  const planSeed = useMemo(() => {
    const now = new Date();
    const todayKey = toDateKey(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const tomorrowKey = toDateKey(tomorrow);

    const todayEvents = (calendarEvents || []).filter((event: any) => getEventDateKey(event) === todayKey);
    const tomorrowEvents = (calendarEvents || []).filter((event: any) => getEventDateKey(event) === tomorrowKey);
    const todayTasks = (todoistTasks || []).filter((task: any) => getTaskDateKey(task) === todayKey);
    const tomorrowTasks = (todoistTasks || []).filter((task: any) => getTaskDateKey(task) === tomorrowKey);

    const hasTodayCoreItems = todayEvents.length + todayTasks.length > 0;
    const targetDateKey = hasTodayCoreItems ? todayKey : tomorrowKey;
    const targetEvents = hasTodayCoreItems ? todayEvents : tomorrowEvents;
    const targetTasks = hasTodayCoreItems ? todayTasks : tomorrowTasks;
    const dayLabel = hasTodayCoreItems ? "Today's Plan" : "Tomorrow's Plan";

    const targetHabits = (habits || []).filter((habit: any) => {
      if (!habit?.name) return false;
      if (!hasTodayCoreItems) return true;
      return !habit?.completed;
    });

    const eventItems: PlanItemData[] = targetEvents.map((event: any) => ({
      id: `event:${String(event.id || Math.random())}`,
      type: "event",
      title: String(event.summary || "Untitled event"),
      timeLabel: formatEventTime(event),
      sortMs: sortTimestampForEvent(event),
      sourceUrl: typeof event.htmlLink === "string" ? event.htmlLink : undefined,
    }));

    const taskItems: PlanItemData[] = targetTasks.map((task: any) => ({
      id: `task:${String(task.id || Math.random())}`,
      type: "task",
      title: String(task.content || "Untitled task"),
      timeLabel: formatTaskTime(task),
      sortMs: sortTimestampForTask(task),
      sourceUrl:
        typeof task.url === "string" && task.url.length > 0
          ? task.url
          : `https://todoist.com/app/task/${String(task.id || "")}`,
    }));

    const habitItems: PlanItemData[] = targetHabits.map((habit: any, index: number) => ({
      id: `habit:${String(habit.id || index)}`,
      type: "habit",
      title: String(habit.name),
      timeLabel: "Routine habit",
      sortMs: sortTimestampForHabit(index),
    }));

    const sortedEvents = [...eventItems].sort((a, b) => a.sortMs - b.sortMs);
    const flexibleQueue = [...taskItems, ...habitItems].sort((a, b) => a.sortMs - b.sortMs);

    if (sortedEvents.length === 0) {
      return {
        dayLabel,
        items: [...flexibleQueue],
      };
    }

    const sequenced: PlanItemData[] = [];
    let cursor = sortedEvents[0].sortMs;
    for (let i = 0; i < sortedEvents.length; i += 1) {
      const current = sortedEvents[i];
      const currentStart = current.sortMs;
      if (i > 0) {
        const gapMinutes = Math.max(0, Math.round((currentStart - cursor) / 60000));
        const injected = allocateGapItems(flexibleQueue, gapMinutes);
        sequenced.push(...injected);
      } else {
        const firstGap = Math.max(0, Math.round((currentStart - new Date(`${targetDateKey}T08:00:00`).getTime()) / 60000));
        const injected = allocateGapItems(flexibleQueue, firstGap);
        sequenced.push(...injected);
      }

      sequenced.push(current);
      cursor = currentStart + 60 * 60000;
    }

    if (flexibleQueue.length > 0) {
      sequenced.push(...flexibleQueue);
    }

    return {
      dayLabel,
      items: sequenced,
    };
  }, [calendarEvents, todoistTasks, habits]);

  const mergedPlanItems = planSeed.items;

  const [planItems, setPlanItems] = useState<PlanItemData[]>(mergedPlanItems);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    setPlanItems(mergedPlanItems);
  }, [mergedPlanItems]);

  const suggestions = useMemo<SuggestedPlanAction[]>(
    () => [
      {
        id: "suggestion:walk-break",
        description: "Your WHOOP recovery is low. Schedule a 15-min walk?",
        title: "15-min recovery walk",
        timeLabel: "Suggested action",
      },
      {
        id: "suggestion:focus-sprint",
        description: "You have multiple tasks due today. Add a 30-min focus sprint now?",
        title: "30-min focus sprint",
        timeLabel: "Suggested action",
      },
    ],
    []
  );

  const handlePrimaryAction = (item: PlanItemData) => {
    if (item.sourceUrl) {
      window.open(item.sourceUrl, "_blank", "noopener,noreferrer");
      return;
    }
    console.log("[RightNow] primary action clicked", item);
  };

  const handleAddSuggestionToPlan = (suggestion: SuggestedPlanAction) => {
    setPlanItems((prev) => {
      if (prev.some((item) => item.id === suggestion.id)) return prev;

      const newItem: PlanItemData = {
        id: suggestion.id,
        type: "task",
        title: suggestion.title,
        timeLabel: suggestion.timeLabel,
        sortMs: Date.now(),
      };

      // Keep "Right now" as first element if present, and insert suggestion next.
      if (prev.length > 0) return [prev[0], newItem, ...prev.slice(1)];
      return [newItem];
    });

    toast.success("Added to today's plan");
  };

  return (
    <div className="space-y-4">
      <RightNow item={planItems[0] ?? null} onPrimaryAction={handlePrimaryAction} />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">{planSeed.dayLabel}</CardTitle>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <RefreshCw className="h-3.5 w-3.5" />
              Drag to reorder
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {planItems.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-600">
              No events, tasks, or habits available for this plan window.
            </div>
          ) : (
            <ul className="space-y-2">
              {planItems.map((item) => (
                <PlanItem
                  key={item.id}
                  item={item}
                  onDragStart={(id) => setDraggingId(id)}
                  onDragOver={() => {
                    // Allow drop while preserving keyboard/tab flow.
                  }}
                  onDrop={(targetId) => {
                    if (!draggingId) return;
                    setPlanItems((prev) => reorderPlan(prev, draggingId, targetId));
                    setDraggingId(null);
                  }}
                />
              ))}
            </ul>
          )}

          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Legend</p>
            <div className="mt-1 flex items-center gap-3 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                Event
              </span>
              <span className="inline-flex items-center gap-1">
                <CheckSquare className="h-3.5 w-3.5" />
                Task
              </span>
              <span className="inline-flex items-center gap-1">
                <Target className="h-3.5 w-3.5" />
                Habit
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Suggested Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {suggestions.map((suggestion) => (
            <SuggestedAction
              key={suggestion.id}
              description={suggestion.description}
              added={planItems.some((item) => item.id === suggestion.id)}
              onAddToPlan={() => handleAddSuggestionToPlan(suggestion)}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
