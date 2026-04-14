import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { Calendar, ExternalLink, RefreshCw } from "lucide-react";
import { WidgetPageSkeleton } from "@/components/WidgetPageSkeleton";
import { useLocation } from "wouter";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { CalendarEvent } from "@/features/dashboard/types";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type RangePreset = "7d" | "14d" | "30d" | "custom";
type EventTypeFilter = "all" | "timed" | "all_day";

type CalendarEventRow = {
  id: string;
  summary: string;
  description: string;
  location: string;
  htmlLink: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  searchText: string;
};

const CALENDAR_PAGE_SIZE = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseCalendarEvent(event: CalendarEvent): CalendarEventRow | null {
  const startDateTime = event?.start?.dateTime as string | undefined;
  const startDate = event?.start?.date as string | undefined;
  const endDateTime = event?.end?.dateTime as string | undefined;
  const endDate = event?.end?.date as string | undefined;
  const startRaw = startDateTime || startDate;
  if (!startRaw) return null;

  const startMs = new Date(startRaw).getTime();
  if (!Number.isFinite(startMs)) return null;

  const allDay = Boolean(startDate && !startDateTime);
  const fallbackEnd = allDay ? startMs + DAY_MS : startMs;
  const parsedEnd = endDateTime || endDate ? new Date(endDateTime || endDate || "").getTime() : Number.NaN;
  const endMs = Number.isFinite(parsedEnd) ? parsedEnd : fallbackEnd;

  const summary = String(event?.summary || "Untitled Event");
  const description = String(event?.description || "");
  const location = String(event?.location || "");

  return {
    id: String(event?.id || `${summary}-${startMs}`),
    summary,
    description,
    location,
    htmlLink: String(event?.htmlLink || ""),
    startMs,
    endMs,
    allDay,
    searchText: `${summary} ${description} ${location}`.toLowerCase(),
  };
}

function formatTimedDate(valueMs: number): string {
  return new Date(valueMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatEventRange(event: CalendarEventRow): string {
  if (event.allDay) {
    const start = new Date(event.startMs);
    const exclusiveEndMs = event.endMs;
    const inclusiveEndMs = exclusiveEndMs > event.startMs ? exclusiveEndMs - 1 : event.startMs;
    const inclusiveEnd = new Date(inclusiveEndMs);
    const sameDay = start.toDateString() === inclusiveEnd.toDateString();
    if (sameDay) {
      return `All day • ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    }
    return `All day • ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} to ${inclusiveEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }

  const start = new Date(event.startMs);
  const end = new Date(event.endMs);
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) {
    return `${formatTimedDate(event.startMs)} to ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return `${formatTimedDate(event.startMs)} to ${formatTimedDate(event.endMs)}`;
}

function getRangeBounds(preset: RangePreset, customStartDate: string, customEndDate: string): { startMs: number; endMs: number } {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  if (preset === "7d") {
    return { startMs: todayStart.getTime(), endMs: todayStart.getTime() + 7 * DAY_MS - 1 };
  }
  if (preset === "14d") {
    return { startMs: todayStart.getTime(), endMs: todayStart.getTime() + 14 * DAY_MS - 1 };
  }
  if (preset === "30d") {
    return { startMs: todayStart.getTime(), endMs: todayStart.getTime() + 30 * DAY_MS - 1 };
  }

  const customStartMs = new Date(`${customStartDate}T00:00:00`).getTime();
  const customEndMs = new Date(`${customEndDate}T23:59:59`).getTime();
  const startMs = Number.isFinite(customStartMs) ? customStartMs : todayStart.getTime();
  const endMs = Number.isFinite(customEndMs) ? customEndMs : startMs + 30 * DAY_MS;
  if (endMs >= startMs) {
    return { startMs, endMs };
  }
  return { startMs: endMs, endMs: startMs };
}

export default function GoogleCalendarWidget() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCalendar, setSelectedCalendar] = useState("primary");
  const [rangePreset, setRangePreset] = useState<RangePreset>("30d");
  const [eventTypeFilter, setEventTypeFilter] = useState<EventTypeFilter>("all");
  const [page, setPage] = useState(1);
  const [customStartDate, setCustomStartDate] = useState(() => {
    const now = new Date();
    return toDateInputValue(now);
  });
  const [customEndDate, setCustomEndDate] = useState(() => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    return toDateInputValue(future);
  });

  const {
    data: events,
    isLoading,
    error,
    isFetching,
    refetch,
  } = trpc.google.getCalendarEvents.useQuery(undefined, {
    enabled: !!user,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  const parsedEvents = useMemo(() => {
    return (events || [])
      .map(parseCalendarEvent)
      .filter((event): event is CalendarEventRow => Boolean(event))
      .sort((a, b) => a.startMs - b.startMs);
  }, [events]);

  const rangeBounds = useMemo(
    () => getRangeBounds(rangePreset, customStartDate, customEndDate),
    [rangePreset, customStartDate, customEndDate]
  );

  const filteredEvents = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return parsedEvents.filter((event) => {
      if (selectedCalendar !== "primary") return false;
      if (eventTypeFilter === "all_day" && !event.allDay) return false;
      if (eventTypeFilter === "timed" && event.allDay) return false;

      const overlapsRange = event.endMs >= rangeBounds.startMs && event.startMs <= rangeBounds.endMs;
      if (!overlapsRange) return false;

      if (!query) return true;
      return event.searchText.includes(query);
    });
  }, [parsedEvents, searchQuery, selectedCalendar, eventTypeFilter, rangeBounds.endMs, rangeBounds.startMs]);

  const densityData = useMemo(() => {
    const buckets = new Map<number, { dateLabel: string; count: number }>();
    for (const event of filteredEvents) {
      const bucketDate = new Date(event.startMs);
      bucketDate.setHours(0, 0, 0, 0);
      const key = bucketDate.getTime();
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        buckets.set(key, {
          dateLabel: bucketDate.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          count: 1,
        });
      }
    }

    return Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value);
  }, [filteredEvents]);

  const totalPages = Math.max(1, Math.ceil(filteredEvents.length / CALENDAR_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * CALENDAR_PAGE_SIZE;
  const pageEnd = pageStart + CALENDAR_PAGE_SIZE;
  const visibleEvents = filteredEvents.slice(pageStart, pageEnd);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, selectedCalendar, rangePreset, customStartDate, customEndDate, eventTypeFilter]);

  useEffect(() => {
    if (page <= totalPages) return;
    setPage(totalPages);
  }, [page, totalPages]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refetch();
      toast.success("Calendar refreshed");
    } catch (refreshError) {
      toast.error(`Failed to refresh calendar: ${(refreshError as Error).message}`);
    } finally {
      setIsRefreshing(false);
    }
  };

  if (authLoading || isLoading) {
    return <WidgetPageSkeleton variant="calendar" />;
  }

  if (!user) {
    return null;
  }

  return (
    <main className="container max-w-4xl mx-auto px-4 py-6 space-y-4">
      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="py-4">
            <p className="text-destructive font-medium">Error loading calendar events</p>
            <p className="text-destructive/80 text-sm mt-1">{error.message}</p>
            <Button variant="outline" onClick={handleRefresh} className="mt-3" size="sm">
              <RefreshCw className="w-4 h-4 mr-2" />
              Try Again
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Event Controls</CardTitle>
              <CardDescription>
                Showing {filteredEvents.length.toLocaleString()} event{filteredEvents.length === 1 ? "" : "s"} in range
              </CardDescription>
            </div>
            <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing || isFetching}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing || isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-4">
            <div className="md:col-span-2">
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search title, description, location..."
              />
            </div>
            <Select value={selectedCalendar} onValueChange={setSelectedCalendar}>
              <SelectTrigger>
                <SelectValue placeholder="Calendar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="primary">Primary calendar</SelectItem>
              </SelectContent>
            </Select>
            <Select value={eventTypeFilter} onValueChange={(value) => setEventTypeFilter(value as EventTypeFilter)}>
              <SelectTrigger>
                <SelectValue placeholder="Event type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All event types</SelectItem>
                <SelectItem value="timed">Timed events</SelectItem>
                <SelectItem value="all_day">All-day events</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            <Select value={rangePreset} onValueChange={(value) => setRangePreset(value as RangePreset)}>
              <SelectTrigger>
                <SelectValue placeholder="Date window" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7d">Next 7 days</SelectItem>
                <SelectItem value="14d">Next 14 days</SelectItem>
                <SelectItem value="30d">Next 30 days</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
            {rangePreset === "custom" ? (
              <>
                <Input type="date" value={customStartDate} onChange={(event) => setCustomStartDate(event.target.value)} />
                <Input type="date" value={customEndDate} onChange={(event) => setCustomEndDate(event.target.value)} />
              </>
            ) : (
              <>
                <div className="h-10 rounded-md border bg-muted px-3 text-sm text-muted-foreground flex items-center">
                  {new Date(rangeBounds.startMs).toLocaleDateString()}
                </div>
                <div className="h-10 rounded-md border bg-muted px-3 text-sm text-muted-foreground flex items-center">
                  {new Date(rangeBounds.endMs).toLocaleDateString()}
                </div>
              </>
            )}
            <div className="h-10 rounded-md border bg-muted px-3 text-sm text-muted-foreground flex items-center">
              {filteredEvents.filter((event) => !event.allDay).length.toLocaleString()} timed, {filteredEvents.filter((event) => event.allDay).length.toLocaleString()} all-day
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Event Density</CardTitle>
          <CardDescription>Event count by day in the selected date window</CardDescription>
        </CardHeader>
        <CardContent>
          {densityData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events in the selected range.</p>
          ) : (
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={densityData} margin={{ left: 0, right: 16, top: 8, bottom: 0 }}>
                  <XAxis dataKey="dateLabel" tick={{ fontSize: 12 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={30} />
                  <Tooltip />
                  <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {visibleEvents.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Calendar className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-foreground">No matching events</h3>
            <p className="text-sm text-muted-foreground mt-1">Adjust your date window or filters to see more events.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {visibleEvents.map((event) => (
            <Card key={event.id} className="hover:shadow-sm transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <CardTitle className="text-base">{event.summary}</CardTitle>
                    <CardDescription className="mt-1">{formatEventRange(event)}</CardDescription>
                    <div className="mt-2 text-sm text-muted-foreground space-y-1">
                      {event.location ? (
                        <p>
                          <span className="font-medium">Location:</span> {event.location}
                        </p>
                      ) : null}
                      {event.description ? (
                        <p className="line-clamp-2">
                          <span className="font-medium">Details:</span> {event.description}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {event.htmlLink ? (
                    <a
                      href={event.htmlLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary/80"
                      aria-label={`Open ${event.summary} in Google Calendar`}
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  ) : null}
                </div>
              </CardHeader>
            </Card>
          ))}

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing {visibleEvents.length} of {filteredEvents.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={currentPage <= 1}
              >
                Previous
              </Button>
              <span>
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={currentPage >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
