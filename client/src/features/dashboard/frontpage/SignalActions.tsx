/**
 * Task 10.1 (2026-04-28) — uniform signal-row action menu.
 *
 * `<SignalActions row={...} />` exposes 5 cross-cutting actions
 * for any row in the dashboard's frontpage feeds:
 *
 *   1. Drop to Dock — pin to the DropDock for later
 *   2. Pin as King — set as today's King of the Day
 *   3. Create Todoist Task — convert non-Todoist rows to a task
 *   4. Archive (Gmail) — Gmail-only
 *   5. Defer to tomorrow (Todoist) — Todoist-only
 *
 * Applicability per row kind is encoded in `applicableActions`
 * (`@/lib/signalActions`); the component only renders entries
 * that helper says apply.
 *
 * Each action is a small `useMutation` wrapper. On success it
 * invalidates the relevant queries so the row falls off the
 * source list (e.g. archive removes it from InboxPanel; defer
 * removes it from TasksTriage). Errors surface via `toast`.
 *
 * Trigger: a small ⋯ button. Designed to fit the dense newsprint
 * row aesthetic — no border, ghost on hover, mono label.
 */
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  Button,
} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  applicableActions,
  dockSourceFor,
  rowTitle,
  rowUrl,
  SIGNAL_ACTION_LABELS,
  type SignalActionKey,
  type SignalRow,
} from "@/lib/signalActions";
import { useTodayKey } from "../useTodayKey";

interface SignalActionsProps {
  row: SignalRow;
  /** Optional CSS class for the trigger button — feed cells size
   *  the menu button differently to fit their density. */
  triggerClassName?: string;
  /** ARIA label for the trigger. Defaults to a generic "Actions
   *  for this row"; pass a row-specific label when the parent has
   *  more context (e.g. "Actions for: 401k rebalance"). */
  ariaLabel?: string;
}

export function SignalActions({
  row,
  triggerClassName,
  ariaLabel = "Actions for this row",
}: SignalActionsProps) {
  const utils = trpc.useUtils();
  const todayKey = useTodayKey();

  const dockAdd = trpc.dock.add.useMutation({
    onSuccess: () => {
      void utils.dock.list.invalidate();
      toast.success("Dropped to dock");
    },
    onError: (err) => toast.error(err.message),
  });

  const kingPin = trpc.kingOfDay.pin.useMutation({
    onSuccess: () => {
      void utils.kingOfDay.get.invalidate();
      toast.success("Pinned as King of the Day");
    },
    onError: (err) => toast.error(err.message),
  });

  const todoistCreate = trpc.todoist.createTask.useMutation({
    onSuccess: () => toast.success("Todoist task created"),
    onError: (err) => toast.error(err.message),
  });

  const gmailArchive = trpc.google.archiveGmail.useMutation({
    onSuccess: () => {
      void utils.google.getGmailMessages.invalidate();
      toast.success("Archived");
    },
    onError: (err) => toast.error(err.message),
  });

  const todoistDefer = trpc.todoist.deferTask.useMutation({
    onSuccess: () => {
      void utils.todoist.getTasks.invalidate();
      toast.success("Deferred to tomorrow");
    },
    onError: (err) => toast.error(err.message),
  });

  function dispatch(action: SignalActionKey) {
    const title = rowTitle(row);
    const url = rowUrl(row);
    if (action === "drop-to-dock") {
      dockAdd.mutate({
        source: dockSourceFor(row.kind),
        url,
        title,
      });
      return;
    }
    if (action === "pin-as-king") {
      kingPin.mutate({
        dateKey: todayKey,
        title,
        // taskId / eventId optional — when the row IS the
        // canonical Todoist or Calendar item, pass the ID through
        // so the King chip becomes a deep link (Task 10.4).
        ...(row.kind === "todoist" ? { taskId: row.taskId } : {}),
        ...(row.kind === "calendar" ? { eventId: row.eventId } : {}),
      });
      return;
    }
    if (action === "create-todoist-task") {
      // Markdown-link pattern matches `createTaskFromEmail` so the
      // task chip in Todoist deep-links back to the source.
      const content = `[${title}](${url})`;
      todoistCreate.mutate({ content });
      return;
    }
    if (action === "archive-gmail" && row.kind === "gmail") {
      gmailArchive.mutate({ messageId: row.messageId });
      return;
    }
    if (action === "defer-todoist" && row.kind === "todoist") {
      todoistDefer.mutate({ taskId: row.taskId, dueString: "tomorrow" });
      return;
    }
  }

  const actions = applicableActions(row);
  const anyPending =
    dockAdd.isPending ||
    kingPin.isPending ||
    todoistCreate.isPending ||
    gmailArchive.isPending ||
    todoistDefer.isPending;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={triggerClassName ?? "h-6 w-6 p-0"}
          aria-label={ariaLabel}
          disabled={anyPending}
          onClick={(e) => {
            // Stop the click from bubbling up to a parent <a> /
            // <li onClick> that might navigate elsewhere. Every
            // feed cell wraps its rows in some kind of anchor.
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action}
            onSelect={(e) => {
              e.preventDefault();
              dispatch(action);
            }}
            className="text-xs"
          >
            {SIGNAL_ACTION_LABELS[action]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
