import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import UniversalDropDock from "@/components/UniversalDropDock";
import { TodaysPlan } from "@/components/todays-plan/TodaysPlan";
import { TriageEmail } from "@/components/todays-plan/TriageEmail";
import { DecisionsWidget } from "@/components/todays-plan/DecisionsWidget";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  getHiddenDashboardHeaderButtons,
  getHiddenDashboardSections,
  buildWidgetLayoutWithHiddenSections,
  DASHBOARD_SECTION_OPTIONS,
  type DashboardHeaderToolButtonKey,
  type DashboardSectionKey,
} from "@/lib/dashboardPreferences";
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
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { useState, useEffect, useMemo, useRef } from "react";
import { DashboardHero } from "@/components/dashboard/DashboardHero";
import { DashboardWidget } from "@/components/dashboard/DashboardWidget";
import MarketHeadlinesCard from "@/components/dashboard/MarketHeadlinesCard";
import SportsCard from "@/components/dashboard/SportsCard";
import { SamsungHealthCard } from "@/components/dashboard/SamsungHealthCard";
import { WhoopCard } from "@/components/dashboard/WhoopCard";
import { HabitsCard } from "@/components/dashboard/HabitsCard";
import { QuickActionsFab } from "@/components/dashboard/QuickActionsFab";
import { DashboardSkeleton } from "@/components/dashboard/DashboardSkeleton";
import { WorkspaceSection } from "@/components/dashboard/WorkspaceSection";
import { ChatPanel } from "@/components/dashboard/ChatPanel";
import { SupplementsCard } from "@/components/dashboard/SupplementsCard";
import { NotesCard } from "@/components/dashboard/NotesCard";
import { useSectionVisibilityTracker } from "@/hooks/useSectionVisibilityTracker";
import { SectionRating } from "@/components/SectionRating";
import { FocusTimer } from "@/components/FocusTimer";
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

type DashboardHeaderButtonConfig = {
  key: DashboardHeaderToolButtonKey;
  label: string;
  route: string;
  icon: LucideIcon;
};

const DASHBOARD_HEADER_BUTTONS: DashboardHeaderButtonConfig[] = [
  { key: "notebook", label: "Notebook", route: "/notes", icon: FileText },
  { key: "clockifyTracker", label: "Clockify", route: "/widget/clockify", icon: Clock3 },
  { key: "solarRec", label: "Solar REC", route: "/solar-rec-dashboard", icon: BarChart3 },
  { key: "invoiceMatch", label: "Invoice Match", route: "/invoice-match-dashboard", icon: FileSpreadsheet },
  { key: "deepUpdate", label: "Deep Update", route: "/deep-update-synthesizer", icon: FileSpreadsheet },
  { key: "contractScanner", label: "Contract Scanner", route: "/contract-scanner", icon: FileText },
  { key: "enphaseV4", label: "Enphase v4", route: "/enphase-v4-meter-reads", icon: Database },
  { key: "solarEdgeApi", label: "SolarEdge API", route: "/solaredge-meter-reads", icon: Database },
  { key: "froniusApi", label: "Fronius API", route: "/fronius-meter-reads", icon: Database },
  { key: "teslaSolarApi", label: "Tesla Solar API", route: "/tesla-solar-api", icon: Database },
  { key: "teslaPowerhubApi", label: "Tesla Powerhub API", route: "/tesla-powerhub-api", icon: Database },
  { key: "zendeskApi", label: "Zendesk API", route: "/zendesk-ticket-metrics", icon: Database },
];

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


import { SUPPLEMENT_UNITS } from "@shared/const";

/** All-day events with these summaries are location/status markers, not actionable events. */
const IGNORED_ALL_DAY_SUMMARIES = new Set(["home", "office", "wfh", "work from home", "remote", "travel", "vacation", "ooo", "out of office"]);

/** Returns true if the event is a non-actionable all-day status marker (e.g. "Home"). */
const isIgnoredStatusEvent = (event: any): boolean => {
  const summary = (event?.summary || "").trim().toLowerCase();
  if (!summary) return false;
  const isAllDay = !event?.start?.dateTime && !!event?.start?.date;
  return isAllDay && IGNORED_ALL_DAY_SUMMARIES.has(summary);
};

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
      <Clock3 className="h-4 w-4 text-muted-foreground" />
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
    forecast: Array<{ day: string; highF: number; lowF: number; code: number }>;
  }>({
    loading: true,
    summary: "",
    location: "",
    temperatureF: null,
    error: null,
    forecast: [],
  });
  const [weatherForecastOpen, setWeatherForecastOpen] = useState(false);
  const [isTodoistDefaultApplied, setIsTodoistDefaultApplied] = useState(false);
  const [markingEmailId, setMarkingEmailId] = useState<string | null>(null);
  const [minuteTick, setMinuteTick] = useState(() => new Date());
  const [dashboardViewMode, setDashboardViewMode] = useState<"essential" | "detailed">("detailed");
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

  const TRACKED_SECTIONS = useMemo(
    () => [
      "section-headlines",
      "section-overview",
      "section-health",
      "section-whoop",
      "section-dailylog",
      "section-supplements",
      "section-tracking",
      "section-notes",
      "section-triage",
      "section-calendar",
      "section-todoist",
      "section-emails",
      "section-drive",
      "section-workspace",
      "section-chat",
    ],
    []
  );
  const { recordInteraction } = useSectionVisibilityTracker(TRACKED_SECTIONS);

  const { data: sectionRatings } = trpc.engagement.getRatings.useQuery(undefined, {
    enabled: !!user,
    staleTime: 300_000,
  });
  const sectionRatingMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const rating of sectionRatings || []) {
      if (rating.sectionId && rating.eventValue) {
        map[rating.sectionId] = rating.eventValue;
      }
    }
    return map;
  }, [sectionRatings]);
  const isDetailedMode = dashboardViewMode === "detailed";

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

  const hiddenSections = useMemo(
    () => new Set(getHiddenDashboardSections(preferences?.widgetLayout)),
    [preferences?.widgetLayout]
  );
  const isSectionVisible = (key: DashboardSectionKey) => !hiddenSections.has(key);
  const shouldLoadWorkspaceData = isSectionVisible("workspace") && workspaceExpanded;
  const shouldLoadChatData = isSectionVisible("chat") && chatExpanded;

  const hasGoogle = Boolean(integrations?.some((i) => i.provider === "google"));
  const hasTodoist = Boolean(integrations?.some((i) => i.provider === "todoist"));
  const hasOpenAI = Boolean(integrations?.some((i) => i.provider === "openai"));
  const hasWhoop = Boolean(integrations?.some((i) => i.provider === "whoop"));
  const hasSamsungHealth = Boolean(integrations?.some((i) => i.provider === "samsung-health"));
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
  
  // Single consistent accent color for all calendar event days
  const dayColor = { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-900", header: "bg-emerald-100" };

  const dateKeys = Object.keys(groupedEvents);
  const eventsByDate = dateKeys.map((dateKey) => ({
    date: dateKey,
    events: groupedEvents[dateKey],
    colors: dayColor,
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
      enabled: !!user && isSectionVisible("supplements"),
      retry: false,
    }
  );

  const { data: supplementDefinitions, refetch: refetchSupplementDefinitions } =
    trpc.supplements.listDefinitions.useQuery(undefined, {
      enabled: !!user && isSectionVisible("supplements"),
      retry: false,
    });

  const { data: habitsForToday, refetch: refetchHabitsForToday } = trpc.habits.getForDate.useQuery(
    { dateKey: todayKey },
    {
      enabled: !!user,
      retry: false,
    }
  );

  const { data: habitStreaks } = trpc.habits.getStreaks.useQuery(undefined, {
    enabled: !!user,
    staleTime: 60_000,
  });

  const habitStreakMap = useMemo(() => {
    const map: Record<string, { streak: number; calendar: Array<{ dateKey: string; completed: boolean }> }> = {};
    for (const s of habitStreaks || []) {
      map[s.habitId] = { streak: s.streak, calendar: s.calendar };
    }
    return map;
  }, [habitStreaks]);

  const { data: notes, isLoading: notesLoading, refetch: refetchNotes } = trpc.notes.list.useQuery(
    { limit: 300 },
    {
      enabled: !!user && isSectionVisible("notes"),
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
        if (isIgnoredStatusEvent(event)) return false;
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

  const todayEventCount = useMemo(() => {
    const now = new Date();
    return (calendarEvents || []).filter((event: any) => {
      if (isIgnoredStatusEvent(event)) return false;
      const startTime = event.start?.dateTime || event.start?.date;
      if (!startTime) return false;
      return isSameLocalDay(new Date(startTime), now);
    }).length;
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
      .filter((event: any) => !isIgnoredStatusEvent(event))
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

  const updateLayoutPreferences = trpc.preferences.update.useMutation({
    onSuccess: () => {
      refetchPreferences();
    },
  });

  const toggleSectionVisibility = (key: DashboardSectionKey) => {
    const current = getHiddenDashboardSections(preferences?.widgetLayout);
    const next = current.includes(key)
      ? current.filter((k) => k !== key)
      : [...current, key];
    const newLayout = buildWidgetLayoutWithHiddenSections(
      preferences?.widgetLayout,
      next
    );
    updateLayoutPreferences.mutate({ widgetLayout: newLayout });
  };

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
    recordInteraction("section-workspace");
    markEmailAsRead.mutate({ messageId });
  };

  const handleTriageReply = (email: { id: string }) => {
    window.open(`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(email.id)}`, "_blank", "noopener,noreferrer");
  };

  const handleTriageMarkRead = (email: { id: string }) => {
    if (markEmailAsRead.isPending) return;
    recordInteraction("section-overview");
    markEmailAsRead.mutate({ messageId: email.id });
  };

  const handleTriageMakeTask = (email: { id: string; subject: string; preview: string }) => {
    recordInteraction("section-overview");
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



  const handleAddSupplementLog = () => {
    if (!supplementName.trim() || !supplementDose.trim()) {
      toast.error("Enter supplement and dose");
      return;
    }
    recordInteraction("section-tracking");
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
    recordInteraction("section-tracking");
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
    recordInteraction("section-tracking");
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
    let cancelled = false;

    const setWeatherError = (message: string) => {
      if (cancelled) return;
      setWeather({
        loading: false,
        summary: "",
        location: "",
        temperatureF: null,
        error: message,
        forecast: [],
      });
    };

    const fetchWeatherForCoordinates = async (
      latitude: number,
      longitude: number,
      fallbackLocation = ""
    ): Promise<void> => {
      const weatherResponse = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&temperature_unit=fahrenheit&timezone=auto&forecast_days=3`
      );
      if (!weatherResponse.ok) {
        throw new Error(`Weather request failed (${weatherResponse.status})`);
      }
      const weatherData = await weatherResponse.json();
      const current = weatherData?.current ?? {};
      const daily = weatherData?.daily ?? {};

      let location = fallbackLocation;
      try {
        const geoResponse = await fetch(
          `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${latitude}&longitude=${longitude}&language=en&count=1`
        );
        if (geoResponse.ok) {
          const geoData = await geoResponse.json();
          const place = geoData?.results?.[0];
          if (place) {
            const parts = [place.name, place.admin1].filter(Boolean);
            location = parts.join(", ");
          }
        }
      } catch {
        // Location name is optional.
      }

      const forecastDays: Array<{ day: string; highF: number; lowF: number; code: number }> = [];
      const dailyDates = Array.isArray(daily.time) ? daily.time : [];
      const dailyMax = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
      const dailyMin = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
      const dailyCodes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
      for (let i = 0; i < dailyDates.length; i++) {
        const d = new Date(dailyDates[i] + "T12:00:00");
        forecastDays.push({
          day: d.toLocaleDateString("en-US", { weekday: "short" }),
          highF: typeof dailyMax[i] === "number" ? Math.round(dailyMax[i]) : 0,
          lowF: typeof dailyMin[i] === "number" ? Math.round(dailyMin[i]) : 0,
          code: typeof dailyCodes[i] === "number" ? dailyCodes[i] : 0,
        });
      }

      if (cancelled) return;
      setWeather({
        loading: false,
        summary: getWeatherLabel(current.weather_code),
        location,
        temperatureF: typeof current.temperature_2m === "number" ? current.temperature_2m : null,
        error: null,
        forecast: forecastDays,
      });
    };

    const fetchWeatherByTimezoneFallback = async () => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      const segments = timezone.split("/").filter(Boolean);
      const cityGuess = segments.length > 0 ? segments[segments.length - 1].replace(/_/g, " ") : "";
      if (!cityGuess) {
        throw new Error("Location unavailable");
      }

      const searchResponse = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityGuess)}&count=1&language=en`
      );
      if (!searchResponse.ok) {
        throw new Error(`Location lookup failed (${searchResponse.status})`);
      }
      const searchData = await searchResponse.json();
      const place = searchData?.results?.[0];
      if (!place || typeof place.latitude !== "number" || typeof place.longitude !== "number") {
        throw new Error("Could not resolve location");
      }

      const parts = [place.name, place.admin1].filter(Boolean);
      await fetchWeatherForCoordinates(place.latitude, place.longitude, parts.join(", "));
    };

    const run = async () => {
      if (navigator.geolocation) {
        try {
          const position = await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 });
          });
          await fetchWeatherForCoordinates(position.coords.latitude, position.coords.longitude);
          return;
        } catch {
          // Fallback to timezone-based lookup.
        }
      }

      try {
        await fetchWeatherByTimezoneFallback();
      } catch (error) {
        setWeatherError(error instanceof Error ? error.message : "Weather fetch failed");
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
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
    recordInteraction("section-todoist");
    completeTask.mutate({ taskId });
  };

  const handleQuickAddTodoistTask = () => {
    const content = quickTodoistTaskInput.trim();
    if (!content) return;
    recordInteraction("section-todoist");
    quickAddTodoistTask.mutate({ content });
  };
  
  const handleNewConversation = () => {
    const title = `Chat ${new Date().toLocaleString()}`;
    createConversation.mutate({ title });
  };
  
  const handleSendMessage = () => {
    if (!chatMessage.trim()) return;
    recordInteraction("section-chat");
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

  const hiddenHeaderButtons = useMemo(
    () => new Set(getHiddenDashboardHeaderButtons(preferences?.widgetLayout)),
    [preferences?.widgetLayout]
  );



  const visibleHeaderButtons = useMemo(
    () => DASHBOARD_HEADER_BUTTONS.filter((button) => !hiddenHeaderButtons.has(button.key)),
    [hiddenHeaderButtons]
  );

  const [headerButtonRowOne, headerButtonRowTwo] = useMemo(() => {
    if (visibleHeaderButtons.length === 0) return [[], []] as const;
    const firstRowSize = Math.max(1, Math.ceil(visibleHeaderButtons.length / 2));
    return [
      visibleHeaderButtons.slice(0, firstRowSize),
      visibleHeaderButtons.slice(firstRowSize),
    ] as const;
  }, [visibleHeaderButtons]);

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Keyboard shortcuts: press 1-6 to jump to sections (when no input is focused)
  useEffect(() => {
    const sectionShortcuts: Record<string, string> = {
      "1": "section-overview",
      "2": "section-health",
      "3": "section-tracking",
      "4": "section-todoist",
      "5": "section-workspace",
      "6": "section-chat",
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input, textarea, or contenteditable
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }

      const sectionId = sectionShortcuts[e.key];
      if (sectionId) {
        e.preventDefault();
        scrollToSection(sectionId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (loading || isLoading) {
    return <DashboardSkeleton />;
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

  return (
    <div id="dashboard-top" className="min-h-screen overflow-x-clip bg-gradient-to-br from-slate-100 via-white to-emerald-50 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950 flex flex-col">
      {/* Hero */}
      <div className="container mx-auto px-4 pt-4">
        <DashboardHero
          userName={preferences?.displayName || user?.name?.split(" ")[0]}
          stats={[
            { label: "Tasks", value: (allTodoistTasks || []).filter((t: any) => t.due?.date && t.due.date <= todayKey).length, icon: CheckSquare },
            { label: "Events", value: todayEventCount, icon: Calendar },
            { label: "Recovery", value: whoopSummary?.recoveryScore != null ? `${Math.round(whoopSummary.recoveryScore)}%` : "--", icon: HeartPulse },
            { label: "Completed", value: todoistCompletedToday?.count ?? "--", icon: CheckSquare },
          ]}
        />
      </div>

      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b">
        <div className="container mx-auto px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <LiveClockValue />
            </span>
            <button
              type="button"
              className="flex items-center gap-1.5 hover:text-foreground transition-colors"
              onClick={() => setWeatherForecastOpen((v) => !v)}
              aria-label="Toggle weather forecast"
              aria-expanded={weatherForecastOpen}
            >
              <CloudSun className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              {weather.loading
                ? "Loading..."
                : weather.error
                  ? "Unavailable"
                  : `${weather.summary}${weather.temperatureF !== null ? `, ${Math.round(weather.temperatureF)}°F` : ""}`}
            </button>
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              {!hasGoogle
                ? "Connect Calendar"
                : calendarLoading
                  ? "Loading..."
                  : nextCalendarEvent
                    ? `${nextCalendarEvent.event?.summary || "Untitled"} · ${
                        nextCalendarEvent.isAllDay
                          ? "All day"
                          : nextCalendarEvent.startDate.toLocaleTimeString("en-US", {
                              hour: "numeric",
                              minute: "2-digit",
                            })
                      }`
                    : "No upcoming events"}
            </span>
            <span className="ml-auto">
              <FocusTimer />
            </span>
          </div>
          {weatherForecastOpen && weather.forecast.length > 0 && (
            <div className="mt-2 flex gap-2 pb-1">
              {weather.forecast.map((day, i) => (
                <div key={i} className="flex-1 rounded-md border bg-muted/50 px-2 py-1 text-center">
                  <p className="text-xs font-semibold text-muted-foreground">{day.day}</p>
                  <p className="text-xs text-muted-foreground">{getWeatherLabel(day.code)}</p>
                  <p className="text-xs font-medium text-foreground">
                    {day.highF}° / {day.lowF}°
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="container mx-auto px-4 py-1.5">
          <div className="flex items-center justify-end gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs">
                  <SettingsIcon className="h-3.5 w-3.5 mr-1.5" />
                  Sections
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {DASHBOARD_SECTION_OPTIONS.map((section) => (
                  <DropdownMenuItem
                    key={section.key}
                    onClick={() => toggleSectionVisibility(section.key)}
                    className="flex items-center justify-between text-xs"
                  >
                    {section.label}
                    <span className="sr-only">{isSectionVisible(section.key) ? "visible" : "hidden"}</span>
                    <span className={`h-2 w-2 rounded-full ${isSectionVisible(section.key) ? "bg-health" : "bg-muted-foreground/30"}`} aria-hidden="true" />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex items-center gap-1 rounded-md border bg-muted/50 px-1 py-1">
              <Button
                variant={dashboardViewMode === "essential" ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setDashboardViewMode("essential");
                  const newLayout = buildWidgetLayoutWithHiddenSections(preferences?.widgetLayout, ["supplements", "notes", "workspace", "chat"]);
                  updateLayoutPreferences.mutate({ widgetLayout: newLayout });
                }}
              >
                Essential
              </Button>
              <Button
                variant={dashboardViewMode === "detailed" ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setDashboardViewMode("detailed");
                  const newLayout = buildWidgetLayoutWithHiddenSections(preferences?.widgetLayout, []);
                  updateLayoutPreferences.mutate({ widgetLayout: newLayout });
                }}
              >
                Detailed
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Headlines & Markets */}
      {isSectionVisible("headlines") && (
        <div id="section-headlines" className="container mx-auto px-4 pt-4 scroll-mt-40">
          <MarketHeadlinesCard />
        </div>
      )}

      {/* MN Sports — only renders on game days */}
      <div className="container mx-auto px-4 pt-4 scroll-mt-40">
        <SportsCard />
      </div>

      {/* Today's Plan */}
      <div id="section-overview" className="container mx-auto px-4 pt-4 scroll-mt-40">
        <div className="space-y-4">
          <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <TodaysPlan
              calendarEvents={(calendarEvents || []).filter((e: any) => !isIgnoredStatusEvent(e))}
              todoistTasks={allTodoistTasks || []}
              emails={gmailMessages || []}
              habits={habitsForToday || []}
              whoopSummary={whoopSummary}
              samsungHealthSnapshot={samsungHealthSnapshot}
              onCompleteHabit={handleCompleteHabitFromPlan}
              onRegenerate={handleRegenerateTodaysPlan}
            />

            <div className="min-w-0">
              <DashboardWidget
                title="Triage Inbox"
                icon={Mail}
                category="productivity"
                collapsible
                isLoading={!gmailMessages && integrationsFetching}
              >
                <div className="space-y-2">
                  <div className="h-32 rounded-md border border-border bg-card dark:border-slate-700 dark:bg-slate-900 px-2 py-1">
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
                    <p className="rounded-md border border-dashed border-border bg-muted dark:border-slate-700 dark:bg-slate-800 px-3 py-4 text-sm text-muted-foreground dark:text-slate-400">
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
                </div>
              </DashboardWidget>
            </div>
          </div>

          <DecisionsWidget
            decisions={decisionsToMake}
            waitingOn={waitingOnItems}
            onSendNudge={handleSendNudge}
          />
        </div>
      </div>

      {/* Health Row */}
      <div id="section-health" className="container mx-auto px-4 pt-4 scroll-mt-40">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SamsungHealthCard
            snapshot={samsungHealthSnapshot}
            hasSamsungHealth={hasSamsungHealth}
            isRefreshing={integrationsFetching}
            onRefresh={() => refetchIntegrations()}
            sectionRating={sectionRatingMap["section-health"] as any}
          />
          <WhoopCard
            whoopSummary={whoopSummary}
            hasWhoop={hasWhoop}
            isLoading={whoopLoading}
            isFetching={whoopFetching}
            errorMessage={whoopErrorMessage}
            onRefresh={() => refetchWhoop()}
            sectionRating={sectionRatingMap["section-whoop"] as any}
          />
        </div>
      </div>

      {/* Tracking Row */}
      <div id="section-tracking" className="container mx-auto px-4 pt-4 scroll-mt-40">
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-4">
          <DashboardWidget
            title="Daily Log Trend"
            icon={BarChart3}
            category="health"
            collapsible
            isLoading={captureDailyMetrics.isPending}
            onRetry={() => captureDailyMetrics.mutate({ dateKey: todayKey })}
            className="min-w-0"
          >
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                One row per day. Captured every 15m while this dashboard is open, and when you complete a Todoist task.
              </p>
              <div className="h-40 rounded-md border bg-card px-2 py-1">
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
                <p className="text-sm text-muted-foreground">No entries yet.</p>
              ) : (
                <div className="space-y-1">
                  <div className="grid grid-cols-4 gap-2 rounded-md border bg-muted px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <span>Date</span>
                    <span>Recovery %</span>
                    <span>Samsung Steps</span>
                    <span>Todo Done</span>
                  </div>
                  {recentMetricRows.map((row: any) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-4 gap-2 rounded-md border bg-muted/50 px-2 py-1.5 text-xs"
                    >
                      <span className="font-medium text-foreground">{row.dateKey}</span>
                      <span className="text-muted-foreground">{row.whoopRecoveryScore ?? "-"}</span>
                      <span className="text-muted-foreground">
                        {row.samsungSteps ? Number(row.samsungSteps).toLocaleString() : "-"}
                      </span>
                      <span className="text-muted-foreground">
                        {row.dateKey === todayKey && hasTodoist
                          ? (todoistCompletedToday?.count ?? row.todoistCompletedCount ?? "-")
                          : (row.todoistCompletedCount ?? "-")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DashboardWidget>

          {isSectionVisible("supplements") ? (
            <SupplementsCard
              supplementName={supplementName}
              supplementDose={supplementDose}
              supplementDoseUnit={supplementDoseUnit}
              supplementTiming={supplementTiming}
              supplementDefinitions={supplementDefinitions}
              supplementLogs={supplementLogs}
              sectionRating={sectionRatingMap["section-supplements"] as any}
              setSupplementName={setSupplementName}
              setSupplementDose={setSupplementDose}
              setSupplementDoseUnit={setSupplementDoseUnit}
              setSupplementTiming={setSupplementTiming}
              onAddDefinition={handleAddSupplementDefinition}
              onLogOnce={handleAddSupplementLog}
              onToggleLock={(id, isLocked) => setSupplementDefinitionLock.mutate({ definitionId: id, isLocked })}
              onDeleteDefinition={(id) => deleteSupplementDefinition.mutate({ definitionId: id })}
              onDeleteLog={(id) => deleteSupplementLog.mutate({ id })}
              addDefinitionPending={createSupplementDefinition.isPending}
              addLogPending={addSupplementLog.isPending}
            />
          ) : null}

          <HabitsCard
            habits={habitsForToday || []}
            habitStreakMap={habitStreakMap}
            completionChartData={habitCompletionChartData}
            onToggle={handleToggleHabit}
            isToggling={setHabitCompletion.isPending}
            onRefresh={() => refetchHabitsForToday()}
            sectionRating={sectionRatingMap["section-tracking"] as any}
          />

          {isSectionVisible("notes") ? (
            <NotesCard
              noteTitleInput={noteTitleInput}
              noteContentInput={noteContentInput}
              noteNotebookInput={noteNotebookInput}
              noteNotebookFilter={noteNotebookFilter}
              editingNoteId={editingNoteId}
              linkNoteId={linkNoteId}
              linkTaskId={linkTaskId}
              linkEventId={linkEventId}
              noteNotebookOptions={noteNotebookOptions}
              filteredNotes={filteredNotes}
              notes={notes}
              notesLoading={notesLoading}
              todayTasks={todayTasks}
              upcomingEvents={upcomingEvents}
              sectionRating={sectionRatingMap["section-notes"] as any}
              setNoteTitleInput={setNoteTitleInput}
              setNoteContentInput={setNoteContentInput}
              setNoteNotebookInput={setNoteNotebookInput}
              setNoteNotebookFilter={setNoteNotebookFilter}
              setEditingNoteId={setEditingNoteId}
              setLinkNoteId={setLinkNoteId}
              setLinkTaskId={setLinkTaskId}
              setLinkEventId={setLinkEventId}
              onSubmitNote={handleSubmitNote}
              onEditNote={handleEditNote}
              onDeleteNote={(id) => deleteNoteMutation.mutate({ noteId: id })}
              onPinNote={(id, pinned) => updateNoteMutation.mutate({ noteId: id, pinned })}
              onLinkNoteToTask={handleLinkExistingNoteToTask}
              onLinkNoteToEvent={handleLinkExistingNoteToEvent}
              onRemoveLink={(id) => removeNoteLinkMutation.mutate({ linkId: id })}
              onRefresh={() => refetchNotes()}
              formatCalendarEventLabel={formatCalendarEventLabel}
              createPending={createNoteMutation.isPending}
              updatePending={updateNoteMutation.isPending}
              linkPending={addNoteLinkMutation.isPending}
            />
          ) : null}
        </div>
      </div>

      {/* Universal Drop Dock */}
      <div className="container mx-auto px-4 pt-4">
        <UniversalDropDock />
      </div>

      {/* Main Content - Four Column Layout */}
      <WorkspaceSection
        isSectionVisible={isSectionVisible}
        workspaceExpanded={workspaceExpanded}
        setWorkspaceExpanded={setWorkspaceExpanded}
        dashboardViewMode={dashboardViewMode}
        setDashboardViewMode={setDashboardViewMode}
        setLocation={setLocation}
        sectionRatingMap={sectionRatingMap}
        hasGoogle={hasGoogle}
        calendarLoading={calendarLoading}
        upcomingEvents={upcomingEvents}
        eventsByDate={eventsByDate}
        selectedCalendarHistoryEventId={selectedCalendarHistoryEventId}
        setSelectedCalendarHistoryEventId={setSelectedCalendarHistoryEventId}
        selectedCalendarHistoryEvent={selectedCalendarHistoryEvent}
        calendarLinkedNotes={calendarLinkedNotes}
        refetchCalendar={() => refetchCalendar()}
        openNotebookForCalendarEvent={openNotebookForCalendarEvent}
        handleCreateNoteFromCalendarEvent={handleCreateNoteFromCalendarEvent}
        createNoteFromCalendarMutationPending={createNoteFromCalendarMutation.isPending}
        handleEditNote={handleEditNote}
        formatEventTime={formatEventTime}
        hasTodoist={hasTodoist}
        tasksLoading={tasksLoading}
        todayTasks={todayTasks}
        todoistFilter={todoistFilter}
        setTodoistFilter={setTodoistFilter}
        todoistProjects={todoistProjects}
        todoistLabels={todoistLabels}
        quickTodoistTaskInput={quickTodoistTaskInput}
        setQuickTodoistTaskInput={setQuickTodoistTaskInput}
        handleQuickAddTodoistTask={handleQuickAddTodoistTask}
        quickAddTodoistTaskPending={quickAddTodoistTask.isPending}
        handleCompleteTask={handleCompleteTask}
        handleCreateNoteFromTask={handleCreateNoteFromTask}
        createNoteFromTaskMutationPending={createNoteFromTaskMutation.isPending}
        refetchTasks={() => refetchTasks()}
        refetchTodoistCompletedToday={() => refetchTodoistCompletedToday()}
        emailsLoading={emailsLoading}
        emailsFetching={emailsFetching}
        gmailMessages={gmailMessages}
        markingEmailId={markingEmailId}
        markEmailAsReadPending={markEmailAsRead.isPending}
        createTaskFromEmailPending={createTaskFromEmail.isPending}
        refetchEmails={() => refetchEmails()}
        handleMarkEmailAsRead={handleMarkEmailAsRead}
        handleAddEmailToTodoist={handleAddEmailToTodoist}
        getEmailHeader={getEmailHeader}
        formatEmailDate={formatEmailDate}
        driveLoading={driveLoading}
        displayedDriveFiles={displayedDriveFiles}
        driveSearchQuery={driveSearchQuery}
        setDriveSearchQuery={setDriveSearchQuery}
        driveSearchResults={driveSearchResults}
        isSearching={isSearching}
        handleDriveSearch={handleDriveSearch}
        clearDriveSearch={clearDriveSearch}
        refetchDrive={() => refetchDrive()}
        createSpreadsheet={{ mutate: createSpreadsheet.mutate, isPending: createSpreadsheet.isPending }}
      />

      {/* Chat Panel at Bottom */}
      <ChatPanel
        hasOpenAI={hasOpenAI}
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        messages={messages}
        chatMessage={chatMessage}
        isSectionVisible={isSectionVisible}
        chatExpanded={chatExpanded}
        setSelectedConversationId={setSelectedConversationId}
        setChatMessage={setChatMessage}
        setChatExpanded={setChatExpanded}
        handleNewConversation={handleNewConversation}
        handleDeleteConversation={handleDeleteConversation}
        handleSendMessage={handleSendMessage}
        sendMessagePending={sendMessage.isPending}
        messagesEndRef={messagesEndRef}
      />

      <QuickActionsFab
        onAddTask={() => {
          const input = document.querySelector<HTMLInputElement>('input[placeholder="Quick add a task..."]');
          if (input) {
            input.scrollIntoView({ behavior: "smooth", block: "center" });
            setTimeout(() => input.focus(), 300);
          } else {
            setLocation("/widget/todoist");
          }
        }}
        onLogSupplement={() => {
          document.getElementById("section-tracking")?.scrollIntoView({ behavior: "smooth" });
        }}
      />
    </div>
  );
}
