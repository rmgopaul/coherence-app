import { useLocation } from "wouter";
import {
  LayoutDashboard,
  CheckSquare,
  Calendar,
  StickyNote,
  MessageSquare,
  HeartPulse,
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
      { label: "Notes", href: "/notes", icon: StickyNote },
      { label: "Chat", href: "/widget/chatgpt", icon: MessageSquare },
      { label: "Health", href: "/dashboard#section-health", icon: HeartPulse },
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
      { label: "Solar REC", href: "/solar-rec-dashboard", icon: BarChart3 },
      { label: "Invoice Match", href: "/invoice-match-dashboard", icon: FileSpreadsheet },
      { label: "Deep Update", href: "/deep-update-synthesizer", icon: FileText },
      { label: "Contract Scanner", href: "/contract-scanner", icon: FileSearch },
      { label: "ABP Settlement", href: "/abp-invoice-settlement", icon: FileSpreadsheet },
      { label: "Enphase v4", href: "/enphase-v4-meter-reads", icon: Zap },
      { label: "SolarEdge", href: "/solaredge-meter-reads", icon: Sun },
      { label: "Fronius", href: "/fronius-meter-reads", icon: Sun },
      { label: "ennexOS", href: "/ennexos-meter-reads", icon: Sun },
      { label: "Tesla Solar", href: "/tesla-solar-api", icon: Sun },
      { label: "Tesla Powerhub", href: "/tesla-powerhub-api", icon: Battery },
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

  // Badge counts
  const { data: todoistTasks } = trpc.todoist.getTasks.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: calendarEvents } = trpc.google.getCalendarEvents.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const badges = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const tasksDueToday = (todoistTasks ?? []).filter(
      (t: any) => t.due?.date && t.due.date <= today
    ).length;
    const eventsToday = (calendarEvents ?? []).length;
    return {
      tasks: tasksDueToday > 0 ? tasksDueToday : null,
      events: eventsToday > 0 ? eventsToday : null,
    } as Record<string, number | null>;
  }, [todoistTasks, calendarEvents]);

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
            className="size-7 rounded-md object-cover shadow-sm ring-1 ring-[#00a95c]/55"
          />
          <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
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
                <SidebarGroupLabel className="cursor-pointer select-none justify-between uppercase tracking-wider text-xs">
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
