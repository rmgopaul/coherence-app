import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  CheckSquare,
  Calendar,
  Clock,
  Zap,
  type LucideIcon,
} from "lucide-react";

interface QuickStat {
  label: string;
  value: string | number;
  icon: LucideIcon;
}

interface DashboardHeroProps {
  /** User's first name for greeting. Falls back to generic greeting. */
  userName?: string;
  /** Quick stat badges to display. */
  stats?: QuickStat[];
  className?: string;
}

type TimeOfDay = "morning" | "afternoon" | "evening";

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function getGreeting(timeOfDay: TimeOfDay, name?: string): string {
  const greetings: Record<TimeOfDay, string> = {
    morning: "Good morning",
    afternoon: "Good afternoon",
    evening: "Good evening",
  };
  const greeting = greetings[timeOfDay];
  return name ? `${greeting}, ${name}` : greeting;
}

function formatDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const GRADIENT_CLASSES: Record<TimeOfDay, string> = {
  morning:
    "from-red-50/60 via-amber-50/30 to-transparent dark:from-red-950/25 dark:via-amber-950/12 dark:to-transparent",
  afternoon:
    "from-cyan-50/60 via-sky-50/30 to-transparent dark:from-cyan-950/25 dark:via-sky-950/12 dark:to-transparent",
  evening:
    "from-red-50/60 via-purple-50/30 to-transparent dark:from-red-950/20 dark:via-purple-950/12 dark:to-transparent",
};

const DEFAULT_STATS: QuickStat[] = [
  { label: "Tasks", value: "--", icon: CheckSquare },
  { label: "Events", value: "--", icon: Calendar },
  { label: "Focus", value: "--", icon: Clock },
  { label: "Streak", value: "--", icon: Zap },
];

export function DashboardHero({
  userName,
  stats,
  className,
}: DashboardHeroProps) {
  const timeOfDay = useMemo(() => getTimeOfDay(), []);
  const greeting = useMemo(
    () => getGreeting(timeOfDay, userName),
    [timeOfDay, userName]
  );
  const dateStr = useMemo(() => formatDate(), []);
  const displayStats = stats ?? DEFAULT_STATS;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border-2 border-primary/20 bg-card p-6 sm:p-8",
        className
      )}
    >
      {/* Gradient overlay */}
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-br pointer-events-none",
          GRADIENT_CLASSES[timeOfDay]
        )}
      />

      <div className="relative z-10">
        <h1 className="text-2xl sm:text-4xl font-bold tracking-wide text-foreground" style={{ fontFamily: '"Permanent Marker", cursive' }}>
          {greeting}
        </h1>
        <p className="mt-1.5 text-sm font-medium text-muted-foreground tracking-wide uppercase">{dateStr}</p>

        {displayStats.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2">
            {displayStats.map((stat) => (
              <Badge
                key={stat.label}
                variant="secondary"
                className="gap-1.5 px-3 py-1 text-xs font-medium"
              >
                <stat.icon className="size-3" />
                <span className="font-semibold">{stat.value}</span>
                <span className="text-muted-foreground">{stat.label}</span>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
