import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  Link2,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
import {
  PERSONAL_DASHBOARD_INTEGRATION_KEYS,
  PERSONAL_DASHBOARD_SOURCE_KINDS,
  type PersonalDashboardCommitment,
  type PersonalDashboardOutcome,
  type PersonalDashboardPlanBlock,
} from "@shared/personalDashboard";
import type { DashboardData } from "../useDashboardData";
import {
  buildCommitmentDrafts,
  buildCarryForwardDailyWorkflowPatch,
  buildDailyBriefDraft,
  buildEndOfDayReviewSummary,
  buildOutcomeDrafts,
  buildTodayPlanDraft,
  completeAllCommitments,
  createManualDailyWorkflowId,
  dailyWorkflowDraftFromState,
  dateTimeLocalInputFromIso,
  emptyDailyWorkflowDraft,
  hasDailyBriefDraftContent,
  hasDailyWorkflowDraftContent,
  isoFromDateTimeLocalInput,
  normalizeDailyWorkflowDraftForSave,
  nextDailyWorkflowDateKey,
  refreshDailyBriefDraftFromSources,
  sourceUrlForBriefSourceRef,
  winActiveOutcomes,
  workspaceNoteRowFromBriefSourceRef,
  workspaceNoteRowFromDailyWorkflowItem,
  workspaceNoteRowsFromDailyWorkflowDraft,
  type DailyWorkflowDraft,
} from "./dailyWorkflow.helpers";
import { LinkedNotesBadge } from "./LinkedNotesBadge";
import { SignalActions } from "./SignalActions";
import { useWorkspaceNotes, type WorkspaceNoteRow } from "./useWorkspaceNotes";

type DailyBriefSourceRef =
  DailyWorkflowDraft["dailyBrief"]["sourceRefs"][number];

const briefSourceOptions: DailyBriefSourceRef["source"][] = Array.from(
  new Set([
    ...PERSONAL_DASHBOARD_SOURCE_KINDS,
    ...PERSONAL_DASHBOARD_INTEGRATION_KEYS,
  ])
);

type DailyWorkflowPanelProps = {
  dateKey: string;
  commandCenter: DashboardData["commandCenter"]["data"];
  state: DashboardData["dailyState"];
};

const commitmentStatuses: PersonalDashboardCommitment["status"][] = [
  "open",
  "waiting",
  "blocked",
  "done",
];

const outcomeStatuses: PersonalDashboardOutcome["status"][] = [
  "active",
  "paused",
  "won",
  "missed",
];

const planBlockStatuses: PersonalDashboardPlanBlock["status"][] = [
  "planned",
  "active",
  "done",
  "skipped",
];

export function DailyWorkflowPanel({
  dateKey,
  commandCenter,
  state,
}: DailyWorkflowPanelProps) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<DailyWorkflowDraft>(() =>
    emptyDailyWorkflowDraft()
  );
  const [dirty, setDirty] = useState(false);
  const workspaceNotes = useWorkspaceNotes();

  const saveDailyState = trpc.personalDashboard.saveDailyState.useMutation({
    onSuccess: async (saved) => {
      setDraft(dailyWorkflowDraftFromState(saved));
      setDirty(false);
      await Promise.all([
        utils.personalDashboard.getDailyState.invalidate({ dateKey }),
        utils.personalDashboard.getCommandCenter.invalidate(),
      ]);
      toast.success("Daily workflow saved");
    },
    onError: (error) => {
      toast.error(error.message || "Could not save daily workflow");
    },
  });
  const carryForwardDailyState =
    trpc.personalDashboard.saveDailyState.useMutation({
      onSuccess: async (_saved, variables) => {
        await Promise.all([
          utils.personalDashboard.getDailyState.invalidate({
            dateKey: variables.dateKey,
          }),
          utils.personalDashboard.getCommandCenter.invalidate(),
        ]);
        toast.success("Carried forward to tomorrow");
      },
      onError: (error) => {
        toast.error(error.message || "Could not carry forward tomorrow");
      },
    });

  const loadedKey = `${state.data?.dateKey ?? dateKey}:${
    state.data?.updatedAt ?? "empty"
  }`;

  useEffect(() => {
    if (dirty) return;
    setDraft(dailyWorkflowDraftFromState(state.data));
  }, [dirty, loadedKey, state.data]);

  const canSeed = Boolean(commandCenter);
  const isSaving = saveDailyState.isPending;
  const canClearDraft = hasDailyWorkflowDraftContent(draft);
  const canRefreshBrief = Boolean(
    draft.dailyBrief.sourceRefs.some(
      (sourceRef) => sourceRef.label.trim().length > 0
    ) || commandCenter
  );
  const briefSourceItems = draft.dailyBrief.sourceRefs.map(
    (sourceRef, index) => ({
      id: String(index),
      index,
      sourceRef,
    })
  );
  const canCompleteCommitments = draft.commitments.some(
    (item) => item.status !== "done"
  );
  const canWinActiveOutcomes = draft.outcomes.some(
    (item) => item.status === "active"
  );
  const endOfDayReview = useMemo(
    () => buildEndOfDayReviewSummary(draft),
    [draft]
  );
  const tomorrowDateKey = useMemo(
    () => nextDailyWorkflowDateKey(dateKey),
    [dateKey]
  );
  const canCarryForward = endOfDayReview.needsAttention.length > 0;
  const workspaceRows = useMemo(
    () => workspaceNoteRowsFromDailyWorkflowDraft(draft),
    [draft]
  );
  const todoistWorkspaceIds = useMemo(
    () =>
      Array.from(
        new Set(
          workspaceRows
            .filter((row) => row.kind === "todoist")
            .map((row) => row.taskId)
        )
      ),
    [workspaceRows]
  );
  const calendarWorkspaceIds = useMemo(
    () =>
      Array.from(
        new Set(
          workspaceRows
            .filter((row) => row.kind === "calendar")
            .map((row) => row.eventId)
        )
      ),
    [workspaceRows]
  );
  const todoistNoteCountsQuery = trpc.notes.countLinksByExternalIds.useQuery(
    { linkType: "todoist_task", externalIds: todoistWorkspaceIds },
    {
      enabled: todoistWorkspaceIds.length > 0,
      staleTime: 60_000,
    }
  );
  const calendarNoteCountsQuery = trpc.notes.countLinksByExternalIds.useQuery(
    { linkType: "google_calendar_event", externalIds: calendarWorkspaceIds },
    {
      enabled: calendarWorkspaceIds.length > 0,
      staleTime: 60_000,
    }
  );

  function linkedNoteCount(row: WorkspaceNoteRow): number {
    if (row.kind === "todoist") {
      return todoistNoteCountsQuery.data?.counts[row.taskId] ?? 0;
    }
    return calendarNoteCountsQuery.data?.counts[row.eventId] ?? 0;
  }

  function linkedNoteCountLoading(row: WorkspaceNoteRow): boolean {
    return row.kind === "todoist"
      ? todoistNoteCountsQuery.isLoading
      : calendarNoteCountsQuery.isLoading;
  }

  function renderWorkspaceActions(row: WorkspaceNoteRow | null) {
    if (!row) return null;
    const linkType =
      row.kind === "todoist" ? "todoist_task" : "google_calendar_event";
    const externalId = row.kind === "todoist" ? row.taskId : row.eventId;
    return (
      <div className="fp-daily-workflow__workspace-actions">
        <LinkedNotesBadge
          linkType={linkType}
          externalId={externalId}
          count={linkedNoteCount(row)}
          countLoading={linkedNoteCountLoading(row)}
          onCreateNote={() => workspaceNotes.createWorkspaceNote(row)}
          createLabel="Create workspace note"
          openLabel="Open workspace"
          className="fp-daily-workflow__mini-btn"
        />
        <SignalActions
          row={row}
          actionKeys={[
            "create-workspace-note",
            "open-workspace-notes",
            "attach-existing-note",
          ]}
          triggerClassName="fp-daily-workflow__icon-btn fp-daily-workflow__icon-btn--quiet"
          ariaLabel={`Workspace actions for ${row.kind === "todoist" ? row.content : row.title}`}
        />
      </div>
    );
  }

  function renderBriefSourceActions(sourceRef: DailyBriefSourceRef) {
    const sourceUrl = sourceUrlForBriefSourceRef(sourceRef);
    const workspaceRow = workspaceNoteRowFromBriefSourceRef(sourceRef);
    if (!sourceUrl && !workspaceRow) return null;

    return (
      <div className="fp-daily-workflow__source-actions">
        {sourceUrl ? (
          <a
            className="fp-daily-workflow__mini-btn"
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            title="Open brief source"
            aria-label={`Open brief source: ${sourceRef.label || sourceRef.id || sourceRef.source}`}
          >
            <ExternalLink aria-hidden="true" />
            <span>OPEN</span>
          </a>
        ) : null}
        {workspaceRow ? renderWorkspaceActions(workspaceRow) : null}
      </div>
    );
  }

  function updateDraft(
    updater: (current: DailyWorkflowDraft) => DailyWorkflowDraft
  ) {
    setDirty(true);
    setDraft(updater);
  }

  function addBriefSourceRef() {
    updateDraft((current) => ({
      ...current,
      dailyBriefStatus:
        current.dailyBriefStatus === "not_started"
          ? "draft"
          : current.dailyBriefStatus,
      dailyBrief: {
        ...current.dailyBrief,
        sourceRefs: [
          ...current.dailyBrief.sourceRefs,
          {
            source: "system",
            id: null,
            label: "",
            url: null,
          },
        ],
      },
    }));
  }

  function updateBriefSourceRef(
    index: number,
    patch: Partial<DailyBriefSourceRef>
  ) {
    updateDraft((current) => ({
      ...current,
      dailyBriefStatus:
        current.dailyBriefStatus === "not_started"
          ? "draft"
          : current.dailyBriefStatus,
      dailyBrief: {
        ...current.dailyBrief,
        sourceRefs: current.dailyBrief.sourceRefs.map((entry, entryIndex) =>
          entryIndex === index ? { ...entry, ...patch } : entry
        ),
      },
    }));
  }

  function removeBriefSourceRef(index: number) {
    updateDraft((current) => ({
      ...current,
      dailyBrief: {
        ...current.dailyBrief,
        sourceRefs: current.dailyBrief.sourceRefs.filter(
          (_entry, entryIndex) => entryIndex !== index
        ),
      },
    }));
  }

  function seedFromCommandCenter() {
    if (!commandCenter) return;
    const now = new Date();
    const nextCommitments = buildCommitmentDrafts(commandCenter, now);
    const nextOutcomes = buildOutcomeDrafts(commandCenter, now);

    updateDraft((current) => ({
      ...current,
      dailyBriefStatus: "draft",
      dailyBrief: buildDailyBriefDraft(commandCenter, now),
      todayPlanStatus: "draft",
      todayPlan: buildTodayPlanDraft(commandCenter, now),
      commitments: dedupeById([
        ...nextCommitments,
        ...current.commitments,
      ]),
      outcomes: dedupeById([...nextOutcomes, ...current.outcomes]),
    }));
  }

  function refreshBriefFromSources() {
    if (!canRefreshBrief) return;
    updateDraft((current) => ({
      ...current,
      dailyBriefStatus:
        current.dailyBriefStatus === "ready" ? "ready" : "draft",
      dailyBrief: refreshDailyBriefDraftFromSources(
        current.dailyBrief,
        commandCenter,
        new Date()
      ),
    }));
  }

  const save = useCallback(async () => {
    const normalized = normalizeDailyWorkflowDraftForSave(draft, new Date());
    const hasDailyBrief = hasDailyBriefDraftContent(normalized.dailyBrief);
    try {
      await saveDailyState.mutateAsync({
        dateKey,
        dailyBriefStatus: normalized.dailyBriefStatus,
        dailyBrief: hasDailyBrief ? normalized.dailyBrief : null,
        todayPlanStatus: normalized.todayPlanStatus,
        todayPlan:
          normalized.todayPlan.topPriority ||
          normalized.todayPlan.notes ||
          normalized.todayPlan.blocks.length > 0
            ? normalized.todayPlan
            : null,
        commitments: normalized.commitments,
        outcomes: normalized.outcomes,
      });
    } catch {
      // Toast is emitted by the mutation's onError handler.
    }
  }, [dateKey, draft, saveDailyState]);

  const discardDraft = useCallback(() => {
    setDraft(dailyWorkflowDraftFromState(state.data));
    setDirty(false);
  }, [state.data]);

  function clearDraft() {
    if (!canClearDraft || isSaving) return;
    const confirmed = window.confirm(
      "Clear all daily workflow fields for this day? This will not persist until you press Save."
    );
    if (!confirmed) return;
    setDraft(emptyDailyWorkflowDraft());
    setDirty(true);
  }

  async function carryForwardTomorrow() {
    if (!canCarryForward || carryForwardDailyState.isPending) return;
    let patch: ReturnType<typeof buildCarryForwardDailyWorkflowPatch>;
    try {
      const tomorrowState =
        await utils.personalDashboard.getDailyState.fetch({
          dateKey: tomorrowDateKey,
        });
      patch = buildCarryForwardDailyWorkflowPatch(
        draft,
        tomorrowState,
        dateKey,
        tomorrowDateKey,
        new Date()
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not load tomorrow's workflow"
      );
      return;
    }

    if (patch.carryForwardCount === 0) {
      toast.info("Tomorrow already has those carried-forward items");
      return;
    }

    try {
      await carryForwardDailyState.mutateAsync({
        dateKey: tomorrowDateKey,
        commitments: patch.commitments,
        outcomes: patch.outcomes,
        todayPlanStatus: patch.todayPlanStatus,
        todayPlan: patch.todayPlan,
      });
    } catch {
      // Toast is emitted by the mutation's onError handler.
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "s") {
        event.preventDefault();
        if (dirty && !isSaving) void save();
        return;
      }

      if (
        event.key === "Escape" &&
        dirty &&
        !isSaving &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        discardDraft();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dirty, discardDraft, isSaving, save]);

  function addCommitment() {
    updateDraft((current) => ({
      ...current,
      commitments: [
        ...current.commitments,
        {
          id: createManualDailyWorkflowId("commitment"),
          title: "",
          source: "system",
          sourceId: null,
          owner: null,
          dueAt: null,
          status: "open",
          url: null,
        },
      ],
    }));
  }

  function addOutcome() {
    updateDraft((current) => ({
      ...current,
      outcomes: [
        ...current.outcomes,
        {
          id: createManualDailyWorkflowId("outcome"),
          title: "",
          status: "active",
          metricLabel: "Progress",
          target: null,
          current: null,
        },
      ],
    }));
  }

  function markCommitmentsDone() {
    updateDraft((current) => ({
      ...current,
      commitments: completeAllCommitments(current.commitments),
    }));
  }

  function markActiveOutcomesWon() {
    updateDraft((current) => ({
      ...current,
      outcomes: winActiveOutcomes(current.outcomes),
    }));
  }

  function addPlanBlock() {
    updateDraft((current) => ({
      ...current,
      todayPlanStatus:
        current.todayPlanStatus === "not_started"
          ? "draft"
          : current.todayPlanStatus,
      todayPlan: {
        ...current.todayPlan,
        blocks: [
          ...current.todayPlan.blocks,
          {
            id: createManualDailyWorkflowId("plan-block"),
            title: "",
            startIso: null,
            endIso: null,
            source: "system",
            sourceId: null,
            status: "planned",
          },
        ],
      },
    }));
  }

  function updatePlanBlock(
    id: string,
    patch: Partial<PersonalDashboardPlanBlock>
  ) {
    updateDraft((current) => ({
      ...current,
      todayPlanStatus:
        current.todayPlanStatus === "not_started"
          ? "draft"
          : current.todayPlanStatus,
      todayPlan: {
        ...current.todayPlan,
        blocks: current.todayPlan.blocks.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry
        ),
      },
    }));
  }

  function removePlanBlock(id: string) {
    updateDraft((current) => ({
      ...current,
      todayPlan: {
        ...current.todayPlan,
        blocks: current.todayPlan.blocks.filter((item) => item.id !== id),
      },
    }));
  }

  if (state.isLoading && !state.data) {
    return (
      <section className="fp-daily-workflow" aria-label="Daily workflow">
        <header className="fp-daily-workflow__head">
          <h2 className="fp-daily-workflow__title">DAILY WORKFLOW</h2>
          <span className="mono-label">LOADING</span>
        </header>
      </section>
    );
  }

  return (
    <section className="fp-daily-workflow" aria-label="Daily workflow">
      <header className="fp-daily-workflow__head">
        <div>
          <span className="mono-label">SERVER-BACKED DAY STATE</span>
          <h2 className="fp-daily-workflow__title">DAILY WORKFLOW</h2>
        </div>
        <div className="fp-daily-workflow__actions">
          <span className="mono-label">
            {state.data?.updatedAt ? "SAVED" : "NOT SAVED"}
          </span>
          <button
            type="button"
            className="fp-daily-workflow__icon-btn"
            onClick={seedFromCommandCenter}
            disabled={!canSeed || isSaving}
            title="Seed from current command-center signals"
            aria-label="Seed from command center"
          >
            <Sparkles aria-hidden="true" />
          </button>
          <button
            type="button"
            className="fp-daily-workflow__icon-btn"
            onClick={clearDraft}
            disabled={!canClearDraft || isSaving}
            title="Clear all daily workflow fields"
            aria-label="Clear daily workflow"
          >
            <Trash2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className="fp-daily-workflow__icon-btn"
            onClick={discardDraft}
            disabled={!dirty || isSaving}
            title="Discard unsaved edits (Escape outside a field)"
            aria-label="Discard unsaved edits"
          >
            <RefreshCw aria-hidden="true" />
          </button>
          <button
            type="button"
            className="fp-daily-workflow__action-btn"
            onClick={() => void save()}
            disabled={isSaving || !dirty}
            title="Save daily workflow (Ctrl/Cmd+S)"
          >
            {isSaving ? (
              <RefreshCw
                className="fp-daily-workflow__spin"
                aria-hidden="true"
              />
            ) : (
              <Save aria-hidden="true" />
            )}
            <span>{isSaving ? "SAVING" : "SAVE"}</span>
          </button>
        </div>
      </header>

      {state.isError ? (
        <p className="fp-daily-workflow__error">
          {state.errorMessage ?? "Daily workflow unavailable."}
        </p>
      ) : null}

      <div className="fp-daily-workflow__grid">
        <div className="fp-daily-workflow__block fp-daily-workflow__block--wide">
          <BlockHeader
            icon={<ClipboardList aria-hidden="true" />}
            label="Daily Brief"
            status={draft.dailyBriefStatus.replace("_", " ")}
            actions={
              <button
                type="button"
                className="fp-daily-workflow__icon-btn fp-daily-workflow__icon-btn--quiet"
                onClick={refreshBriefFromSources}
                disabled={!canRefreshBrief || isSaving}
                title="Refresh Daily Brief from Brief Sources"
                aria-label="Refresh Daily Brief from Brief Sources"
              >
                <RefreshCw aria-hidden="true" />
              </button>
            }
          />
          <label className="fp-daily-workflow__field">
            <span>Headline</span>
            <input
              value={draft.dailyBrief.headline}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  dailyBriefStatus:
                    current.dailyBriefStatus === "not_started"
                      ? "draft"
                      : current.dailyBriefStatus,
                  dailyBrief: {
                    ...current.dailyBrief,
                    headline: event.target.value,
                  },
                }))
              }
              placeholder="What should the day optimize for?"
            />
          </label>
          <label className="fp-daily-workflow__field">
            <span>Summary</span>
            <textarea
              value={draft.dailyBrief.summary ?? ""}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  dailyBriefStatus:
                    current.dailyBriefStatus === "not_started"
                      ? "draft"
                      : current.dailyBriefStatus,
                  dailyBrief: {
                    ...current.dailyBrief,
                    summary: event.target.value,
                  },
                }))
              }
              rows={3}
              placeholder="Key tasks, meetings, waiting-on items, and risk."
            />
          </label>
          <select
            className="fp-daily-workflow__select"
            value={draft.dailyBriefStatus}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                dailyBriefStatus:
                  event.target.value as DailyWorkflowDraft["dailyBriefStatus"],
              }))
            }
            aria-label="Daily Brief status"
          >
            <option value="not_started">not started</option>
            <option value="draft">draft</option>
            <option value="ready">ready</option>
            <option value="failed">failed</option>
          </select>
        </div>

        <EditableList
          title="Brief Sources"
          icon={<Link2 aria-hidden="true" />}
          items={briefSourceItems}
          onAdd={addBriefSourceRef}
          onRemove={(id) => removeBriefSourceRef(Number(id))}
          renderRowActions={(item) =>
            renderBriefSourceActions(item.sourceRef)
          }
          renderItem={(item) => (
            <>
              <input
                className="fp-daily-workflow__row-field--wide"
                value={item.sourceRef.label}
                onChange={(event) =>
                  updateBriefSourceRef(item.index, {
                    label: event.target.value,
                  })
                }
                placeholder="Source label"
                aria-label="Brief source label"
              />
              <select
                value={item.sourceRef.source}
                onChange={(event) => {
                  const source =
                    event.target.value as DailyBriefSourceRef["source"];
                  updateBriefSourceRef(item.index, { source });
                }}
                aria-label="Brief source type"
              >
                {briefSourceOptions.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
              <input
                value={item.sourceRef.id ?? ""}
                onChange={(event) =>
                  updateBriefSourceRef(item.index, { id: event.target.value })
                }
                placeholder="Source ID"
                aria-label="Brief source ID"
              />
              <input
                className="fp-daily-workflow__row-field--wide"
                value={item.sourceRef.url ?? ""}
                onChange={(event) =>
                  updateBriefSourceRef(item.index, { url: event.target.value })
                }
                placeholder="https://..."
                aria-label="Brief source URL"
              />
            </>
          )}
        />

        <div className="fp-daily-workflow__block">
          <BlockHeader
            icon={<CheckCircle2 aria-hidden="true" />}
            label="Today Plan"
            status={draft.todayPlanStatus.replace("_", " ")}
          />
          <label className="fp-daily-workflow__field">
            <span>Top priority</span>
            <input
              value={draft.todayPlan.topPriority ?? ""}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  todayPlanStatus:
                    current.todayPlanStatus === "not_started"
                      ? "draft"
                      : current.todayPlanStatus,
                  todayPlan: {
                    ...current.todayPlan,
                    topPriority: event.target.value,
                  },
                }))
              }
              placeholder="The one thing to protect"
            />
          </label>
          <label className="fp-daily-workflow__field">
            <span>Notes</span>
            <textarea
              value={draft.todayPlan.notes ?? ""}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  todayPlanStatus:
                    current.todayPlanStatus === "not_started"
                      ? "draft"
                      : current.todayPlanStatus,
                  todayPlan: {
                    ...current.todayPlan,
                    notes: event.target.value,
                  },
                }))
              }
              rows={3}
              placeholder="Constraints, sequencing, or decision criteria."
            />
          </label>
          <select
            className="fp-daily-workflow__select"
            value={draft.todayPlanStatus}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                todayPlanStatus:
                  event.target.value as DailyWorkflowDraft["todayPlanStatus"],
              }))
            }
            aria-label="Today Plan status"
          >
            <option value="not_started">not started</option>
            <option value="draft">draft</option>
            <option value="ready">ready</option>
            <option value="completed">completed</option>
          </select>
        </div>

        <EditableList
          title="Plan Blocks"
          icon={<CalendarClock aria-hidden="true" />}
          items={draft.todayPlan.blocks}
          onAdd={addPlanBlock}
          onRemove={removePlanBlock}
          renderItem={(item) => (
            <>
              <input
                value={item.title}
                onChange={(event) =>
                  updatePlanBlock(item.id, { title: event.target.value })
                }
                placeholder="Plan block"
                aria-label="Plan block title"
              />
              <select
                value={item.status}
                onChange={(event) => {
                  const status =
                    event.target.value as PersonalDashboardPlanBlock["status"];
                  updatePlanBlock(item.id, { status });
                }}
                aria-label="Plan block status"
              >
                {planBlockStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <input
                type="datetime-local"
                value={dateTimeLocalInputFromIso(item.startIso)}
                onChange={(event) =>
                  updatePlanBlock(item.id, {
                    startIso: isoFromDateTimeLocalInput(event.target.value),
                  })
                }
                aria-label="Plan block start time"
              />
              <input
                type="datetime-local"
                value={dateTimeLocalInputFromIso(item.endIso)}
                onChange={(event) =>
                  updatePlanBlock(item.id, {
                    endIso: isoFromDateTimeLocalInput(event.target.value),
                  })
                }
                aria-label="Plan block end time"
              />
            </>
          )}
          renderRowActions={(item) =>
            renderWorkspaceActions(workspaceNoteRowFromDailyWorkflowItem(item))
          }
        />

        <EditableList
          title="Commitments"
          icon={<ClipboardList aria-hidden="true" />}
          items={draft.commitments}
          fieldsClassName="fp-daily-workflow__row-fields--commitment"
          onAdd={addCommitment}
          actions={
            <button
              type="button"
              className="fp-daily-workflow__mini-btn"
              onClick={markCommitmentsDone}
              disabled={!canCompleteCommitments || isSaving}
              title="Mark every non-done commitment as done"
            >
              <CheckCircle2 aria-hidden="true" />
              <span>DONE ALL</span>
            </button>
          }
          onRemove={(id) =>
            updateDraft((current) => ({
              ...current,
              commitments: current.commitments.filter((item) => item.id !== id),
            }))
          }
          renderItem={(item) => (
            <>
              <input
                value={item.title}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    commitments: current.commitments.map((entry) =>
                      entry.id === item.id
                        ? { ...entry, title: event.target.value }
                        : entry
                    ),
                  }))
                }
                placeholder="Commitment"
                aria-label="Commitment title"
              />
              <select
                value={item.status}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    commitments: current.commitments.map((entry) =>
                      entry.id === item.id
                        ? {
                            ...entry,
                            status:
                              event.target
                                .value as PersonalDashboardCommitment["status"],
                          }
                        : entry
                    ),
                  }))
                }
                aria-label="Commitment status"
              >
                {commitmentStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <input
                value={item.owner ?? ""}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    commitments: current.commitments.map((entry) =>
                      entry.id === item.id
                        ? { ...entry, owner: event.target.value }
                        : entry
                    ),
                  }))
                }
                placeholder="Owner"
                aria-label="Commitment owner"
              />
              <input
                type="datetime-local"
                value={dateTimeLocalInputFromIso(item.dueAt)}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    commitments: current.commitments.map((entry) =>
                      entry.id === item.id
                        ? {
                            ...entry,
                            dueAt: isoFromDateTimeLocalInput(
                              event.target.value
                            ),
                          }
                        : entry
                    ),
                  }))
                }
                aria-label="Commitment due time"
              />
              <input
                className="fp-daily-workflow__row-field--wide"
                value={item.url ?? ""}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    commitments: current.commitments.map((entry) =>
                      entry.id === item.id
                        ? { ...entry, url: event.target.value }
                        : entry
                    ),
                  }))
                }
                placeholder="https://..."
                aria-label="Commitment URL"
              />
            </>
          )}
          renderRowActions={(item) =>
            renderWorkspaceActions(workspaceNoteRowFromDailyWorkflowItem(item))
          }
        />

        <EditableList
          title="Outcomes"
          icon={<Target aria-hidden="true" />}
          items={draft.outcomes}
          fieldsClassName="fp-daily-workflow__row-fields--outcome"
          onAdd={addOutcome}
          actions={
            <button
              type="button"
              className="fp-daily-workflow__mini-btn"
              onClick={markActiveOutcomesWon}
              disabled={!canWinActiveOutcomes || isSaving}
              title="Mark every active outcome as won"
            >
              <CheckCircle2 aria-hidden="true" />
              <span>WIN ACTIVE</span>
            </button>
          }
          onRemove={(id) =>
            updateDraft((current) => ({
              ...current,
              outcomes: current.outcomes.filter((item) => item.id !== id),
            }))
          }
          renderItem={(item) => (
            <>
              <input
                value={item.title}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    outcomes: current.outcomes.map((entry) =>
                      entry.id === item.id
                        ? { ...entry, title: event.target.value }
                        : entry
                    ),
                  }))
                }
                placeholder="Outcome"
                aria-label="Outcome title"
              />
              <select
                value={item.status}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    outcomes: current.outcomes.map((entry) =>
                      entry.id === item.id
                        ? {
                            ...entry,
                            status:
                              event.target
                                .value as PersonalDashboardOutcome["status"],
                          }
                        : entry
                    ),
                  }))
                }
                aria-label="Outcome status"
              >
                {outcomeStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <input
                value={item.metricLabel ?? ""}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    outcomes: current.outcomes.map((entry) =>
                      entry.id === item.id
                        ? { ...entry, metricLabel: event.target.value }
                        : entry
                    ),
                  }))
                }
                placeholder="Metric"
                aria-label="Outcome metric label"
              />
              <input
                value={item.target ?? ""}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    outcomes: current.outcomes.map((entry) =>
                      entry.id === item.id
                        ? { ...entry, target: event.target.value }
                        : entry
                    ),
                  }))
                }
                placeholder="Target"
                aria-label="Outcome target"
              />
              <input
                className="fp-daily-workflow__row-field--wide"
                value={item.current ?? ""}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    outcomes: current.outcomes.map((entry) =>
                      entry.id === item.id
                        ? { ...entry, current: event.target.value }
                        : entry
                    ),
                  }))
                }
                placeholder="Current value"
                aria-label="Outcome current value"
              />
            </>
          )}
        />

        <div className="fp-daily-workflow__block fp-daily-workflow__block--wide">
          <BlockHeader
            icon={<CheckCircle2 aria-hidden="true" />}
            label="End-of-Day Review"
            status={endOfDayReview.tone}
            actions={
              <button
                type="button"
                className="fp-daily-workflow__icon-btn fp-daily-workflow__icon-btn--quiet"
                onClick={() => void carryForwardTomorrow()}
                disabled={!canCarryForward || carryForwardDailyState.isPending}
                title={`Carry unresolved work to ${tomorrowDateKey}`}
                aria-label={`Carry unresolved work to ${tomorrowDateKey}`}
              >
                <ArrowRight aria-hidden="true" />
              </button>
            }
          />
          <p className="fp-daily-workflow__review-summary">
            {endOfDayReview.summary}
          </p>
          <div className="fp-daily-workflow__review-grid">
            <ReviewMetric
              label="Commitments"
              primary={`${endOfDayReview.commitmentCounts.done}/${endOfDayReview.commitmentCounts.total}`}
              secondary={`${endOfDayReview.commitmentCounts.open} open | ${endOfDayReview.commitmentCounts.waiting} waiting | ${endOfDayReview.commitmentCounts.blocked} blocked`}
            />
            <ReviewMetric
              label="Outcomes"
              primary={`${endOfDayReview.outcomeCounts.won + endOfDayReview.outcomeCounts.missed}/${endOfDayReview.outcomeCounts.total}`}
              secondary={`${endOfDayReview.outcomeCounts.active} active | ${endOfDayReview.outcomeCounts.paused} paused | ${endOfDayReview.outcomeCounts.missed} missed`}
            />
            <ReviewMetric
              label="Plan Blocks"
              primary={`${endOfDayReview.planBlockCounts.done + endOfDayReview.planBlockCounts.skipped}/${endOfDayReview.planBlockCounts.total}`}
              secondary={`${endOfDayReview.planBlockCounts.planned} planned | ${endOfDayReview.planBlockCounts.active} active | ${endOfDayReview.planBlockCounts.skipped} skipped`}
            />
          </div>
          {endOfDayReview.needsAttention.length > 0 ? (
            <ul className="fp-daily-workflow__review-list">
              {endOfDayReview.needsAttention.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ReviewMetric({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary: string;
}) {
  return (
    <div className="fp-daily-workflow__review-metric">
      <span>{label}</span>
      <strong>{primary}</strong>
      <small>{secondary}</small>
    </div>
  );
}

function BlockHeader({
  icon,
  label,
  status,
  actions,
}: {
  icon: ReactNode;
  label: string;
  status: string;
  actions?: ReactNode;
}) {
  return (
    <header className="fp-daily-workflow__block-head">
      <span className="fp-daily-workflow__block-title">
        {icon}
        {label}
      </span>
      <span className="fp-daily-workflow__block-head-actions">
        {actions}
        <span className="mono-label">{status}</span>
      </span>
    </header>
  );
}

function EditableList<T extends { id: string }>({
  title,
  icon,
  items,
  fieldsClassName,
  onAdd,
  actions,
  onRemove,
  renderItem,
  renderRowActions,
}: {
  title: string;
  icon: ReactNode;
  items: T[];
  fieldsClassName?: string;
  onAdd: () => void;
  actions?: ReactNode;
  onRemove: (id: string) => void;
  renderItem: (item: T) => ReactNode;
  renderRowActions?: (item: T) => ReactNode;
}) {
  return (
    <div className="fp-daily-workflow__block">
      <BlockHeader icon={icon} label={title} status={`${items.length}`} />
      {actions ? (
        <div className="fp-daily-workflow__list-actions">{actions}</div>
      ) : null}
      <div className="fp-daily-workflow__list">
        {items.length === 0 ? (
          <p className="fp-empty">none tracked yet.</p>
        ) : (
          items.map((item) => {
            const rowActions = renderRowActions?.(item);
            return (
              <div
                key={item.id}
                className={
                  rowActions
                    ? "fp-daily-workflow__row fp-daily-workflow__row--with-workspace"
                    : "fp-daily-workflow__row"
                }
              >
                <div
                  className={
                    fieldsClassName
                      ? `fp-daily-workflow__row-fields ${fieldsClassName}`
                      : "fp-daily-workflow__row-fields"
                  }
                >
                  {renderItem(item)}
                </div>
                {rowActions}
                <button
                  type="button"
                  className="fp-daily-workflow__icon-btn fp-daily-workflow__icon-btn--quiet"
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remove ${title.slice(0, -1).toLowerCase()}`}
                  title="Remove"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            );
          })
        )}
      </div>
      <button
        type="button"
        className="fp-daily-workflow__add-btn"
        onClick={onAdd}
      >
        <Plus aria-hidden="true" />
        <span>ADD {title.toUpperCase().slice(0, -1)}</span>
      </button>
    </div>
  );
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  return Array.from(byId.values());
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable]")
  );
}
