import { useEffect, useMemo, useState } from "react";
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
  Loader2,
  HardDrive,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { trpc } from "@/lib/trpc";

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
  { label: "Contract Scraper", href: "/contract-scrape-manager", icon: FileText, keywords: ["contract", "scrape", "csg", "portal"] },
  { label: "DIN Scraper", href: "/din-scrape-manager", icon: FileText, keywords: ["din", "inverter", "meter", "photo", "csg", "portal"] },
  { label: "ABP Invoice Settlement", href: "/abp-invoice-settlement", icon: FileText, keywords: ["abp", "settlement", "invoice"] },
  { label: "Early Payment", href: "/early-payment", icon: FileText, keywords: ["early", "payment", "abp", "icc"] },
  { label: "Enphase v4", href: "/enphase-v4-meter-reads", icon: FileText, keywords: ["enphase", "meter"] },
  { label: "SolarEdge", href: "/solaredge-meter-reads", icon: FileText, keywords: ["solaredge", "meter"] },
  { label: "Fronius", href: "/fronius-meter-reads", icon: FileText, keywords: ["fronius", "solar", "meter", "solarweb"] },
  { label: "ennexOS", href: "/ennexos-meter-reads", icon: FileText, keywords: ["ennexos", "sma", "solarweb", "meter"] },
  { label: "eGauge", href: "/egauge-api", icon: FileText, keywords: ["egauge", "meter", "register"] },
  { label: "Tesla Solar", href: "/tesla-solar-api", icon: FileText, keywords: ["tesla", "solar"] },
  { label: "Tesla Powerhub", href: "/tesla-powerhub-api", icon: FileText, keywords: ["tesla", "powerhub"] },
  { label: "Zendesk", href: "/zendesk-ticket-metrics", icon: FileText, keywords: ["zendesk", "tickets"] },
];

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_MIN_LENGTH = 3;

const SEARCH_TYPE_ICON: Record<string, LucideIcon> = {
  note: StickyNote,
  task: CheckSquare,
  calendar_event: Calendar,
  conversation: MessageSquare,
  drive_file: HardDrive,
};

function searchResultHref(item: {
  type: string;
  id: string;
  url: string | null;
}): string {
  if (item.url) return item.url;
  switch (item.type) {
    case "note":
      return `/notes?noteId=${encodeURIComponent(item.id)}`;
    case "task":
      return "/widget/todoist";
    case "calendar_event":
      return "/widget/google-calendar";
    case "conversation":
      return "/widget/chatgpt";
    case "drive_file":
      return "/widget/gmail";
    default:
      return "/dashboard";
  }
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
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

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
    }
  }, [open]);

  const searchEnabled =
    open && debouncedQuery.length >= SEARCH_MIN_LENGTH;
  const searchQuery = trpc.search.global.useQuery(
    { query: debouncedQuery, limit: 20 },
    {
      enabled: searchEnabled,
      staleTime: 15_000,
      retry: false,
    },
  );
  const searchResults = useMemo(
    () => (searchEnabled ? searchQuery.data?.items ?? [] : []),
    [searchEnabled, searchQuery.data],
  );
  const showSearchGroup = searchEnabled;
  const showSearchLoading =
    showSearchGroup &&
    (searchQuery.isPending || searchQuery.isFetching) &&
    searchResults.length === 0;

  const navigate = (href: string) => {
    setOpen(false);
    setLocation(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen} showCloseButton={false}>
      <CommandInput
        placeholder="Type a command or search notes, tasks, calendar…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Commands">
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

        {showSearchGroup ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Search Results">
              {showSearchLoading ? (
                <CommandItem
                  value="__search_loading__"
                  disabled
                  className="text-slate-500"
                >
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  <span>Searching…</span>
                </CommandItem>
              ) : searchResults.length === 0 ? (
                <CommandItem
                  value="__search_empty__"
                  disabled
                  className="text-slate-500"
                >
                  <span>No matches in notes, tasks, calendar, or drive.</span>
                </CommandItem>
              ) : (
                searchResults.map((item) => {
                  const Icon = SEARCH_TYPE_ICON[item.type] ?? FileText;
                  return (
                    <CommandItem
                      key={`${item.type}:${item.id}`}
                      value={`${item.title} ${item.subtitle ?? ""} ${item.type}`}
                      onSelect={() => navigate(searchResultHref(item))}
                    >
                      <Icon className="mr-2 size-4" />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{item.title}</span>
                        {item.subtitle ? (
                          <span className="truncate text-xs text-slate-500">
                            {item.subtitle}
                          </span>
                        ) : null}
                      </div>
                    </CommandItem>
                  );
                })
              )}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
