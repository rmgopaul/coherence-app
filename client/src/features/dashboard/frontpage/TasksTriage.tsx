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
import {
  dueLabel,
  priorityClass,
  priorityLabel,
  projectLabel,
  splitTriageBands,
} from "./triage.helpers";
// Task 10.1 (2026-04-28): cross-cutting per-row action menu.
import { SignalActions } from "./SignalActions";

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
              {/* Task 10.1: cross-cutting actions (Drop to Dock /
                  Pin as King / Defer to tomorrow). The bx button
                  keeps "Mark complete" because it's the most-used
                  action and the menu would otherwise add a click. */}
              <SignalActions
                row={{
                  kind: "todoist",
                  taskId: task.id,
                  content: task.content,
                  taskUrl: `https://todoist.com/showTask?id=${encodeURIComponent(task.id)}`,
                }}
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

  const { overdue, today } = useMemo(
    () => splitTriageBands(tasks.dueToday),
    [tasks.dueToday]
  );

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
