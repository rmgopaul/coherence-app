import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import UniversalDropDock from "@/components/UniversalDropDock";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
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
  Pencil,
  Check,
  X,
  Pill,
  Target,
  BarChart3,
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { useState, useEffect, useMemo, useRef } from "react";

const DAILY_OVERVIEW_CACHE_KEY = "dailyOverviewCache";

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

const OVERVIEW_SECTION_ORDER = [
  "Summary",
  "Must Do Today",
  "Priority Emails",
  "Risks & Follow-ups",
] as const;

type OverviewSection = {
  title: (typeof OVERVIEW_SECTION_ORDER)[number];
  items: string[];
};

const normalizeOverviewHeading = (line: string): OverviewSection["title"] | null => {
  const clean = line
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/<u>|<\/u>/g, "")
    .replace(/[:]/g, "")
    .trim()
    .toLowerCase();

  if (clean === "summary") return "Summary";
  if (clean === "must do today") return "Must Do Today";
  if (clean === "priority emails") return "Priority Emails";
  if (clean === "risks & follow-ups" || clean === "risks and follow-ups")
    return "Risks & Follow-ups";
  return null;
};

const parseDailyOverviewSections = (content: string): OverviewSection[] => {
  const sections = new Map<OverviewSection["title"], string[]>();
  OVERVIEW_SECTION_ORDER.forEach((title) => sections.set(title, []));

  let currentTitle: OverviewSection["title"] = "Summary";

  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = normalizeOverviewHeading(line);
    if (heading) {
      currentTitle = heading;
      continue;
    }

    const item = line
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .trim();
    if (!item) continue;
    sections.get(currentTitle)?.push(item);
  }

  return OVERVIEW_SECTION_ORDER.map((title) => ({
    title,
    items: sections.get(title) || [],
  }));
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
    active: "bg-blue-600 text-white border-blue-700",
    inactive: "bg-blue-50 text-blue-700 border-blue-200",
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
  const [dailyOverview, setDailyOverview] = useState<string>("");
  const [dailyOverviewDate, setDailyOverviewDate] = useState<string | null>(null);
  const [isEditingWelcomeName, setIsEditingWelcomeName] = useState(false);
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
    if (isEditingWelcomeName) return;
    setWelcomeDisplayNameInput(greetingDisplayName);
  }, [user?.id, greetingDisplayName, isEditingWelcomeName]);
  
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
    { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-900', header: 'bg-blue-100' },
    { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-900', header: 'bg-green-100' },
    { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-900', header: 'bg-purple-100' },
    { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-900', header: 'bg-orange-100' },
    { bg: 'bg-pink-50', border: 'border-pink-200', text: 'text-pink-900', header: 'bg-pink-100' },
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

  const { data: allTodoistTasks } = trpc.todoist.getTasks.useQuery(undefined, {
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
  
  const { data: driveFiles, isLoading: driveLoading, refetch: refetchDrive } = trpc.google.getDriveFiles.useQuery(undefined, {
    enabled: !!user && hasGoogle,
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
      enabled: !!user,
      retry: false,
    }
  );

  const { data: supplementDefinitions, refetch: refetchSupplementDefinitions } =
    trpc.supplements.listDefinitions.useQuery(undefined, {
      enabled: !!user,
      retry: false,
    });

  const { data: habitsForToday, refetch: refetchHabitsForToday } = trpc.habits.getForDate.useQuery(
    { dateKey: todayKey },
    {
      enabled: !!user,
      retry: false,
    }
  );

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

  const createTaskFromOverview = trpc.todoist.createTask.useMutation({
    onSuccess: () => {
      toast.success("Overview item added to Todoist");
      refetchTasks();
      refetchDueTodayTasks();
    },
    onError: (error) => {
      toast.error(`Failed to add to Todoist: ${error.message}`);
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
      setIsEditingWelcomeName(false);
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

  const handleAddOverviewItemToTodoist = (item: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hasTodoist) {
      toast.error("Connect Todoist in Settings first");
      return;
    }
    createTaskFromOverview.mutate({ content: item });
  };

  const handleMarkEmailAsRead = (messageId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (markEmailAsRead.isPending) return;
    markEmailAsRead.mutate({ messageId });
  };

  const handleSaveWelcomeName = () => {
    const trimmed = welcomeDisplayNameInput.trim();
    updatePreferences.mutate({
      displayName: trimmed.length > 0 ? trimmed : null,
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
    enabled: !!user,
  });
  
  const { data: messages, refetch: refetchMessages } = trpc.conversations.getMessages.useQuery(
    { conversationId: selectedConversationId! },
    { enabled: !!selectedConversationId }
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

  const generateDailyOverview = trpc.openai.generateDailyOverview.useMutation({
    onError: (error) => {
      toast.error(`Failed to generate daily overview: ${error.message}`);
    },
  });

  const saveDailyOverviewCache = (content: string, date: string) => {
    setDailyOverview(content);
    setDailyOverviewDate(date);
    localStorage.setItem(
      DAILY_OVERVIEW_CACHE_KEY,
      JSON.stringify({
        date,
        content,
      })
    );
  };

  const refreshDailyOverview = async () => {
    if (!hasOpenAI) return;

    const weatherSummary = weather.error
      ? "Weather unavailable"
      : `${weather.summary}${weather.temperatureF !== null ? `, ${Math.round(weather.temperatureF)}F` : ""}`;

    const overview = await generateDailyOverview.mutateAsync({
      date: todayKey,
      weather: {
        summary: weatherSummary,
        location: weather.location || undefined,
        temperatureF: weather.temperatureF ?? undefined,
      },
      todoistTasks: (dueTodayTasks || []).slice(0, 10).map((task: any) => ({
        content: task.content,
        due: task.due?.date,
        priority: task.priority,
      })),
      calendarEvents: todaysCalendarEvents.slice(0, 10),
      prioritizedEmails: prioritizedEmails.map((email) => ({
        from: email.from,
        subject: email.subject,
        snippet: email.snippet,
        date: email.date,
        reason: email.reason,
      })),
    });

    saveDailyOverviewCache(overview.overview, todayKey);
  };

  useEffect(() => {
    const cached = localStorage.getItem(DAILY_OVERVIEW_CACHE_KEY);
    if (!cached) return;
    try {
      const parsed = JSON.parse(cached);
      if (parsed?.date === todayKey && typeof parsed?.content === "string") {
        setDailyOverview(parsed.content);
        setDailyOverviewDate(parsed.date);
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
    if (!hasOpenAI || !user) return;
    if (generateDailyOverview.isPending) return;
    if (dailyOverviewDate === todayKey && dailyOverview) return;

    const googleReady = !hasGoogle || (!calendarLoading && !emailsLoading);
    const todoistReady = !hasTodoist || !dueTodayTasksLoading;
    const weatherReady = !weather.loading;
    if (!googleReady || !todoistReady || !weatherReady) return;

    refreshDailyOverview().catch((error) => {
      console.error("Daily overview generation failed:", error);
    });
  }, [
    hasOpenAI,
    user,
    generateDailyOverview.isPending,
    dailyOverviewDate,
    dailyOverview,
    todayKey,
    hasGoogle,
    calendarLoading,
    emailsLoading,
    hasTodoist,
    dueTodayTasksLoading,
    weather.loading,
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

  const weatherLabel = weather.error
    ? "Weather unavailable"
    : `${weather.summary}${weather.temperatureF !== null ? `, ${Math.round(weather.temperatureF)}F` : ""}${
        weather.location ? ` (${weather.location})` : ""
      }`;

  const fallbackDailyOverview = [
    "### Snapshot",
    `- Weather: ${weatherLabel}`,
    `- Todoist due today: ${(dueTodayTasks || []).length}`,
    `- Calendar events today: ${todaysCalendarEvents.length}`,
    `- Priority emails to review: ${prioritizedEmails.length}`,
    "",
    "### Focus Now",
    ...(dueTodayTasks || []).slice(0, 3).map((task: any) => `- Task: ${task.content}`),
    ...todaysCalendarEvents.slice(0, 3).map((event) => `- Event: ${event.summary}`),
    ...prioritizedEmails
      .slice(0, 3)
      .map((email) => `- Email: ${email.subject} (${email.reason})`),
  ]
    .filter(Boolean)
    .join("\n");

  const overviewSections = useMemo(
    () => parseDailyOverviewSections(dailyOverview || fallbackDailyOverview),
    [dailyOverview, fallbackDailyOverview]
  );
  const overviewLoading = hasOpenAI && generateDailyOverview.isPending && !dailyOverview;
  
  if (loading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
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
  const formatHours = (minutes: number) => `${(minutes / 60).toFixed(1)}h`;
  const recentMetricRows = (metricHistory || []).slice(0, 7);
  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div id="dashboard-top" className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 flex flex-col">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Coherence</h1>
            <div className="flex items-center gap-2">
              {isEditingWelcomeName ? (
                <>
                  <p className="text-sm text-gray-600">Welcome,</p>
                  <Input
                    value={welcomeDisplayNameInput}
                    onChange={(e) => setWelcomeDisplayNameInput(e.target.value)}
                    className="h-7 w-56 text-sm"
                    maxLength={120}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={handleSaveWelcomeName}
                    disabled={updatePreferences.isPending}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => {
                      setIsEditingWelcomeName(false);
                      setWelcomeDisplayNameInput(greetingDisplayName);
                    }}
                    disabled={updatePreferences.isPending}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-600">Welcome, {greetingDisplayName}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2"
                    onClick={() => setIsEditingWelcomeName(true)}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
          <Button variant="outline" onClick={() => setLocation("/settings")}>
            <SettingsIcon className="h-4 w-4 mr-2" />
            Settings
          </Button>
        </div>
      </header>

      <div className="sticky top-[76px] z-20 bg-gradient-to-br from-blue-50/95 via-white/95 to-purple-50/95 backdrop-blur-sm">
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
              Daily Overview
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
              className="h-8 text-xs border border-indigo-200 bg-indigo-50 hover:bg-indigo-100"
              onClick={() => scrollToSection("section-tracking")}
            >
              <BarChart3 className="h-3.5 w-3.5 mr-1.5 text-indigo-700" />
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
          </div>
        </div>
      </div>
      </div>

      {/* Daily Overview */}
      <div id="section-overview" className="container mx-auto px-4 pt-4 scroll-mt-40">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-lg">Daily Overview</CardTitle>
              <p className="text-xs text-gray-600 mt-1">
                {hasOpenAI ? "Generated by ChatGPT using today's data" : "Connect OpenAI to enable AI-generated overview"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs px-2.5"
              onClick={() => refreshDailyOverview().catch(() => null)}
              disabled={!hasOpenAI || generateDailyOverview.isPending}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${generateDailyOverview.isPending ? "animate-spin" : ""}`} />
              Regenerate
            </Button>
          </CardHeader>
          <CardContent>
            {overviewLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating today&apos;s overview...
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {overviewSections.map((section) => (
                  <div key={section.title} className="rounded-md bg-slate-50/70 border border-slate-200 p-2.5">
                    <h3 className="text-xs font-semibold text-slate-800 underline underline-offset-4 decoration-slate-300">
                      {section.title}
                    </h3>
                    {section.items.length > 0 ? (
                      <ul className="mt-1.5 space-y-1">
                        {section.items.map((item, index) => (
                          <li
                            key={`${section.title}-${index}`}
                            className="group relative pr-7 text-xs text-slate-700 leading-5"
                          >
                            <span className="font-semibold mr-2">•</span>
                            {item}
                            {hasTodoist && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="absolute right-0 top-0 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={(e) => handleAddOverviewItemToTodoist(item, e)}
                                disabled={createTaskFromOverview.isPending}
                                title="Add to Todoist"
                              >
                                <CheckSquare className="h-3.5 w-3.5 text-red-600" />
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1.5 text-xs text-slate-500">No notable items.</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Health Row */}
      <div id="section-health" className="container mx-auto px-4 pt-4 scroll-mt-40">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="flex flex-col border-blue-200 bg-gradient-to-br from-blue-50 via-cyan-50 to-sky-100 text-slate-900 shadow-[0_14px_34px_rgba(14,116,144,0.18)]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-sky-700" />
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
                  <Smartphone className="h-8 w-8 mx-auto mb-2 text-sky-400" />
                  <p className="text-sm">No Samsung Health sync detected yet.</p>
                  <p className="text-xs mt-2 text-slate-600">
                    Run the Android companion and tap Sync Now.
                  </p>
                </div>
              ) : !samsungHealthSnapshot ? (
                <div className="text-center py-5 text-slate-700">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-sky-600" />
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
                    <div className="rounded-md border border-blue-200 bg-white/80 p-2">
                      <p className="text-xs text-slate-500">Steps</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {samsungHealthSnapshot.steps !== null
                          ? Math.round(samsungHealthSnapshot.steps).toLocaleString()
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-blue-200 bg-white/80 p-2">
                      <p className="text-xs text-slate-500">Sleep</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {samsungHealthSnapshot.sleepTotalMinutes !== null
                          ? formatHours(samsungHealthSnapshot.sleepTotalMinutes)
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-blue-200 bg-white/80 p-2">
                      <p className="text-xs text-slate-500">SpO2 Avg</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {samsungHealthSnapshot.spo2AvgPercent !== null && samsungHealthSnapshot.spo2AvgPercent > 0
                          ? `${samsungHealthSnapshot.spo2AvgPercent.toFixed(1)}%`
                          : "-"}
                      </p>
                    </div>
                    <div className="rounded-md border border-blue-200 bg-white/80 p-2">
                      <p className="text-xs text-slate-500">Sleep Sessions</p>
                      <p className="text-sm font-semibold text-slate-900">
                        {samsungHealthSnapshot.sleepSessionsCount !== null
                          ? Math.round(samsungHealthSnapshot.sleepSessionsCount)
                          : "-"}
                      </p>
                    </div>
                    <div
                      className="rounded-md border border-blue-200 bg-white/80 p-2 cursor-pointer"
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
                      className="rounded-md border border-blue-200 bg-white/80 p-2 cursor-pointer"
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
                  <div className="rounded-md border border-blue-200 bg-white/80 p-2">
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
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-indigo-600" />
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

          <Card className="flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <Pill className="h-4 w-4 text-emerald-600" />
                <CardTitle className="text-base">Supplements</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                <Input
                  value={supplementName}
                  onChange={(e) => setSupplementName(e.target.value)}
                  placeholder="Supplement"
                  className="md:col-span-2 h-8 text-xs"
                />
                <Input
                  value={supplementDose}
                  onChange={(e) => setSupplementDose(e.target.value)}
                  placeholder="Dose"
                  className="h-8 text-xs"
                />
                <Select
                  value={supplementDoseUnit}
                  onValueChange={(value) => setSupplementDoseUnit(value as (typeof SUPPLEMENT_UNITS)[number])}
                >
                  <SelectTrigger className="h-8 text-xs">
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
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <Select
                  value={supplementTiming}
                  onValueChange={(value) => setSupplementTiming(value as "am" | "pm")}
                >
                  <SelectTrigger className="h-8 text-xs">
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
                  className="h-8 text-xs md:justify-self-start"
                  onClick={handleAddSupplementDefinition}
                  disabled={createSupplementDefinition.isPending}
                >
                  Add to List
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleAddSupplementLog}
                  disabled={addSupplementLog.isPending}
                >
                  Log Once
                </Button>
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
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5"
                    >
                      <p className="text-xs text-slate-800 flex-1 min-w-0 truncate pr-2">
                        {definition.name} • {definition.dose} {definition.doseUnit} • {definition.timing}
                      </p>
                      <div className="flex items-center gap-1">
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
                      className="flex items-center justify-between rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5"
                    >
                      <div className="min-w-0 pr-2">
                        <p className="text-xs font-medium text-emerald-900 truncate">
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
                        className="h-6 w-6 p-0"
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

          <Card className="flex flex-col">
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
        </div>
      </div>

      {/* Universal Drop Dock */}
      <div className="container mx-auto px-4 pt-4">
        <UniversalDropDock />
      </div>

      {/* Main Content - Four Column Layout */}
      <main id="section-workspace" className="container mx-auto px-4 py-6 flex-1 overflow-hidden scroll-mt-40">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-full">
          {/* Left Column - Calendar Events */}
          <Card className="lg:col-span-1 flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-blue-600" />
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
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
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
                        <a
                          key={event.id}
                          href={event.htmlLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`block p-2 ${colors.bg} rounded-md border ${colors.border} hover:opacity-80 transition-opacity`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <p className={`font-medium text-xs ${colors.text} truncate leading-4`}>{event.summary}</p>
                              <p className="text-[11px] text-gray-600">{formatEventTime(event)}</p>
                              {event.location && (
                                <p className="text-[11px] text-gray-500 truncate">{event.location}</p>
                              )}
                            </div>
                          </div>
                        </a>
                      ))}
                    </div>
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

      {/* Chat Panel at Bottom */}
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
                        selectedConversationId === conv.id ? "bg-blue-100" : "hover:bg-gray-100"
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
                              ? "bg-blue-600 text-white"
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
    </div>
  );
}
