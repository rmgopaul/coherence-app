/**
 * PinDialog — manual override for the hero's headline.
 *
 * Triggered from the hero via the `k` keyboard shortcut or a
 * right-click on the headline. Three tabs:
 *
 *   1. Pick from tasks     — today + overdue Todoist tasks
 *   2. Pick from calendar  — today's Google Calendar events
 *   3. Write your own      — free-form title + reason
 *
 * Submitting calls `trpc.kingOfDay.pin` and invalidates the
 * `kingOfDay.get` query so the hero re-renders with the new pick
 * and the PINNED badge appears.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import type { CalendarEvent, TodoistTask } from "../types";

interface PinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todayKey: string;
  tasks: TodoistTask[];
  calendar: CalendarEvent[];
}

type Tab = "tasks" | "calendar" | "custom";

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function eventStartLabel(event: CalendarEvent): string {
  const iso = event.start?.dateTime ?? event.start?.date ?? null;
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toUpperCase();
}

export function PinDialog({
  open,
  onOpenChange,
  todayKey,
  tasks,
  calendar,
}: PinDialogProps) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [customTitle, setCustomTitle] = useState("");
  const [customReason, setCustomReason] = useState("");

  // Reset the custom fields when the dialog re-opens so yesterday's
  // draft doesn't leak into today.
  useEffect(() => {
    if (!open) return;
    setCustomTitle("");
    setCustomReason("");
    setTab("tasks");
  }, [open]);

  const utils = trpc.useUtils();
  const pinMutation = trpc.kingOfDay.pin.useMutation({
    onSuccess: () => {
      utils.kingOfDay.get.invalidate();
      onOpenChange(false);
    },
  });

  const sortedTasks = useMemo(() => {
    // Overdue first (lower "priority value" in Todoist = higher),
    // then today's P1s, then the rest. Keep max 15 so the list stays
    // scannable.
    return [...tasks]
      .sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1))
      .slice(0, 15);
  }, [tasks]);

  const upcomingEvents = useMemo(() => {
    const now = Date.now();
    return calendar
      .filter((e) => {
        const iso = e.start?.dateTime ?? e.start?.date ?? null;
        if (!iso) return false;
        const t = new Date(iso).getTime();
        return !Number.isNaN(t) && t >= now - 30 * 60_000;
      })
      .slice(0, 10);
  }, [calendar]);

  const handlePinTask = (task: TodoistTask) => {
    pinMutation.mutate({
      dateKey: todayKey,
      title: truncate(task.content, 200),
      reason: "pinned from tasks",
      taskId: task.id,
    });
  };

  const handlePinEvent = (event: CalendarEvent) => {
    pinMutation.mutate({
      dateKey: todayKey,
      title: truncate(`Prep ${event.summary ?? "untitled"}`, 200),
      reason: `first event · ${eventStartLabel(event)}`,
      eventId: event.id ?? undefined,
    });
  };

  const handlePinCustom = () => {
    const title = customTitle.trim();
    if (!title) return;
    pinMutation.mutate({
      dateKey: todayKey,
      title: truncate(title, 200),
      reason: customReason.trim().slice(0, 500) || undefined,
    });
  };

  const isPending = pinMutation.status === "pending";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-[Archivo_Black] text-2xl tracking-tight">
            PIN TODAY'S HEADLINE
          </DialogTitle>
          <DialogDescription>
            Override the auto-picker with a specific task, event, or
            something you write yourself. Unpin from the hero to go
            back to the auto-pick.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="w-full">
            <TabsTrigger value="tasks">Tasks</TabsTrigger>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
            <TabsTrigger value="custom">Write your own</TabsTrigger>
          </TabsList>

          <TabsContent value="tasks" className="mt-4 max-h-80 overflow-y-auto">
            {sortedTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No tasks to pin from.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {sortedTasks.map((task) => (
                  <li key={task.id} className="py-2">
                    <button
                      type="button"
                      onClick={() => handlePinTask(task)}
                      disabled={isPending}
                      className="w-full text-left hover:bg-muted/50 focus-visible:bg-muted/50 outline-none rounded px-2 py-1.5 flex items-start gap-3"
                    >
                      <span className="text-[10.5px] font-mono uppercase tracking-wider text-muted-foreground pt-0.5 min-w-[2.5rem]">
                        P{5 - (task.priority ?? 1)}
                      </span>
                      <span className="flex-1 text-sm">
                        {task.content}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent
            value="calendar"
            className="mt-4 max-h-80 overflow-y-auto"
          >
            {upcomingEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No upcoming events today.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {upcomingEvents.map((event) => (
                  <li key={event.id ?? event.summary} className="py-2">
                    <button
                      type="button"
                      onClick={() => handlePinEvent(event)}
                      disabled={isPending}
                      className="w-full text-left hover:bg-muted/50 focus-visible:bg-muted/50 outline-none rounded px-2 py-1.5 flex items-start gap-3"
                    >
                      <span className="text-[10.5px] font-mono uppercase tracking-wider text-muted-foreground pt-0.5 min-w-[4rem]">
                        {eventStartLabel(event)}
                      </span>
                      <span className="flex-1 text-sm">
                        {event.summary ?? "(untitled)"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="custom" className="mt-4 space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                Headline
              </label>
              <Input
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="Ship the ABP settlement fix"
                maxLength={200}
                autoFocus={tab === "custom"}
              />
              <p className="text-[10px] text-muted-foreground">
                {customTitle.length}/200
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                Why it matters
              </label>
              <Textarea
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Two payers waiting · blocks 42 invoices"
                maxLength={500}
                rows={2}
              />
              <p className="text-[10px] text-muted-foreground">
                {customReason.length}/500
              </p>
            </div>
          </TabsContent>
        </Tabs>

        {tab === "custom" && (
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handlePinCustom}
              disabled={isPending || customTitle.trim().length === 0}
            >
              {isPending ? "Pinning…" : "Pin"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
