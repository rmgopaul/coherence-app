import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  CheckSquare,
  Calendar,
  StickyNote,
  MessageSquare,
  HeartPulse,
  Clock,
  FolderOpen,
  Settings,
  Plus,
  FileText,
  Sun,
  Moon,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";

type CommandRoute = {
  label: string;
  href: string;
  icon: LucideIcon;
  keywords?: string[];
};

const NAV_COMMANDS: CommandRoute[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, keywords: ["home", "overview"] },
  { label: "Tasks (Todoist)", href: "/widget/todoist", icon: CheckSquare, keywords: ["todo", "tasks"] },
  { label: "Calendar", href: "/widget/google-calendar", icon: Calendar, keywords: ["schedule", "events"] },
  { label: "Notes", href: "/notes", icon: StickyNote, keywords: ["notebook", "write"] },
  { label: "Chat (ChatGPT)", href: "/widget/chatgpt", icon: MessageSquare, keywords: ["ai", "gpt"] },
  { label: "Health Log", href: "/dashboard#health", icon: HeartPulse, keywords: ["wellness", "health"] },
  { label: "Clockify", href: "/widget/clockify", icon: Clock, keywords: ["time", "tracker"] },
  { label: "Gmail", href: "/widget/gmail", icon: FolderOpen, keywords: ["email", "mail"] },
  { label: "Settings", href: "/settings", icon: Settings },
  { label: "Solar REC Dashboard", href: "/solar-rec-dashboard", icon: LayoutDashboard, keywords: ["solar", "rec"] },
  { label: "Invoice Match", href: "/invoice-match-dashboard", icon: FileText, keywords: ["invoice"] },
  { label: "Deep Update Synthesizer", href: "/deep-update-synthesizer", icon: FileText, keywords: ["deep", "update"] },
  { label: "Contract Scanner", href: "/contract-scanner", icon: FileText, keywords: ["contract"] },
  { label: "Enphase v4", href: "/enphase-v4-meter-reads", icon: FileText, keywords: ["enphase", "meter"] },
  { label: "SolarEdge", href: "/solaredge-meter-reads", icon: FileText, keywords: ["solaredge", "meter"] },
  { label: "Tesla Solar", href: "/tesla-solar-api", icon: FileText, keywords: ["tesla", "solar"] },
  { label: "Tesla Powerhub", href: "/tesla-powerhub-api", icon: FileText, keywords: ["tesla", "powerhub"] },
  { label: "Zendesk", href: "/zendesk-ticket-metrics", icon: FileText, keywords: ["zendesk", "tickets"] },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const navigate = (href: string) => {
    setOpen(false);
    setLocation(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen} showCloseButton={false}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigation">
          {NAV_COMMANDS.map((cmd) => (
            <CommandItem
              key={cmd.href}
              value={[cmd.label, ...(cmd.keywords ?? [])].join(" ")}
              onSelect={() => navigate(cmd.href)}
            >
              <cmd.icon className="mr-2 size-4" />
              <span>{cmd.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Quick Actions">
          <CommandItem
            value="create task new todo"
            onSelect={() => navigate("/widget/todoist")}
          >
            <Plus className="mr-2 size-4" />
            <span>Create Task</span>
          </CommandItem>
          <CommandItem
            value="new note create note"
            onSelect={() => navigate("/notes")}
          >
            <FileText className="mr-2 size-4" />
            <span>New Note</span>
          </CommandItem>
          <CommandItem
            value="toggle theme dark light mode"
            onSelect={() => {
              toggleTheme?.();
              setOpen(false);
            }}
          >
            {theme === "dark" ? (
              <Sun className="mr-2 size-4" />
            ) : (
              <Moon className="mr-2 size-4" />
            )}
            <span>Toggle Theme ({theme === "dark" ? "Light" : "Dark"})</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
