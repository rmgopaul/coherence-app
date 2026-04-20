/**
 * Today's habits for the standalone page — larger and more detailed than
 * the dashboard HabitsCard. Shows each habit as a toggle tile with name,
 * streak, and a 7-day calendar of past completions.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { toErrorMessage, toLocalDateKey } from "@/lib/helpers";
import { trpc } from "@/lib/trpc";
import type { HabitEntry, HabitStreakRow } from "@/features/dashboard/types";
import { formatStreak } from "./habits.helpers";

export interface HabitsTodayPanelProps {
  habits: readonly HabitEntry[];
  streaks: readonly HabitStreakRow[];
  onChanged: () => void;
}

const COLOR_TO_BG: Record<string, string> = {
  slate: "bg-slate-600",
  emerald: "bg-emerald-600",
  blue: "bg-blue-600",
  violet: "bg-violet-600",
  rose: "bg-rose-600",
  amber: "bg-amber-600",
};

function bgFor(color: string | null | undefined): string {
  return COLOR_TO_BG[color ?? "slate"] ?? COLOR_TO_BG.slate;
}

export function HabitsTodayPanel({
  habits,
  streaks,
  onChanged,
}: HabitsTodayPanelProps) {
  const today = toLocalDateKey();
  const setCompletion = trpc.habits.setCompletion.useMutation();

  const streakByHabit = new Map(streaks.map((s) => [s.habitId, s]));

  async function toggle(habitId: string, completed: boolean) {
    try {
      await setCompletion.mutateAsync({ habitId, completed, dateKey: today });
      onChanged();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  if (habits.length === 0) {
    return (
      <div className="rounded-md border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        No habits yet. Add one from the Protocol tab.
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {habits.map((habit) => {
        const streakRow = streakByHabit.get(habit.id);
        const calendar = streakRow?.calendar ?? [];
        return (
          <Card key={habit.id} className="min-w-0">
            <CardContent className="space-y-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn(
                      "h-3 w-3 shrink-0 rounded-full",
                      bgFor(habit.color)
                    )}
                  />
                  <span className="truncate text-sm font-medium">
                    {habit.name}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatStreak(streakRow?.streak ?? 0)}
                </span>
              </div>

              <Button
                size="sm"
                variant={habit.completed ? "default" : "outline"}
                className={cn(
                  "w-full h-8 text-xs",
                  habit.completed && bgFor(habit.color),
                  habit.completed && "text-white hover:opacity-90"
                )}
                onClick={() => toggle(habit.id, !habit.completed)}
                disabled={setCompletion.isPending}
              >
                {habit.completed ? "Completed today" : "Mark complete"}
              </Button>

              {calendar.length > 0 ? (
                <div className="flex items-center gap-1 justify-end pt-1">
                  {calendar.map((cell, idx) => (
                    <div
                      key={`${habit.id}-${idx}`}
                      className={cn(
                        "h-2 w-2 rounded-full",
                        cell.completed ? bgFor(habit.color) : "bg-muted"
                      )}
                      title={cell.dateKey}
                    />
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
