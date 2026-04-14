import type { AppRouter } from "../../../../server/routers";
import type { inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type CalendarEvent = RouterOutputs["google"]["getCalendarEvents"][number];
export type GmailMessage = RouterOutputs["google"]["getGmailMessages"][number];
export type GmailWaitingOnItem = RouterOutputs["google"]["getGmailWaitingOn"][number];
export type TodoistTask = RouterOutputs["todoist"]["getTasks"][number];
export type TodoistProject = RouterOutputs["todoist"]["getProjects"][number];
export type Note = RouterOutputs["notes"]["list"][number];
export type NoteLink = Note["links"][number];
export type HabitEntry = RouterOutputs["habits"]["getForDate"][number];
export type MetricHistoryRow = RouterOutputs["metrics"]["getHistory"][number];
export type DriveFile = RouterOutputs["google"]["searchDrive"][number];
export type SupplementDefinition = RouterOutputs["supplements"]["listDefinitions"][number];
export type SupplementLog = RouterOutputs["supplements"]["getLogs"][number];
export type WhoopSummary = RouterOutputs["whoop"]["getSummary"];
export type Conversation = RouterOutputs["conversations"]["list"][number];
export type ChatMessage = RouterOutputs["conversations"]["getMessages"][number];
export type SolarReadingSummary = RouterOutputs["solarReadings"]["summary"];
export type SolarReading = RouterOutputs["solarReadings"]["list"][number];
