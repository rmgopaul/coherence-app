import { useLocation } from "wouter";
import {
  LayoutDashboard,
  CheckSquare,
  Calendar,
  StickyNote,
  MessageSquare,
  HeartPulse,
  ListChecks,
  Pill,
  Clock,
  Mail,
  ChevronDown,
  BarChart3,
  FileText,
  FileSpreadsheet,
  Zap,
  Sun,
  Battery,
  Headset,
  FileSearch,
  MapPin,
  Settings,
  type LucideIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useState, useEffect, useMemo, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { SidebarMenuBadge } from "@/components/ui/sidebar";
import { APP_LOGO } from "@/const";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  badgeKey?: string;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Personal",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { label: "Tasks", href: "/widget/todoist", icon: CheckSquare, badgeKey: "tasks" },
      { label: "Calendar", href: "/widget/google-calendar", icon: Calendar, badgeKey: "events" },
      { label: "Notes", href: "/notes", icon: StickyNote, badgeKey: "notes" },
      { label: "Supplements", href: "/supplements", icon: Pill, badgeKey: "supplements" },
      { label: "Habits", href: "/habits", icon: ListChecks, badgeKey: "habits" },
      { label: "Health", href: "/health", icon: HeartPulse, badgeKey: "health" },
      { label: "Chat", href: "/widget/chatgpt", icon: MessageSquare, badgeKey: "chat" },
    ],
  },
  {
    title: "Work",
    items: [
      { label: "Clockify", href: "/widget/clockify", icon: Clock },
      { label: "Gmail", href: "/widget/gmail", icon: Mail },
    ],
  },
  {
    title: "Portfolio",
    items: [
      { label: "SunPower Reads", href: "/sunpower-readings", icon: Zap, badgeKey: "sunpowerReadings" },
      { label: "Solar REC", href: "/solar-rec/", icon: BarChart3 },
      { label: "Invoice Match", href: "/invoice-match-dashboard", icon: FileSpreadsheet },
      { label: "Deep Update", href: "/deep-update-synthesizer", icon: FileText },
      { label: "Contract Scanner", href: "/contract-scanner", icon: FileSearch },
      { label: "Contract Scraper", href: "/contract-scrape-manager", icon: FileSearch },
      { label: "ABP Settlement", href: "/abp-invoice-settlement", icon: FileSpreadsheet },
      { label: "Early Payment", href: "/early-payment", icon: FileSpreadsheet },
      { label: "Address Checker", href: "/address-checker", icon: MapPin },
      { label: "Enphase v4", href: "/enphase-v4-meter-reads", icon: Zap },
      { label: "SolarEdge", href: "/solaredge-meter-reads", icon: Sun },
      { label: "Fronius", href: "/fronius-meter-reads", icon: Sun },
      { label: "ennexOS", href: "/ennexos-meter-reads", icon: Sun },
      { label: "eGauge", href: "/egauge-api", icon: Sun },
      { label: "Tesla Solar", href: "/tesla-solar-api", icon: Sun },
      { label: "Tesla Powerhub", href: "/tesla-powerhub-api", icon: Battery },
      { label: "Solis", href: "/solis-meter-reads", icon: Sun },
      { label: "GoodWe", href: "/goodwe-meter-reads", icon: Sun },
      { label: "Generac", href: "/generac-meter-reads", icon: Battery },
      { label: "Locus/SolarNOC", href: "/locus-meter-reads", icon: Sun },
      { label: "Growatt", href: "/growatt-meter-reads", icon: Sun },
      { label: "APsystems", href: "/apsystems-meter-reads", icon: Sun },
      { label: "EKM", href: "/ekm-meter-reads", icon: Zap },
      { label: "Hoymiles", href: "/hoymiles-meter-reads", icon: Sun },
      { label: "Solar-Log", href: "/solarlog-meter-reads", icon: Sun },
      { label: "Zendesk", href: "/zendesk-ticket-metrics", icon: Headset },
    ],
  },
];

function getStoredSections(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem("sidebar-sections");
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function storeSections(sections: Record<string, boolean>) {
  localStorage.setItem("sidebar-sections", JSON.stringify(sections));
}

export function AppSidebar() {
  const [location] = useLocation();

  // Badge counts. All queries pin staleTime + disable refetch-on-focus
  // so a sidebar mount doesn't cost a roundtrip when the user tabs back.
  // The Personal-section queries also live in `useDashboardData`, so React
  // Query dedupes — adding them here is free when the dashboard is open.
  const { data: todoistTasks } = trpc.todoist.getTasks.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: calendarEvents } = trpc.google.getCalendarEvents.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: notes } = trpc.notes.list.useQuery(
    { limit: 1000 },
    { staleTime: 5 * 60_000, refetchOnWindowFocus: false }
  );
  const { data: supplementLogs } = trpc.supplements.getLogs.useQuery(
    undefined,
    { staleTime: 60_000, refetchOnWindowFocus: false }
  );
  const { data: habitsForDate } = trpc.habits.getForDate.useQuery(
    undefined,
    { staleTime: 60_000, refetchOnWindowFocus: false }
  );
  const { data: whoopSummary } = trpc.whoop.getSummary.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: conversations } = trpc.conversations.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: readingSummary } = trpc.solarReadings.summary.useQuery(undefined, {
    staleTime: 120_000,
    refetchOnWindowFocus: false,
  });

  const badges = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const tasksDueToday = (todoistTasks ?? []).filter(
      (t) => t.due?.date && t.due.date <= today
    ).length;
    const eventsToday = (calendarEvents ?? []).length;
    const readingCount = readingSummary?.totalReadings ?? 0;
    const noteCount = (notes ?? []).length;
    const supplementCount = (supplementLogs ?? []).length;
    const habitsTotal = (habitsForDate ?? []).length;
    const habitsDone = (habitsForDate ?? []).filter((h) => h.completed).length;
    const recovery =
      typeof whoopSummary?.recoveryScore === "number"
        ? Math.round(whoopSummary.recoveryScore)
        : null;
    const chatCount = (conversations ?? []).length;
    return {
      tasks: tasksDueToday > 0 ? tasksDueToday : null,
      events: eventsToday > 0 ? eventsToday : null,
      notes: noteCount > 0 ? noteCount : null,
      supplements: supplementCount > 0 ? supplementCount : null,
      // Habits render as "done/total" — `0/13` reads as a progress bar
      // even when nothing's checked yet, matching the wireframe.
      habits: habitsTotal > 0 ? `${habitsDone}/${habitsTotal}` : null,
      health: recovery,
      chat: chatCount > 0 ? chatCount : null,
      sunpowerReadings: readingCount > 0 ? readingCount : null,
    } as Record<string, number | string | null>;
  }, [
    todoistTasks,
    calendarEvents,
    readingSummary,
    notes,
    supplementLogs,
    habitsForDate,
    whoopSummary,
    conversations,
  ]);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    () => {
      const stored = getStoredSections();
      const defaults: Record<string, boolean> = {};
      const defaultClosed = new Set<string>(["Portfolio"]);
      for (const section of NAV_SECTIONS) {
        defaults[section.title] =
          stored[section.title] !== undefined
            ? stored[section.title]
            : !defaultClosed.has(section.title);
      }
      return defaults;
    }
  );

  useEffect(() => {
    storeSections(openSections);
  }, [openSections]);

  const toggleSection = (title: string) => {
    setOpenSections((prev) => ({ ...prev, [title]: !prev[title] }));
  };

  const isActive = (href: string) => {
    // Hash links (e.g. /dashboard#section-health) are jump links — never highlight as active page
    if (href.includes("#")) return false;
    return location === href;
  };

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="px-4 py-3">
        <a
          href="/dashboard"
          className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center"
        >
          <img
            src={APP_LOGO}
            alt="Coherence logo"
            className="size-7 rounded-full object-cover bg-black ring-1 ring-[#E8432A]/60"
          />
          <span className="text-sm font-bold tracking-wide uppercase group-data-[collapsible=icon]:hidden" style={{ fontFamily: '"Permanent Marker", cursive' }}>
            Coherence
          </span>
        </a>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent>
        {NAV_SECTIONS.map((section) => (
          <Collapsible
            key={section.title}
            open={openSections[section.title]}
            onOpenChange={() => toggleSection(section.title)}
          >
            <SidebarGroup>
              <CollapsibleTrigger asChild>
                <SidebarGroupLabel className="cursor-pointer select-none justify-between uppercase tracking-widest text-[10px] font-bold">
                  {section.title}
                  <ChevronDown
                    className={cn(
                      "size-3.5 transition-transform duration-200",
                      openSections[section.title] ? "" : "-rotate-90"
                    )}
                  />
                </SidebarGroupLabel>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {section.items.map((item) => {
                      const active = isActive(item.href);
                      const isHashLink = item.href.includes("#");
                      return (
                        <SidebarMenuItem key={item.label}>
                          <SidebarMenuButton
                            asChild
                            isActive={active}
                            tooltip={item.label}
                            className={cn(
                              "relative",
                              active &&
                                "before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[3px] before:rounded-full before:bg-primary"
                            )}
                          >
                            <a
                              href={item.href}
                              onClick={isHashLink ? (e) => {
                                const [path, hash] = item.href.split("#");
                                if (location === path) {
                                  e.preventDefault();
                                  document.getElementById(hash)?.scrollIntoView({ behavior: "smooth" });
                                }
                              } : undefined}
                            >
                              <item.icon className="size-4" />
                              <span>{item.label}</span>
                            </a>
                          </SidebarMenuButton>
                          {item.badgeKey && badges[item.badgeKey] != null && (
                            <SidebarMenuBadge className="text-xs font-medium">
                              {badges[item.badgeKey]}
                            </SidebarMenuBadge>
                          )}
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
        ))}
      </SidebarContent>

      <SidebarFooter className="group-data-[collapsible=icon]:px-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={isActive("/settings")}
              tooltip="Settings"
            >
              <a href="/settings">
                <Settings className="size-4" />
                <span>Settings</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Shortcuts">
              <button
                type="button"
                onClick={() =>
                  document.dispatchEvent(
                    new KeyboardEvent("keydown", {
                      key: "?",
                      bubbles: true,
                    })
                  )
                }
                className="text-muted-foreground"
              >
                <kbd className="flex size-4 items-center justify-center rounded border bg-muted text-xs font-mono">?</kbd>
                <span>Shortcuts</span>
              </button>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
