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
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import type { TodoistTask } from "../types";
import { isTaskOverdue, taskPriorityOrder } from "./newsprint.helpers";

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
}

function priorityLabel(t: TodoistTask): string {
  // Todoist priority: 4 = P1 (highest) … 1 = P4
  const p = t.priority ?? 1;
  return `P${5 - p}`;
}

function priorityClass(t: TodoistTask): string {
  // Two band-internal markers we use to color the priority dot —
  // P1 is filled red, P2 is striped, P3+ is plain.
  const p = t.priority ?? 1;
  if (p === 4) return "fp-triage-row__bx--p1";
  if (p === 3) return "fp-triage-row__bx--p2";
  return "fp-triage-row__bx--p3";
}

function projectLabel(t: TodoistTask): string | null {
  // Todoist tasks may carry a `projectName` (when the server enriches)
  // or a `projectId` (raw). Render the name when we have it, else null.
  const anyT = t as unknown as { projectName?: string };
  return anyT.projectName?.trim() || null;
}

function dueLabel(t: TodoistTask): string | null {
  const date = t.due?.date;
  if (!date) return null;
  // If we have a datetime, show HH:MM; if a bare date, show "today".
  const hasTime = /T\d{2}:\d{2}/.test(date);
  if (!hasTime) return "today";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
}

function Band({
  variant,
  label,
  rightLabel,
  items,
  onComplete,
  busyTaskId,
}: BandProps) {
  if (items.length === 0) return null;
  return (
    <div className="fp-triage-band-group">
      <div className={`fp-triage-band fp-triage-band--${variant}`}>
        <span>{label}</span>
        {rightLabel && <span className="fp-triage-band__right">{rightLabel}</span>}
      </div>
      <ol className="fp-triage-list">
        {items.map((task) => {
          const due = dueLabel(task);
          const project = projectLabel(task);
          const isBusy = busyTaskId === task.id;
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
                      <span className="fp-triage-row__meta-proj">@{project}</span>
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
              <span className={`fp-triage-row__pri fp-triage-row__pri--${priorityLabel(task).toLowerCase()}`}>
                {priorityLabel(task)}
              </span>
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

  const { overdue, today } = useMemo(() => {
    const sorted = [...tasks.dueToday].sort(
      (a, b) => taskPriorityOrder(a) - taskPriorityOrder(b)
    );
    const overdueArr: TodoistTask[] = [];
    const todayArr: TodoistTask[] = [];
    for (const t of sorted) {
      if (isTaskOverdue(t)) overdueArr.push(t);
      else todayArr.push(t);
    }
    // Cap each band so the column stays scannable.
    return {
      overdue: overdueArr.slice(0, 6),
      today: todayArr.slice(0, 8),
    };
  }, [tasks.dueToday]);

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
            onComplete={(taskId) => completeMut.mutate({ taskId })}
            busyTaskId={busyId}
          />
          <Band
            variant="today"
            label="TODAY"
            rightLabel={`${today.length} due`}
            items={today}
            onComplete={(taskId) => completeMut.mutate({ taskId })}
            busyTaskId={busyId}
          />
        </div>
      )}
    </section>
  );
}

export default TasksTriage;
