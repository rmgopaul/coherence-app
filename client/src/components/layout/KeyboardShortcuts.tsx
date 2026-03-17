import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTheme } from "@/contexts/ThemeContext";
import { toast } from "sonner";

interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; description: string }[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["G", "D"], description: "Go to Dashboard" },
      { keys: ["G", "T"], description: "Go to Tasks" },
      { keys: ["G", "C"], description: "Go to Calendar" },
      { keys: ["G", "N"], description: "Go to Notes" },
      { keys: ["G", "A"], description: "Go to Chat" },
      { keys: ["G", "S"], description: "Go to Settings" },
    ],
  },
  {
    title: "Actions",
    shortcuts: [
      { keys: ["⌘", "K"], description: "Open command palette" },
      { keys: ["⌘", "B"], description: "Toggle sidebar" },
      { keys: ["⌘", "\\"], description: "Toggle dark mode" },
      { keys: ["?"], description: "Show keyboard shortcuts" },
    ],
  },
];

const NAV_MAP: Record<string, { route: string; label: string }> = {
  d: { route: "/dashboard", label: "Dashboard" },
  t: { route: "/widget/todoist", label: "Tasks" },
  c: { route: "/widget/google-calendar", label: "Calendar" },
  n: { route: "/notes", label: "Notes" },
  a: { route: "/widget/chatgpt", label: "Chat" },
  s: { route: "/settings", label: "Settings" },
};

export function KeyboardShortcuts() {
  const [helpOpen, setHelpOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { toggleTheme } = useTheme();
  const [pendingG, setPendingG] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't fire in inputs/textareas
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      // ? for help
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }

      // ⌘+\ for dark mode
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleTheme?.();
        return;
      }

      // ⌘+B for sidebar toggle
      if (e.key === "b" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const trigger = document.querySelector(
          'button[data-sidebar="trigger"]'
        ) as HTMLButtonElement;
        trigger?.click();
        return;
      }

      // G + key chord navigation
      if (pendingG) {
        setPendingG(false);
        const nav = NAV_MAP[e.key.toLowerCase()];
        if (nav) {
          e.preventDefault();
          setLocation(nav.route);
          toast(`Navigating to ${nav.label}`, { duration: 1500 });
        }
        return;
      }

      if (e.key === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setPendingG(true);
        // Auto-cancel after 1s
        setTimeout(() => setPendingG(false), 1000);
        return;
      }
    },
    [pendingG, setLocation, toggleTheme]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 pt-2">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
              <div className="space-y-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-foreground">
                      {shortcut.description}
                    </span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <span key={i}>
                          {i > 0 && (
                            <span className="mx-0.5 text-muted-foreground text-xs">
                              then
                            </span>
                          )}
                          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium">
                            {key}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
