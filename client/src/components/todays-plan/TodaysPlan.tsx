import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar, CheckSquare, Mail, RefreshCw, Target } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PlanItem } from "./PlanItem";
import { RightNow } from "./RightNow";
import { SuggestedAction } from "./SuggestedAction";
import {
  addOverrideItem,
  loadPlanOverrides,
  mergePlanWithOverrides,
  removePlanItemOverride,
  savePlanOverrides,
  type PersistedPlanOverrides,
} from "./persistence";
import { buildDayPlanSeed, PLAN_SOURCE_PRIORITY } from "./scheduler";
import type { PlanItemData } from "./types";

type TodaysPlanProps = {
  calendarEvents: any[];
  todoistTasks: any[];
  emails: any[];
  habits: any[];
  onCompleteHabit?: (habitId: string) => void;
};

type SuggestedPlanAction = {
  id: string;
  description: string;
  title: string;
  durationMinutes: number;
};

type GroupedRow = {
  slotKey: string;
  sortMs: number;
  items: PlanItemData[];
};

function reorderPlan(items: PlanItemData[], fromId: string, toId: string): PlanItemData[] {
  const fromIndex = items.findIndex((item) => item.id === fromId);
  const toIndex = items.findIndex((item) => item.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

const roundToNextFiveMinutes = (ms: number): number => {
  const intervalMs = 5 * 60 * 1000;
  return Math.ceil(ms / intervalMs) * intervalMs;
};

const formatStartTimeLabel = (startMs: number, durationMinutes: number): string => {
  const date = new Date(startMs);
  return `${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} • ${durationMinutes}m`;
};

const toSlotKey = (item: PlanItemData): string => {
  if (Number.isFinite(item.startMs)) {
    const date = new Date(item.startMs as number);
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }
  return `item:${item.id}`;
};

export function TodaysPlan({ calendarEvents, todoistTasks, emails, habits, onCompleteHabit }: TodaysPlanProps) {
  const seed = useMemo(
    () =>
      buildDayPlanSeed({
        calendarEvents: calendarEvents || [],
        todoistTasks: todoistTasks || [],
        emails: emails || [],
        habits: habits || [],
      }),
    [calendarEvents, todoistTasks, emails, habits]
  );

  const [overrides, setOverrides] = useState<PersistedPlanOverrides>({ addedItems: [], removedIds: [] });
  const [planItems, setPlanItems] = useState<PlanItemData[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    const loaded = loadPlanOverrides(seed.dateKey);
    setOverrides(loaded);
  }, [seed.dateKey]);

  useEffect(() => {
    savePlanOverrides(seed.dateKey, overrides);
  }, [seed.dateKey, overrides]);

  const mergedPlanItems = useMemo(
    () => mergePlanWithOverrides(seed.autoItems, overrides),
    [seed.autoItems, overrides]
  );

  useEffect(() => {
    setPlanItems(mergedPlanItems);
  }, [mergedPlanItems]);

  const suggestions = useMemo<SuggestedPlanAction[]>(
    () => [
      {
        id: "suggestion:walk-break",
        description: "Your WHOOP recovery is low. Schedule a 15-min walk?",
        title: "15-min recovery walk",
        durationMinutes: 15,
      },
      {
        id: "suggestion:focus-sprint",
        description: "You have multiple tasks due today. Add a 30-min focus sprint now?",
        title: "30-min focus sprint",
        durationMinutes: 30,
      },
    ],
    []
  );

  const handlePrimaryAction = (item: PlanItemData) => {
    if (item.sourceUrl) {
      window.open(item.sourceUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (item.type === "habit" && onCompleteHabit) {
      const habitId = item.id.startsWith("habit:") ? item.id.slice("habit:".length) : item.id;
      onCompleteHabit(habitId);
      return;
    }
    toast.info("No linked source available for this item yet.");
  };

  const handleAddSuggestionToPlan = (suggestion: SuggestedPlanAction) => {
    const startMs = roundToNextFiveMinutes(Date.now());
    const newItem: PlanItemData = {
      id: suggestion.id,
      type: "task",
      source: "suggestion",
      title: suggestion.title,
      timeLabel: formatStartTimeLabel(startMs, suggestion.durationMinutes),
      sortMs: startMs,
      startMs,
      durationMinutes: suggestion.durationMinutes,
      dueTime: false,
      dateKey: seed.dateKey,
    };

    setOverrides((prev) => addOverrideItem(prev, newItem));
    setPlanItems((prev) => {
      if (prev.some((item) => item.id === newItem.id)) return prev;
      if (prev.length === 0) return [newItem];
      return [prev[0], newItem, ...prev.slice(1)];
    });
    toast.success("Added to today's plan");
  };

  const handleRemovePlanItem = (itemId: string) => {
    setOverrides((prev) => removePlanItemOverride(prev, itemId));
    setPlanItems((prev) => prev.filter((item) => item.id !== itemId));
    toast.success("Removed from today's plan");
  };

  const handleCompleteHabitFromPlan = (item: PlanItemData) => {
    if (!onCompleteHabit) return;
    const habitId = item.id.startsWith("habit:") ? item.id.slice("habit:".length) : item.id;
    onCompleteHabit(habitId);
  };

  const groupedRows = useMemo<GroupedRow[]>(() => {
    const sorted = [...planItems].sort((a, b) => {
      if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
      const sourcePriorityDelta = (PLAN_SOURCE_PRIORITY[a.source] ?? 99) - (PLAN_SOURCE_PRIORITY[b.source] ?? 99);
      if (sourcePriorityDelta !== 0) return sourcePriorityDelta;
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    });

    const rowsByKey = new Map<string, GroupedRow>();
    for (const item of sorted) {
      const slotKey = toSlotKey(item);
      const existing = rowsByKey.get(slotKey);
      if (existing) {
        existing.items.push(item);
        continue;
      }
      rowsByKey.set(slotKey, {
        slotKey,
        sortMs: item.sortMs,
        items: [item],
      });
    }

    return Array.from(rowsByKey.values()).sort((a, b) => a.sortMs - b.sortMs);
  }, [planItems]);

  return (
    <div className="space-y-4">
      <RightNow item={planItems[0] ?? null} onPrimaryAction={handlePrimaryAction} />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">{seed.dayLabel}</CardTitle>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <RefreshCw className="h-3.5 w-3.5" />
              Drag to reorder
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {groupedRows.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-600">
              No events, tasks, or habits available for this plan window.
            </div>
          ) : (
            <ul className="space-y-2">
              {groupedRows.map((row) => (
                <li key={row.slotKey} className="space-y-2">
                  <div className={`grid gap-2 ${row.items.length > 1 ? "md:grid-cols-2" : "grid-cols-1"}`}>
                    {row.items.map((item) => (
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
                        onOpenSource={handlePrimaryAction}
                        onCompleteHabit={handleCompleteHabitFromPlan}
                        onRemove={handleRemovePlanItem}
                      />
                    ))}
                  </div>
                </li>
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
                <Mail className="h-3.5 w-3.5" />
                Email deadline
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
