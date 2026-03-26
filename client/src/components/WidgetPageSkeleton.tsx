import { Skeleton } from "@/components/ui/skeleton";

type WidgetSkeletonVariant = "list" | "chat" | "timer" | "calendar";

interface WidgetPageSkeletonProps {
  variant?: WidgetSkeletonVariant;
  /** Number of list item rows to show (default 6) */
  rows?: number;
}

function ListItemSkeleton() {
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-3.5 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-6">
      {/* Header area */}
      <div className="flex items-center justify-between mb-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
      {/* List items */}
      {Array.from({ length: rows }).map((_, i) => (
        <ListItemSkeleton key={i} />
      ))}
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div className="space-y-4 p-6">
      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-4 space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>
      {/* Chat layout */}
      <div className="grid grid-cols-3 gap-4">
        {/* Sidebar */}
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-md" />
          ))}
        </div>
        {/* Messages area */}
        <div className="col-span-2 space-y-3">
          <Skeleton className="h-10 w-3/5 rounded-xl" />
          <Skeleton className="h-10 w-2/5 rounded-xl ml-auto" />
          <Skeleton className="h-10 w-4/5 rounded-xl" />
          <Skeleton className="h-10 w-1/3 rounded-xl ml-auto" />
          <div className="mt-auto pt-4">
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}

function TimerSkeleton() {
  return (
    <div className="space-y-4 p-6">
      {/* Timer card */}
      <div className="rounded-lg border p-6 space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-48 mx-auto" />
        <div className="flex justify-center gap-3">
          <Skeleton className="h-9 w-20 rounded-md" />
          <Skeleton className="h-9 w-20 rounded-md" />
        </div>
      </div>
      {/* Recent entries */}
      <Skeleton className="h-5 w-32" />
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="rounded-lg border p-3 flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="space-y-4 p-6">
      {/* Chart area */}
      <Skeleton className="h-32 w-full rounded-lg" />
      {/* Event list */}
      <div className="flex items-center justify-between mb-2">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-8 w-20 rounded-md" />
      </div>
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rounded-lg border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

const VARIANT_MAP: Record<WidgetSkeletonVariant, React.FC<{ rows?: number }>> = {
  list: ListSkeleton,
  chat: ChatSkeleton,
  timer: TimerSkeleton,
  calendar: CalendarSkeleton,
};

export function WidgetPageSkeleton({ variant = "list", rows }: WidgetPageSkeletonProps) {
  const Component = VARIANT_MAP[variant];
  return (
    <div className="min-h-screen animate-in fade-in duration-300">
      <Component rows={rows} />
    </div>
  );
}
