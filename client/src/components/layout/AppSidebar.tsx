import { useLocation } from "wouter";
import {
  LayoutDashboard,
  CheckSquare,
  Calendar,
  StickyNote,
  MessageSquare,
  HeartPulse,
  Repeat,
  Pill,
  Clock,
  FolderOpen,
  ChevronDown,
  BarChart3,
  FileText,
  FileSpreadsheet,
  Database,
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
import { useState, useEffect } from "react";
import { APP_TITLE } from "@/const";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
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
      { label: "Tasks", href: "/widget/todoist", icon: CheckSquare },
      { label: "Calendar", href: "/widget/google-calendar", icon: Calendar },
      { label: "Notes", href: "/notes", icon: StickyNote },
      { label: "Chat", href: "/widget/chatgpt", icon: MessageSquare },
    ],
  },
  {
    title: "Health",
    items: [
      { label: "Daily Log", href: "/dashboard#health", icon: HeartPulse },
      { label: "Habits", href: "/dashboard#habits", icon: Repeat },
      { label: "Supplements", href: "/dashboard#supplements", icon: Pill },
    ],
  },
  {
    title: "Work",
    items: [
      { label: "Clockify", href: "/widget/clockify", icon: Clock },
      { label: "Drive", href: "/widget/gmail", icon: FolderOpen },
    ],
  },
  {
    title: "Portfolio",
    items: [
      { label: "Solar REC", href: "/solar-rec-dashboard", icon: BarChart3 },
      { label: "Invoice Match", href: "/invoice-match-dashboard", icon: FileSpreadsheet },
      { label: "Deep Update", href: "/deep-update-synthesizer", icon: FileText },
      { label: "Contract Scanner", href: "/contract-scanner", icon: FileText },
      { label: "Enphase v4", href: "/enphase-v4-meter-reads", icon: Database },
      { label: "SolarEdge", href: "/solaredge-meter-reads", icon: Database },
      { label: "Tesla Solar", href: "/tesla-solar-api", icon: Database },
      { label: "Tesla Powerhub", href: "/tesla-powerhub-api", icon: Database },
      { label: "Zendesk", href: "/zendesk-ticket-metrics", icon: Database },
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
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    () => {
      const stored = getStoredSections();
      const defaults: Record<string, boolean> = {};
      const defaultClosed = new Set(["Portfolio"]);
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
    if (href.includes("#")) {
      return location === href.split("#")[0];
    }
    return location === href;
  };

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="px-4 py-3">
        <a
          href="/dashboard"
          className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center"
        >
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
            C
          </div>
          <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            {APP_TITLE}
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
                <SidebarGroupLabel className="cursor-pointer select-none justify-between uppercase tracking-wider text-[0.65rem]">
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
                      return (
                        <SidebarMenuItem key={item.href}>
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
                            <a href={item.href}>
                              <item.icon className="size-4" />
                              <span>{item.label}</span>
                            </a>
                          </SidebarMenuButton>
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
            <SidebarMenuButton asChild tooltip="Settings">
              <a href="/settings" className="text-muted-foreground">
                <span className="text-xs">Settings</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
