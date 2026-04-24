import { useLocation } from "wouter";
import {
  LayoutDashboard,
  Activity,
  Zap,
  Settings,
  LogOut,
  Users,
  ChevronDown,
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
import { useState } from "react";
import type { SolarRecUser } from "../hooks/useSolarRecAuth";

type NavItem = { label: string; href: string; icon: LucideIcon };

const METER_READ_ITEMS: NavItem[] = [
  { label: "SolarEdge", href: "/solar-rec/meter-reads/solaredge", icon: Zap },
  { label: "Enphase V4", href: "/solar-rec/meter-reads/enphase-v4", icon: Zap },
  { label: "APsystems", href: "/solar-rec/meter-reads/apsystems", icon: Zap },
  { label: "Hoymiles", href: "/solar-rec/meter-reads/hoymiles", icon: Zap },
  { label: "Fronius", href: "/solar-rec/meter-reads/fronius", icon: Zap },
  { label: "Generac", href: "/solar-rec/meter-reads/generac", icon: Zap },
  { label: "GoodWe", href: "/solar-rec/meter-reads/goodwe", icon: Zap },
  { label: "Solis", href: "/solar-rec/meter-reads/solis", icon: Zap },
  { label: "Locus", href: "/solar-rec/meter-reads/locus", icon: Zap },
  { label: "Growatt", href: "/solar-rec/meter-reads/growatt", icon: Zap },
  { label: "SolarLog", href: "/solar-rec/meter-reads/solarlog", icon: Zap },
  { label: "EKM", href: "/solar-rec/meter-reads/ekm", icon: Zap },
  { label: "EnnexOS", href: "/solar-rec/meter-reads/ennexos", icon: Zap },
  { label: "eGauge", href: "/solar-rec/meter-reads/egauge", icon: Zap },
  { label: "SunPower", href: "/solar-rec/meter-reads/sunpower", icon: Zap },
  { label: "Tesla Powerhub", href: "/solar-rec/meter-reads/tesla-powerhub", icon: Zap },
];

export default function SolarRecSidebar({
  user,
  onLogout,
}: {
  user: SolarRecUser | null;
  onLogout: () => void;
}) {
  const [location, setLocation] = useLocation();
  const [meterReadsOpen, setMeterReadsOpen] = useState(
    location.startsWith("/solar-rec/meter-reads")
  );

  const isAdmin = user?.role === "owner" || user?.role === "admin";

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m6.34 17.66-1.41 1.41" />
            <path d="m19.07 4.93-1.41 1.41" />
          </svg>
          <span className="text-sm font-semibold">Solar REC</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* Main nav */}
        <SidebarGroup>
          <SidebarGroupLabel>Main</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setLocation("/solar-rec/dashboard")}
                  isActive={location === "/solar-rec/dashboard" || location === "/solar-rec/" || location === "/solar-rec"}
                >
                  <LayoutDashboard className="h-4 w-4" />
                  <span>Dashboard</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setLocation("/solar-rec/monitoring")}
                  isActive={location === "/solar-rec/monitoring"}
                >
                  <Activity className="h-4 w-4" />
                  <span>Monitoring</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setLocation("/solar-rec/monitoring-overview")}
                  isActive={location === "/solar-rec/monitoring-overview"}
                >
                  <Activity className="h-4 w-4" />
                  <span>Monitoring Overview</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        {/* Meter Reads (collapsible) */}
        <Collapsible open={meterReadsOpen} onOpenChange={setMeterReadsOpen}>
          <SidebarGroup>
            <CollapsibleTrigger asChild>
              <SidebarGroupLabel className="cursor-pointer flex items-center justify-between">
                <span>Meter Reads</span>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    meterReadsOpen && "rotate-180"
                  )}
                />
              </SidebarGroupLabel>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {METER_READ_ITEMS.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        onClick={() => setLocation(item.href)}
                        isActive={location === item.href}
                        className="text-xs"
                      >
                        <item.icon className="h-3.5 w-3.5" />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>

        <SidebarSeparator />

        {/* Admin */}
        {isAdmin && (
          <SidebarGroup>
            <SidebarGroupLabel>Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => setLocation("/solar-rec/settings")}
                    isActive={location === "/solar-rec/settings"}
                  >
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                className="h-6 w-6 rounded-full shrink-0"
              />
            ) : (
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">
                {user?.name ?? user?.email ?? "Unknown"}
              </p>
              <p className="text-[10px] text-muted-foreground capitalize">
                {user?.role}
              </p>
            </div>
          </div>
          <button
            onClick={onLogout}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
