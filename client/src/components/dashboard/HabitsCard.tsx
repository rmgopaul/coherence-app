import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Target, RefreshCw } from "lucide-react";
import { SectionRating } from "@/components/SectionRating";
import { useLocation } from "wouter";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

const HABIT_COLOR_STYLES: Record<string, { active: string; inactive: string; dot: string }> = {
  slate: {
    active: "bg-slate-900 text-white border-slate-900",
    inactive: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700",
    dot: "bg-slate-600",
  },
  emerald: {
    active: "bg-emerald-600 text-white border-emerald-700",
    inactive: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
    dot: "bg-emerald-500",
  },
  blue: {
    active: "bg-emerald-700 text-white border-emerald-800",
    inactive: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
    dot: "bg-emerald-500",
  },
  violet: {
    active: "bg-violet-600 text-white border-violet-700",
    inactive: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800",
    dot: "bg-violet-500",
  },
  rose: {
    active: "bg-rose-600 text-white border-rose-700",
    inactive: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800",
    dot: "bg-rose-500",
  },
  amber: {
    active: "bg-amber-500 text-amber-950 border-amber-600",
    inactive: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
    dot: "bg-amber-500",
  },
};

interface HabitStreak {
  streak: number;
  calendar: { dateKey: string; completed: boolean }[];
}

interface HabitsCardProps {
  habits: any[];
  habitStreakMap: Record<string, HabitStreak>;
  completionChartData: { name: string; value: number; color: string }[];
  onToggle: (habitId: string, completed: boolean) => void;
  isToggling: boolean;
  onRefresh: () => void;
  sectionRating?: number;
}

export function HabitsCard({
  habits,
  habitStreakMap,
  completionChartData,
  onToggle,
  isToggling,
  onRefresh,
  sectionRating,
}: HabitsCardProps) {
  const [, setLocation] = useLocation();

  return (
    <Card className="min-w-0 flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-rose-600" />
          <CardTitle className="text-base">Habits</CardTitle>
        </div>
        <div className="flex items-center gap-1">
          <SectionRating sectionId="section-tracking" currentRating={sectionRating as any} />
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 h-36 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Tooltip />
              <Pie
                data={completionChartData}
                dataKey="value"
                nameKey="name"
                innerRadius={36}
                outerRadius={56}
                paddingAngle={2}
              >
                {completionChartData.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        {habits.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No habits configured.
            <Button
              variant="link"
              className="px-1 h-auto text-sm"
              onClick={() => setLocation("/settings")}
            >
              Create habits in Settings
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {habits.map((habit: any) => {
              const styles = HABIT_COLOR_STYLES[habit.color] ?? HABIT_COLOR_STYLES.slate;
              const streakData = habitStreakMap[habit.id];
              return (
                <button
                  type="button"
                  key={habit.id}
                  onClick={() => onToggle(habit.id, !habit.completed)}
                  className={`rounded-md border px-2 py-2 text-left transition-colors ${
                    habit.completed ? styles.active : styles.inactive
                  }`}
                  disabled={isToggling}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold">{habit.name}</p>
                    {streakData && streakData.streak > 0 && (
                      <span className="text-xs font-bold opacity-70">{streakData.streak}d</span>
                    )}
                  </div>
                  {streakData ? (
                    <div className="flex items-center gap-0.5 mt-1">
                      {streakData.calendar.map((day) => (
                        <span
                          key={day.dateKey}
                          className={`h-1.5 w-1.5 rounded-full ${
                            day.completed ? styles.dot : "bg-black/10 dark:bg-white/10"
                          }`}
                          title={day.dateKey}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs mt-0.5 opacity-80">
                      {habit.completed ? "Done today" : "Tap to mark done"}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
