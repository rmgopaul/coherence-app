import type { DashboardData } from "../useDashboardData";
import type {
  CalendarEvent,
  ClockifyCurrentEntry,
  ClockifyRecentEntry,
  ClockifyStatus,
  DockItem,
  DriveFile,
  GmailMessage,
  TodoistTask,
  WeeklyReview,
  WhoopSummary,
} from "../types";
import type { DailyWorkflowDraft } from "./dailyWorkflow.helpers";

type DailyBriefSourceRef =
  DailyWorkflowDraft["dailyBrief"]["sourceRefs"][number];
type CommandCenterData = NonNullable<DashboardData["commandCenter"]["data"]>;
type NewsPayload = DashboardData["news"];
type WeatherPayload = DashboardData["weather"];

export type BriefSourcePickerOption = {
  key: string;
  source: DailyBriefSourceRef["source"];
  id: string | null;
  label: string;
  url: string | null;
  display: string;
};

function todoistTaskUrl(taskId: string): string {
  return `https://todoist.com/showTask?id=${encodeURIComponent(taskId)}`;
}

function calendarEventUrl(eventId: string): string {
  return `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(
    eventId
  )}`;
}

function gmailMessageUrl(message: GmailMessage): string | null {
  const id = message.threadId || message.id;
  if (!id) return null;
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(id)}`;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function compactParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" - ");
}

function shortSourceLabel(source: string): string {
  return source.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function option({
  source,
  id,
  label,
  url = null,
  display,
}: {
  source: DailyBriefSourceRef["source"];
  id: string | null;
  label: string;
  url?: string | null;
  display?: string;
}): BriefSourcePickerOption {
  const safeLabel = label.trim();
  const safeId = id?.trim() || null;
  return {
    key: `${source}:${safeId ?? safeLabel}`,
    source,
    id: safeId,
    label: safeLabel,
    url,
    display: display ?? safeLabel,
  };
}

function gmailHeader(message: GmailMessage, headerName: string): string {
  const headers = Array.isArray(message.payload?.headers)
    ? message.payload.headers
    : [];
  const header = headers.find(
    (entry: { name?: string; value?: string }) =>
      String(entry.name || "").toLowerCase() === headerName.toLowerCase()
  );
  return String(header?.value || "");
}

function formatBriefSourceDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function todoistBriefSourceOptions(
  tasks: TodoistTask[]
): BriefSourcePickerOption[] {
  return tasks
    .filter(task => task.id && task.content.trim())
    .map(task => ({
      key: `todoist:${task.id}`,
      source: "todoist",
      id: task.id,
      label: task.content.trim(),
      url: todoistTaskUrl(task.id),
      display: task.content.trim(),
    }));
}

export function gmailBriefSourceOptions(
  messages: GmailMessage[]
): BriefSourcePickerOption[] {
  return messages
    .filter(message => message.id || message.threadId)
    .map(message => {
      const subject = gmailHeader(message, "Subject") || "(No subject)";
      const from = gmailHeader(message, "From");
      const id = message.threadId || message.id || null;
      return {
        key: `gmail:${id}`,
        source: "gmail" as const,
        id,
        label: subject,
        url: gmailMessageUrl(message),
        display: from ? `${subject} - ${from}` : subject,
      };
    });
}

export function calendarBriefSourceOptions(
  events: CalendarEvent[],
  now = new Date()
): BriefSourcePickerOption[] {
  const sixMonthsFromNow = new Date(now);
  sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);

  return events
    .map(event => {
      const startIso = event.start?.dateTime ?? event.start?.date ?? null;
      const startMs = startIso ? new Date(startIso).getTime() : Number.NaN;
      return { event, startIso, startMs };
    })
    .filter(
      ({ event, startMs }) =>
        event.id &&
        Number.isFinite(startMs) &&
        startMs >= now.getTime() &&
        startMs <= sixMonthsFromNow.getTime()
    )
    .map(({ event, startIso }) => {
      const title = event.summary || "(Untitled event)";
      const startLabel = formatBriefSourceDate(startIso);
      return {
        key: `calendar:${event.id}`,
        source: "calendar" as const,
        id: event.id ?? null,
        label: title,
        url:
          typeof event.htmlLink === "string" && event.htmlLink
            ? event.htmlLink
            : event.id
              ? calendarEventUrl(event.id)
              : null,
        display: startLabel ? `${title} - ${startLabel}` : title,
      };
    });
}

export function dockBriefSourceOptions(
  items: DockItem[]
): BriefSourcePickerOption[] {
  return items.map((item) => {
    const title = nonEmpty(item.title) ?? item.url;
    const sourceLabel = shortSourceLabel(String(item.source)).toUpperCase();
    const dueLabel = formatBriefSourceDate(item.dueAt ?? null);
    return option({
      source: "dock",
      id: item.id,
      label: title,
      url: item.url,
      display: compactParts([title, sourceLabel, dueLabel]),
    });
  });
}

export function driveBriefSourceOptions(
  files: DriveFile[]
): BriefSourcePickerOption[] {
  return files
    .filter((file) => file.id && nonEmpty(file.name))
    .map((file) => {
      const modified = formatBriefSourceDate(
        nonEmpty(file.modifiedTime) ?? null
      );
      return option({
        source: "drive",
        id: file.id,
        label: nonEmpty(file.name) ?? "Untitled Drive file",
        url: nonEmpty(file.webViewLink),
        display: compactParts([nonEmpty(file.name), "Drive", modified]),
      });
    });
}

export function dailyBriefSourceOptions(
  brief: DailyWorkflowDraft["dailyBrief"],
  dateKey: string
): BriefSourcePickerOption[] {
  const entries: BriefSourcePickerOption[] = [];
  const headline = nonEmpty(brief.headline);
  if (headline) {
    entries.push(
      option({
        source: "daily_brief",
        id: brief.generatedAt ?? `daily-brief:${dateKey}`,
        label: headline,
        display: compactParts(["Daily brief", headline]),
      })
    );
  }

  const summary = nonEmpty(brief.summary);
  if (summary) {
    entries.push(
      option({
        source: "daily_brief",
        id: `daily-brief-summary:${dateKey}`,
        label: "Daily brief summary",
        display: compactParts(["Daily brief summary", summary.slice(0, 90)]),
      })
    );
  }

  return entries;
}

export function todayPlanBriefSourceOptions(
  plan: DailyWorkflowDraft["todayPlan"]
): BriefSourcePickerOption[] {
  const entries: BriefSourcePickerOption[] = [];
  const topPriority = nonEmpty(plan.topPriority);
  if (topPriority) {
    entries.push(
      option({
        source: "today_plan",
        id: "today-plan:top-priority",
        label: topPriority,
        display: compactParts(["Top priority", topPriority]),
      })
    );
  }

  for (const block of plan.blocks) {
    const title = nonEmpty(block.title);
    if (!title) continue;
    entries.push(
      option({
        source: "today_plan",
        id: block.id,
        label: title,
        display: compactParts([
          title,
          block.status.replace("_", " "),
          formatBriefSourceDate(block.startIso),
        ]),
      })
    );
  }

  return entries;
}

export function weeklyReviewBriefSourceOptions(
  latestReview: WeeklyReview | null | undefined,
  commandCenter: CommandCenterData | null | undefined
): BriefSourcePickerOption[] {
  const reviewHeadline =
    nonEmpty(latestReview?.headline) ??
    nonEmpty(commandCenter?.weeklyReview.headline);
  const weekKey =
    nonEmpty(latestReview?.weekKey) ??
    nonEmpty(commandCenter?.weeklyReview.weekKey);
  if (!reviewHeadline && !weekKey) return [];

  return [
    option({
      source: "weekly_review",
      id: weekKey ?? "weekly-review:latest",
      label: reviewHeadline ?? `Weekly review ${weekKey}`,
      display: compactParts([
        "Weekly review",
        weekKey,
        reviewHeadline ?? nonEmpty(commandCenter?.weeklyReview.status),
      ]),
    }),
  ];
}

export function healthBriefSourceOptions(
  whoop: WhoopSummary | null | undefined,
  commandCenter: CommandCenterData | null | undefined
): BriefSourcePickerOption[] {
  const options: BriefSourcePickerOption[] = [];
  if (whoop) {
    const metrics = [
      whoop.recoveryScore !== null ? `Recovery ${whoop.recoveryScore}` : null,
      whoop.sleepHours !== null ? `Sleep ${whoop.sleepHours.toFixed(1)}h` : null,
      whoop.dayStrain !== null ? `Strain ${whoop.dayStrain.toFixed(1)}` : null,
    ];
    options.push(
      option({
        source: "health",
        id: whoop.dataDate ?? whoop.updatedAt,
        label: "Health summary",
        display: compactParts(["Health summary", ...metrics]),
      })
    );
    options.push(
      option({
        source: "whoop",
        id: whoop.dataDate ?? whoop.updatedAt,
        label: "WHOOP recovery",
        display: compactParts(["WHOOP", ...metrics]),
      })
    );
  }

  const samsungFreshness =
    commandCenter?.sourceFreshness.find(
      (item) => item.source === "samsungHealth"
    ) ??
    commandCenter?.integrations.find((item) => item.key === "samsungHealth");
  if (samsungFreshness) {
    options.push(
      option({
        source: "samsungHealth",
        id: "samsung-health:status",
        label: "Samsung Health status",
        display: compactParts([
          "Samsung Health",
          "status" in samsungFreshness
            ? samsungFreshness.status.replace("_", " ")
            : null,
          "detail" in samsungFreshness
            ? nonEmpty(samsungFreshness.detail)
            : nonEmpty(samsungFreshness.reason),
        ]),
      })
    );
  }

  return options;
}

export function weatherBriefSourceOptions(
  weather: WeatherPayload
): BriefSourcePickerOption[] {
  if (!weather) return [];
  if (weather.offline || typeof weather.tempF !== "number") {
    return [
      option({
        source: "weather",
        id: `weather:${weather.label ?? "home"}`,
        label: "Weather status",
        display: compactParts(["Weather", nonEmpty(weather.reason)]),
      }),
    ];
  }

  return [
    option({
      source: "weather",
      id: weather.fetchedAt ?? `weather:${weather.label ?? "home"}`,
      label: `Weather in ${weather.label ?? "Home"}`,
      display: compactParts([
        `Weather in ${weather.label ?? "Home"}`,
        `${weather.tempF}F`,
        nonEmpty(weather.description),
      ]),
    }),
  ];
}

export function newsBriefSourceOptions(
  news: NewsPayload
): BriefSourcePickerOption[] {
  return (news?.items ?? []).slice(0, 20).map((item) =>
    option({
      source: "news",
      id: item.url,
      label: item.title,
      url: item.url,
      display: compactParts([
        item.title,
        nonEmpty(item.src),
        formatBriefSourceDate(item.publishedAt),
      ]),
    })
  );
}

export function systemBriefSourceOptions(
  commandCenter: CommandCenterData | null | undefined
): BriefSourcePickerOption[] {
  if (!commandCenter) return [];
  const options: BriefSourcePickerOption[] = [];
  if (commandCenter.rightNow) {
    options.push(
      option({
        source: "system",
        id: commandCenter.rightNow.sourceId ?? "right-now",
        label: commandCenter.rightNow.title,
        url: commandCenter.rightNow.sourceUrl,
        display: compactParts([
          "Right now",
          commandCenter.rightNow.title,
          commandCenter.rightNow.reason,
        ]),
      })
    );
  }

  options.push(
    option({
      source: "system",
      id: `command-center:${commandCenter.dateKey}`,
      label: "Command center metrics",
      display: compactParts([
        "Command center",
        `${commandCenter.metrics.tasksDueToday} tasks`,
        `${commandCenter.metrics.meetingsRemaining} meetings`,
        `${commandCenter.metrics.inboxToTriage} inbox`,
      ]),
    })
  );

  return options;
}

export function googleBriefSourceOptions(
  commandCenter: CommandCenterData | null | undefined
): BriefSourcePickerOption[] {
  if (!commandCenter) return [];
  return commandCenter.integrations
    .filter((item) =>
      ["google", "gmail", "calendar", "drive"].includes(item.key)
    )
    .map((item) =>
      option({
        source: item.key,
        id: `integration:${item.key}`,
        label: `${item.label} integration`,
        url: item.actionHref,
        display: compactParts([
          item.label,
          item.status.replace("_", " "),
          item.reason,
        ]),
      })
    );
}

export function clockifyBriefSourceOptions(
  status: ClockifyStatus | null | undefined,
  currentEntry: ClockifyCurrentEntry | null | undefined,
  recentEntries: ClockifyRecentEntry[] | null | undefined
): BriefSourcePickerOption[] {
  const options: BriefSourcePickerOption[] = [];
  if (currentEntry?.isRunning) {
    const label =
      nonEmpty(currentEntry.description) ??
      nonEmpty(currentEntry.projectName) ??
      "Running Clockify timer";
    options.push(
      option({
        source: "clockify",
        id: currentEntry.id,
        label,
        url: "https://app.clockify.me/tracker",
        display: compactParts(["Running timer", label, currentEntry.projectName]),
      })
    );
  }

  for (const entry of (recentEntries ?? []).slice(0, 20)) {
    const label =
      nonEmpty(entry.description) ??
      nonEmpty(entry.projectName) ??
      "Clockify time entry";
    options.push(
      option({
        source: "clockify",
        id: entry.id,
        label,
        url: "https://app.clockify.me/tracker",
        display: compactParts([
          label,
          entry.projectName,
          formatBriefSourceDate(entry.start),
        ]),
      })
    );
  }

  if (options.length === 0 && status?.connected) {
    options.push(
      option({
        source: "clockify",
        id: status.workspaceId ?? "clockify:workspace",
        label: "Clockify workspace",
        url: "https://app.clockify.me/tracker",
        display: compactParts(["Clockify", status.workspaceName]),
      })
    );
  }

  return options;
}

export function sourceRefPatchFromPickerOption(
  option: BriefSourcePickerOption
): Pick<DailyBriefSourceRef, "id" | "label" | "url"> {
  return {
    id: option.id,
    label: option.label,
    url: option.url,
  };
}
