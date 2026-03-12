import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import UniversalDropDock from "@/components/UniversalDropDock";
import { TodaysPlan } from "@/components/todays-plan/TodaysPlan";
import { TriageEmail } from "@/components/todays-plan/TriageEmail";
import { DecisionsWidget } from "@/components/todays-plan/DecisionsWidget";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { buildDailyBrief, MOCK_DAILY_BRIEF, withFreshness, type DailyBrief, type DailyBriefAction } from "@/lib/dailyBrief";
import {
  Calendar,
  CheckSquare,
  Mail,
  MailCheck,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  Send,
  Plus,
  MessageSquare,
  Trash2,
  FileText,
  FolderOpen,
  HeartPulse,
  Smartphone,
  Pill,
  Target,
  BarChart3,
  Database,
  Clock3,
  CloudSun,
  FileSpreadsheet,
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const DAILY_BRIEF_CACHE_KEY = "dailyBriefCacheV1";

const WEATHER_CODE_LABELS: Record<number, string> = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  56: "Freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Heavy rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Severe thunderstorm with hail",
};

const getWeatherLabel = (code?: number) => {
  if (typeof code !== "number") return "Weather unavailable";
  return WEATHER_CODE_LABELS[code] || "Weather unavailable";
};

const decodeHtmlEntities = (content: string) => {
  if (typeof window === "undefined") return content.replace(/&nbsp;/gi, " ");
  const textarea = document.createElement("textarea");
  textarea.innerHTML = content;
  return textarea.value;
};

const toPlainText = (content: string) =>
  decodeHtmlEntities(
    content
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const formatCalendarEventLabel = (event: any) => {
  const summary = String(event?.summary || "Untitled event").trim() || "Untitled event";
  const startDateTime = event?.start?.dateTime;
  const startDate = event?.start?.date;
  const raw = startDateTime || startDate;
  if (!raw) return summary;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return summary;

  const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
  if (startDateTime) {
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${summary} · ${weekday} ${time}`;
  }
  return `${summary} · ${weekday} all-day`;
};

const normalizeEventText = (value: string) =>
  value
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildLocalDateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const isSameLocalDay = (dateA: Date, dateB: Date) => {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
};

const HABIT_COLOR_STYLES: Record<string, { active: string; inactive: string }> = {
  slate: {
    active: "bg-slate-900 text-white border-slate-900",
    inactive: "bg-slate-50 text-slate-700 border-slate-200",
  },
  emerald: {
    active: "bg-emerald-600 text-white border-emerald-700",
    inactive: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  blue: {
    active: "bg-emerald-700 text-white border-emerald-800",
    inactive: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  violet: {
    active: "bg-violet-600 text-white border-violet-700",
    inactive: "bg-violet-50 text-violet-700 border-violet-200",
  },
  rose: {
    active: "bg-rose-600 text-white border-rose-700",
    inactive: "bg-rose-50 text-rose-700 border-rose-200",
  },
  amber: {
    active: "bg-amber-500 text-amber-950 border-amber-600",
    inactive: "bg-amber-50 text-amber-800 border-amber-200",
  },
};

const SUPPLEMENT_UNITS = ["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"] as const;

function LiveClockValue() {
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <Clock3 className="h-4 w-4 text-slate-600" />
      {currentTime.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })}
    </>
  );
}

export default function Dashboard() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [chatMessage, setChatMessage] = useState("");
  const [quickTodoistTaskInput, setQuickTodoistTaskInput] = useState("");
  const [driveSearchQuery, setDriveSearchQuery] = useState("");
  const [driveSearchResults, setDriveSearchResults] = useState<any[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [todoistFilter, setTodoistFilter] = useState("all");
  const [dailyBrief, setDailyBrief] = useState<DailyBrief | null>(null);
  const [dailyBriefDate, setDailyBriefDate] = useState<string | null>(null);
  const [isGeneratingDailyBrief, setIsGeneratingDailyBrief] = useState(false);
  const [welcomeDisplayNameInput, setWelcomeDisplayNameInput] = useState("");
  const [weather, setWeather] = useState<{
    loading: boolean;
    summary: string;
    location: string;
    temperatureF: number | null;
    error: string | null;
  }>({
    loading: true,
    summary: "",
    location: "",
    temperatureF: null,
    error: null,
  });
  const [isTodoistDefaultApplied, setIsTodoistDefaultApplied] = useState(false);
  const [markingEmailId, setMarkingEmailId] = useState<string | null>(null);
  const [manualSleepScoreInput, setManualSleepScoreInput] = useState("");
  const [manualEnergyScoreInput, setManualEnergyScoreInput] = useState("");
  const [editingSamsungField, setEditingSamsungField] = useState<"sleep" | "energy" | null>(null);
  const [minuteTick, setMinuteTick] = useState(() => new Date());
  const [dashboardViewMode, setDashboardViewMode] = useState<"essential" | "detailed">("essential");
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [noteTitleInput, setNoteTitleInput] = useState("");
  const [noteContentInput, setNoteContentInput] = useState("");
  const [noteNotebookInput, setNoteNotebookInput] = useState("General");
  const [noteNotebookFilter, setNoteNotebookFilter] = useState("all");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [linkNoteId, setLinkNoteId] = useState<string>("");
  const [linkTaskId, setLinkTaskId] = useState<string>("");
  const [linkEventId, setLinkEventId] = useState<string>("");
  const [selectedCalendarHistoryEventId, setSelectedCalendarHistoryEventId] = useState<string | null>(null);
  const [supplementName, setSupplementName] = useState("");
  const [supplementDose, setSupplementDose] = useState("");
  const [supplementDoseUnit, setSupplementDoseUnit] =
    useState<(typeof SUPPLEMENT_UNITS)[number]>("capsule");
  const [supplementTiming, setSupplementTiming] = useState<"am" | "pm">("am");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const metricCaptureStartedRef = useRef(false);
  const lastSamsungSyncSeenRef = useRef<string | null>(null);
  const todayKey = buildLocalDateKey();
  const trpcUtils = trpc.useUtils();
  const isDetailedMode = dashboardViewMode === "detailed";
  const shouldLoadWorkspaceData = isDetailedMode && workspaceExpanded;
  const shouldLoadChatData = isDetailedMode && chatExpanded;
  
  const {
    data: integrations,
    isLoading,
    isFetching: integrationsFetching,
    refetch: refetchIntegrations,
  } = trpc.integrations.list.useQuery(undefined, {
    enabled: !!user,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  const { data: preferences, refetch: refetchPreferences } = trpc.preferences.get.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  
  const hasGoogle = integrations?.some((i) => i.provider === "google");
  const hasTodoist = integrations?.some((i) => i.provider === "todoist");
  const hasOpenAI = integrations?.some((i) => i.provider === "openai");
  const hasWhoop = integrations?.some((i) => i.provider === "whoop");
  const hasSamsungHealth = integrations?.some((i) => i.provider === "samsung-health");
  const greetingDisplayName = (preferences?.displayName || user?.name || "User").trim();

  const samsungHealthSnapshot = useMemo(() => {
    const integration = integrations?.find((i) => i.provider === "samsung-health");
    if (!integration?.metadata) return null;

    try {
      const parsed = JSON.parse(integration.metadata) as any;
      const summary = (parsed?.summary ?? {}) as Record<string, unknown>;
      const sync = (parsed?.sync ?? {}) as Record<string, unknown>;
      const toNullableNumber = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const manualScores =
        parsed?.manualScores && typeof parsed.manualScores === "object"
          ? (parsed.manualScores as Record<string, unknown>)
          : {};
      const manualSleepScore = toNullableNumber(manualScores?.sleepScore);
      const manualEnergyScore = toNullableNumber(manualScores?.energyScore);

      return {
        receivedAt:
          typeof parsed?.receivedAt === "string" && parsed.receivedAt.length > 0
            ? parsed.receivedAt
            : null,
        sourceProvider:
          typeof summary?.sourceProvider === "string" && summary.sourceProvider.length > 0
            ? summary.sourceProvider
            : "unknown",
        steps: toNullableNumber(summary?.steps),
        sleepTotalMinutes: toNullableNumber(summary?.sleepTotalMinutes),
        sleepScore: manualSleepScore ?? toNullableNumber(summary?.sleepScore),
        energyScore: manualEnergyScore ?? toNullableNumber(summary?.energyScore),
        spo2AvgPercent: toNullableNumber(summary?.spo2AvgPercent),
        sleepSessionsCount: toNullableNumber(summary?.sleepSessionsCount),
        heartRateSamplesCount: toNullableNumber(summary?.heartRateSamplesCount),
        permissionsGranted: Boolean(sync?.permissionsGranted),
        warnings: Array.isArray(sync?.warnings) ? (sync.warnings as string[]) : [],
      };
    } catch {
      return null;
    }
  }, [integrations]);

  useEffect(() => {
    if (!samsungHealthSnapshot) return;
    if (editingSamsungField) return;
    setManualSleepScoreInput(
      samsungHealthSnapshot.sleepScore === null ? "" : String(samsungHealthSnapshot.sleepScore)
    );
    setManualEnergyScoreInput(
      samsungHealthSnapshot.energyScore === null ? "" : String(samsungHealthSnapshot.energyScore)
    );
  }, [samsungHealthSnapshot?.sleepScore, samsungHealthSnapshot?.energyScore, editingSamsungField]);

  const getEmailHeader = (message: any, headerName: string) => {
    const header = message.payload?.headers?.find((h: any) => h.name === headerName);
    return header?.value || "";
  };

  useEffect(() => {
    if (!hasTodoist) {
      setIsTodoistDefaultApplied(false);
      return;
    }
    if (isTodoistDefaultApplied) return;

    const todoistIntegration = integrations?.find((i) => i.provider === "todoist");
    if (!todoistIntegration) return;

    let defaultFilter = "all";
    if (todoistIntegration.metadata) {
      try {
        const parsed = JSON.parse(todoistIntegration.metadata);
        if (typeof parsed?.defaultFilter === "string" && parsed.defaultFilter.trim()) {
          defaultFilter = parsed.defaultFilter.trim();
        }
      } catch {
        defaultFilter = "all";
      }
    }

    setTodoistFilter(defaultFilter);
    setIsTodoistDefaultApplied(true);
  }, [hasTodoist, integrations, isTodoistDefaultApplied]);

  useEffect(() => {
    if (!user) return;
    setWelcomeDisplayNameInput(greetingDisplayName);
  }, [user?.id, greetingDisplayName]);

  useEffect(() => {
    if (dashboardViewMode === "detailed") {
      setWorkspaceExpanded(true);
      setChatExpanded(true);
      return;
    }
    setWorkspaceExpanded(false);
    setChatExpanded(false);
  }, [dashboardViewMode]);
  
  const { data: calendarEvents, isLoading: calendarLoading, refetch: refetchCalendar } = trpc.google.getCalendarEvents.useQuery(undefined, {
    enabled: !!user && hasGoogle,
    retry: false,
  });
  
  // Filter to show only upcoming events (not past events) in Central Time
  const upcomingEvents = calendarEvents?.filter((event: any) => {
    const startTime = event.start?.dateTime || event.start?.date;
    if (!startTime) return false;
    
    const eventDate = new Date(startTime);
    const now = new Date();
    
    // Only show events that haven't started yet
    return eventDate > now;
  }) || [];
  
  // Group events by date and assign colors
  const groupedEvents = upcomingEvents.reduce((acc: any, event: any) => {
    const startTime = event.start?.dateTime || event.start?.date;
    const eventDate = new Date(startTime);
    const dateKey = eventDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    
    if (!acc[dateKey]) {
      acc[dateKey] = [];
    }
    acc[dateKey].push(event);
    return acc;
  }, {});
  
  // Color palette for different days
  const dayColors = [
    { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-900", header: "bg-emerald-100" },
    { bg: "bg-lime-50", border: "border-lime-200", text: "text-lime-900", header: "bg-lime-100" },
    { bg: "bg-teal-50", border: "border-teal-200", text: "text-teal-900", header: "bg-teal-100" },
    { bg: "bg-slate-100", border: "border-slate-300", text: "text-slate-900", header: "bg-slate-200" },
    { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-900", header: "bg-amber-100" },
  ];
  
  const dateKeys = Object.keys(groupedEvents);
  const eventsByDate = dateKeys.map((dateKey, index) => ({
    date: dateKey,
    events: groupedEvents[dateKey],
    colors: dayColors[index % dayColors.length],
  }));
  
  // Fetch Todoist projects for the filter dropdown
  const { data: todoistProjects } = trpc.todoist.getProjects.useQuery(undefined, {
    enabled: !!user && hasTodoist,
    retry: false,
  });
  
  // Build filter string based on selection
  const getTodoistFilterString = (): string | undefined => {
    if (todoistFilter === "all") return undefined;
    if (todoistFilter === "today") return "today";
    if (todoistFilter === "upcoming") return "7 days";
    if (todoistFilter.startsWith("project_")) {
      const projectId = todoistFilter.replace("project_", "");
      return `#${projectId}`;
    }
    if (todoistFilter.startsWith("label_")) {
      const encodedLabel = todoistFilter.replace("label_", "");
      return `@${decodeURIComponent(encodedLabel)}`;
    }
    return todoistFilter; // For custom filters like "#Inbox"
  };
  
  const { data: todayTasks, isLoading: tasksLoading, refetch: refetchTasks } = trpc.todoist.getTasks.useQuery(
    { filter: getTodoistFilterString() },
    {
      enabled: !!user && hasTodoist,
      retry: false,
    }
  );

  const { data: dueTodayTasks, isLoading: dueTodayTasksLoading, refetch: refetchDueTodayTasks } = trpc.todoist.getTasks.useQuery(
    { filter: "today" },
    {
      enabled: !!user && hasTodoist,
      retry: false,
    }
  );

  const { data: allTodoistTasks, refetch: refetchAllTodoistTasks } = trpc.todoist.getTasks.useQuery(undefined, {
    enabled: !!user && hasTodoist,
    retry: false,
  });
  const {
    data: todoistCompletedToday,
    refetch: refetchTodoistCompletedToday,
  } = trpc.todoist.getCompletedCount.useQuery(
    { dateKey: todayKey, timezoneOffsetMinutes: new Date().getTimezoneOffset() },
    {
      enabled: !!user && hasTodoist,
      retry: false,
      staleTime: 0,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    }
  );

  const todoistLabels = Array.from(
    new Set(
      (allTodoistTasks ?? []).flatMap((task: any) =>
        Array.isArray(task.labels) ? task.labels : []
      )
    )
  ).sort((a, b) => String(a).localeCompare(String(b)));
  
  const {
    data: gmailMessages,
    isLoading: emailsLoading,
    isFetching: emailsFetching,
    refetch: refetchEmails,
  } = trpc.google.getGmailMessages.useQuery({ maxResults: 50 }, {
    enabled: !!user && hasGoogle,
    retry: false,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const {
    data: gmailWaitingOn,
    isLoading: waitingOnLoading,
    error: waitingOnError,
  } = trpc.google.getGmailWaitingOn.useQuery({ maxResults: 25 }, {
    enabled: !!user && hasGoogle,
    retry: false,
    staleTime: 120_000,
    refetchOnWindowFocus: false,
  });
  
  const { data: driveFiles, isLoading: driveLoading, refetch: refetchDrive } = trpc.google.getDriveFiles.useQuery(undefined, {
    enabled: !!user && hasGoogle && shouldLoadWorkspaceData,
    retry: false,
  });

  const {
    data: whoopSummary,
    isLoading: whoopLoading,
    isFetching: whoopFetching,
    error: whoopError,
    refetch: refetchWhoop,
  } = trpc.whoop.getSummary.useQuery(undefined, {
    enabled: !!user && hasWhoop,
    retry: false,
    staleTime: 0,
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });

  const { data: metricHistory, refetch: refetchMetricHistory } = trpc.metrics.getHistory.useQuery(
    { limit: 30 },
    {
      enabled: !!user,
      retry: false,
    }
  );

  const { data: supplementLogs, refetch: refetchSupplementLogs } = trpc.supplements.getLogs.useQuery(
    { dateKey: todayKey, limit: 50 },
    {
      enabled: !!user && isDetailedMode,
      retry: false,
    }
  );

  const { data: supplementDefinitions, refetch: refetchSupplementDefinitions } =
    trpc.supplements.listDefinitions.useQuery(undefined, {
      enabled: !!user && isDetailedMode,
      retry: false,
    });

  const { data: habitsForToday, refetch: refetchHabitsForToday } = trpc.habits.getForDate.useQuery(
    { dateKey: todayKey },
    {
      enabled: !!user,
      retry: false,
    }
  );

  const { data: notes, isLoading: notesLoading, refetch: refetchNotes } = trpc.notes.list.useQuery(
    { limit: 300 },
    {
      enabled: !!user && isDetailedMode,
      retry: false,
    }
  );

  const noteNotebookOptions = useMemo(() => {
    const values = new Set<string>(["General", "Meetings", "Tasks"]);
    for (const note of notes || []) {
      const notebook = typeof note?.notebook === "string" ? note.notebook.trim() : "";
      if (notebook) values.add(notebook);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const filteredNotes = useMemo(() => {
    if (!notes) return [];
    if (noteNotebookFilter === "all") return notes;
    return notes.filter((note: any) => (note.notebook || "General") === noteNotebookFilter);
  }, [notes, noteNotebookFilter]);

  const selectedTaskForLink = useMemo(
    () => (todayTasks || []).find((task: any) => String(task.id) === linkTaskId) || null,
    [todayTasks, linkTaskId]
  );

  const selectedEventForLink = useMemo(
    () => upcomingEvents.find((event: any) => String(event.id || "") === linkEventId) || null,
    [upcomingEvents, linkEventId]
  );

  const selectedCalendarHistoryEvent = useMemo(
    () =>
      upcomingEvents.find((event: any) => String(event.id || "") === selectedCalendarHistoryEventId) || null,
    [upcomingEvents, selectedCalendarHistoryEventId]
  );

  const calendarLinkedNotes = useMemo(() => {
    if (!selectedCalendarHistoryEvent || !notes) return [];
    const eventId = String(selectedCalendarHistoryEvent.id || "");
    const recurringId = String(selectedCalendarHistoryEvent.recurringEventId || "");
    const iCalUID = String(selectedCalendarHistoryEvent.iCalUID || "");
    const eventSummary = normalizeEventText(String(selectedCalendarHistoryEvent.summary || ""));
    const eventStart = String(
      selectedCalendarHistoryEvent.start?.dateTime || selectedCalendarHistoryEvent.start?.date || ""
    );

    const targetSeries = [recurringId, iCalUID].filter((value) => value.length > 0);

    const matchesLink = (link: any) => {
      if (link?.linkType !== "google_calendar_event") return false;
      if (String(link.externalId || "") === eventId) return true;

      let parsedMetadata: Record<string, unknown> = {};
      if (typeof link.metadata === "string" && link.metadata.trim()) {
        try {
          parsedMetadata = JSON.parse(link.metadata);
        } catch {
          parsedMetadata = {};
        }
      }

      const linkSeriesCandidates = [
        String(link.seriesId || ""),
        String(parsedMetadata.recurringEventId || ""),
        String(parsedMetadata.iCalUID || ""),
      ].filter((value) => value.length > 0);

      if (targetSeries.length > 0 && linkSeriesCandidates.length > 0) {
        if (linkSeriesCandidates.some((value) => targetSeries.includes(value))) {
          return true;
        }
      }

      // If the selected event has no series but the link does, treat as non-match.
      if (targetSeries.length === 0 && linkSeriesCandidates.length > 0) {
        return false;
      }

      const occurrence = String(link.occurrenceStartIso || "");
      if (!eventStart || !occurrence) return false;
      if (occurrence === eventStart) return true;

      const eventStartDate = new Date(eventStart);
      const occurrenceDate = new Date(occurrence);
      if (Number.isNaN(eventStartDate.getTime()) || Number.isNaN(occurrenceDate.getTime())) {
        return false;
      }

      const sameDay =
        eventStartDate.getFullYear() === occurrenceDate.getFullYear() &&
        eventStartDate.getMonth() === occurrenceDate.getMonth() &&
        eventStartDate.getDate() === occurrenceDate.getDate();

      if (!sameDay) return false;

      const linkTitle = normalizeEventText(
        String(parsedMetadata.sourceTitle || link.sourceTitle || "")
      );
      if (eventSummary && linkTitle && eventSummary !== linkTitle) {
        return false;
      }

      return true;
    };

    return notes
      .map((note: any) => {
        const matchingLinks = (Array.isArray(note.links) ? note.links : []).filter(matchesLink);
        if (matchingLinks.length === 0) return null;
        const latestOccurrence = matchingLinks
          .map((link: any) => String(link.occurrenceStartIso || ""))
          .filter((value: string) => value.length > 0)
          .sort((a: string, b: string) => new Date(b).getTime() - new Date(a).getTime())[0];
        return { ...note, matchingLinks, latestOccurrence };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => {
        const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bTs - aTs;
      });
  }, [selectedCalendarHistoryEvent, notes]);

  const todaysCalendarEvents = useMemo(() => {
    const now = new Date();
    return (calendarEvents || [])
      .filter((event: any) => {
        const startTime = event.start?.dateTime || event.start?.date;
        if (!startTime) return false;
        const eventDate = new Date(startTime);
        return isSameLocalDay(eventDate, now);
      })
      .slice(0, 8)
      .map((event: any) => ({
        summary: event.summary || "Untitled event",
        start: event.start?.dateTime || event.start?.date || "",
        location: event.location || "",
      }));
  }, [calendarEvents]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMinuteTick(new Date());
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const nextCalendarEvent = useMemo(() => {
    const nowMs = minuteTick.getTime();
    const todayStart = new Date(minuteTick);
    todayStart.setHours(0, 0, 0, 0);

    const candidates = (calendarEvents || [])
      .map((event: any) => {
        if (event?.start?.dateTime) {
          return {
            event,
            startDate: new Date(event.start.dateTime),
            isAllDay: false,
          };
        }
        if (event?.start?.date) {
          return {
            event,
            startDate: new Date(`${event.start.date}T00:00:00`),
            isAllDay: true,
          };
        }
        return null;
      })
      .filter((item: any) => {
        if (!item) return false;
        if (item.isAllDay) return item.startDate.getTime() >= todayStart.getTime();
        return item.startDate.getTime() >= nowMs;
      })
      .sort((a: any, b: any) => a.startDate.getTime() - b.startDate.getTime());

    return candidates[0] ?? null;
  }, [calendarEvents, minuteTick]);

  const prioritizedEmails = useMemo(() => {
    const urgentPattern =
      /(urgent|asap|action required|deadline|overdue|today|tomorrow|important|final notice|payment due|invoice)/i;

    return (gmailMessages || [])
      .map((message: any) => {
        const subject = getEmailHeader(message, "Subject");
        const from = getEmailHeader(message, "From");
        const dateHeader = getEmailHeader(message, "Date");
        const snippet = message.snippet || "";
        const textBlob = `${subject} ${snippet}`;
        let score = 0;
        const reasons: string[] = [];

        if (urgentPattern.test(textBlob)) {
          score += 3;
          reasons.push("Urgent language");
        }

        const parsedDate = new Date(dateHeader);
        if (!Number.isNaN(parsedDate.getTime())) {
          const ageHours = (Date.now() - parsedDate.getTime()) / (1000 * 60 * 60);
          if (ageHours <= 24) {
            score += 2;
            reasons.push("Received in last 24h");
          } else if (ageHours <= 72) {
            score += 1;
          }
        }

        if (/boss|manager|director|ceo|client|invoice|billing|finance/i.test(textBlob)) {
          score += 1;
          reasons.push("Likely business-critical");
        }

        return {
          id: String(message.id || ""),
          threadId: String(message.threadId || ""),
          from,
          subject: subject || "(No subject)",
          snippet,
          date: dateHeader,
          reason: reasons.join(", ") || "Important/unread signal",
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }, [gmailMessages]);

  const triageEmails = useMemo(() => {
    return prioritizedEmails.slice(0, 5).map((email) => ({
      id: email.id,
      sender: email.from || "Unknown sender",
      subject: email.subject || "(No subject)",
      preview: email.snippet || "No preview",
    }));
  }, [prioritizedEmails]);

  const decisionsToMake = useMemo(() => {
    return prioritizedEmails.slice(0, 4).map((email) => ({
      id: `decision:${email.id}`,
      title: `Respond: ${email.subject}`,
      detail: email.reason || "Requires follow-up",
    }));
  }, [prioritizedEmails]);

  const waitingOnItems = useMemo(() => {
    return (gmailWaitingOn || []).slice(0, 4).map((item: any) => ({
      id: String(item.threadId || item.id || ""),
      title: item.subject || "(No subject)",
      detail: item.to || item.from || "Awaiting response",
    }));
  }, [gmailWaitingOn]);
  
  const createSpreadsheet = trpc.google.createSpreadsheet.useMutation({
    onSuccess: (data) => {
      toast.success("Spreadsheet created!");
      window.open(data.webViewLink, "_blank");
      refetchDrive();
    },
    onError: (error) => {
      toast.error(`Failed to create spreadsheet: ${error.message}`);
    },
  });
  
  const createTaskFromEmail = trpc.todoist.createTaskFromEmail.useMutation({
    onSuccess: () => {
      toast.success("Task created in Todoist!");
      refetchTasks();
      refetchDueTodayTasks();
    },
    onError: (error) => {
      toast.error(`Failed to create task: ${error.message}`);
    },
  });

  const markEmailAsRead = trpc.google.markGmailAsRead.useMutation({
    onMutate: async ({ messageId }) => {
      setMarkingEmailId(messageId);
      const queryInput = { maxResults: 50 };
      await trpcUtils.google.getGmailMessages.cancel(queryInput);
      const previous = trpcUtils.google.getGmailMessages.getData(queryInput);
      trpcUtils.google.getGmailMessages.setData(queryInput, (current) => {
        if (!Array.isArray(current)) return current;
        return current.filter((message: any) => message.id !== messageId);
      });
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        trpcUtils.google.getGmailMessages.setData({ maxResults: 50 }, context.previous);
      }
      toast.error(`Failed to mark as read: ${error.message}`);
    },
    onSuccess: () => {
      toast.success("Email marked as read");
    },
    onSettled: () => {
      setMarkingEmailId(null);
      refetchEmails();
    },
  });

  const quickAddTodoistTask = trpc.todoist.createTask.useMutation({
    onSuccess: () => {
      toast.success("Task added");
      setQuickTodoistTaskInput("");
      refetchTasks();
      refetchDueTodayTasks();
    },
    onError: (error) => {
      toast.error(`Failed to add task: ${error.message}`);
    },
  });

  const saveSamsungManualScores = trpc.samsungHealth.saveManualScores.useMutation({
    onSuccess: () => {
      toast.success("Samsung scores updated");
      refetchIntegrations();
    },
    onError: (error) => {
      toast.error(`Failed to save Samsung scores: ${error.message}`);
    },
  });

  const captureDailyMetrics = trpc.metrics.captureToday.useMutation({
    onSuccess: () => {
      refetchMetricHistory();
    },
    onError: (error) => {
      console.error("Failed to capture daily metrics:", error);
    },
  });

  useEffect(() => {
    const receivedAt = samsungHealthSnapshot?.receivedAt ?? null;
    if (!receivedAt) return;

    if (!lastSamsungSyncSeenRef.current) {
      lastSamsungSyncSeenRef.current = receivedAt;
      return;
    }

    if (lastSamsungSyncSeenRef.current === receivedAt) return;
    lastSamsungSyncSeenRef.current = receivedAt;

    // A fresh Samsung payload arrived; refresh dashboard data and capture metrics immediately.
    captureDailyMetrics.mutate({ dateKey: todayKey });
    refetchMetricHistory();
    refetchSupplementLogs();
    refetchHabitsForToday();
  }, [
    samsungHealthSnapshot?.receivedAt,
    captureDailyMetrics,
    refetchMetricHistory,
    refetchSupplementLogs,
    refetchHabitsForToday,
    todayKey,
  ]);

  const addSupplementLog = trpc.supplements.addLog.useMutation({
    onSuccess: () => {
      setSupplementName("");
      setSupplementDose("");
      setSupplementDoseUnit("capsule");
      setSupplementTiming("am");
      refetchSupplementLogs();
      refetchMetricHistory();
    },
    onError: (error) => {
      toast.error(`Failed to add supplement log: ${error.message}`);
    },
  });

  const deleteSupplementLog = trpc.supplements.deleteLog.useMutation({
    onSuccess: () => {
      refetchSupplementLogs();
    },
    onError: (error) => {
      toast.error(`Failed to delete supplement log: ${error.message}`);
    },
  });

  const createSupplementDefinition = trpc.supplements.createDefinition.useMutation({
    onSuccess: () => {
      toast.success("Supplement added to protocol");
      setSupplementName("");
      setSupplementDose("");
      setSupplementDoseUnit("capsule");
      setSupplementTiming("am");
      refetchSupplementDefinitions();
    },
    onError: (error) => {
      toast.error(`Failed to add to protocol: ${error.message}`);
    },
  });

  const setSupplementDefinitionLock = trpc.supplements.setDefinitionLock.useMutation({
    onSuccess: () => {
      refetchSupplementDefinitions();
      refetchSupplementLogs();
    },
    onError: (error) => {
      toast.error(`Failed to update lock: ${error.message}`);
    },
  });

  const deleteSupplementDefinition = trpc.supplements.deleteDefinition.useMutation({
    onSuccess: () => {
      refetchSupplementDefinitions();
      refetchSupplementLogs();
    },
    onError: (error) => {
      toast.error(`Failed to delete supplement: ${error.message}`);
    },
  });

  const createNoteMutation = trpc.notes.create.useMutation({
    onSuccess: () => {
      toast.success("Note created");
      setNoteTitleInput("");
      setNoteContentInput("");
      setNoteNotebookInput("General");
      setEditingNoteId(null);
      refetchNotes();
    },
    onError: (error) => {
      toast.error(`Failed to create note: ${error.message}`);
    },
  });

  const updateNoteMutation = trpc.notes.update.useMutation({
    onSuccess: () => {
      toast.success("Note updated");
      setNoteTitleInput("");
      setNoteContentInput("");
      setNoteNotebookInput("General");
      setEditingNoteId(null);
      refetchNotes();
    },
    onError: (error) => {
      toast.error(`Failed to update note: ${error.message}`);
    },
  });

  const deleteNoteMutation = trpc.notes.delete.useMutation({
    onSuccess: () => {
      toast.success("Note deleted");
      if (editingNoteId) {
        setEditingNoteId(null);
        setNoteTitleInput("");
        setNoteContentInput("");
        setNoteNotebookInput("General");
      }
      refetchNotes();
    },
    onError: (error) => {
      toast.error(`Failed to delete note: ${error.message}`);
    },
  });

  const addNoteLinkMutation = trpc.notes.addLink.useMutation({
    onSuccess: (result) => {
      if (result?.alreadyLinked) {
        toast.info("This item is already linked to the note");
      } else {
        toast.success("Link added");
      }
      setLinkTaskId("");
      setLinkEventId("");
      refetchNotes();
    },
    onError: (error) => {
      toast.error(`Failed to add link: ${error.message}`);
    },
  });

  const removeNoteLinkMutation = trpc.notes.removeLink.useMutation({
    onSuccess: () => {
      toast.success("Link removed");
      refetchNotes();
    },
    onError: (error) => {
      toast.error(`Failed to remove link: ${error.message}`);
    },
  });

  const createNoteFromTaskMutation = trpc.notes.createFromTodoistTask.useMutation({
    onSuccess: () => {
      toast.success("Task note created");
      refetchNotes();
    },
    onError: (error) => {
      toast.error(`Failed to create task note: ${error.message}`);
    },
  });

  const createNoteFromCalendarMutation = trpc.notes.createFromCalendarEvent.useMutation({
    onSuccess: () => {
      toast.success("Event note created");
      refetchNotes();
    },
    onError: (error) => {
      toast.error(`Failed to create event note: ${error.message}`);
    },
  });

  const setHabitCompletion = trpc.habits.setCompletion.useMutation({
    onSuccess: () => {
      refetchHabitsForToday();
    },
    onError: (error) => {
      toast.error(`Failed to update habit: ${error.message}`);
    },
  });

  const updatePreferences = trpc.preferences.update.useMutation({
    onSuccess: () => {
      refetchPreferences();
      toast.success("Header name updated");
    },
    onError: (error) => {
      toast.error(`Failed to save name: ${error.message}`);
    },
  });

  const handleAddEmailToTodoist = (message: any, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const getEmailHeader = (msg: any, headerName: string) => {
      const header = msg.payload?.headers?.find((h: any) => h.name === headerName);
      return header?.value || '';
    };
    const subject = getEmailHeader(message, "Subject");
    const emailLink = `https://mail.google.com/mail/u/0/#inbox/${message.id}`;
    const body = message.bodyText || message.snippet || '';
    
    createTaskFromEmail.mutate({ subject, emailLink, body });
  };

  const handleMarkEmailAsRead = (messageId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (markEmailAsRead.isPending) return;
    markEmailAsRead.mutate({ messageId });
  };

  const handleTriageReply = (email: { id: string }) => {
    window.open(`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(email.id)}`, "_blank", "noopener,noreferrer");
  };

  const handleTriageMarkRead = (email: { id: string }) => {
    if (markEmailAsRead.isPending) return;
    markEmailAsRead.mutate({ messageId: email.id });
  };

  const handleTriageMakeTask = (email: { id: string; subject: string; preview: string }) => {
    createTaskFromEmail.mutate({
      subject: email.subject,
      emailLink: `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(email.id)}`,
      body: email.preview || "",
    });
  };

  const handleSendNudge = (item: { id: string }) => {
    const source = (gmailWaitingOn || []).find((row: any) => String(row.threadId || row.id || "") === item.id);
    const url = typeof source?.url === "string" && source.url.length > 0
      ? source.url
      : `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(item.id)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleSaveWelcomeName = () => {
    const trimmed = welcomeDisplayNameInput.trim();
    const nextDisplayName = trimmed.length > 0 ? trimmed : null;
    const currentDisplayName = preferences?.displayName ?? null;
    if ((currentDisplayName ?? "") === (nextDisplayName ?? "")) return;
    updatePreferences.mutate({
      displayName: nextDisplayName,
    });
  };

  const parseScoreInput = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      throw new Error("Scores must be numeric");
    }
    if (numeric < 0 || numeric > 100) {
      throw new Error("Scores must be between 0 and 100");
    }
    return Math.round(numeric * 10) / 10;
  };

  const handleSaveSamsungManualScores = (onSaved?: () => void) => {
    try {
      const sleepScore = parseScoreInput(manualSleepScoreInput);
      const energyScore = parseScoreInput(manualEnergyScoreInput);
      saveSamsungManualScores.mutate(
        { sleepScore, energyScore },
        {
          onSuccess: () => {
            onSaved?.();
          },
        }
      );
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const handleAddSupplementLog = () => {
    if (!supplementName.trim() || !supplementDose.trim()) {
      toast.error("Enter supplement and dose");
      return;
    }
    addSupplementLog.mutate({
      name: supplementName.trim(),
      dose: supplementDose.trim(),
      doseUnit: supplementDoseUnit,
      timing: supplementTiming,
      dateKey: todayKey,
    });
  };

  const handleSubmitNote = () => {
    const title = noteTitleInput.trim();
    const notebook = noteNotebookInput.trim() || "General";
    if (!title) {
      toast.error("Note title is required");
      return;
    }
    if (editingNoteId) {
      updateNoteMutation.mutate({
        noteId: editingNoteId,
        notebook,
        title,
        content: noteContentInput,
      });
      return;
    }
    createNoteMutation.mutate({
      notebook,
      title,
      content: noteContentInput,
    });
  };

  const handleEditNote = (note: any) => {
    setEditingNoteId(note.id);
    setNoteNotebookInput(note.notebook || "General");
    setNoteTitleInput(note.title || "");
    setNoteContentInput(toPlainText(String(note.content || "")));
  };

  const handleLinkExistingNoteToTask = () => {
    if (!linkNoteId || !selectedTaskForLink) {
      toast.error("Select a note and a task");
      return;
    }
    addNoteLinkMutation.mutate({
      noteId: linkNoteId,
      linkType: "todoist_task",
      externalId: String(selectedTaskForLink.id),
      sourceUrl:
        (selectedTaskForLink as any).url ||
        `https://todoist.com/app/task/${selectedTaskForLink.id}`,
      sourceTitle: String(selectedTaskForLink.content || "Todoist task"),
      metadata: {
        dueDate: selectedTaskForLink.due?.date ?? selectedTaskForLink.due?.string ?? null,
      },
    });
  };

  const handleLinkExistingNoteToEvent = () => {
    if (!linkNoteId || !selectedEventForLink) {
      toast.error("Select a note and an event");
      return;
    }
    addNoteLinkMutation.mutate({
      noteId: linkNoteId,
      linkType: "google_calendar_event",
      externalId: String(selectedEventForLink.id || ""),
      seriesId: selectedEventForLink.recurringEventId || selectedEventForLink.iCalUID || "",
      occurrenceStartIso:
        selectedEventForLink.start?.dateTime || selectedEventForLink.start?.date || "",
      sourceUrl: selectedEventForLink.htmlLink || undefined,
      sourceTitle: String(selectedEventForLink.summary || "Google Calendar event"),
      metadata: {
        location: selectedEventForLink.location || null,
        recurringEventId: selectedEventForLink.recurringEventId || null,
        iCalUID: selectedEventForLink.iCalUID || null,
      },
    });
  };

  const handleCreateNoteFromTask = (task: any) => {
    createNoteFromTaskMutation.mutate({
      taskId: String(task.id),
      taskContent: String(task.content || "Untitled task"),
      taskUrl: task.url || `https://todoist.com/app/task/${task.id}`,
      dueDate: task.due?.date ?? task.due?.string ?? undefined,
      projectName:
        todoistFilter.startsWith("project_")
          ? todoistProjects?.find((p: any) => p.id === todoistFilter.replace("project_", ""))?.name
          : undefined,
    });
  };

  const handleCreateNoteFromCalendarEvent = (event: any) => {
    createNoteFromCalendarMutation.mutate({
      eventId: String(event.id || ""),
      eventSummary: String(event.summary || "Untitled event"),
      eventUrl: event.htmlLink || undefined,
      start: event.start?.dateTime || event.start?.date || undefined,
      location: event.location || undefined,
      recurringEventId: event.recurringEventId || undefined,
      iCalUID: event.iCalUID || undefined,
    });
  };

  const openNotebookForCalendarEvent = (event: any) => {
    const params = new URLSearchParams();
    params.set("view", "calendar");
    if (event?.id) {
      params.set("eventId", String(event.id));
    }
    const seriesId = String(event?.recurringEventId || event?.iCalUID || "");
    if (seriesId) {
      params.set("seriesId", seriesId);
    }
    setLocation(`/notes?${params.toString()}`);
  };

  const handleAddSupplementDefinition = () => {
    if (!supplementName.trim() || !supplementDose.trim()) {
      toast.error("Enter supplement and dose");
      return;
    }
    createSupplementDefinition.mutate({
      name: supplementName.trim(),
      dose: supplementDose.trim(),
      doseUnit: supplementDoseUnit,
      timing: supplementTiming,
    });
  };

  const handleToggleHabit = (habitId: string, completed: boolean) => {
    setHabitCompletion.mutate({
      habitId,
      completed,
      dateKey: todayKey,
    });
  };

  const handleCompleteHabitFromPlan = (habitId: string) => {
    handleToggleHabit(habitId, true);
  };

  const handleRegenerateTodaysPlan = async () => {
    await Promise.all([
      refetchCalendar(),
      refetchDueTodayTasks(),
      refetchTasks(),
      refetchAllTodoistTasks(),
      refetchEmails(),
      refetchHabitsForToday(),
    ]);
  };
  
  const searchDriveMutation = trpc.google.searchDrive.useQuery(
    { query: driveSearchQuery },
    { enabled: false }
  );
  
  const handleDriveSearch = async () => {
    if (!driveSearchQuery.trim()) {
      setDriveSearchResults(null);
      return;
    }
    setIsSearching(true);
    try {
      const results = await searchDriveMutation.refetch();
      setDriveSearchResults(results.data || []);
    } catch (error) {
      toast.error("Failed to search Drive");
    } finally {
      setIsSearching(false);
    }
  };
  
  const clearDriveSearch = () => {
    setDriveSearchQuery("");
    setDriveSearchResults(null);
  };
  
  // Show search results if available, otherwise show recent files
  const displayedDriveFiles = driveSearchResults !== null ? driveSearchResults : (driveFiles || []);
  
  const { data: conversations, refetch: refetchConversations } = trpc.conversations.list.useQuery(undefined, {
    enabled: !!user && shouldLoadChatData,
  });
  
  const { data: messages, refetch: refetchMessages } = trpc.conversations.getMessages.useQuery(
    { conversationId: selectedConversationId! },
    { enabled: !!selectedConversationId && shouldLoadChatData }
  );
  
  const createConversation = trpc.conversations.create.useMutation({
    onSuccess: (data) => {
      setSelectedConversationId(data.id);
      refetchConversations();
      toast.success("New conversation started");
    },
  });
  
  const deleteConversation = trpc.conversations.delete.useMutation({
    onSuccess: () => {
      setSelectedConversationId(null);
      refetchConversations();
      toast.success("Conversation deleted");
    },
  });
  
  const sendMessage = trpc.openai.chat.useMutation({
    onSuccess: () => {
      refetchMessages();
      setChatMessage("");
    },
    onError: (error) => {
      toast.error(`Chat error: ${error.message}`);
    },
  });
  
  const completeTask = trpc.todoist.completeTask.useMutation({
    onSuccess: () => {
      toast.success("Task completed!");
      refetchTasks();
      refetchDueTodayTasks();
      refetchTodoistCompletedToday();
      captureDailyMetrics.mutate({ dateKey: todayKey });
      window.setTimeout(() => {
        refetchTodoistCompletedToday();
        captureDailyMetrics.mutate({ dateKey: todayKey });
      }, 5000);
    },
    onError: (error) => {
      toast.error(`Failed to complete task: ${error.message}`);
    },
  });

  const saveDailyBriefCache = (brief: DailyBrief, date: string) => {
    setDailyBrief(brief);
    setDailyBriefDate(date);
    localStorage.setItem(
      DAILY_BRIEF_CACHE_KEY,
      JSON.stringify({
        date,
        brief,
      })
    );
  };

  const regenerateDailyBrief = async () => {
    try {
      setIsGeneratingDailyBrief(true);
      const brief = buildDailyBrief({
        now: new Date(),
        todayKey,
        calendarEvents: calendarEvents || [],
        todoistTasks: dueTodayTasks || [],
        prioritizedEmails,
        waitingOnEmails: gmailWaitingOn || [],
        whoopSummary,
        samsungHealthSnapshot,
        notes: notes || [],
      });
      saveDailyBriefCache(withFreshness(brief, new Date()), todayKey);
    } catch (error) {
      console.error("Failed to build daily brief:", error);
      // Safe fallback keeps the section operational if upstream data is malformed.
      saveDailyBriefCache(withFreshness({ ...MOCK_DAILY_BRIEF, generatedAt: new Date().toISOString() }, new Date()), todayKey);
    } finally {
      setIsGeneratingDailyBrief(false);
    }
  };

  useEffect(() => {
    const cached = localStorage.getItem(DAILY_BRIEF_CACHE_KEY);
    if (!cached) return;
    try {
      const parsed = JSON.parse(cached);
      if (parsed?.date === todayKey && parsed?.brief && typeof parsed.brief === "object") {
        setDailyBrief(withFreshness(parsed.brief as DailyBrief, new Date()));
        setDailyBriefDate(parsed.date);
      }
    } catch {
      // Ignore malformed cache and regenerate.
    }
  }, [todayKey]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setWeather({
        loading: false,
        summary: "",
        location: "",
        temperatureF: null,
        error: "Geolocation not supported",
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          const weatherResponse = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`
          );
          const weatherData = await weatherResponse.json();
          const current = weatherData?.current ?? {};

          let location = "";
          try {
            const geoResponse = await fetch(
              `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${latitude}&longitude=${longitude}&language=en&count=1`
            );
            const geoData = await geoResponse.json();
            const place = geoData?.results?.[0];
            if (place) {
              const parts = [place.name, place.admin1].filter(Boolean);
              location = parts.join(", ");
            }
          } catch {
            // Location name is optional.
          }

          setWeather({
            loading: false,
            summary: getWeatherLabel(current.weather_code),
            location,
            temperatureF:
              typeof current.temperature_2m === "number" ? current.temperature_2m : null,
            error: null,
          });
        } catch (error) {
          setWeather({
            loading: false,
            summary: "",
            location: "",
            temperatureF: null,
            error: (error as Error).message || "Weather fetch failed",
          });
        }
      },
      (error) => {
        setWeather({
          loading: false,
          summary: "",
          location: "",
          temperatureF: null,
          error: error.message || "Location access denied",
        });
      },
      {
        timeout: 10000,
      }
    );
  }, []);

  useEffect(() => {
    if (!user) return;
    if (isGeneratingDailyBrief) return;
    if (dailyBriefDate === todayKey && dailyBrief) return;

    const googleReady =
      !hasGoogle || (!calendarLoading && !emailsLoading && (!waitingOnLoading || Boolean(waitingOnError)));
    const todoistReady = !hasTodoist || !dueTodayTasksLoading;
    const weatherReady = !weather.loading;
    if (!googleReady || !todoistReady || !weatherReady) return;

    regenerateDailyBrief().catch((error) => {
      console.error("Daily brief generation failed:", error);
    });
  }, [
    user,
    isGeneratingDailyBrief,
    dailyBriefDate,
    dailyBrief,
    todayKey,
    hasGoogle,
    calendarLoading,
    emailsLoading,
    hasTodoist,
    dueTodayTasksLoading,
    weather.loading,
    prioritizedEmails,
    gmailWaitingOn,
    dueTodayTasks,
    calendarEvents,
    whoopSummary,
    samsungHealthSnapshot,
    notes,
    waitingOnLoading,
    waitingOnError,
  ]);

  useEffect(() => {
    if (!user) return;
    if (isLoading || integrationsFetching) return;
    if (metricCaptureStartedRef.current) return;

    metricCaptureStartedRef.current = true;
    const runCapture = () => {
      captureDailyMetrics.mutate({ dateKey: todayKey });
    };

    runCapture();
    const intervalId = window.setInterval(runCapture, 15 * 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [
    user,
    isLoading,
    integrationsFetching,
    captureDailyMetrics,
    todayKey,
  ]);
  
  const handleCompleteTask = (taskId: string) => {
    completeTask.mutate({ taskId });
  };

  const handleQuickAddTodoistTask = () => {
    const content = quickTodoistTaskInput.trim();
    if (!content) return;
    quickAddTodoistTask.mutate({ content });
  };
  
  const handleNewConversation = () => {
    const title = `Chat ${new Date().toLocaleString()}`;
    createConversation.mutate({ title });
  };
  
  const handleSendMessage = () => {
    if (!chatMessage.trim()) return;
    if (!selectedConversationId) {
      // Create new conversation first
      const title = chatMessage.slice(0, 50);
      createConversation.mutate({ title }, {
        onSuccess: (data) => {
          sendMessage.mutate({ conversationId: data.id, message: chatMessage });
        },
      });
    } else {
      sendMessage.mutate({ conversationId: selectedConversationId, message: chatMessage });
    }
  };

  const handleDeleteConversation = (id: string) => {
    if (confirm("Delete this conversation?")) {
      deleteConversation.mutate({ conversationId: id });
    }
  };
  
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);
  
  useEffect(() => {
    if (!loading && !user) {
      setLocation("/");
    }
  }, [loading, user, setLocation]);

  const effectiveDailyBrief = useMemo(() => {
    if (dailyBrief) return withFreshness(dailyBrief, new Date());
    return withFreshness({ ...MOCK_DAILY_BRIEF, generatedAt: new Date().toISOString() }, new Date());
  }, [dailyBrief, minuteTick]);

  const toGoogleCalendarUtcStamp = (value: Date) =>
    value
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");

  const handleDailyBriefAction = (action: DailyBriefAction) => {
    const openUrl = (url: unknown) => {
      if (typeof url === "string" && url.trim()) {
        if (url.startsWith("/")) {
          setLocation(url);
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      }
    };

    switch (action.kind) {
      case "open_email": {
        const wantsMarkRead =
          Boolean(action.payload?.markRead) || Boolean(action.payload?.archiveHint);
        const messageId = typeof action.payload?.id === "string" ? action.payload.id : "";

        if (wantsMarkRead) {
          if (!messageId) {
            toast.error("No email id available to mark as read");
            return;
          }
          if (markEmailAsRead.isPending) return;
          markEmailAsRead.mutate({ messageId });
          return;
        }
        openUrl(action.payload?.url);
        return;
      }
      case "open_event":
      case "open_task":
      case "open_note":
        openUrl(action.payload?.url);
        return;
      case "insert_draft": {
        const text = typeof action.payload?.text === "string" ? action.payload.text : "";
        if (!text) {
          toast.error("No draft text available");
          return;
        }
        navigator.clipboard
          .writeText(text)
          .then(() => toast.success("Draft copied to clipboard"))
          .catch(() => toast.error("Failed to copy draft"));
        return;
      }
      case "create_task": {
        const content = typeof action.payload?.content === "string" ? action.payload.content.trim() : "";
        if (!content) {
          toast.error("No task content provided");
          return;
        }
        if (!hasTodoist) {
          toast.error("Connect Todoist to create tasks");
          return;
        }
        quickAddTodoistTask.mutate({ content });
        return;
      }
      case "schedule_block": {
        const title = typeof action.payload?.title === "string" ? action.payload.title : "Focus block";
        const startIso = typeof action.payload?.startTime === "string" ? action.payload.startTime : "";
        const endIso = typeof action.payload?.endTime === "string" ? action.payload.endTime : "";
        const start = startIso ? new Date(startIso) : new Date();
        const end = endIso ? new Date(endIso) : new Date(start.getTime() + 45 * 60 * 1000);

        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          toast.error("Invalid time range for scheduled block");
          return;
        }

        const calendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(
          title
        )}&dates=${toGoogleCalendarUtcStamp(start)}/${toGoogleCalendarUtcStamp(end)}&details=${encodeURIComponent(
          "Created from Coherence Daily Brief"
        )}`;
        window.open(calendarUrl, "_blank", "noopener,noreferrer");
        return;
      }
      case "send_message": {
        const text = typeof action.payload?.text === "string" ? action.payload.text : "";
        if (!text) {
          toast.error("No message available");
          return;
        }
        navigator.clipboard
          .writeText(text)
          .then(() => toast.success("Message copied"))
          .catch(() => toast.error("Failed to copy message"));
        return;
      }
      default:
        return;
    }
  };
  
  if (loading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
      </div>
    );
  }
  
  if (!user) {
    return null;
  }
  
  const formatEventTime = (event: any) => {
    const start = event.start?.dateTime || event.start?.date;
    if (!start) return "";
    const date = new Date(start);
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };
  
  const formatEmailDate = (internalDate: string) => {
    const date = new Date(parseInt(internalDate));
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const whoopErrorMessage =
    whoopError && typeof whoopError.message === "string" ? whoopError.message : null;
  const toPercent = (value: number | null) =>
    value === null ? "-" : `${Math.round(value)}%`;
  const toOneDecimal = (value: number | null) =>
    value === null ? "-" : value.toFixed(1);
  const toInteger = (value: number | null) =>
    value === null ? "-" : Math.round(value).toLocaleString("en-US");
  const celsiusToFahrenheit = (value: number | null) =>
    value === null ? null : Number(((value * 9) / 5 + 32).toFixed(1));
  const kilojouleToCalories = (value: number | null) =>
    value === null ? null : Number((value / 4.184).toFixed(0));
  const formatHoursAndMinutes = (minutes: number) => {
    const totalMinutes = Math.max(0, Math.round(minutes));
    const hours = Math.floor(totalMinutes / 60);
    const remainder = totalMinutes % 60;
    if (hours > 0 && remainder > 0) return `${hours}h ${remainder}m`;
    if (hours > 0) return `${hours}h`;
    return `${remainder}m`;
  };
  const recentMetricRows = (metricHistory || []).slice(0, 7);
  const dailyTrendChartData = [...recentMetricRows]
    .reverse()
    .map((row: any) => ({
      date: String(row.dateKey || "").slice(5),
      recovery: row.whoopRecoveryScore ?? null,
      steps: row.samsungSteps ?? null,
      completed: row.todoistCompletedCount ?? null,
    }));
  const emailPriorityChartData = (() => {
    const buckets = [
      { label: "High (4+)", count: 0 },
      { label: "Medium (2-3)", count: 0 },
      { label: "Low (0-1)", count: 0 },
    ];
    prioritizedEmails.forEach((email) => {
      if (email.score >= 4) buckets[0].count += 1;
      else if (email.score >= 2) buckets[1].count += 1;
      else buckets[2].count += 1;
    });
    return buckets;
  })();
  const habitCompletionChartData = (() => {
    const total = (habitsForToday || []).length;
    const completed = (habitsForToday || []).filter((habit: any) => habit.completed).length;
    return [
      { name: "Completed", value: completed, color: "#059669" },
      { name: "Remaining", value: Math.max(0, total - completed), color: "#cbd5e1" },
    ];
  })();
  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div id="dashboard-top" className="min-h-screen overflow-x-clip bg-gradient-to-br from-slate-100 via-white to-emerald-50 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950 flex flex-col">
      {/* Header */}
      <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Coherence</h1>
            <div className="mt-1 flex items-center gap-2">
              <Input
                value={welcomeDisplayNameInput}
                onChange={(e) => setWelcomeDisplayNameInput(e.target.value)}
                onBlur={handleSaveWelcomeName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
                className="h-8 w-64 text-sm bg-white dark:bg-slate-900"
                maxLength={120}
                placeholder="Enter display name"
              />
              {updatePreferences.isPending && (
                <span className="text-xs text-slate-500">Saving...</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setLocation("/notes")}>
              <FileText className="h-4 w-4 mr-2" />
              Notebook
            </Button>
            <Button variant="outline" onClick={() => setLocation("/solar-rec-dashboard")}>
              <BarChart3 className="h-4 w-4 mr-2" />
              Solar REC
            </Button>
            <Button variant="outline" onClick={() => setLocation("/deep-update-synthesizer")}>
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              Deep Update
            </Button>
            <Button variant="outline" onClick={() => setLocation("/enphase-v4-meter-reads")}>
              <Database className="h-4 w-4 mr-2" />
              Enphase v4
            </Button>
            <Button variant="outline" onClick={() => setLocation("/solaredge-meter-reads")}>
              <Database className="h-4 w-4 mr-2" />
              SolarEdge API
            </Button>
            <Button variant="outline" onClick={() => setLocation("/tesla-solar-api")}>
              <Database className="h-4 w-4 mr-2" />
              Tesla Solar API
            </Button>
            <Button variant="outline" onClick={() => setLocation("/zendesk-ticket-metrics")}>
              <Database className="h-4 w-4 mr-2" />
              Zendesk API
            </Button>
            <Button variant="outline" onClick={() => setLocation("/settings")}>
              <SettingsIcon className="h-4 w-4 mr-2" />
              Settings
            </Button>
          </div>
        </div>
      </header>

      <div className="sticky top-[76px] z-20 bg-gradient-to-br from-slate-100/95 via-white/95 to-emerald-50/95 dark:from-slate-950/95 dark:via-slate-900/95 dark:to-blue-950/95 backdrop-blur-sm">
        <div className="container mx-auto px-4 pt-3">
          <Card className="border-emerald-200 bg-gradient-to-r from-emerald-50 via-white to-slate-50">
            <CardContent className="py-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-md border border-slate-200 bg-white/90 p-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Current Time</p>
                  <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <LiveClockValue />
                  </p>
                </div>

                <div className="rounded-md border border-slate-200 bg-white/90 p-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Weather</p>
                  <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <CloudSun className="h-4 w-4 text-emerald-600" />
                    {weather.loading
                      ? "Loading..."
                      : weather.error
                        ? "Unavailable"
                        : `${weather.summary}${weather.temperatureF !== null ? `, ${Math.round(weather.temperatureF)}F` : ""}`}
                  </p>
                </div>

                <div className="rounded-md border border-slate-200 bg-white/90 p-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Next Event</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {!hasGoogle
                      ? "Connect Google Calendar"
                      : calendarLoading
                        ? "Loading..."
                        : nextCalendarEvent
                          ? `${nextCalendarEvent.event?.summary || "Untitled event"} · ${
                              nextCalendarEvent.isAllDay
                                ? "All day"
                                : nextCalendarEvent.startDate.toLocaleTimeString("en-US", {
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })
                            }`
                          : "No upcoming events"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="container mx-auto px-4 py-2">
          <div className="rounded-xl border border-rose-200 bg-gradient-to-r from-rose-50 via-white to-red-50 px-3 py-2 shadow-[0_10px_28px_rgba(225,29,72,0.12)]">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs border border-slate-200 bg-white hover:bg-slate-50"
              onClick={() => scrollToSection("section-overview")}
            >
              <FileText className="h-3.5 w-3.5 mr-1.5 text-slate-700" />
              Today's Plan
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs border border-cyan-200 bg-cyan-50 hover:bg-cyan-100"
              onClick={() => scrollToSection("section-health")}
            >
              <HeartPulse className="h-3.5 w-3.5 mr-1.5 text-cyan-700" />
              Health
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs border border-emerald-200 bg-emerald-50 hover:bg-emerald-100"
              onClick={() => scrollToSection("section-tracking")}
            >
              <BarChart3 className="h-3.5 w-3.5 mr-1.5 text-emerald-700" />
              Tracking
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs border border-red-200 bg-red-50 hover:bg-red-100"
              onClick={() => scrollToSection("section-todoist")}
            >
              <CheckSquare className="h-3.5 w-3.5 mr-1.5 text-red-600" />
              Todoist
            </Button>
            {isDetailedMode ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs border border-emerald-200 bg-emerald-50 hover:bg-emerald-100"
                  onClick={() => scrollToSection("section-workspace")}
                >
                  <Calendar className="h-3.5 w-3.5 mr-1.5 text-emerald-700" />
                  Workspace
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs border border-violet-200 bg-violet-50 hover:bg-violet-100"
                  onClick={() => scrollToSection("section-chat")}
                >
                  <MessageSquare className="h-3.5 w-3.5 mr-1.5 text-violet-700" />
                  Chat
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs border border-emerald-200 bg-white hover:bg-emerald-50"
                  onClick={() => setWorkspaceExpanded((current) => !current)}
                >
                  {workspaceExpanded ? "Hide Workspace" : "Show Workspace"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs border border-violet-200 bg-white hover:bg-violet-50"
                  onClick={() => setChatExpanded((current) => !current)}
                >
                  {chatExpanded ? "Hide Chat" : "Show Chat"}
                </Button>
              </>
            ) : null}
            <div className="ml-auto flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1 py-1">
              <Button
                variant={dashboardViewMode === "essential" ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setDashboardViewMode("essential")}
              >
                Essential
              </Button>
              <Button
                variant={dashboardViewMode === "detailed" ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setDashboardViewMode("detailed")}
              >
                Detailed
              </Button>
            </div>
          </div>
        </div>
      </div>
      </div>

      {/* Today's Plan */}
      <div id="section-overview" className="container mx-auto px-4 pt-4 scroll-mt-40">
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <TodaysPlan
            calendarEvents={calendarEvents || []}
            todoistTasks={allTodoistTasks || []}
            emails={gmailMessages || []}
            habits={habitsForToday || []}
            onCompleteHabit={handleCompleteHabitFromPlan}
            onRegenerate={handleRegenerateTodaysPlan}
          />

          <div className="min-w-0 space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Triage Inbox</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="h-32 rounded-md border border-slate-200 bg-white px-2 py-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={emailPriorityChartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="count" name="Emails" fill="#e11d48" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {triageEmails.length === 0 ? (
                  <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-sm text-slate-600">
                    No priority emails to triage right now.
                  </p>
                ) : (
                  triageEmails.map((email) => (
                    <TriageEmail
                      key={email.id}
                      email={email}
                      onReply={handleTriageReply}
                      onMarkRead={handleTriageMarkRead}
                      onMakeTask={handleTriageMakeTask}
                      markReadDisabled={markEmailAsRead.isPending}
                      markReadPending={markEmailAsRead.isPending && markingEmailId === email.id}
                    />
                  ))
                )}
              </CardContent>
            </Card>

            <DecisionsWidget
              decisions={decisionsToMake}
              waitingOn={waitingOnItems}
              onSendNudge={handleSendNudge}
            />
          </div>
        </div>
      </div>

      {/* Health Row */}
      <div id="section-health" className="container mx-auto px-4 pt-4 scroll-mt-40">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="flex flex-col border-emerald-200 bg-gradient-to-br from-emerald-50 via-lime-50 to-slate-100 text-slate-900 shadow-[0_14px_34px_rgba(22,101,52,0.18)]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-emerald-700" />
                <CardTitle className="text-base text-slate-900">Samsung Health</CardTitle>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetchIntegrations()}
                disabled={integrationsFetching}
                className="h-8 px-2 text-slate-800 hover:text-slate-900 hover:bg-white/60"
              >
                <RefreshCw className={`h-4 w-4 ${integrationsFetching ? "animate-spin" : ""}`} />
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {!hasSamsungHealth ? (
                <div className="text-center py-5 text-slate-700">
                  <Smartphone className="h-8 w-8 mx-auto mb-2 text-emerald-400" />
                  <p className="text-sm">No Samsung Health sync detected yet.</p>
                  <p className="text-xs mt-2 text-slate-600">
                    Run the Android companion and tap Sync Now.
                  </p>
                </div>
              ) : !samsungHealthSnapshot ? (
                <div className="text-center py-5 text-slate-700">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-emerald-600" />
                  <p className="text-sm">Waiting for Samsung sync payload...</p>
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-slate-700">
                    Source: {samsungHealthSnapshot.sourceProvider}.{" "}
                    {samsungHealthSnapshot.receivedAt
                      ? `Last sync ${new Date(samsungHealthSnapshot.receivedAt).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}.`
                      : "No sync timestamp."}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <div className="rounded-md border border-emerald-200 bg-white/80 p-2">
                      <p className="text-xs text-slate-500">Steps</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {samsungHealthSnapshot.steps !== null
                          ? Math.round(samsungHealthSnapshot.steps).toLocaleString()
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-emerald-200 bg-white/80 p-2">
                      <p className="text-xs text-slate-500">Sleep</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {samsungHealthSnapshot.sleepTotalMinutes !== null
                          ? formatHoursAndMinutes(samsungHealthSnapshot.sleepTotalMinutes)
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-emerald-200 bg-white/80 p-2">
                      <p className="text-xs text-slate-500">SpO2 Avg</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {samsungHealthSnapshot.spo2AvgPercent !== null && samsungHealthSnapshot.spo2AvgPercent > 0
                          ? `${samsungHealthSnapshot.spo2AvgPercent.toFixed(1)}%`
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-emerald-200 bg-white/80 p-2">
                      <p className="text-xs text-slate-500">Sleep Sessions</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {samsungHealthSnapshot.sleepSessionsCount !== null
                          ? Math.round(samsungHealthSnapshot.sleepSessionsCount)
                          : "-"}
                      </p>
                    </div>
                    <div
                      className="rounded-md border border-emerald-200 bg-white/80 p-2 cursor-pointer"
                      onClick={() => setEditingSamsungField("sleep")}
                    >
                      <p className="text-xs text-slate-500">Sleep Score</p>
                      {editingSamsungField === "sleep" ? (
                        <div className="mt-1 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={manualSleepScoreInput}
                            autoFocus
                            onChange={(e) => setManualSleepScoreInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleSaveSamsungManualScores(() => setEditingSamsungField(null));
                              } else if (e.key === "Escape") {
                                setEditingSamsungField(null);
                              }
                            }}
                            placeholder="82"
                            className="h-7 text-xs"
                          />
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() =>
                              handleSaveSamsungManualScores(() => setEditingSamsungField(null))
                            }
                            disabled={saveSamsungManualScores.isPending}
                          >
                            Save
                          </Button>
                        </div>
                      ) : (
                        <p className="text-sm font-semibold text-slate-900">
                          {samsungHealthSnapshot.sleepScore ?? "N/A"}
                        </p>
                      )}
                    </div>
                    <div
                      className="rounded-md border border-emerald-200 bg-white/80 p-2 cursor-pointer"
                      onClick={() => setEditingSamsungField("energy")}
                    >
                      <p className="text-xs text-slate-500">Energy Score</p>
                      {editingSamsungField === "energy" ? (
                        <div className="mt-1 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={manualEnergyScoreInput}
                            autoFocus
                            onChange={(e) => setManualEnergyScoreInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleSaveSamsungManualScores(() => setEditingSamsungField(null));
                              } else if (e.key === "Escape") {
                                setEditingSamsungField(null);
                              }
                            }}
                            placeholder="74"
                            className="h-7 text-xs"
                          />
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() =>
                              handleSaveSamsungManualScores(() => setEditingSamsungField(null))
                            }
                            disabled={saveSamsungManualScores.isPending}
                          >
                            Save
                          </Button>
                        </div>
                      ) : (
                        <p className="text-sm font-semibold text-slate-900">
                          {samsungHealthSnapshot.energyScore ?? "N/A"}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="rounded-md border border-emerald-200 bg-white/80 p-2">
                    <p className="text-xs text-slate-500">Sync Health</p>
                    <p className="text-sm font-semibold text-slate-900">
                      {samsungHealthSnapshot.permissionsGranted ? "Permissions granted" : "Permissions incomplete"}
                    </p>
                    {samsungHealthSnapshot.warnings.length > 0 && (
                      <p className="text-xs text-amber-700 mt-1">
                        {samsungHealthSnapshot.warnings[0]}
                      </p>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
          <Card className="flex flex-col border-zinc-900 bg-zinc-950 text-zinc-100 shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <HeartPulse className="h-4 w-4 text-lime-300" />
                <CardTitle className="text-base text-white">WHOOP</CardTitle>
              </div>
              {hasWhoop && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refetchWhoop()}
                  disabled={whoopLoading || whoopFetching}
                  className="h-8 px-2 text-zinc-100 hover:text-white hover:bg-zinc-800"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${whoopLoading || whoopFetching ? "animate-spin" : ""}`}
                  />
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {!hasWhoop ? (
                <div className="text-center py-5 text-zinc-300">
                  <HeartPulse className="h-8 w-8 mx-auto mb-2 text-zinc-500" />
                  <p className="text-sm">Connect WHOOP in Settings</p>
                  <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2 text-lime-300">
                    Go to Settings
                  </Button>
                </div>
              ) : whoopLoading ? (
                <div className="flex justify-center py-5">
                  <Loader2 className="h-6 w-6 animate-spin text-lime-300" />
                </div>
              ) : whoopSummary ? (
                <>
                  <p className="text-[11px] text-zinc-300">
                    Auto-refresh every 5m.
                    {whoopSummary.dataDate ? ` Data: ${whoopSummary.dataDate}.` : ""}
                    {whoopSummary.profile
                      ? ` ${whoopSummary.profile.firstName} ${whoopSummary.profile.lastName}`.trim()
                      : ""}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Recovery</p>
                      <p className="text-sm font-semibold text-lime-300">
                        {toPercent(whoopSummary.recoveryScore)}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Day Strain</p>
                      <p className="text-sm font-semibold text-white">
                        {toOneDecimal(whoopSummary.dayStrain)}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Sleep Total</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.sleepHours !== null ? `${whoopSummary.sleepHours}h` : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Time In Bed</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.timeInBedHours !== null ? `${whoopSummary.timeInBedHours}h` : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Light Sleep</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.lightSleepHours !== null ? `${whoopSummary.lightSleepHours}h` : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Deep Sleep</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.deepSleepHours !== null ? `${whoopSummary.deepSleepHours}h` : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">REM Sleep</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.remSleepHours !== null ? `${whoopSummary.remSleepHours}h` : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Awake</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.awakeHours !== null ? `${whoopSummary.awakeHours}h` : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Sleep Performance</p>
                      <p className="text-sm font-semibold text-white">
                        {toPercent(whoopSummary.sleepPerformance)}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Sleep Efficiency</p>
                      <p className="text-sm font-semibold text-white">
                        {toPercent(whoopSummary.sleepEfficiency)}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Sleep Consistency</p>
                      <p className="text-sm font-semibold text-white">
                        {toPercent(whoopSummary.sleepConsistency)}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Energy</p>
                      <p className="text-sm font-semibold text-white">
                        {kilojouleToCalories(whoopSummary.kilojoule) !== null
                          ? `${kilojouleToCalories(whoopSummary.kilojoule)} cal`
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Resting HR</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.restingHeartRate !== null
                          ? `${whoopSummary.restingHeartRate} bpm`
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">HRV (RMSSD)</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.hrvRmssdMilli !== null
                          ? `${Math.round(whoopSummary.hrvRmssdMilli)} ms`
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Respiratory Rate</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.respiratoryRate !== null
                          ? `${whoopSummary.respiratoryRate.toFixed(1)} br/min`
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Skin Temp</p>
                      <p className="text-sm font-semibold text-white">
                        {celsiusToFahrenheit(whoopSummary.skinTempCelsius) !== null
                          ? `${celsiusToFahrenheit(whoopSummary.skinTempCelsius)?.toFixed(1)}F`
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">SpO2</p>
                      <p className="text-sm font-semibold text-white">
                        {toPercent(whoopSummary.spo2Percentage)}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Avg HR</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.averageHeartRate !== null
                          ? `${Math.round(whoopSummary.averageHeartRate)} bpm`
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Max HR</p>
                      <p className="text-sm font-semibold text-white">
                        {whoopSummary.maxHeartRate !== null
                          ? `${Math.round(whoopSummary.maxHeartRate)} bpm`
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                      <p className="text-xs text-zinc-400">Workout Strain</p>
                      <p className="text-sm font-semibold text-white">
                        {toOneDecimal(whoopSummary.latestWorkoutStrain)}
                      </p>
                    </div>
                    <div className="rounded-md border border-lime-300 bg-lime-300/10 p-2">
                      <p className="text-xs text-lime-200">Last Update</p>
                      <p className="text-xs font-semibold text-lime-100">
                        {new Date(whoopSummary.updatedAt).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-5 text-zinc-300">
                  <p className="text-sm">Unable to load WHOOP data</p>
                  {whoopErrorMessage && (
                    <p className="text-xs text-rose-400 mt-2 break-words">
                      {whoopErrorMessage}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Tracking Row */}
      <div id="section-tracking" className="container mx-auto px-4 pt-4 scroll-mt-40">
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-4">
          <Card className="min-w-0 flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-emerald-600" />
                <CardTitle className="text-base">Daily Log Trend</CardTitle>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => captureDailyMetrics.mutate({ dateKey: todayKey })}
                disabled={captureDailyMetrics.isPending}
              >
                <RefreshCw className={`h-4 w-4 ${captureDailyMetrics.isPending ? "animate-spin" : ""}`} />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-slate-500">
                One row per day. Captured every 15m while this dashboard is open, and when you complete a Todoist task.
              </p>
              <div className="h-40 rounded-md border border-slate-200 bg-white px-2 py-1">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dailyTrendChartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Line yAxisId="left" type="monotone" dataKey="recovery" stroke="#2563eb" strokeWidth={2} dot={false} />
                    <Line yAxisId="right" type="monotone" dataKey="completed" stroke="#dc2626" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {recentMetricRows.length === 0 ? (
                <p className="text-sm text-slate-500">No entries yet.</p>
              ) : (
                <div className="space-y-1">
                  <div className="grid grid-cols-4 gap-2 rounded-md border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                    <span>Date</span>
                    <span>Recovery %</span>
                    <span>Samsung Steps</span>
                    <span>Todo Done</span>
                  </div>
                  {recentMetricRows.map((row: any) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-4 gap-2 rounded-md border bg-slate-50 px-2 py-1.5 text-[11px]"
                    >
                      <span className="font-medium text-slate-700">{row.dateKey}</span>
                      <span className="text-slate-600">{row.whoopRecoveryScore ?? "-"}</span>
                      <span className="text-slate-600">
                        {row.samsungSteps ? Number(row.samsungSteps).toLocaleString() : "-"}
                      </span>
                      <span className="text-slate-600">
                        {row.dateKey === todayKey && hasTodoist
                          ? (todoistCompletedToday?.count ?? row.todoistCompletedCount ?? "-")
                          : (row.todoistCompletedCount ?? "-")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {isDetailedMode ? (
            <Card className="min-w-0 flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <Pill className="h-4 w-4 text-emerald-600" />
                <CardTitle className="text-base">Supplements</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 min-w-0">
              <div className="space-y-2 min-w-0">
                <Input
                  value={supplementName}
                  onChange={(e) => setSupplementName(e.target.value)}
                  placeholder="Supplement"
                  className="h-9 min-w-0 text-sm"
                />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 min-w-0">
                  <Input
                    value={supplementDose}
                    onChange={(e) => setSupplementDose(e.target.value)}
                    placeholder="Dose"
                    className="h-9 min-w-0 text-sm"
                  />
                  <Select
                    value={supplementDoseUnit}
                    onValueChange={(value) => setSupplementDoseUnit(value as (typeof SUPPLEMENT_UNITS)[number])}
                  >
                    <SelectTrigger className="h-9 w-full min-w-0 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPLEMENT_UNITS.map((unit) => (
                        <SelectItem key={unit} value={unit}>
                          {unit}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 min-w-0">
                  <Select
                    value={supplementTiming}
                    onValueChange={(value) => setSupplementTiming(value as "am" | "pm")}
                  >
                    <SelectTrigger className="h-9 w-full min-w-0 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="am">am</SelectItem>
                      <SelectItem value="pm">pm</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 w-full text-sm"
                    onClick={handleAddSupplementDefinition}
                    disabled={createSupplementDefinition.isPending}
                  >
                    Add to List
                  </Button>
                  <Button
                    size="sm"
                    className="h-9 w-full text-sm"
                    onClick={handleAddSupplementLog}
                    disabled={addSupplementLog.isPending}
                  >
                    Log Once
                  </Button>
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                Lock items below to auto-log daily.
              </p>

              <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
                {(supplementDefinitions || []).length === 0 ? (
                  <p className="text-xs text-slate-500">No curated supplements yet.</p>
                ) : (
                  (supplementDefinitions || []).map((definition: any) => (
                    <div
                      key={definition.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5"
                    >
                      <p className="min-w-0 break-words pr-1 text-xs leading-tight text-slate-800">
                        {definition.name} • {definition.dose} {definition.doseUnit} • {definition.timing}
                      </p>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant={definition.isLocked ? "default" : "outline"}
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={() =>
                            setSupplementDefinitionLock.mutate({
                              definitionId: definition.id,
                              isLocked: !definition.isLocked,
                            })
                          }
                        >
                          {definition.isLocked ? "Locked" : "Lock"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => deleteSupplementDefinition.mutate({ definitionId: definition.id })}
                        >
                          <Trash2 className="h-3 w-3 text-slate-600" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                {(supplementLogs || []).length === 0 ? (
                  <p className="text-sm text-slate-500">No supplements logged today.</p>
                ) : (
                  (supplementLogs || []).map((log: any) => (
                    <div
                      key={log.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5"
                    >
                      <div className="min-w-0 pr-1">
                        <p className="break-words text-xs font-medium leading-tight text-emerald-900">
                          {log.name} • {log.dose} {log.doseUnit} • {log.timing}
                          {log.autoLogged ? " • auto" : ""}
                        </p>
                        <p className="text-[11px] text-emerald-700">
                          {new Date(log.takenAt).toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 shrink-0 p-0"
                        onClick={() => deleteSupplementLog.mutate({ id: log.id })}
                      >
                        <Trash2 className="h-3 w-3 text-emerald-700" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
            </Card>
          ) : null}

          <Card className="min-w-0 flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-rose-600" />
                <CardTitle className="text-base">Habits</CardTitle>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetchHabitsForToday()}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent>
              <div className="mb-3 h-36 rounded-md border border-slate-200 bg-white px-2 py-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip />
                    <Pie
                      data={habitCompletionChartData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={36}
                      outerRadius={56}
                      paddingAngle={2}
                    >
                      {habitCompletionChartData.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {(habitsForToday || []).length === 0 ? (
                <div className="text-sm text-slate-500">
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
                  {(habitsForToday || []).map((habit: any) => {
                    const styles = HABIT_COLOR_STYLES[habit.color] ?? HABIT_COLOR_STYLES.slate;
                    return (
                      <button
                        type="button"
                        key={habit.id}
                        onClick={() => handleToggleHabit(habit.id, !habit.completed)}
                        className={`rounded-md border px-2 py-2 text-left transition-colors ${
                          habit.completed ? styles.active : styles.inactive
                        }`}
                        disabled={setHabitCompletion.isPending}
                      >
                        <p className="text-xs font-semibold">{habit.name}</p>
                        <p className="text-[11px] mt-0.5 opacity-80">
                          {habit.completed ? "Done today" : "Tap to mark done"}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {isDetailedMode ? (
            <Card className="min-w-0 flex flex-col">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-emerald-600" />
                  <CardTitle className="text-base">Notes</CardTitle>
                </div>
                <Button variant="ghost" size="sm" onClick={() => refetchNotes()}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={noteNotebookInput}
                  onChange={(e) => setNoteNotebookInput(e.target.value)}
                  placeholder="Notebook"
                  className="h-8 text-xs"
                />
                <Select value={noteNotebookFilter} onValueChange={setNoteNotebookFilter}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Filter notebook" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All notebooks</SelectItem>
                    {noteNotebookOptions.map((notebook) => (
                      <SelectItem key={notebook} value={notebook}>
                        {notebook}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Input
                value={noteTitleInput}
                onChange={(e) => setNoteTitleInput(e.target.value)}
                placeholder="Note title"
                className="h-8 text-xs"
              />
              <Textarea
                value={noteContentInput}
                onChange={(e) => setNoteContentInput(e.target.value)}
                placeholder="Write note content..."
                className="min-h-[84px] text-xs"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleSubmitNote}
                  disabled={createNoteMutation.isPending || updateNoteMutation.isPending}
                >
                  {editingNoteId ? "Update Note" : "Create Note"}
                </Button>
                {editingNoteId && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => {
                      setEditingNoteId(null);
                      setNoteNotebookInput("General");
                      setNoteTitleInput("");
                      setNoteContentInput("");
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>

              <div className="rounded-md border border-slate-200 bg-slate-50 p-2 space-y-2">
                <p className="text-[11px] font-semibold text-slate-600">Link Existing Note</p>
                <Select value={linkNoteId || "__none"} onValueChange={(value) => setLinkNoteId(value === "__none" ? "" : value)}>
                  <SelectTrigger className="h-8 text-xs bg-white">
                    <SelectValue placeholder="Select note" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Select note</SelectItem>
                    {(notes || []).map((note: any) => (
                      <SelectItem key={note.id} value={note.id}>
                        {note.notebook || "General"} • {note.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="grid grid-cols-1 gap-2">
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                    <Select
                      value={linkTaskId || "__none"}
                      onValueChange={(value) => setLinkTaskId(value === "__none" ? "" : value)}
                    >
                      <SelectTrigger className="h-8 min-w-0 text-xs bg-white sm:flex-1">
                        <SelectValue placeholder="Link to Todoist task" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">Select Todoist task</SelectItem>
                        {(todayTasks || []).slice(0, 50).map((task: any) => (
                          <SelectItem key={task.id} value={String(task.id)}>
                            {task.content}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      className="h-8 text-xs sm:shrink-0"
                      onClick={handleLinkExistingNoteToTask}
                      disabled={addNoteLinkMutation.isPending}
                    >
                      Link Task
                    </Button>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                    <Select
                      value={linkEventId || "__none"}
                      onValueChange={(value) => setLinkEventId(value === "__none" ? "" : value)}
                    >
                      <SelectTrigger className="h-8 min-w-0 text-xs bg-white sm:flex-1">
                        <SelectValue placeholder="Link to calendar event" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">Select calendar event</SelectItem>
                        {upcomingEvents.slice(0, 50).map((event: any) => (
                          <SelectItem key={event.id} value={String(event.id || "")}>
                            {formatCalendarEventLabel(event)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      className="h-8 text-xs sm:shrink-0"
                      onClick={handleLinkExistingNoteToEvent}
                      disabled={addNoteLinkMutation.isPending}
                    >
                      Link Event
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {notesLoading ? (
                  <div className="flex justify-center py-3">
                    <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
                  </div>
                ) : filteredNotes.length === 0 ? (
                  <p className="text-xs text-slate-500">No notes for this notebook filter.</p>
                ) : (
                  filteredNotes.map((note: any) => (
                    <div key={note.id} className="rounded-md border border-emerald-100 bg-emerald-50/60 px-2 py-2 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <button type="button" className="min-w-0 text-left" onClick={() => handleEditNote(note)}>
                          <p className="text-xs font-semibold text-slate-900 truncate">{note.title}</p>
                          <p className="text-[11px] text-slate-600 line-clamp-2 mt-1">
                            {toPlainText(String(note.content || "")) || "No content"}
                          </p>
                        </button>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant={note.pinned ? "default" : "outline"}
                            className="h-6 px-2 text-[11px]"
                            onClick={() =>
                              updateNoteMutation.mutate({
                                noteId: note.id,
                                pinned: !note.pinned,
                              })
                            }
                          >
                            {note.pinned ? "Pinned" : "Pin"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0"
                            onClick={() => deleteNoteMutation.mutate({ noteId: note.id })}
                          >
                            <Trash2 className="h-3 w-3 text-slate-600" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className="text-[10px]">
                          Notebook: {note.notebook || "General"}
                        </Badge>
                        <span className="text-[10px] text-slate-500">
                          {new Date(note.updatedAt || note.createdAt || Date.now()).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {Array.isArray(note.links) && note.links.length > 0 ? (
                          note.links.map((link: any) => (
                            <Badge key={link.id} variant="outline" className="text-[10px] gap-1">
                              {link.linkType === "todoist_task" ? "Task" : "Event"}
                              {link.seriesId ? " • Recurring" : ""}
                              <button
                                type="button"
                                className="ml-1 text-slate-500 hover:text-slate-900"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  removeNoteLinkMutation.mutate({ linkId: link.id });
                                }}
                                aria-label="Remove link"
                              >
                                ×
                              </button>
                            </Badge>
                          ))
                        ) : (
                          <span className="text-[11px] text-slate-500">No links</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {/* Universal Drop Dock */}
      <div className="container mx-auto px-4 pt-4">
        <UniversalDropDock />
      </div>

      {/* Main Content - Four Column Layout */}
      {isDetailedMode ? (
        workspaceExpanded ? (
      <main id="section-workspace" className="container mx-auto px-4 py-6 flex-1 overflow-hidden scroll-mt-40">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-full">
          {/* Left Column - Calendar Events */}
          <Card className="lg:col-span-1 flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-emerald-600" />
                <CardTitle className="text-base">Today's Events</CardTitle>
              </div>
              {hasGoogle && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refetchCalendar()}
                  disabled={calendarLoading}
                >
                  <RefreshCw className={`h-4 w-4 ${calendarLoading ? "animate-spin" : ""}`} />
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-2 overflow-y-auto flex-1">
              {!hasGoogle ? (
                <div className="text-center py-8 text-gray-500">
                  <Calendar className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                  <p className="text-sm">Connect Google Calendar in Settings</p>
                  <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2">
                    Go to Settings
                  </Button>
                </div>
              ) : calendarLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
                </div>
              ) : upcomingEvents.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <p className="text-sm">No upcoming events</p>
                </div>
              ) : (
                eventsByDate.map(({ date, events, colors }) => (
                  <div key={date} className="mb-2.5">
                    <div className={`${colors.header} px-2 py-0.5 rounded-t text-[11px] font-semibold ${colors.text} sticky top-0 z-10`}>
                      {date}
                    </div>
                    <div className="space-y-1 mt-1">
                      {events.map((event: any) => (
                        <div
                          key={event.id}
                          className={`p-2 ${colors.bg} rounded-md border ${colors.border} hover:opacity-95 transition-opacity ${
                            selectedCalendarHistoryEventId === String(event.id || "")
                              ? "ring-1 ring-emerald-500"
                              : ""
                          } cursor-pointer`}
                          onClick={() =>
                            setSelectedCalendarHistoryEventId((current) =>
                              current === String(event.id || "") ? null : String(event.id || "")
                            )
                          }
                        >
                          <div className="flex items-start gap-2">
                            <a
                              href={event.htmlLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-1 min-w-0"
                            >
                              <p className={`font-medium text-xs ${colors.text} truncate leading-4`}>{event.summary}</p>
                              <p className="text-[11px] text-gray-600">{formatEventTime(event)}</p>
                              {event.location && (
                                <p className="text-[11px] text-gray-500 truncate">{event.location}</p>
                              )}
                            </a>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 shrink-0"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedCalendarHistoryEventId((current) =>
                                  current === String(event.id || "") ? null : String(event.id || "")
                                );
                              }}
                              title="Show related notes"
                            >
                              <MessageSquare className="h-3.5 w-3.5 text-emerald-700" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 shrink-0"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                openNotebookForCalendarEvent(event);
                              }}
                              title="Open in notebook"
                            >
                              <FolderOpen className="h-3.5 w-3.5 text-emerald-700" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 shrink-0"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleCreateNoteFromCalendarEvent(event);
                              }}
                              disabled={createNoteFromCalendarMutation.isPending}
                              title="Create linked note"
                            >
                              <FileText className="h-3.5 w-3.5 text-emerald-700" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {selectedCalendarHistoryEvent &&
                      events.some(
                        (event: any) =>
                          String(event.id || "") === String(selectedCalendarHistoryEvent.id || "")
                      ) && (
                        <div className="mt-1.5 rounded-md border border-emerald-200 bg-emerald-50/70 p-2">
                          <p className="text-[11px] font-semibold text-emerald-900 mb-1">
                            Linked notes for this event series
                          </p>
                          {calendarLinkedNotes.length === 0 ? (
                            <p className="text-[11px] text-emerald-800">
                              No linked notes yet. Link an existing note from the Notes card or create one.
                            </p>
                          ) : (
                            <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                              {calendarLinkedNotes.slice(0, 12).map((note: any) => (
                                <button
                                  key={note.id}
                                  type="button"
                                  onClick={() => handleEditNote(note)}
                                  className="w-full text-left rounded border border-emerald-200 bg-white px-2 py-1.5 hover:bg-emerald-50"
                                >
                                  <p className="text-[11px] font-semibold text-slate-900 truncate">
                                    {note.notebook || "General"} • {note.title}
                                  </p>
                                  <p className="text-[11px] text-slate-600 line-clamp-1">
                                    {toPlainText(String(note.content || "")) || "No content"}
                                  </p>
                                  {note.latestOccurrence && (
                                    <p className="text-[10px] text-emerald-700 mt-0.5">
                                      Linked occurrence:{" "}
                                      {new Date(note.latestOccurrence).toLocaleString("en-US", {
                                        month: "short",
                                        day: "numeric",
                                        hour: "numeric",
                                        minute: "2-digit",
                                      })}
                                    </p>
                                  )}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Middle Column - Todoist Tasks */}
          <Card id="section-todoist" className="lg:col-span-1 flex flex-col overflow-hidden border border-[#cf3a2b] bg-[#e44332] text-white shadow-[0_18px_34px_rgba(228,67,50,0.35)] scroll-mt-40">
            <CardHeader className="space-y-3 pb-4 border-b border-white/20 bg-[#e44332] text-white">
              <div className="flex flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckSquare className="h-5 w-5 text-white" />
                  <CardTitle className="text-lg text-white">
                    {todoistFilter === "all" ? "All Open Tasks" :
                     todoistFilter === "today" ? "Today's Tasks" :
                     todoistFilter === "#Inbox" ? "Inbox" :
                     todoistFilter === "upcoming" ? "Upcoming" :
                     todoistFilter.startsWith("label_") ?
                       `@${decodeURIComponent(todoistFilter.replace("label_", ""))}` :
                     todoistFilter.startsWith("project_") ? 
                       todoistProjects?.find((p: any) => p.id === todoistFilter.replace("project_", ""))?.name || "Tasks" :
                     "Tasks"}
                  </CardTitle>
                </div>
                {hasTodoist && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      refetchTasks();
                      refetchTodoistCompletedToday();
                    }}
                    disabled={tasksLoading}
                    className="text-white hover:text-white hover:bg-white/20"
                  >
                    <RefreshCw className={`h-4 w-4 ${tasksLoading ? "animate-spin" : ""}`} />
                  </Button>
                )}
              </div>
              {hasTodoist && (
                <>
                  <div className="flex items-center gap-2">
                    <Input
                      value={quickTodoistTaskInput}
                      onChange={(e) => setQuickTodoistTaskInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleQuickAddTodoistTask();
                        }
                      }}
                      placeholder="Quick add a task..."
                      className="h-9 border-white/40 bg-white text-slate-900 placeholder:text-slate-500"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleQuickAddTodoistTask}
                      disabled={quickAddTodoistTask.isPending || !quickTodoistTaskInput.trim()}
                      className="h-9 shrink-0 bg-white text-[#c93426] hover:bg-red-50"
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </Button>
                  </div>
                  <Select value={todoistFilter} onValueChange={setTodoistFilter}>
                    <SelectTrigger className="w-full border-white/40 bg-white text-slate-800">
                      <SelectValue placeholder="Select filter" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All open tasks</SelectItem>
                      <SelectItem value="today">Today</SelectItem>
                      <SelectItem value="#Inbox">Inbox</SelectItem>
                      <SelectItem value="upcoming">Upcoming</SelectItem>
                      {todoistProjects && todoistProjects.length > 0 && (
                        <>
                          <SelectItem value="separator" disabled>── My Projects ──</SelectItem>
                          {todoistProjects.map((project: any) => (
                            <SelectItem key={project.id} value={`project_${project.id}`}>
                              {project.name}
                            </SelectItem>
                          ))}
                        </>
                      )}
                      {todoistLabels.length > 0 && (
                        <>
                          <SelectItem value="separator-labels" disabled>── Labels ──</SelectItem>
                          {todoistLabels.map((label) => (
                            <SelectItem key={label} value={`label_${encodeURIComponent(label)}`}>
                              @{label}
                            </SelectItem>
                          ))}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </>
              )}
            </CardHeader>
            <CardContent className="space-y-2 overflow-y-auto flex-1 pt-3 bg-[#e44332]">
              {!hasTodoist ? (
                <div className="text-center py-8 text-white/90">
                  <CheckSquare className="h-12 w-12 mx-auto mb-3 text-white/70" />
                  <p className="text-sm">Connect Todoist in Settings</p>
                  <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2 text-white">
                    Go to Settings
                  </Button>
                </div>
              ) : tasksLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-white" />
                </div>
              ) : !todayTasks || todayTasks.length === 0 ? (
                <div className="text-center py-8 text-white/90">
                  <p className="text-sm">
                    {todoistFilter === "today"
                      ? "No tasks for today"
                      : todoistFilter === "all"
                        ? "No open tasks found"
                        : "No tasks for this filter"}
                  </p>
                </div>
              ) : (
                todayTasks.slice(0, 50).map((task: any) => (
                  <div
                    key={task.id}
                    className="flex items-start gap-3 p-2 rounded border border-[#f29b90] bg-[#d63a2b] hover:bg-[#c93426] transition-colors"
                  >
                    <Checkbox
                      checked={false}
                      onCheckedChange={() => handleCompleteTask(task.id)}
                      className="mt-1 border-white/80 data-[state=checked]:border-white data-[state=checked]:bg-white"
                    />
                    <div className="flex-1 min-w-0">
                      <a
                        href={task.url || `https://todoist.com/app/task/${task.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-white break-words hover:text-white/90 hover:underline"
                      >
                        {task.content.replace(/\s*\(https?:\/\/[^)]+\)\s*/g, '').trim()}
                      </a>
                      {task.description && (
                        <p className="text-xs text-red-100 mt-1 break-words">{task.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        {task.priority > 1 && (
                          <span className="text-xs px-1.5 py-0.5 bg-white text-[#c93426] rounded font-semibold">
                            P{task.priority}
                          </span>
                        )}
                        {task.due?.date && (
                          <span className="text-xs text-red-100">{task.due.date}</span>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 shrink-0 text-white hover:bg-white/20 hover:text-white"
                      onClick={() => handleCreateNoteFromTask(task)}
                      disabled={createNoteFromTaskMutation.isPending}
                      title="Create linked note"
                    >
                      <FileText className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Third Column - Important & Unread Emails */}
          <Card className="lg:col-span-1 flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
              <div className="flex items-center gap-2">
                <Mail className="h-5 w-5 text-purple-600" />
                <CardTitle className="text-lg">Important &amp; Unread</CardTitle>
              </div>
              {hasGoogle && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refetchEmails()}
                  disabled={emailsLoading || emailsFetching}
                >
                  <RefreshCw
                    className={`h-4 w-4 ${emailsLoading || emailsFetching ? "animate-spin" : ""}`}
                  />
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3 overflow-y-auto flex-1">
              {!hasGoogle ? (
                <div className="text-center py-8 text-gray-500">
                  <Mail className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                  <p className="text-sm">Connect Gmail in Settings</p>
                  <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2">
                    Go to Settings
                  </Button>
                </div>
              ) : emailsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
                </div>
              ) : !gmailMessages || gmailMessages.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <p className="text-sm">No recent emails</p>
                </div>
              ) : (
                gmailMessages.slice(0, 50).map((message: any) => (
                  <div key={message.id} className="group relative">
                    <a
                      href={`https://mail.google.com/mail/u/0/#inbox/${message.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block p-3 bg-purple-50 rounded-lg border border-purple-100 hover:bg-purple-100 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <p className="font-medium text-sm text-gray-900 truncate flex-1">
                          {getEmailHeader(message, "From")}
                        </p>
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {formatEmailDate(message.internalDate)}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-gray-700 truncate mb-1">
                        {getEmailHeader(message, "Subject")}
                      </p>
                      <p className="text-xs text-gray-600 line-clamp-2">{message.snippet}</p>
                    </a>
                    <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                        onClick={(e) => handleMarkEmailAsRead(message.id, e)}
                        disabled={markEmailAsRead.isPending}
                        title="Mark as read"
                      >
                        {markingEmailId === message.id && markEmailAsRead.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin text-purple-600" />
                        ) : (
                          <MailCheck className="h-3 w-3 text-purple-700" />
                        )}
                      </Button>
                      {hasTodoist && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0"
                          onClick={(e) => handleAddEmailToTodoist(message, e)}
                          disabled={createTaskFromEmail.isPending}
                          title="Add to Todoist"
                        >
                          <CheckSquare className="h-3 w-3 text-red-600" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Fourth Column - Google Drive Files */}
          <Card className="lg:col-span-1 flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-5 w-5 text-green-600" />
                <CardTitle className="text-lg">Drive Files</CardTitle>
              </div>
              {hasGoogle && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refetchDrive()}
                  disabled={driveLoading}
                >
                  <RefreshCw className={`h-4 w-4 ${driveLoading ? "animate-spin" : ""}`} />
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3 overflow-y-auto flex-1">
              {hasGoogle && (
                <div className="flex gap-2 mb-2">
                  <Input
                    type="text"
                    placeholder="Search all Drive files..."
                    value={driveSearchQuery}
                    onChange={(e) => setDriveSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleDriveSearch()}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    onClick={handleDriveSearch}
                    disabled={isSearching || !driveSearchQuery.trim()}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
                  </Button>
                  {driveSearchResults !== null && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={clearDriveSearch}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              )}
              {!hasGoogle ? (
                <div className="text-center py-8 text-gray-500">
                  <FolderOpen className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                  <p className="text-sm">Connect Google Drive in Settings</p>
                  <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2">
                    Go to Settings
                  </Button>
                </div>
              ) : (
                <>
                  <Button
                    className="w-full mb-3 bg-green-600 hover:bg-green-700"
                    onClick={() => {
                      const title = `Untitled Spreadsheet ${new Date().toLocaleDateString()}`;
                      createSpreadsheet.mutate({ title });
                    }}
                    disabled={createSpreadsheet.isPending}
                  >
                    {createSpreadsheet.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <FileText className="h-4 w-4 mr-2" />
                    )}
                    Create Spreadsheet
                  </Button>
                  {driveLoading ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-green-600" />
                    </div>
                  ) : displayedDriveFiles.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      <p className="text-sm">{driveSearchResults !== null ? "No files found" : "No recent files"}</p>
                    </div>
                  ) : (
                    displayedDriveFiles.map((file: any) => (
                      <a
                        key={file.id}
                        href={file.webViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block p-3 bg-green-50 rounded-lg border border-green-100 hover:bg-green-100 transition-colors"
                      >
                        <div className="flex items-start gap-2">
                          {file.iconLink && (
                            <img src={file.iconLink} alt="" className="w-4 h-4 mt-0.5" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm text-gray-900 truncate">{file.name}</p>
                            <p className="text-xs text-gray-500 mt-1">
                              {new Date(file.modifiedTime).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                      </a>
                    ))
                  )}
                </>
              )}
            </CardContent>
          </Card>

        </div>
      </main>
        ) : (
          <div id="section-workspace" className="container mx-auto px-4 py-6 scroll-mt-40">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Workspace Hidden</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-600 mb-3">
                  Workspace data loading is paused until you expand this section.
                </p>
                <Button onClick={() => setWorkspaceExpanded(true)}>Show Workspace</Button>
              </CardContent>
            </Card>
          </div>
        )
      ) : (
        <div id="section-workspace" className="container mx-auto px-4 py-6 scroll-mt-40">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detailed Workspace</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600 mb-3">
                Switch to Detailed mode to view calendar, Todoist, Gmail, Drive, and Chat workspace sections.
              </p>
              <Button onClick={() => setDashboardViewMode("detailed")}>Switch to Detailed Mode</Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Chat Panel at Bottom */}
      {isDetailedMode && chatExpanded ? (
      <div id="section-chat" className="border-t bg-white scroll-mt-40">
        <div className="container mx-auto px-4 py-4">
          <div className="grid grid-cols-12 gap-4 h-80">
            {/* Conversation List */}
            <div className="col-span-3 border-r pr-4 overflow-y-auto">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Conversations
                </h3>
                <Button size="sm" variant="ghost" onClick={handleNewConversation}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {!hasOpenAI ? (
                <div className="text-center py-8 text-gray-500 text-xs">
                  <p>Connect OpenAI in Settings to use chat</p>
                </div>
              ) : conversations && conversations.length > 0 ? (
                <div className="space-y-2">
                  {conversations.map((conv) => (
                    <div
                      key={conv.id}
                      className={`p-2 rounded cursor-pointer text-sm flex items-center justify-between group ${
                        selectedConversationId === conv.id ? "bg-emerald-100" : "hover:bg-gray-100"
                      }`}
                      onClick={() => setSelectedConversationId(conv.id)}
                    >
                      <span className="truncate flex-1">{conv.title}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="opacity-0 group-hover:opacity-100 h-6 w-6 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteConversation(conv.id);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500 text-xs">
                  <p>No conversations yet</p>
                  <p className="mt-1">Click + to start</p>
                </div>
              )}
            </div>

            {/* Chat Messages */}
            <div className="col-span-9 flex flex-col">
              <div className="flex-1 overflow-y-auto mb-3 space-y-3">
                {!hasOpenAI ? (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    <div className="text-center">
                      <MessageSquare className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                      <p className="text-sm">Connect OpenAI in Settings to start chatting</p>
                    </div>
                  </div>
                ) : !selectedConversationId ? (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    <div className="text-center">
                      <MessageSquare className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                      <p className="text-sm">Select a conversation or start a new one</p>
                    </div>
                  </div>
                ) : messages && messages.length > 0 ? (
                  <>
                    {messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[80%] p-3 rounded-lg ${
                            msg.role === "user"
                              ? "bg-emerald-700 text-white"
                              : "bg-gray-100 text-gray-900"
                          }`}
                        >
                          {msg.role === "assistant" ? (
                            <div className="prose prose-sm max-w-none">
                              <ReactMarkdown>{msg.content}</ReactMarkdown>
                            </div>
                          ) : (
                            <p className="text-sm break-words">{msg.content}</p>
                          )}
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    <p className="text-sm">Start the conversation...</p>
                  </div>
                )}
              </div>

              {/* Chat Input */}
              {hasOpenAI && (
                <div className="flex gap-2">
                  <Input
                    value={chatMessage}
                    onChange={(e) => setChatMessage(e.target.value)}
                    placeholder="Type your message..."
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    disabled={sendMessage.isPending}
                  />
                  <Button
                    onClick={handleSendMessage}
                    disabled={!chatMessage.trim() || sendMessage.isPending}
                  >
                    {sendMessage.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      ) : isDetailedMode ? (
        <div id="section-chat" className="container mx-auto px-4 pb-6 scroll-mt-40">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Chat Hidden</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600 mb-3">
                Chat queries are paused while this section is collapsed.
              </p>
              <Button onClick={() => setChatExpanded(true)}>Show Chat</Button>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
