import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/ThemeContext";
import { useLocation } from "wouter";
import { useMemo, type ReactNode } from "react";
import { Search, Moon, Sun } from "lucide-react";
import { ScrollToTop } from "./ScrollToTop";
import { OnlineIndicator } from "./OnlineIndicator";

interface AppShellProps {
  children: ReactNode;
}

const ROUTE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/dashboard/one-thing": "One Thing",
  "/dashboard/river": "River",
  "/dashboard/canvas": "Canvas",
  "/dashboard/command": "Command Deck",
  "/widget/todoist": "Tasks",
  "/widget/google-calendar": "Calendar",
  "/notes": "Notes",
  "/widget/chatgpt": "Chat",
  "/widget/clockify": "Clockify",
  "/widget/gmail": "Gmail",
  "/settings": "Settings",
  "/solar-rec-dashboard": "Solar REC",
  "/invoice-match-dashboard": "Invoice Match",
  "/deep-update-synthesizer": "Deep Update",
  "/contract-scanner": "Contract Scanner",
  "/contract-scrape-manager": "Contract Scraper",
  "/din-scrape-manager": "DIN Scraper",
  "/zendesk-ticket-metrics": "Zendesk",
};

export function AppShell({ children }: AppShellProps) {
  const [location] = useLocation();
  const { theme, toggleTheme, switchable } = useTheme();
  const pageTitle = useMemo(
    () => ROUTE_TITLES[location] ?? "",
    [location]
  );

  return (
    <SidebarProvider>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-3 focus:bg-primary focus:text-primary-foreground focus:rounded-md focus:m-2">
        Skip to main content
      </a>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          {pageTitle && (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
              <span className="text-sm font-bold tracking-wide uppercase text-foreground">
                {pageTitle}
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <OnlineIndicator />
            {switchable && toggleTheme && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={toggleTheme}
                aria-label="Toggle theme"
              >
                {theme === "dark" ? (
                  <Sun className="size-4" />
                ) : (
                  <Moon className="size-4" />
                )}
              </Button>
            )}
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: "k",
                    metaKey: true,
                    bubbles: true,
                  })
                )
              }
              className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              <Search className="size-3" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="pointer-events-none hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium sm:inline">
                ⌘K
              </kbd>
            </button>
          </div>
        </header>
        <div id="main-content" key={location} data-scroll-container className="flex-1 overflow-auto animate-in fade-in duration-200">{children}</div>
        <ScrollToTop />
      </SidebarInset>
      <CommandPalette />
      <KeyboardShortcuts />
    </SidebarProvider>
  );
}
