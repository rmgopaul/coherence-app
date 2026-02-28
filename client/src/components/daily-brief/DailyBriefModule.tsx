import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Calendar, ChevronDown, Copy, Ellipsis, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { DailyBrief, DailyBriefAction, PlanBlock } from "@/lib/dailyBrief";

type DailyBriefModuleProps = {
  brief: DailyBrief | null;
  isLoading: boolean;
  isRegenerating: boolean;
  onRegenerate: () => void;
  onAction: (action: DailyBriefAction) => void;
};

const formatTimeRange = (startIso?: string, endIso?: string) => {
  if (!startIso || !endIso) return "Unscheduled";
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Unscheduled";
  const fmt = (value: Date) =>
    value.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  return `${fmt(start)} - ${fmt(end)}`;
};

const formatGeneratedAt = (generatedAt: string) => {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};

const formatSingleTime = (valueIso?: string) => {
  if (!valueIso) return "-";
  const date = new Date(valueIso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};

const confidenceClasses: Record<NonNullable<PlanBlock["confidence"]>, string> = {
  high: "bg-emerald-100 text-emerald-800 border-emerald-200",
  med: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-rose-100 text-rose-800 border-rose-200",
};

function DailyBriefHeader({
  brief,
  isRegenerating,
  onRegenerate,
  onCopy,
}: {
  brief: DailyBrief;
  isRegenerating: boolean;
  onRegenerate: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Daily Brief</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>Generated {formatGeneratedAt(brief.generatedAt)} using today&apos;s data</span>
          <Badge variant="outline" className={brief.freshness === "fresh" ? "text-emerald-700" : "text-amber-700"}>
            {brief.freshness === "fresh" ? "Fresh" : "Stale"}
          </Badge>
          {brief.mode.type === "low_sleep" ? (
            <Badge
              className="bg-amber-100 text-amber-900"
              title={brief.mode.rationale || "Shorter blocks and extra guardrails are enabled."}
            >
              Low-sleep mode
            </Badge>
          ) : (
            <Badge variant="outline" title={brief.mode.rationale || "Normal mode"}>Normal mode</Badge>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRegenerate}
          disabled={isRegenerating}
          aria-label="Regenerate daily brief"
          className="focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <RefreshCw className={`mr-1.5 h-4 w-4 ${isRegenerating ? "animate-spin" : ""}`} />
          Regenerate
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Daily brief actions" className="h-8 w-8">
              <Ellipsis className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onCopy}>Copy brief</DropdownMenuItem>
            <DropdownMenuItem onClick={() => toast.info("Issue report captured locally")}>Report issue</DropdownMenuItem>
            <DropdownMenuItem onClick={() => toast.info("Use Settings to tune integrations and preferences")}>Settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function MetricChipsRow({
  brief,
  onChipClick,
}: {
  brief: DailyBrief;
  onChipClick: (target: "plan" | "inbox" | "meetings" | "outcomes" | "risks") => void;
}) {
  const chips = [
    {
      key: "plan" as const,
      label: `Deep work available: ${brief.metrics.deepWorkMinutesAvailable} min`,
    },
    {
      key: "meetings" as const,
      label: `Meetings left: ${brief.metrics.meetingsRemaining}`,
    },
    {
      key: "outcomes" as const,
      label: `Tasks due today: ${brief.metrics.tasksDueToday}`,
    },
    {
      key: "inbox" as const,
      label: `Inbox to triage: ${brief.metrics.inboxToTriage}`,
    },
    {
      key: "plan" as const,
      label:
        brief.metrics.recoveryPercent !== undefined || brief.metrics.sleepHours !== undefined
          ? `Energy: ${brief.metrics.recoveryPercent ?? "-"}% (sleep ${brief.metrics.sleepHours?.toFixed(1) ?? "-"}h)`
          : "Health data unavailable; using normal mode",
    },
    {
      key: "risks" as const,
      label: `Hard deadlines today: ${brief.metrics.deadlinesToday ?? 0}`,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-6">
      {chips.map((chip, index) => (
        <button
          key={`${chip.key}-${index}`}
          type="button"
          onClick={() => onChipClick(chip.key)}
          className="rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-xs font-medium text-slate-700 shadow-sm transition hover:bg-emerald-50 hover:text-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          aria-label={`Jump to ${chip.key} section`}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

function ActionButtons({ actions, onAction, limit = 3 }: { actions: DailyBriefAction[]; onAction: (action: DailyBriefAction) => void; limit?: number }) {
  if (!actions || actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {actions.slice(0, limit).map((action) => (
        <Button
          key={`${action.kind}-${action.label}`}
          size="sm"
          variant="outline"
          onClick={() => onAction(action)}
          className="h-8 text-xs"
          aria-label={action.label}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}

function RightNowBlock({ brief, onAction }: { brief: DailyBrief; onAction: (action: DailyBriefAction) => void }) {
  const { focusBlock, adminBlock, breakSuggestion } = brief.rightNow;

  return (
    <Card className="sticky top-24 z-[6] border-emerald-300 bg-gradient-to-r from-emerald-50 via-white to-emerald-100 shadow-[0_10px_24px_rgba(22,101,52,0.12)]">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Right now (next 60-90 min)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-emerald-200 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{focusBlock.title}</span>
            <Badge variant="outline">{focusBlock.durationMinutes} min</Badge>
          </div>
          <p className="mt-1 text-xs text-slate-600">{formatTimeRange(focusBlock.startTime, focusBlock.endTime)}</p>
          <ActionButtons actions={focusBlock.actions} onAction={onAction} />
        </div>

        {adminBlock ? (
          <div className="rounded-md border border-slate-200 bg-white p-3">
            <p className="text-sm font-semibold text-slate-900">{adminBlock.title}</p>
            <p className="mt-1 text-xs text-slate-600">{adminBlock.durationMinutes} min</p>
            <ActionButtons actions={adminBlock.actions} onAction={onAction} limit={2} />
          </div>
        ) : null}

        {breakSuggestion ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {breakSuggestion}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TimeBlockPlanCard({ brief, onAction }: { brief: DailyBrief; onAction: (action: DailyBriefAction) => void }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? brief.timeBlockPlan : brief.timeBlockPlan.slice(0, 3);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Time-block plan (rest of day)</CardTitle>
          <Badge variant="outline">Available deep work: {brief.metrics.deepWorkMinutesAvailable} min</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-xs text-slate-600">
            No deep-work slots. Recommend 2x 15-min bursts + inbox triage.
          </p>
        ) : (
          rows.map((block, idx) => (
            <div key={`${block.title}-${idx}`} className="rounded-md border border-slate-200 bg-white p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">{block.title}</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">{formatTimeRange(block.startTime, block.endTime)}</span>
                  {block.confidence ? (
                    <Badge variant="outline" className={confidenceClasses[block.confidence]}>
                      {block.confidence}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <ActionButtons actions={block.actions} onAction={onAction} limit={2} />
            </div>
          ))
        )}

        {brief.timeBlockPlan.length > 3 ? (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((prev) => !prev)} className="text-xs">
            {expanded ? "Show less" : `Show all (${brief.timeBlockPlan.length})`}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InboxTriageCard({ brief, onAction }: { brief: DailyBrief; onAction: (action: DailyBriefAction) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedDraftIds, setExpandedDraftIds] = useState<Record<string, boolean>>({});
  const [activeDraftItemId, setActiveDraftItemId] = useState<string | null>(null);

  const rows = expanded ? brief.inboxTriage : brief.inboxTriage.slice(0, 3);
  const activeDraftItem = rows.find((item) => item.id === activeDraftItemId) || null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Inbox triage (Top 5)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-xs text-slate-600">
            You&apos;re clear. Pick an outcome and block 45 minutes.
          </p>
        ) : (
          rows.map((item) => {
            const showDraft = Boolean(expandedDraftIds[item.id]);
            const urgencyClass =
              item.urgency === "high"
                ? "bg-rose-100 text-rose-800"
                : item.urgency === "med"
                  ? "bg-amber-100 text-amber-800"
                  : "bg-slate-100 text-slate-700";

            return (
              <div key={item.id} className="rounded-md border border-slate-200 bg-white p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                  <Badge className={urgencyClass}>{item.urgency || "med"}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-600">{item.from}</p>
                <p className="mt-1 text-xs text-slate-700">Recommended: {item.recommendedAction}</p>

                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() =>
                      onAction({
                        label: "Open",
                        kind: "open_email",
                        payload: { url: item.sourceRef.url, id: item.sourceRef.id },
                      })
                    }
                  >
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => {
                      setActiveDraftItemId(item.id);
                      onAction({
                        label: "Insert draft",
                        kind: "insert_draft",
                        payload: { text: item.draftReply || "" },
                      });
                    }}
                  >
                    Insert draft
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() =>
                      onAction({
                        label: "Make task",
                        kind: "create_task",
                        payload: { content: item.title, sourceId: item.sourceRef.id },
                      })
                    }
                  >
                    Make task
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() =>
                      onAction({
                        label: "Archive",
                        kind: "open_email",
                        payload: { url: item.sourceRef.url, archiveHint: true, id: item.sourceRef.id },
                      })
                    }
                  >
                    Archive
                  </Button>
                </div>

                {item.draftReply ? (
                  <div className="mt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-1.5 text-xs"
                      onClick={() =>
                        setExpandedDraftIds((prev) => ({
                          ...prev,
                          [item.id]: !prev[item.id],
                        }))
                      }
                    >
                      {showDraft ? "Hide draft" : "Show draft"}
                    </Button>
                    {showDraft ? (
                      <p className="mt-1 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">{item.draftReply}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}

        {brief.inboxTriage.length > 3 ? (
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => setExpanded((prev) => !prev)}>
            {expanded ? "Show less" : "Show all"}
          </Button>
        ) : null}

        {activeDraftItem && activeDraftItem.draftReply ? (
          <div className="fixed bottom-3 left-3 right-3 z-20 rounded-lg border border-slate-300 bg-white p-2 shadow-xl lg:hidden">
            <div className="flex items-center justify-between gap-2 text-xs text-slate-600">
              <span>Draft actions</span>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setActiveDraftItemId(null)}>
                Close
              </Button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Button size="sm" className="h-8 text-xs" onClick={() => onAction({ label: "Insert draft", kind: "insert_draft", payload: { text: activeDraftItem.draftReply } })}>Insert draft</Button>
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onAction({ label: "Open", kind: "open_email", payload: { url: activeDraftItem.sourceRef.url } })}>Open</Button>
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onAction({ label: "Make task", kind: "create_task", payload: { content: activeDraftItem.title } })}>Make task</Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OutcomesCard({ brief, onAction }: { brief: DailyBrief; onAction: (action: DailyBriefAction) => void }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Top outcomes (3)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {brief.outcomes.length === 0 ? (
          <p className="text-xs text-slate-600">Pick one meaningful outcome and start a 45-minute block.</p>
        ) : (
          brief.outcomes.slice(0, 3).map((outcome) => {
            const stepsTotal = outcome.steps?.length || 0;
            const progress = stepsTotal > 0 ? Math.min(100, Math.round((1 / stepsTotal) * 100)) : 0;
            return (
              <div key={outcome.id} className="rounded-md border border-slate-200 bg-white p-2.5">
                <p className="text-sm font-semibold text-slate-900">{outcome.title}</p>
                <p className="mt-1 text-xs text-slate-600">{outcome.why}</p>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-slate-200">
                  <div className="h-full bg-emerald-500" style={{ width: `${progress}%` }} />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => onAction({ label: "Add step", kind: "create_task", payload: { content: `${outcome.title} - next step` } })}
                  >
                    Add step
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => onAction({ label: "Link task", kind: "open_task", payload: { url: outcome.sourceRefs?.[0]?.url } })}
                  >
                    Link task
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function NextMeetingsCard({ brief, onAction }: { brief: DailyBrief; onAction: (action: DailyBriefAction) => void }) {
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  if (brief.nextMeetings.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Next meetings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {brief.nextMeetings.slice(0, 2).map((meeting) => {
          const isOpen = Boolean(openMap[meeting.sourceRef.id]);
          return (
            <div key={meeting.sourceRef.id} className="rounded-md border border-slate-200 bg-white p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">{meeting.eventTitle}</p>
                <span className="text-xs text-slate-500">{formatSingleTime(meeting.startTime)}</span>
              </div>
              <p className="mt-1 text-xs text-slate-600">Linked notes: {meeting.linkedNotes}</p>

              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-7 px-1.5 text-xs"
                onClick={() => setOpenMap((prev) => ({ ...prev, [meeting.sourceRef.id]: !prev[meeting.sourceRef.id] }))}
              >
                {isOpen ? "Hide prep pack" : "Show prep pack"}
              </Button>

              {isOpen ? (
                <div className="mt-2 space-y-1 text-xs text-slate-700">
                  {(meeting.openLoops || []).slice(0, 3).map((loop, idx) => (
                    <p key={`loop-${idx}`}>- {loop}</p>
                  ))}
                  {(meeting.talkingPoints || []).slice(0, 3).map((point, idx) => (
                    <p key={`point-${idx}`}>- {point}</p>
                  ))}
                  {meeting.desiredOutcome ? <p className="text-slate-600">Outcome: {meeting.desiredOutcome}</p> : null}
                </div>
              ) : null}

              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onAction({ label: "Open linked note", kind: "open_note", payload: { url: `/notes?eventId=${encodeURIComponent(meeting.sourceRef.id)}` } })}
                >
                  Open linked note
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onAction({ label: "Create agenda note", kind: "open_note", payload: { url: `/notes?eventId=${encodeURIComponent(meeting.sourceRef.id)}&new=1` } })}
                >
                  Create agenda note
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onAction({ label: "View series notes", kind: "open_note", payload: { url: `/notes?seriesId=${encodeURIComponent(meeting.sourceRef.id)}` } })}
                >
                  View series notes
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function DecisionsWaitingCard({ brief, onAction }: { brief: DailyBrief; onAction: (action: DailyBriefAction) => void }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Decisions &amp; Waiting on</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Decisions</p>
          <div className="mt-1 space-y-2">
            {brief.decisions.slice(0, 3).map((item, idx) => (
              <div key={`decision-${idx}`} className="rounded-md border border-slate-200 bg-white p-2">
                <p className="text-xs font-medium text-slate-900">{item.decision}</p>
                {item.dueBy ? <p className="mt-0.5 text-[11px] text-slate-500">Due {new Date(item.dueBy).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</p> : null}
                {item.suggestedMessage ? <p className="mt-1 text-[11px] text-slate-700">{item.suggestedMessage}</p> : null}
              </div>
            ))}
            {brief.decisions.length === 0 ? <p className="text-xs text-slate-500">No explicit decisions queued.</p> : null}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Waiting on</p>
          <div className="mt-1 space-y-2">
            {brief.waitingOn.slice(0, 3).map((item, idx) => (
              <div key={`waiting-${idx}`} className="rounded-md border border-slate-200 bg-white p-2">
                <p className="text-xs font-medium text-slate-900">{item.person}</p>
                <p className="mt-0.5 text-[11px] text-slate-700">{item.blocker}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1.5 h-7 text-xs"
                  onClick={() => onAction({ label: "Send nudge", kind: "send_message", payload: { text: item.suggestedNudge || "Quick follow-up on this blocker." } })}
                >
                  Send nudge
                </Button>
              </div>
            ))}
            {brief.waitingOn.length === 0 ? <p className="text-xs text-slate-500">No active blockers waiting on others.</p> : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RisksCard({ brief }: { brief: DailyBrief }) {
  const severeCount = brief.risks.filter((risk) => risk.severity === "high").length;
  const defaultOpen = severeCount > 0;

  if (brief.risks.length === 0) return null;

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-4 w-4 text-rose-600" />
              Risks
            </CardTitle>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </CollapsibleTrigger>
          </div>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-2">
            {brief.risks.map((risk, idx) => (
              <div key={`risk-${idx}`} className="rounded-md border border-rose-200 bg-rose-50 p-2.5">
                <p className="text-xs font-semibold text-rose-900">{risk.risk}</p>
                <p className="mt-0.5 text-xs text-rose-800">Mitigation: {risk.mitigation}</p>
              </div>
            ))}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export function DailyBriefModule({ brief, isLoading, isRegenerating, onRegenerate, onAction }: DailyBriefModuleProps) {
  const planRef = useRef<HTMLDivElement | null>(null);
  const inboxRef = useRef<HTMLDivElement | null>(null);
  const meetingsRef = useRef<HTMLDivElement | null>(null);
  const outcomesRef = useRef<HTMLDivElement | null>(null);
  const risksRef = useRef<HTMLDivElement | null>(null);

  const copyBrief = () => {
    if (!brief) return;
    const text = JSON.stringify(brief, null, 2);
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Daily brief copied"))
      .catch(() => toast.error("Failed to copy brief"));
  };

  const scrollTo = (target: "plan" | "inbox" | "meetings" | "outcomes" | "risks") => {
    const map = {
      plan: planRef,
      inbox: inboxRef,
      meetings: meetingsRef,
      outcomes: outcomesRef,
      risks: risksRef,
    } as const;

    const node = map[target].current;
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!brief && isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Building your daily brief...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!brief) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-slate-600">
          Brief unavailable. Regenerate to build a schedule-aware plan.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" aria-label="Daily brief module">
      <Card>
        <CardContent className="space-y-3 p-4">
          <DailyBriefHeader brief={brief} isRegenerating={isRegenerating} onRegenerate={onRegenerate} onCopy={copyBrief} />
          <MetricChipsRow brief={brief} onChipClick={scrollTo} />
        </CardContent>
      </Card>

      <RightNowBlock brief={brief} onAction={onAction} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div className="space-y-3 lg:col-span-8">
          <div ref={planRef}>
            <TimeBlockPlanCard brief={brief} onAction={onAction} />
          </div>
          <div ref={inboxRef}>
            <InboxTriageCard brief={brief} onAction={onAction} />
          </div>
        </div>

        <div className="space-y-3 lg:col-span-4">
          <div ref={outcomesRef}>
            <OutcomesCard brief={brief} onAction={onAction} />
          </div>
          <div ref={meetingsRef}>
            <NextMeetingsCard brief={brief} onAction={onAction} />
          </div>
          <DecisionsWaitingCard brief={brief} onAction={onAction} />
          <div ref={risksRef}>
            <RisksCard brief={brief} />
          </div>
        </div>
      </div>
    </div>
  );
}
