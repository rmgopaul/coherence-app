export type SourceRef = {
  kind: "email" | "event" | "task" | "note" | "thread";
  id: string;
  url?: string;
};

export type DailyBriefAction = {
  label: string;
  kind:
    | "open_email"
    | "open_event"
    | "open_task"
    | "open_note"
    | "insert_draft"
    | "create_task"
    | "schedule_block"
    | "send_message";
  payload: Record<string, unknown>;
};

export type PlanBlock = {
  startTime?: string;
  endTime?: string;
  durationMinutes: number;
  title: string;
  type: "focus" | "admin" | "meeting_prep" | "break";
  confidence?: "high" | "med" | "low";
  actions: DailyBriefAction[];
  sourceRefs?: SourceRef[];
};

export type DailyBrief = {
  generatedAt: string;
  freshness: "fresh" | "stale";
  mode: { type: "normal" | "low_sleep"; rationale?: string };
  metrics: {
    deepWorkMinutesAvailable: number;
    meetingsRemaining: number;
    tasksDueToday: number;
    inboxToTriage: number;
    sleepHours?: number;
    recoveryPercent?: number;
    deadlinesToday?: number;
  };
  outcomes: Array<{
    id: string;
    title: string;
    why: string;
    steps?: string[];
    sourceRefs?: SourceRef[];
  }>;
  rightNow: {
    focusBlock: PlanBlock;
    adminBlock?: PlanBlock;
    breakSuggestion?: string;
  };
  timeBlockPlan: Array<PlanBlock>;
  inboxTriage: Array<{
    id: string;
    title: string;
    from: string;
    recommendedAction: "reply" | "draft" | "schedule" | "archive" | "delegate";
    neededInfo?: string[];
    draftReply?: string;
    urgency?: "high" | "med" | "low";
    sourceRef: SourceRef;
  }>;
  nextMeetings: Array<{
    eventTitle: string;
    startTime: string;
    linkedNotes: number;
    openLoops?: string[];
    talkingPoints?: string[];
    desiredOutcome?: string;
    sourceRef: SourceRef;
  }>;
  decisions: Array<{
    decision: string;
    dueBy?: string;
    suggestedMessage?: string;
    sourceRefs?: SourceRef[];
  }>;
  waitingOn: Array<{
    person: string;
    blocker: string;
    suggestedNudge?: string;
    sourceRefs?: SourceRef[];
  }>;
  risks: Array<{
    risk: string;
    severity: "high" | "med" | "low";
    mitigation: string;
    owner?: string;
    dueBy?: string;
    sourceRefs?: SourceRef[];
  }>;
  later?: Array<{ title: string; sourceRefs?: SourceRef[] }>;
};

export type PrioritizedEmailInput = {
  id: string;
  threadId?: string;
  from: string;
  to?: string;
  subject: string;
  snippet?: string;
  date?: string;
  reason?: string;
  score: number;
  url?: string;
};

export type BuildDailyBriefInput = {
  now: Date;
  todayKey: string;
  calendarEvents: any[];
  todoistTasks: any[];
  prioritizedEmails: PrioritizedEmailInput[];
  waitingOnEmails?: PrioritizedEmailInput[];
  whoopSummary?: any | null;
  samsungHealthSnapshot?: any | null;
  notes?: any[];
};

type CalendarEventWindow = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  htmlLink?: string;
  recurringId?: string;
};

type TimeWindow = { start: Date; end: Date };

const MINUTE_MS = 60 * 1000;

const toFinite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const clampMinutes = (value: number) => Math.max(0, Math.round(value));

const asIso = (date: Date | null | undefined) => (date ? date.toISOString() : undefined);

const startOfLocalDay = (date: Date) => {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
};

const endOfLocalDay = (date: Date) => {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
};

const parseEventWindow = (event: any): CalendarEventWindow | null => {
  const id = String(event?.id || "").trim();
  const title = String(event?.summary || "Untitled event").trim() || "Untitled event";
  const startRaw = event?.start?.dateTime || event?.start?.date;
  const endRaw = event?.end?.dateTime || event?.end?.date;
  if (!startRaw) return null;

  const isAllDay = !event?.start?.dateTime && !!event?.start?.date;
  const start = new Date(isAllDay ? `${startRaw}T00:00:00` : startRaw);
  if (Number.isNaN(start.getTime())) return null;

  let end: Date;
  if (endRaw) {
    end = new Date(isAllDay ? `${endRaw}T00:00:00` : endRaw);
    if (Number.isNaN(end.getTime())) {
      end = new Date(start.getTime() + (isAllDay ? 24 * 60 * MINUTE_MS : 30 * MINUTE_MS));
    }
  } else {
    end = new Date(start.getTime() + (isAllDay ? 24 * 60 * MINUTE_MS : 30 * MINUTE_MS));
  }

  if (end.getTime() <= start.getTime()) {
    end = new Date(start.getTime() + 30 * MINUTE_MS);
  }

  return {
    id,
    title,
    start,
    end,
    isAllDay,
    htmlLink: typeof event?.htmlLink === "string" ? event.htmlLink : undefined,
    recurringId:
      typeof event?.recurringEventId === "string"
        ? event.recurringEventId
        : typeof event?.iCalUID === "string"
          ? event.iCalUID
          : undefined,
  };
};

const mergeWindows = (windows: TimeWindow[]): TimeWindow[] => {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: TimeWindow[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
      continue;
    }
    merged.push({ start: new Date(current.start), end: new Date(current.end) });
  }

  return merged;
};

const buildFreeWindows = (start: Date, end: Date, busyWindows: TimeWindow[]): TimeWindow[] => {
  const mergedBusy = mergeWindows(
    busyWindows
      .map((window) => ({
        start: new Date(Math.max(window.start.getTime(), start.getTime())),
        end: new Date(Math.min(window.end.getTime(), end.getTime())),
      }))
      .filter((window) => window.end.getTime() > window.start.getTime())
  );

  if (mergedBusy.length === 0) {
    return [{ start, end }];
  }

  const windows: TimeWindow[] = [];
  let cursor = start;

  for (const busy of mergedBusy) {
    if (busy.start.getTime() > cursor.getTime()) {
      windows.push({ start: new Date(cursor), end: new Date(busy.start) });
    }
    if (busy.end.getTime() > cursor.getTime()) {
      cursor = new Date(busy.end);
    }
  }

  if (cursor.getTime() < end.getTime()) {
    windows.push({ start: cursor, end });
  }

  return windows.filter((window) => window.end.getTime() > window.start.getTime());
};

const getLinkedNoteCountForEvent = (event: CalendarEventWindow, notes: any[]): number => {
  if (!Array.isArray(notes) || notes.length === 0) return 0;

  const matchesEvent = (link: any) => {
    if (!link || link.linkType !== "google_calendar_event") return false;
    const externalId = String(link.externalId || "");
    if (externalId && externalId === event.id) return true;

    const seriesId = String(link.seriesId || "");
    if (seriesId && event.recurringId && seriesId === event.recurringId) return true;

    return false;
  };

  return notes.filter((note: any) => {
    const links = Array.isArray(note?.links) ? note.links : [];
    return links.some(matchesEvent);
  }).length;
};

const deriveHealthMode = (whoopSummary: any | null | undefined, samsungSnapshot: any | null | undefined) => {
  const sleepHours =
    toFinite(whoopSummary?.sleepHours) ??
    (toFinite(samsungSnapshot?.sleepTotalMinutes) !== null
      ? Number((Number(samsungSnapshot.sleepTotalMinutes) / 60).toFixed(1))
      : undefined);

  const recoveryPercent =
    toFinite(whoopSummary?.recoveryScore) ?? toFinite(samsungSnapshot?.energyScore) ?? undefined;

  const lowSleep =
    (typeof sleepHours === "number" && sleepHours < 5) ||
    (typeof recoveryPercent === "number" && recoveryPercent < 45);

  if (lowSleep) {
    return {
      type: "low_sleep" as const,
      rationale:
        typeof sleepHours === "number"
          ? `Sleep ${sleepHours.toFixed(1)}h suggests reduced cognitive reserve.`
          : "Recovery signal suggests reduced cognitive reserve.",
      sleepHours,
      recoveryPercent,
    };
  }

  return {
    type: "normal" as const,
    rationale:
      typeof sleepHours === "number"
        ? `Sleep ${sleepHours.toFixed(1)}h supports standard focus blocks.`
        : "Health data unavailable; using normal mode.",
    sleepHours,
    recoveryPercent,
  };
};

const guessRecommendedAction = (email: PrioritizedEmailInput): DailyBrief["inboxTriage"][number]["recommendedAction"] => {
  const blob = `${email.subject} ${email.reason || ""} ${email.snippet || ""}`.toLowerCase();
  if (/(schedule|meeting|calendar|slot|time)/.test(blob)) return "schedule";
  if (/(fyi|newsletter|receipt|confirm|done)/.test(blob)) return "archive";
  if (/(delegate|owner|assign)/.test(blob)) return "delegate";
  if (/(draft|review)/.test(blob)) return "draft";
  return "reply";
};

const urgencyFromScore = (score: number): "high" | "med" | "low" => {
  if (score >= 4) return "high";
  if (score >= 2) return "med";
  return "low";
};

const eventSourceRef = (event: CalendarEventWindow): SourceRef => ({
  kind: "event",
  id: event.id,
  url: event.htmlLink,
});

const taskSourceRef = (task: any): SourceRef => ({
  kind: "task",
  id: String(task?.id || ""),
  url: `https://todoist.com/app/task/${String(task?.id || "")}`,
});

const emailSourceRef = (email: PrioritizedEmailInput): SourceRef => ({
  kind: "email",
  id: email.threadId || email.id,
  url: email.url || `https://mail.google.com/mail/u/0/#inbox/${email.id}`,
});

const getDurationMinutes = (window: TimeWindow) =>
  clampMinutes((window.end.getTime() - window.start.getTime()) / MINUTE_MS);

const planBlockFromWindow = (window: TimeWindow, title: string, type: PlanBlock["type"], confidence: PlanBlock["confidence"], actions: DailyBriefAction[], sourceRefs?: SourceRef[]): PlanBlock => ({
  startTime: asIso(window.start),
  endTime: asIso(window.end),
  durationMinutes: getDurationMinutes(window),
  title,
  type,
  confidence,
  actions,
  sourceRefs,
});

export const MOCK_DAILY_BRIEF: DailyBrief = {
  generatedAt: new Date().toISOString(),
  freshness: "fresh",
  mode: { type: "normal", rationale: "Mock fallback: using normal planning mode." },
  metrics: {
    deepWorkMinutesAvailable: 95,
    meetingsRemaining: 3,
    tasksDueToday: 7,
    inboxToTriage: 4,
    sleepHours: 6.8,
    recoveryPercent: 72,
    deadlinesToday: 2,
  },
  outcomes: [
    {
      id: "outcome-1",
      title: "Close critical approval loop",
      why: "Unblocks downstream work and reduces same-day escalation risk.",
      steps: ["Verify required docs", "Send approval update", "Log evidence in tracker"],
      sourceRefs: [{ kind: "task", id: "mock-task-1", url: "https://todoist.com" }],
    },
    {
      id: "outcome-2",
      title: "Prep for next meeting with clear asks",
      why: "Improves decision quality and avoids follow-up churn.",
      steps: ["Review prior notes", "Draft top 3 asks"],
    },
    {
      id: "outcome-3",
      title: "Triage priority inbox threads",
      why: "Prevents waiting-on blockers from compounding.",
      steps: ["Reply to two urgent threads", "Convert one thread to task"],
    },
  ],
  rightNow: {
    focusBlock: {
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 45 * MINUTE_MS).toISOString(),
      durationMinutes: 45,
      title: "Focus: close top-priority task",
      type: "focus",
      confidence: "med",
      actions: [
        { label: "Start focus", kind: "schedule_block", payload: { durationMinutes: 45 } },
        { label: "Open task", kind: "open_task", payload: { url: "https://todoist.com" } },
      ],
      sourceRefs: [{ kind: "task", id: "mock-task-1", url: "https://todoist.com" }],
    },
    adminBlock: {
      durationMinutes: 15,
      title: "Admin sprint: inbox triage",
      type: "admin",
      confidence: "med",
      actions: [{ label: "Open inbox", kind: "open_email", payload: { url: "https://mail.google.com" } }],
    },
  },
  timeBlockPlan: [],
  inboxTriage: [],
  nextMeetings: [],
  decisions: [],
  waitingOn: [],
  risks: [],
};

export function buildDailyBrief(input: BuildDailyBriefInput): DailyBrief {
  const now = input.now;
  const dayStart = startOfLocalDay(now);
  const dayEnd = endOfLocalDay(now);

  const events = (input.calendarEvents || [])
    .map(parseEventWindow)
    .filter((event): event is CalendarEventWindow => Boolean(event));

  const todaysEvents = events.filter((event) =>
    event.start.getTime() < dayEnd.getTime() && event.end.getTime() > dayStart.getTime()
  );

  const remainingMeetings = todaysEvents.filter((event) => event.end.getTime() > now.getTime());
  const busyWindows = remainingMeetings.map((event) => ({ start: event.start, end: event.end }));
  const freeWindows = buildFreeWindows(now, dayEnd, busyWindows);

  const health = deriveHealthMode(input.whoopSummary, input.samsungHealthSnapshot);
  const focusTargetMinutes = health.type === "low_sleep" ? 30 : 45;
  const adminTargetMinutes = 15;

  const deepWorkMinutesAvailable = freeWindows
    .map(getDurationMinutes)
    .filter((minutes) => minutes >= (health.type === "low_sleep" ? 20 : 30))
    .reduce((sum, minutes) => sum + minutes, 0);

  const deadlinesToday = (input.todoistTasks || []).filter((task) => {
    const due = String(task?.due?.date || "");
    return due === input.todayKey;
  }).length;

  const topTask = (input.todoistTasks || [])[0] || null;
  const topEvent = remainingMeetings[0] || null;

  const largestFreeWindow = [...freeWindows].sort((a, b) => getDurationMinutes(b) - getDurationMinutes(a))[0] || null;

  const focusWindow: TimeWindow = largestFreeWindow
    ? {
        start: largestFreeWindow.start,
        end: new Date(
          Math.min(
            largestFreeWindow.end.getTime(),
            largestFreeWindow.start.getTime() + focusTargetMinutes * MINUTE_MS
          )
        ),
      }
    : {
        start: now,
        end: new Date(now.getTime() + focusTargetMinutes * MINUTE_MS),
      };

  const focusTitle = topTask
    ? `Focus: ${String(topTask.content || "Top priority task")}`
    : topEvent
      ? `Focus prep: ${topEvent.title}`
      : "Focus block: top outcome";

  const focusActions: DailyBriefAction[] = [
    {
      label: "Start focus",
      kind: "schedule_block",
      payload: {
        title: focusTitle,
        startTime: asIso(focusWindow.start),
        endTime: asIso(focusWindow.end),
      },
    },
  ];

  if (topTask) {
    focusActions.push({
      label: "Open relevant source",
      kind: "open_task",
      payload: { url: `https://todoist.com/app/task/${String(topTask.id || "")}` },
    });
  } else if (topEvent) {
    focusActions.push({
      label: "Open relevant source",
      kind: "open_event",
      payload: { url: topEvent.htmlLink || "https://calendar.google.com" },
    });
  }

  focusActions.push({
    label: "Snooze 30m",
    kind: "schedule_block",
    payload: {
      title: `${focusTitle} (Snoozed)`,
      startTime: asIso(new Date(now.getTime() + 30 * MINUTE_MS)),
      endTime: asIso(new Date(now.getTime() + (30 + focusTargetMinutes) * MINUTE_MS)),
    },
  });

  const focusRefs = topTask ? [taskSourceRef(topTask)] : topEvent ? [eventSourceRef(topEvent)] : [];

  const rightNowFocusBlock: PlanBlock = planBlockFromWindow(
    focusWindow,
    focusTitle,
    "focus",
    largestFreeWindow ? "high" : "med",
    focusActions,
    focusRefs
  );

  const adminBlock: PlanBlock = {
    durationMinutes: adminTargetMinutes,
    title: "Admin sprint: triage inbox and clarify asks",
    type: "admin",
    confidence: input.prioritizedEmails.length > 0 ? "high" : "med",
    actions: [
      {
        label: "Open inbox view",
        kind: "open_email",
        payload: { url: "https://mail.google.com/mail/u/0/#inbox" },
      },
    ],
    sourceRefs: input.prioritizedEmails[0] ? [emailSourceRef(input.prioritizedEmails[0])] : undefined,
  };

  const outcomes = (input.todoistTasks || [])
    .slice(0, 3)
    .map((task, index) => ({
      id: `outcome-task-${String(task.id || index)}`,
      title: String(task.content || `Outcome ${index + 1}`),
      why: index === 0 ? "Most time-sensitive commitment due today." : "Keeps momentum on top commitments.",
      steps: ["Define done state", "Execute first meaningful step", "Confirm next dependency"],
      sourceRefs: [taskSourceRef(task)],
    }));

  if (outcomes.length < 3 && input.prioritizedEmails.length > 0) {
    for (const email of input.prioritizedEmails) {
      if (outcomes.length >= 3) break;
      outcomes.push({
        id: `outcome-email-${email.id}`,
        title: `Resolve: ${email.subject}`,
        why: "Reduces waiting-on dependencies in active threads.",
        steps: ["Review context", "Send concise update"],
        sourceRefs: [emailSourceRef(email)],
      });
    }
  }

  const inboxTriage = input.prioritizedEmails.slice(0, 5).map((email) => {
    const action = guessRecommendedAction(email);
    return {
      id: email.id,
      title: email.subject,
      from: email.from || "Unknown sender",
      recommendedAction: action,
      neededInfo: ["Owner", "Deadline", "Expected output"],
      draftReply: `Hi ${email.from?.split("<")[0]?.trim() || "there"}, quick update: I reviewed this and will send a concrete next step by today.`,
      urgency: urgencyFromScore(email.score),
      sourceRef: emailSourceRef(email),
    };
  });

  const nextMeetings = remainingMeetings.slice(0, 2).map((event) => {
    const linkedNotes = getLinkedNoteCountForEvent(event, input.notes || []);
    return {
      eventTitle: event.title,
      startTime: event.start.toISOString(),
      linkedNotes,
      openLoops:
        linkedNotes > 0
          ? ["Review unresolved actions in linked note", "Confirm owner + deadline for prior ask"]
          : ["No linked note yet"],
      talkingPoints: ["Current status", "Top blocker", "Decision needed"],
      desiredOutcome: "Leave with one owner and one due date for each open item.",
      sourceRef: eventSourceRef(event),
    };
  });

  const decisions: DailyBrief["decisions"] = input.prioritizedEmails.slice(0, 3).map((email) => {
    const urgency = urgencyFromScore(email.score);
    const dueBy =
      urgency === "high"
        ? new Date(now.getTime() + 90 * MINUTE_MS).toISOString()
        : urgency === "med"
          ? new Date(now.getTime() + 3 * 60 * MINUTE_MS).toISOString()
          : undefined;

    return {
      decision: `Inbox action: ${email.subject}`,
      dueBy,
      suggestedMessage:
        urgency === "high"
          ? "Reply with owner + deadline now, then convert follow-up to a task."
          : "Triage this thread and send the next clear action.",
      sourceRefs: [emailSourceRef(email)],
    };
  });

  if (decisions.length < 3 && topTask) {
    decisions.push({
      decision: `Commit first deep block to: ${String(topTask.content || "Top task")}`,
      dueBy: focusWindow.end.toISOString(),
      suggestedMessage: "I’m prioritizing this first block and will send status by end of block.",
      sourceRefs: [taskSourceRef(topTask)],
    });
  }

  if (decisions.length < 3 && topEvent) {
    decisions.push({
      decision: `Define desired outcome for ${topEvent.title}`,
      dueBy: topEvent.start.toISOString(),
      suggestedMessage: "Goal for this meeting: leave with owner + date on next step.",
      sourceRefs: [eventSourceRef(topEvent)],
    });
  }

  const waitingCandidates = (input.waitingOnEmails && input.waitingOnEmails.length > 0
    ? input.waitingOnEmails
    : input.prioritizedEmails
  )
    .filter((email) => Boolean(email?.subject))
    .slice(0, 6);

  const seenWaiting = new Set<string>();
  const waitingOn: DailyBrief["waitingOn"] = waitingCandidates
    .filter((email) => {
      const key = String(email.threadId || email.id || email.subject).toLowerCase();
      if (seenWaiting.has(key)) return false;
      seenWaiting.add(key);
      return true;
    })
    .slice(0, 3)
    .map((email) => {
      const recipient = String(email.to || email.from || "").trim();
      const person = recipient || "Recipient";
      return {
        person,
        blocker: email.subject,
        suggestedNudge: `Quick follow-up on "${email.subject}" — can you share status and ETA today?`,
        sourceRefs: [emailSourceRef(email)],
      };
    });

  const risks: DailyBrief["risks"] = [];
  if (deepWorkMinutesAvailable < focusTargetMinutes && input.todoistTasks.length > 0) {
    risks.push({
      risk: "Insufficient deep-work capacity for due tasks today.",
      severity: "high",
      mitigation: "Switch to two 15-minute execution bursts and protect one block before end of day.",
      owner: "You",
      dueBy: new Date(now.getTime() + 2 * 60 * MINUTE_MS).toISOString(),
    });
  }

  if (health.type === "low_sleep") {
    risks.push({
      risk: "Low-sleep mode increases avoidable error risk on external communications.",
      severity: "high",
      mitigation: "Use checklist and run a second pass before sending anything external.",
      owner: "You",
      dueBy: dayEnd.toISOString(),
    });
  }

  if (deadlinesToday > 0 && deadlinesToday > deepWorkMinutesAvailable / 30) {
    risks.push({
      risk: "Deadlines exceed realistic remaining focus capacity.",
      severity: "med",
      mitigation: "De-scope one non-critical task and communicate revised ETA now.",
      owner: "You",
      dueBy: new Date(now.getTime() + 60 * MINUTE_MS).toISOString(),
    });
  }

  const timeBlockPlan: PlanBlock[] = [];
  timeBlockPlan.push(rightNowFocusBlock);
  timeBlockPlan.push(adminBlock);

  for (const event of nextMeetings) {
    const eventStart = new Date(event.startTime);
    const prepEnd = new Date(eventStart.getTime() - 5 * MINUTE_MS);
    const prepStart = new Date(prepEnd.getTime() - 10 * MINUTE_MS);
    if (prepEnd.getTime() <= now.getTime()) continue;

    timeBlockPlan.push({
      startTime: prepStart.toISOString(),
      endTime: prepEnd.toISOString(),
      durationMinutes: 10,
      title: `Prep: ${event.eventTitle}`,
      type: "meeting_prep",
      confidence: "med",
      actions: [
        {
          label: "Open linked note",
          kind: "open_note",
          payload: { url: `/notes?eventId=${encodeURIComponent(event.sourceRef.id)}` },
        },
        {
          label: "Open event",
          kind: "open_event",
          payload: { url: event.sourceRef.url || "https://calendar.google.com" },
        },
      ],
      sourceRefs: [event.sourceRef],
    });

    timeBlockPlan.push({
      startTime: new Date(new Date(event.startTime).getTime() + 5 * MINUTE_MS).toISOString(),
      endTime: new Date(new Date(event.startTime).getTime() + 15 * MINUTE_MS).toISOString(),
      durationMinutes: 10,
      title: `Post-meeting buffer: ${event.eventTitle}`,
      type: "admin",
      confidence: "med",
      actions: [
        {
          label: "Capture follow-ups",
          kind: "open_note",
          payload: { url: `/notes?eventId=${encodeURIComponent(event.sourceRef.id)}` },
        },
      ],
      sourceRefs: [event.sourceRef],
    });
  }

  if (health.type === "low_sleep") {
    timeBlockPlan.push({
      durationMinutes: 10,
      title: "Recovery break: water + short walk",
      type: "break",
      confidence: "high",
      actions: [
        {
          label: "Set 10m break timer",
          kind: "schedule_block",
          payload: { title: "Recovery break", durationMinutes: 10 },
        },
      ],
    });
  }

  const dedupedPlan = timeBlockPlan
    .sort((a, b) => new Date(a.startTime || now.toISOString()).getTime() - new Date(b.startTime || now.toISOString()).getTime())
    .slice(0, 10);

  const later = (input.todoistTasks || []).slice(3, 7).map((task) => ({
    title: String(task.content || "Follow-up task"),
    sourceRefs: [taskSourceRef(task)],
  }));

  return {
    generatedAt: new Date().toISOString(),
    freshness: "fresh",
    mode: {
      type: health.type,
      rationale: health.rationale,
    },
    metrics: {
      deepWorkMinutesAvailable,
      meetingsRemaining: remainingMeetings.length,
      tasksDueToday: input.todoistTasks.length,
      inboxToTriage: input.prioritizedEmails.length,
      sleepHours: health.sleepHours,
      recoveryPercent: health.recoveryPercent,
      deadlinesToday,
    },
    outcomes: outcomes.slice(0, 3),
    rightNow: {
      focusBlock: rightNowFocusBlock,
      adminBlock,
      breakSuggestion:
        health.type === "low_sleep" ? "Take a 5–10 minute walk + water before external messaging." : undefined,
    },
    timeBlockPlan: dedupedPlan,
    inboxTriage,
    nextMeetings,
    decisions: decisions.slice(0, 3),
    waitingOn,
    risks,
    later,
  };
}

export function withFreshness(brief: DailyBrief, now: Date): DailyBrief {
  const generatedAt = new Date(brief.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) {
    return { ...brief, freshness: "stale" };
  }

  const ageMinutes = (now.getTime() - generatedAt.getTime()) / MINUTE_MS;
  return {
    ...brief,
    freshness: ageMinutes <= 20 ? "fresh" : "stale",
  };
}
