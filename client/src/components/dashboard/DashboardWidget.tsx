import { useState, useEffect, type ReactNode } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
  CardAction,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  RefreshCw,
  AlertCircle,
  type LucideIcon,
} from "lucide-react";

export type WidgetCategory = "health" | "productivity" | "ai" | "energy";

interface DashboardWidgetProps {
  title: string;
  icon?: LucideIcon;
  category?: WidgetCategory;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  lastUpdated?: Date | null;
  collapsible?: boolean;
  /** Unique key for persisting collapsed state. Falls back to title. */
  storageKey?: string;
  children: ReactNode;
  className?: string;
}

const CATEGORY_BORDER_CLASSES: Record<WidgetCategory, string> = {
  health: "border-l-health",
  productivity: "border-l-productivity",
  ai: "border-l-ai",
  energy: "border-l-energy",
};

const CATEGORY_ICON_CLASSES: Record<WidgetCategory, string> = {
  health: "text-health",
  productivity: "text-productivity",
  ai: "text-ai",
  energy: "text-energy",
};

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getStoredCollapsed(key: string): boolean | null {
  try {
    const val = localStorage.getItem(`widget-collapsed:${key}`);
    return val !== null ? val === "true" : null;
  } catch {
    return null;
  }
}

function storeCollapsed(key: string, collapsed: boolean) {
  try {
    localStorage.setItem(`widget-collapsed:${key}`, String(collapsed));
  } catch {
    // Ignore storage errors
  }
}

export function DashboardWidget({
  title,
  icon: Icon,
  category,
  isLoading = false,
  error = null,
  onRetry,
  lastUpdated,
  collapsible = false,
  storageKey,
  children,
  className,
}: DashboardWidgetProps) {
  const persistKey = storageKey ?? title;
  const [isOpen, setIsOpen] = useState(() => {
    if (!collapsible) return true;
    const stored = getStoredCollapsed(persistKey);
    return stored !== null ? !stored : true;
  });

  // Persist collapsed state
  useEffect(() => {
    if (collapsible) {
      storeCollapsed(persistKey, !isOpen);
    }
  }, [isOpen, collapsible, persistKey]);

  // Update relative time display
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastUpdated) return;
    const interval = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  const borderClass = category ? CATEGORY_BORDER_CLASSES[category] : "";
  const iconColorClass = category ? CATEGORY_ICON_CLASSES[category] : "text-muted-foreground";

  const cardContent = (
    <Card
      className={cn(
        "relative overflow-hidden transition-shadow hover:shadow-md",
        category && "border-l-[3px]",
        borderClass,
        className
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          {Icon && <Icon className={cn("size-4", iconColorClass)} />}
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        </div>
        {collapsible && (
          <CardAction>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6">
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform duration-200",
                    isOpen ? "" : "-rotate-90"
                  )}
                />
                <span className="sr-only">Toggle {title}</span>
              </Button>
            </CollapsibleTrigger>
          </CardAction>
        )}
      </CardHeader>

      <CollapsibleContent>
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <AlertCircle className="size-8 text-destructive/60" />
              <p className="text-sm text-muted-foreground">{error}</p>
              {onRetry && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetry}
                  className="gap-1.5"
                >
                  <RefreshCw className="size-3" />
                  Retry
                </Button>
              )}
            </div>
          ) : (
            children
          )}
        </CardContent>

        {lastUpdated && !isLoading && !error && (
          <CardFooter className="pt-0 pb-3">
            <span className="text-xs text-muted-foreground">
              Updated {formatRelativeTime(lastUpdated)}
            </span>
          </CardFooter>
        )}
      </CollapsibleContent>
    </Card>
  );

  if (collapsible) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        {cardContent}
      </Collapsible>
    );
  }

  return cardContent;
}
