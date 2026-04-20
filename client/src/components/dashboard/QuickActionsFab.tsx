import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Plus,
  X,
  CheckSquare,
  StickyNote,
  Pill,
  Clock,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";

interface QuickAction {
  label: string;
  icon: LucideIcon;
  action: () => void;
  color: string;
}

interface QuickActionsFabProps {
  onAddTask?: () => void;
  onNewNote?: () => void;
  onLogSupplement?: () => void;
  onStartTimer?: () => void;
}

export function QuickActionsFab({
  onAddTask,
  onNewNote,
  onLogSupplement,
  onStartTimer,
}: QuickActionsFabProps) {
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const actions: QuickAction[] = [
    {
      label: "Add Task",
      icon: CheckSquare,
      action: () => {
        if (onAddTask) {
          onAddTask();
        } else {
          setLocation("/widget/todoist");
        }
        setOpen(false);
      },
      color: "bg-red-500 hover:bg-red-600 text-white",
    },
    {
      label: "New Note",
      icon: StickyNote,
      action: () => {
        if (onNewNote) {
          onNewNote();
        } else {
          setLocation("/notes");
        }
        setOpen(false);
      },
      color: "bg-emerald-500 hover:bg-emerald-600 text-white",
    },
    {
      label: "Log Supplement",
      icon: Pill,
      action: () => {
        if (onLogSupplement) {
          onLogSupplement();
        } else {
          window.location.href = "/supplements";
        }
        setOpen(false);
      },
      color: "bg-amber-500 hover:bg-amber-600 text-white",
    },
    {
      label: "Focus Timer",
      icon: Clock,
      action: () => {
        onStartTimer?.();
        setOpen(false);
      },
      color: "bg-blue-500 hover:bg-blue-600 text-white",
    },
    {
      label: "Chat",
      icon: MessageSquare,
      action: () => {
        setLocation("/widget/chatgpt");
        setOpen(false);
      },
      color: "bg-purple-500 hover:bg-purple-600 text-white",
    },
  ];

  return (
    <div ref={containerRef} className="fixed bottom-6 right-6 z-50 flex flex-col-reverse items-end gap-3">
      {/* Main FAB button */}
      <Button
        size="lg"
        className={cn(
          "h-14 w-14 rounded-full shadow-lg transition-all duration-200",
          open
            ? "bg-muted text-muted-foreground hover:bg-muted/80 rotate-45"
            : "bg-primary text-primary-foreground hover:bg-primary/90"
        )}
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close quick actions" : "Open quick actions"}
      >
        {open ? <X className="h-6 w-6" /> : <Plus className="h-6 w-6" />}
      </Button>

      {/* Action buttons */}
      {open && (
        <div className="flex flex-col-reverse items-end gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
          {actions.map((action) => (
            <div key={action.label} className="flex items-center gap-3">
              <span className="rounded-md bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-md border">
                {action.label}
              </span>
              <Button
                size="icon"
                className={cn("h-11 w-11 rounded-full shadow-md", action.color)}
                onClick={action.action}
              >
                <action.icon className="h-5 w-5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
