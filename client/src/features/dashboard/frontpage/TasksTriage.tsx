/**
 * TasksTriage — replaces the original UP NEXT newsprint column.
 *
 * Splits the day's todoist load into priority bands (matching the
 * D1 wireframe):
 *
 *   OVERDUE — tasks past their due date (red band)
 *   TODAY   — tasks due today, not overdue (ink band)
 *
 * Each row exposes a hover-reveal "done" action that hits
 * trpc.todoist.completeTask and invalidates the relevant queries so
 * the row falls off the list.
 *
 * Spec: handoff CLAUDE_CODE_PROMPT §"Phase F4" + wireframe §triage.
 */
import { useMemo, useState } from "react";
import { Pin } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import type { TodoistTask } from "../types";
import {
  dueLabel,
  priorityClass,
  priorityLabel,
  projectLabel,
  splitTriageBands,
} from "./triage.helpers";
import { SignalActions } from "./SignalActions";
// Workspace linked-note badge for source-backed Todoist task rows.
import { LinkedNotesBadge } from "./LinkedNotesBadge";
import type { WorkspaceNoteRow } from "./useWorkspaceNotes";

interface TasksTriageProps {
  tasks: {
    dueToday: TodoistTask[];
    completedCount: number;
  };
}

interface BandProps {
  variant: "overdue" | "today";
  label: string;
  rightLabel?: string;
  items: TodoistTask[];
  onComplete: (taskId: string) => void;
  busyTaskId: string | null;
  /** Per-row note count, threaded down from the parent so we make
   *  one batched count query for the whole feed rather than N
   *  separate listForExternal calls. */
  noteCountsByTaskId: Record<string, number>;
  noteCountsLoading: boolean;
  onPin: (task: TodoistTask) => void;
  pinningTaskId: string | null;
}

function Band({
  variant,
  label,
  rightLabel,
  items,
  onComplete,
  busyTaskId,
  noteCountsByTaskId,
  noteCountsLoading,
  onPin,
  pinningTaskId,
}: BandProps) {
  if (items.length === 0) return null;
  return (
    <div className="fp-triage-band-group">
      <div className={`fp-triage-band fp-triage-band--${variant}`}>
        <span>{label}</span>
        {rightLabel && (
          <span className="fp-triage-band__right">{rightLabel}</span>
        )}
      </div>
      <ol className="fp-triage-list">
        {items.map(task => {
          const due = dueLabel(task);
          const project = projectLabel(task);
          const isBusy = busyTaskId === task.id;
          const workspaceRow: WorkspaceNoteRow = {
            kind: "todoist",
            taskId: task.id,
            content: task.content,
            taskUrl: `https://todoist.com/showTask?id=${encodeURIComponent(task.id)}`,
            dueDate:
              task.due?.string ?? task.due?.datetime ?? task.due?.date ?? null,
            projectName: project,
          };
          return (
            <li
              key={task.id}
              className={`fp-triage-row${isBusy ? " fp-triage-row--busy" : ""}`}
            >
              <button
                type="button"
                aria-label={`Mark "${task.content}" complete`}
                className={`fp-triage-row__bx ${priorityClass(task)}`}
                onClick={() => onComplete(task.id)}
                disabled={isBusy}
              />
              <div className="fp-triage-row__body">
                <div className="fp-triage-row__title">{task.content}</div>
                {(project || due || variant === "overdue") && (
                  <div className="fp-triage-row__meta mono-label">
                    {project && (
                      <span className="fp-triage-row__meta-proj">
                        @{project}
                      </span>
                    )}
                    {due && (
                      <span className="fp-triage-row__meta-due">{due}</span>
                    )}
                    {variant === "overdue" && (
                      <span className="fp-triage-row__meta-od">overdue</span>
                    )}
                  </div>
                )}
              </div>
              <span
                className={`fp-triage-row__pri fp-triage-row__pri--${priorityLabel(task).toLowerCase()}`}
              >
                {priorityLabel(task)}
              </span>
              {/* Linked-note badge — only renders
                  when the count is > 0, so most rows are unaffected. */}
              <LinkedNotesBadge
                linkType="todoist_task"
                externalId={task.id}
                count={noteCountsByTaskId[task.id] ?? 0}
                countLoading={noteCountsLoading}
                className="fp-triage-row__notes inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              />
              <button
                type="button"
                aria-label={`Pin "${task.content}" to dock`}
                title="Pin to dock"
                className="fp-triage-row__pin inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
                onClick={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  onPin(task);
                }}
                disabled={pinningTaskId === task.id}
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
              {/* Cross-cutting actions. The bx button keeps
                  "Mark complete" because it's the most-used action
                  and the menu would otherwise add a click. */}
              <SignalActions
                row={workspaceRow}
                triggerClassName="fp-triage-row__menu"
                ariaLabel={`Actions for: ${task.content}`}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function TasksTriage({ tasks }: TasksTriageProps) {
  const utils = trpc.useUtils();
  const completeMut = trpc.todoist.completeTask.useMutation({
    onSuccess: () => {
      void utils.todoist.getTasks.invalidate();
      void utils.todoist.getCompletedCount.invalidate();
    },
  });

  const [pinningTaskId, setPinningTaskId] = useState<string | null>(null);
  const dockAdd = trpc.dock.add.useMutation({
    onSuccess: () => {
      void utils.dock.list.invalidate();
      toast.success("Dropped to dock");
    },
    onError: err => toast.error(err.message),
    onSettled: () => setPinningTaskId(null),
  });

  const handlePin = (task: TodoistTask) => {
    setPinningTaskId(task.id);
    dockAdd.mutate({
      source: "todoist",
      url: `https://todoist.com/showTask?id=${encodeURIComponent(task.id)}`,
      title: task.content,
    });
  };

  const { overdue, today } = useMemo(
    () => splitTriageBands(tasks.dueToday),
    [tasks.dueToday]
  );

  // Batched note-count query so the linked-note badge gets its
  // count without N separate listForExternal calls. The dashboard
  // typically has 5-15 tasks; one round-trip handles all of them.
  const taskIds = useMemo(
    () => tasks.dueToday.map(t => t.id),
    [tasks.dueToday]
  );
  const noteCountsQuery = trpc.notes.countLinksByExternalIds.useQuery(
    { linkType: "todoist_task" as const, externalIds: taskIds },
    {
      enabled: taskIds.length > 0,
      staleTime: 60_000,
    }
  );
  const noteCountsByTaskId = noteCountsQuery.data?.counts ?? {};
  const noteCountsLoading = taskIds.length > 0 && noteCountsQuery.isLoading;

  const open = tasks.dueToday.length;
  const done = tasks.completedCount;

  if (open === 0 && done === 0) {
    return (
      <section className="fp-col">
        <header className="fp-col__head">
          <h2 className="fp-col__title">UP NEXT</h2>
        </header>
        <p className="fp-empty">inbox zero for today.</p>
      </section>
    );
  }

  const busyId = completeMut.isPending
    ? (completeMut.variables?.taskId ?? null)
    : null;

  return (
    <section className="fp-col fp-triage">
      <header className="fp-col__head">
        <h2 className="fp-col__title">UP NEXT</h2>
        <span className="mono-label">
          {done} DONE · {open} DUE
          {overdue.length > 0 && (
            <>
              {" · "}
              <strong className="fp-triage-overdue-count">
                {overdue.length} OVERDUE
              </strong>
            </>
          )}
        </span>
      </header>

      {open === 0 ? (
        <p className="fp-empty">all clear — {done} done today.</p>
      ) : (
        <div className="fp-triage-bands">
          <Band
            variant="overdue"
            label="OVERDUE"
            rightLabel={`${overdue.length} late`}
            items={overdue}
            onComplete={taskId => completeMut.mutate({ taskId })}
            busyTaskId={busyId}
            noteCountsByTaskId={noteCountsByTaskId}
            noteCountsLoading={noteCountsLoading}
            onPin={handlePin}
            pinningTaskId={pinningTaskId}
          />
          <Band
            variant="today"
            label="TODAY"
            rightLabel={`${today.length} due`}
            items={today}
            onComplete={taskId => completeMut.mutate({ taskId })}
            busyTaskId={busyId}
            noteCountsByTaskId={noteCountsByTaskId}
            noteCountsLoading={noteCountsLoading}
            onPin={handlePin}
            pinningTaskId={pinningTaskId}
          />
        </div>
      )}
    </section>
  );
}

export default TasksTriage;
