import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { useTheme } from "@/contexts/ThemeContext";
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

function formatDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const GREETING_IMAGES_LIGHT: Record<TimeOfDay, string> = {
  morning: "/greeting-morning.png",
  afternoon: "/greeting-afternoon.png",
  evening: "/greeting-evening.png",
};

const GREETING_IMAGES_DARK: Record<TimeOfDay, string> = {
  morning: "/greeting-morning-dark.svg",
  afternoon: "/greeting-afternoon-dark.svg",
  evening: "/greeting-evening-dark.svg",
};

const DEFAULT_STATS: QuickStat[] = [
  { label: "Tasks", value: "--", icon: CheckSquare },
  { label: "Events", value: "--", icon: Calendar },
  { label: "Focus", value: "--", icon: Clock },
  { label: "Streak", value: "--", icon: Zap },
];

export function DashboardHero({
  stats,
  className,
}: DashboardHeroProps) {
  const { theme } = useTheme();
  const timeOfDay = useMemo(() => getTimeOfDay(), []);
  const dateStr = useMemo(() => formatDate(), []);
  const displayStats = stats ?? DEFAULT_STATS;
  const greetingImages = theme === "dark" ? GREETING_IMAGES_DARK : GREETING_IMAGES_LIGHT;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border-2 border-primary/20 bg-card",
        className
      )}
    >
      {/* Greeting image */}
      <div className="flex justify-center px-4 pt-4 sm:px-6 sm:pt-6">
        <img
          src={greetingImages[timeOfDay]}
          alt={`Good ${timeOfDay}`}
          className="h-auto w-full max-w-2xl object-contain"
          draggable={false}
        />
      </div>

      {/* Date + stats */}
      <div className="px-4 pb-4 pt-2 sm:px-6 sm:pb-6">
        <p className="text-sm font-bold text-muted-foreground tracking-widest uppercase text-center">
          {dateStr}
        </p>

        {displayStats.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
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
