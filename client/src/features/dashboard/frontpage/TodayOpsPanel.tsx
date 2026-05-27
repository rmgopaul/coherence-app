import { useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
import type { PersonalDashboardTodayOpsCard } from "@shared/personalDashboard";
import type { DashboardData } from "../useDashboardData";
import { DailyWorkflowPanel } from "./DailyWorkflowPanel";
import { LinkedNotesBadge } from "./LinkedNotesBadge";
import { SignalActions } from "./SignalActions";
import {
  buildTodayOpsAddCardToPlanPatch,
  buildTodayOpsCarryForwardCardPatch,
  buildTodayOpsCommitPlanPatch,
  buildTodayOpsMarkDonePatch,
  isTodayOpsSafePrimaryAction,
  todayOpsLinkedNotesBadgeCanCreate,
  todayOpsCardIsInPlan,
  todayOpsCardToWorkspaceNoteRow,
  todayOpsWorkspaceSignalActionKeys,
} from "./todayOps.helpers";
import { nextDailyWorkflowDateKey } from "./dailyWorkflow.helpers";
import { useWorkspaceNotes, type WorkspaceNoteRow } from "./useWorkspaceNotes";

type TodayOpsPanelProps = {
  dateKey: string;
  commandCenter: DashboardData["commandCenter"]["data"];
  state: DashboardData["dailyState"];
  todoistTasksDueToday: DashboardData["tasks"]["dueToday"];
  weather: DashboardData["weather"];
  news: DashboardData["news"];
  health: DashboardData["health"];
};

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "not generated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not generated";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function sourceLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function linkMeta(row: WorkspaceNoteRow) {
  return row.kind === "todoist"
    ? {
        linkType: "todoist_task" as const,
        externalId: row.taskId,
        title: row.content,
      }
    : {
        linkType: "google_calendar_event" as const,
        externalId: row.eventId,
        title: row.title,
      };
}

export function TodayOpsPanel({
  dateKey,
  commandCenter,
  state,
  todoistTasksDueToday,
  weather,
  news,
  health,
}: TodayOpsPanelProps) {
  const utils = trpc.useUtils();
  const workspaceNotes = useWorkspaceNotes();
  const dailyStateActionInFlightRef = useRef(false);
  const [dailyStateActionPending, setDailyStateActionPending] = useState(false);
  const [advancedEditorOpen, setAdvancedEditorOpen] = useState(false);
  const todayOps = commandCenter?.todayOps ?? null;
  const tomorrowDateKey = useMemo(
    () => nextDailyWorkflowDateKey(dateKey),
    [dateKey]
  );

  const workspaceRows = useMemo(
    () =>
      todayOps?.cards
        .map(todayOpsCardToWorkspaceNoteRow)
        .filter((row): row is WorkspaceNoteRow => row !== null) ?? [],
    [todayOps]
  );
  const todoistWorkspaceIds = useMemo(
    () =>
      Array.from(
        new Set(
          workspaceRows
            .filter(row => row.kind === "todoist")
            .map(row => row.taskId)
        )
      ),
    [workspaceRows]
  );
  const calendarWorkspaceIds = useMemo(
    () =>
      Array.from(
        new Set(
          workspaceRows
            .filter(row => row.kind === "calendar")
            .map(row => row.eventId)
        )
      ),
    [workspaceRows]
  );
  const todoistNoteCountsQuery = trpc.notes.countLinksByExternalIds.useQuery(
    { linkType: "todoist_task", externalIds: todoistWorkspaceIds },
    { enabled: todoistWorkspaceIds.length > 0, staleTime: 60_000 }
  );
  const calendarNoteCountsQuery = trpc.notes.countLinksByExternalIds.useQuery(
    { linkType: "google_calendar_event", externalIds: calendarWorkspaceIds },
    { enabled: calendarWorkspaceIds.length > 0, staleTime: 60_000 }
  );

  const saveDailyState = trpc.personalDashboard.saveDailyState.useMutation({
    onSuccess: async (_saved, variables) => {
      await Promise.all([
        utils.personalDashboard.getDailyState.invalidate({
          dateKey: variables.dateKey ?? dateKey,
        }),
        utils.personalDashboard.getCommandCenter.invalidate(),
      ]);
    },
    onError: error => {
      toast.error(error.message || "Could not update Today Ops");
    },
  });

  const planBlockCounts = useMemo(() => {
    const blocks = state.data?.todayPlan?.blocks ?? [];
    return {
      total: blocks.length,
      done: blocks.filter(block => block.status === "done").length,
    };
  }, [state.data?.todayPlan?.blocks]);
  const dailyStateMutationPending =
    dailyStateActionPending || saveDailyState.isPending;

  function linkedNoteCount(row: WorkspaceNoteRow): number {
    return row.kind === "todoist"
      ? (todoistNoteCountsQuery.data?.counts[row.taskId] ?? 0)
      : (calendarNoteCountsQuery.data?.counts[row.eventId] ?? 0);
  }

  function linkedNoteCountLoading(row: WorkspaceNoteRow): boolean {
    return row.kind === "todoist"
      ? todoistNoteCountsQuery.isLoading
      : calendarNoteCountsQuery.isLoading;
  }

  async function loadDailyStateForAction(
    targetDateKey: string,
    fallbackMessage: string
  ) {
    try {
      return await utils.personalDashboard.getDailyState.fetch({
        dateKey: targetDateKey,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallbackMessage);
      return null;
    }
  }

  function beginDailyStateAction(): boolean {
    if (dailyStateActionInFlightRef.current || saveDailyState.isPending) {
      return false;
    }
    dailyStateActionInFlightRef.current = true;
    setDailyStateActionPending(true);
    return true;
  }

  function endDailyStateAction() {
    dailyStateActionInFlightRef.current = false;
    setDailyStateActionPending(false);
  }

  async function commitTodaysPlan() {
    if (!todayOps || !beginDailyStateAction()) return;
    try {
      const currentState = await loadDailyStateForAction(
        dateKey,
        "Could not load today's daily state"
      );
      if (!currentState) return;
      await saveDailyState.mutateAsync({
        dateKey,
        ...buildTodayOpsCommitPlanPatch(todayOps, currentState, new Date()),
      });
      toast.success("Today Ops committed");
    } catch {
      // Toast is emitted by the mutation's onError handler.
    } finally {
      endDailyStateAction();
    }
  }

  async function addCardToPlan(card: PersonalDashboardTodayOpsCard) {
    if (!beginDailyStateAction()) return;
    try {
      const currentState = await loadDailyStateForAction(
        dateKey,
        "Could not load today's daily state"
      );
      if (!currentState) return;
      await saveDailyState.mutateAsync({
        dateKey,
        ...buildTodayOpsAddCardToPlanPatch(
          card,
          currentState,
          dateKey,
          new Date()
        ),
      });
      toast.success("Added to today's plan");
    } catch {
      // Toast is emitted by the mutation's onError handler.
    } finally {
      endDailyStateAction();
    }
  }

  async function markCardDone(card: PersonalDashboardTodayOpsCard) {
    if (!beginDailyStateAction()) return;
    try {
      const currentState = await loadDailyStateForAction(
        dateKey,
        "Could not load today's daily state"
      );
      if (!currentState) return;
      const patch = buildTodayOpsMarkDonePatch(card, currentState, new Date());
      if (!patch) {
        toast.info("Nothing local to mark done");
        return;
      }
      await saveDailyState.mutateAsync({ dateKey, ...patch });
      toast.success("Marked done locally");
    } catch {
      // Toast is emitted by the mutation's onError handler.
    } finally {
      endDailyStateAction();
    }
  }

  async function carryForwardCard(card: PersonalDashboardTodayOpsCard) {
    if (!beginDailyStateAction()) return;
    try {
      const [currentState, targetState] = await Promise.all([
        loadDailyStateForAction(dateKey, "Could not load today's daily state"),
        loadDailyStateForAction(
          tomorrowDateKey,
          "Could not load tomorrow's daily state"
        ),
      ]);
      if (!currentState || !targetState) return;

      const { carryForwardCount, ...patch } =
        buildTodayOpsCarryForwardCardPatch(
          card,
          currentState,
          targetState,
          tomorrowDateKey,
          new Date()
        );
      if (carryForwardCount === 0) {
        toast.info("That item is already carried forward or closed");
        return;
      }
      await saveDailyState.mutateAsync({
        dateKey: tomorrowDateKey,
        ...patch,
      });
      toast.success("Carried forward to tomorrow");
    } catch {
      // Toast is emitted by the mutation's onError handler.
    } finally {
      endDailyStateAction();
    }
  }

  function renderWorkspaceActions(
    card: PersonalDashboardTodayOpsCard,
    row: WorkspaceNoteRow | null
  ) {
    if (!row) return null;
    const meta = linkMeta(row);
    const canCreateFromBadge = todayOpsLinkedNotesBadgeCanCreate(card);
    return (
      <div className="fp-today-ops__workspace-actions">
        <LinkedNotesBadge
          linkType={meta.linkType}
          externalId={meta.externalId}
          count={linkedNoteCount(row)}
          countLoading={linkedNoteCountLoading(row)}
          onCreateNote={
            canCreateFromBadge
              ? () => workspaceNotes.createWorkspaceNote(row)
              : undefined
          }
          createLabel="Create note"
          openLabel="Open workspace"
          className="fp-today-ops__mini-btn"
        />
        <SignalActions
          row={row}
          actionKeys={todayOpsWorkspaceSignalActionKeys(card)}
          triggerClassName="fp-today-ops__icon-btn fp-today-ops__icon-btn--quiet"
          ariaLabel={`Workspace actions for ${meta.title}`}
        />
      </div>
    );
  }

  function renderPrimaryAction(
    card: PersonalDashboardTodayOpsCard,
    row: WorkspaceNoteRow | null
  ) {
    if (!isTodayOpsSafePrimaryAction(card.primaryAction)) return null;
    if (card.primaryAction === "open_source" && card.sourceUrl) {
      return (
        <a
          className="fp-today-ops__action-btn"
          href={card.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink aria-hidden="true" />
          <span>Open source</span>
        </a>
      );
    }
    if (card.primaryAction === "create_workspace_note" && row) {
      return (
        <button
          type="button"
          className="fp-today-ops__action-btn"
          onClick={() => workspaceNotes.createWorkspaceNote(row)}
          disabled={workspaceNotes.isCreatingWorkspaceNote}
        >
          <FileText aria-hidden="true" />
          <span>Create note</span>
        </button>
      );
    }
    if (card.primaryAction === "mark_done_local") {
      return (
        <button
          type="button"
          className="fp-today-ops__action-btn"
          onClick={() => void markCardDone(card)}
          disabled={dailyStateMutationPending}
        >
          <CheckCircle2 aria-hidden="true" />
          <span>Mark done</span>
        </button>
      );
    }
    if (card.primaryAction === "carry_forward_local") {
      return (
        <button
          type="button"
          className="fp-today-ops__action-btn"
          onClick={() => void carryForwardCard(card)}
          disabled={dailyStateMutationPending}
        >
          <ArrowRight aria-hidden="true" />
          <span>Carry forward</span>
        </button>
      );
    }
    return (
      <button
        type="button"
        className="fp-today-ops__action-btn"
        onClick={() => void addCardToPlan(card)}
        disabled={
          dailyStateMutationPending ||
          todayOpsCardIsInPlan(card, state.data, dateKey)
        }
      >
        <Plus aria-hidden="true" />
        <span>Add to plan</span>
      </button>
    );
  }

  function renderSecondaryActions(
    card: PersonalDashboardTodayOpsCard,
    row: WorkspaceNoteRow | null
  ) {
    const inPlan = todayOpsCardIsInPlan(card, state.data, dateKey);
    const canCarryForward =
      card.kind === "saved_commitment" ||
      card.kind === "saved_outcome" ||
      card.kind === "saved_plan_block";
    return (
      <div className="fp-today-ops__secondary-actions">
        {card.sourceUrl && card.primaryAction !== "open_source" ? (
          <a
            className="fp-today-ops__mini-btn"
            href={card.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink aria-hidden="true" />
            <span>Open</span>
          </a>
        ) : null}
        {card.primaryAction !== "add_to_plan" ? (
          <button
            type="button"
            className="fp-today-ops__mini-btn"
            onClick={() => void addCardToPlan(card)}
            disabled={dailyStateMutationPending || inPlan}
          >
            <Plus aria-hidden="true" />
            <span>{inPlan ? "Planned" : "Plan"}</span>
          </button>
        ) : null}
        {canCarryForward ? (
          <button
            type="button"
            className="fp-today-ops__mini-btn"
            onClick={() => void carryForwardCard(card)}
            disabled={dailyStateMutationPending}
          >
            <ArrowRight aria-hidden="true" />
            <span>Carry</span>
          </button>
        ) : null}
        {renderWorkspaceActions(card, row)}
      </div>
    );
  }

  function renderCard(card: PersonalDashboardTodayOpsCard) {
    const row = todayOpsCardToWorkspaceNoteRow(card);
    return (
      <li className="fp-today-ops-card" key={card.id}>
        <div className="fp-today-ops-card__rank">{card.rank}</div>
        <div className="fp-today-ops-card__body">
          <div className="fp-today-ops-card__meta">
            <span>{sourceLabel(card.source)}</span>
            {card.status ? <span>{card.status}</span> : null}
          </div>
          <h3 className="fp-today-ops-card__title">{card.title}</h3>
          <p>{card.reason}</p>
          {renderSecondaryActions(card, row)}
        </div>
        <div className="fp-today-ops-card__primary">
          {renderPrimaryAction(card, row)}
        </div>
      </li>
    );
  }

  if (state.isLoading && !state.data && !commandCenter) {
    return (
      <section className="fp-today-ops" aria-label="Today Ops">
        <header className="fp-today-ops__head">
          <h2 className="fp-today-ops__title">TODAY OPS</h2>
          <span className="mono-label">LOADING</span>
        </header>
      </section>
    );
  }

  return (
    <section className="fp-today-ops" aria-label="Today Ops">
      <header className="fp-today-ops__head">
        <div>
          <span className="mono-label">ACTIONABLE TRIAGE</span>
          <h2 className="fp-today-ops__title">TODAY OPS</h2>
        </div>
        <div className="fp-today-ops__head-actions">
          <span className="mono-label">
            {todayOps
              ? `AUTO ${formatTimestamp(todayOps.autoBrief.generatedAt)}`
              : "NO BRIEF"}
          </span>
          <button
            type="button"
            className="fp-today-ops__action-btn"
            onClick={() => void commitTodaysPlan()}
            disabled={!todayOps || dailyStateMutationPending}
          >
            {dailyStateMutationPending ? (
              <RefreshCw className="fp-today-ops__spin" aria-hidden="true" />
            ) : (
              <Save aria-hidden="true" />
            )}
            <span>Commit plan</span>
          </button>
        </div>
      </header>

      {state.isError ? (
        <p className="fp-today-ops__error">
          {state.errorMessage ?? "Saved daily state unavailable."}
        </p>
      ) : null}

      {!todayOps ? (
        <div className="fp-today-ops__empty">
          <Sparkles aria-hidden="true" />
          <p>Today Ops will appear when the command center finishes loading.</p>
        </div>
      ) : (
        <div className="fp-today-ops__grid">
          <div className="fp-today-ops-brief">
            <div className="fp-today-ops__block-head">
              <span className="mono-label">AUTO BRIEF</span>
              <span className="mono-label">
                {formatTimestamp(todayOps.autoBrief.generatedAt)}
              </span>
            </div>
            <h3>{todayOps.autoBrief.headline}</h3>
            <ul>
              {todayOps.autoBrief.summaryBullets.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {todayOps.autoBrief.sourceRefs.length > 0 ? (
              <details className="fp-today-ops-brief__sources">
                <summary>Sources</summary>
                <ol>
                  {todayOps.autoBrief.sourceRefs.map((sourceRef, index) => (
                    <li key={`${sourceRef.source}:${sourceRef.id ?? index}`}>
                      {sourceRef.url ? (
                        <a
                          href={sourceRef.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {sourceRef.label}
                        </a>
                      ) : (
                        <span>{sourceRef.label}</span>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            <dl className="fp-today-ops-progress">
              <div>
                <dt className="mono-label">Plan</dt>
                <dd>
                  {planBlockCounts.done}/{planBlockCounts.total} done
                </dd>
              </div>
              <div>
                <dt className="mono-label">Commitments</dt>
                <dd>
                  {todayOps.progress.commitments.done}/
                  {todayOps.progress.commitments.total} done
                </dd>
              </div>
              <div>
                <dt className="mono-label">Outcomes</dt>
                <dd>
                  {todayOps.progress.outcomes.won}/
                  {todayOps.progress.outcomes.total} won
                </dd>
              </div>
            </dl>
          </div>

          <div className="fp-today-ops-cards">
            <div className="fp-today-ops__block-head">
              <span className="mono-label">RANKED ACTIONS</span>
              <span className="mono-label">{todayOps.cards.length}/6</span>
            </div>
            {todayOps.cards.length > 0 ? (
              <ol>{todayOps.cards.map(renderCard)}</ol>
            ) : (
              <p className="fp-empty">
                No ranked actions. Keep the day clear or use advanced edit.
              </p>
            )}
          </div>
        </div>
      )}

      <details
        className="fp-today-ops__advanced"
        onToggle={event => setAdvancedEditorOpen(event.currentTarget.open)}
      >
        <summary>
          <span>Advanced daily workflow editor</span>
          <span className="mono-label">EDIT</span>
        </summary>
        {advancedEditorOpen ? (
          <DailyWorkflowPanel
            dateKey={dateKey}
            commandCenter={commandCenter}
            state={state}
            todoistTasksDueToday={todoistTasksDueToday}
            weather={weather}
            news={news}
            health={health}
          />
        ) : null}
      </details>
    </section>
  );
}
