import { Skeleton } from "@/components/ui/skeleton";

export function DashboardSkeleton() {
  return (
    <div className="animate-in fade-in duration-300">
      {/* Hero skeleton */}
      <div className="container mx-auto px-4 pt-4">
        <div className="rounded-xl border bg-card p-6 sm:p-8">
          <Skeleton className="h-8 w-72 mb-2" />
          <Skeleton className="h-4 w-48" />
          <div className="mt-5 flex flex-wrap gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-24 rounded-full" />
            ))}
          </div>
        </div>
      </div>

      {/* Sticky toolbar skeleton */}
      <div className="container mx-auto px-4 py-2 mt-2">
        <Skeleton className="h-5 w-full max-w-lg" />
      </div>

      {/* Navigation buttons skeleton */}
      <div className="container mx-auto px-4 py-1.5">
        <div className="rounded-lg border bg-card px-3 py-3 shadow-sm">
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-20 rounded-md" />
            ))}
          </div>
        </div>
      </div>

      {/* Today's Plan skeleton */}
      <div className="container mx-auto px-4 pt-4">
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-5 w-32" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-4 w-14 rounded" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-5">
            <Skeleton className="h-5 w-28 mb-4" />
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Health cards skeleton */}
      <div className="container mx-auto px-4 pt-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-5 w-32" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-md" />
              ))}
            </div>
          </div>
          <div className="rounded-xl border bg-zinc-950 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Skeleton className="h-4 w-4 rounded bg-zinc-800" />
              <Skeleton className="h-5 w-20 bg-zinc-800" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-lg bg-zinc-800" />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Tracking row skeleton */}
      <div className="container mx-auto px-4 pt-4 pb-8">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-5 w-24" />
              </div>
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, j) => (
                  <Skeleton key={j} className="h-10 w-full rounded-md" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
