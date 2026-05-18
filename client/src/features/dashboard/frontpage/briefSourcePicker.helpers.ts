import type { CalendarEvent, GmailMessage, TodoistTask } from "../types";
import type { DailyWorkflowDraft } from "./dailyWorkflow.helpers";

type DailyBriefSourceRef =
  DailyWorkflowDraft["dailyBrief"]["sourceRefs"][number];

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

export function sourceRefPatchFromPickerOption(
  option: BriefSourcePickerOption
): Pick<DailyBriefSourceRef, "id" | "label" | "url"> {
  return {
    id: option.id,
    label: option.label,
    url: option.url,
  };
}
