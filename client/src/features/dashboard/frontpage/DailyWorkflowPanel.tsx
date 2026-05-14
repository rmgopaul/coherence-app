import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ClipboardList,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
import type {
  PersonalDashboardCommitment,
  PersonalDashboardOutcome,
} from "@shared/personalDashboard";
import type { DashboardData } from "../useDashboardData";
import {
  buildCommitmentDraft,
  buildDailyBriefDraft,
  buildOutcomeDraft,
  buildTodayPlanDraft,
  dailyWorkflowDraftFromState,
  emptyDailyWorkflowDraft,
  normalizeDailyWorkflowDraftForSave,
  type DailyWorkflowDraft,
} from "./dailyWorkflow.helpers";

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

  const loadedKey = `${state.data?.dateKey ?? dateKey}:${
    state.data?.updatedAt ?? "empty"
  }`;

  useEffect(() => {
    if (dirty) return;
    setDraft(dailyWorkflowDraftFromState(state.data));
  }, [dirty, loadedKey, state.data]);

  const canSeed = Boolean(commandCenter);
  const isSaving = saveDailyState.isPending;

  function updateDraft(
    updater: (current: DailyWorkflowDraft) => DailyWorkflowDraft
  ) {
    setDirty(true);
    setDraft(updater);
  }

  function seedFromCommandCenter() {
    if (!commandCenter) return;
    const now = new Date();
    const nextCommitment = buildCommitmentDraft(commandCenter, now);
    const nextOutcome = buildOutcomeDraft(commandCenter, now);

    updateDraft((current) => ({
      ...current,
      dailyBriefStatus: "draft",
      dailyBrief: buildDailyBriefDraft(commandCenter, now),
      todayPlanStatus: "draft",
      todayPlan: buildTodayPlanDraft(commandCenter, now),
      commitments: dedupeById([
        ...(nextCommitment ? [nextCommitment] : []),
        ...current.commitments,
      ]),
      outcomes: dedupeById([nextOutcome, ...current.outcomes]),
    }));
  }

  async function save() {
    const normalized = normalizeDailyWorkflowDraftForSave(draft, new Date());
    try {
      await saveDailyState.mutateAsync({
        dateKey,
        dailyBriefStatus: normalized.dailyBriefStatus,
        dailyBrief: normalized.dailyBrief.headline
          ? normalized.dailyBrief
          : null,
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
  }

  function addCommitment() {
    updateDraft((current) => ({
      ...current,
      commitments: [
        ...current.commitments,
        {
          id: `commitment:manual:${Date.now()}`,
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
          id: `outcome:manual:${Date.now()}`,
          title: "",
          status: "active",
          metricLabel: "Progress",
          target: null,
          current: null,
        },
      ],
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
            onClick={() => {
              setDraft(dailyWorkflowDraftFromState(state.data));
              setDirty(false);
            }}
            disabled={!dirty || isSaving}
            title="Discard unsaved edits"
            aria-label="Discard unsaved edits"
          >
            <RefreshCw aria-hidden="true" />
          </button>
          <button
            type="button"
            className="fp-daily-workflow__action-btn"
            onClick={() => void save()}
            disabled={isSaving || !dirty}
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
          title="Commitments"
          icon={<ClipboardList aria-hidden="true" />}
          items={draft.commitments}
          onAdd={addCommitment}
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
            </>
          )}
        />

        <EditableList
          title="Outcomes"
          icon={<Target aria-hidden="true" />}
          items={draft.outcomes}
          onAdd={addOutcome}
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
            </>
          )}
        />
      </div>
    </section>
  );
}

function BlockHeader({
  icon,
  label,
  status,
}: {
  icon: ReactNode;
  label: string;
  status: string;
}) {
  return (
    <header className="fp-daily-workflow__block-head">
      <span className="fp-daily-workflow__block-title">
        {icon}
        {label}
      </span>
      <span className="mono-label">{status}</span>
    </header>
  );
}

function EditableList<T extends { id: string }>({
  title,
  icon,
  items,
  onAdd,
  onRemove,
  renderItem,
}: {
  title: string;
  icon: ReactNode;
  items: T[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  renderItem: (item: T) => ReactNode;
}) {
  return (
    <div className="fp-daily-workflow__block">
      <BlockHeader icon={icon} label={title} status={`${items.length}`} />
      <div className="fp-daily-workflow__list">
        {items.length === 0 ? (
          <p className="fp-empty">none tracked yet.</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="fp-daily-workflow__row">
              <div className="fp-daily-workflow__row-fields">
                {renderItem(item)}
              </div>
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
          ))
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
