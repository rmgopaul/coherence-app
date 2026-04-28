/**
 * Task 10.1 (2026-04-28) — pure helpers for the dashboard's
 * uniform signal-row action menu. Lives in `lib/` so the existing
 * vitest `client/src/lib` glob picks up the tests without
 * expanding the include list.
 *
 * The dashboard's frontpage exposes several feed cells that
 * contain row-level signals (Gmail messages in InboxPanel,
 * Todoist tasks in TasksTriage, calendar events in upcoming
 * cells). Each row historically had its own per-feed action
 * surface — done in InboxPanel, complete in TasksTriage. Phase
 * 10's `SignalActions` menu unifies five cross-cutting actions:
 *
 *   1. Drop to Dock — pin to the DropDock for later
 *   2. Pin as King — set as today's King of the Day
 *   3. Create Todoist Task — convert a non-Todoist row to a task
 *   4. Archive (Gmail) — Gmail-only
 *   5. Defer (Todoist) — Todoist-only
 *
 * Not every action applies to every row. This module owns the
 * applicability matrix as a pure function so the menu component
 * stays presentational and the matrix is testable independently
 * of React.
 */

/** Discriminated union covering the row kinds the menu surfaces.
 *  Each variant carries the minimum identity + display fields the
 *  five actions need. Add a variant + its action mapping when a
 *  new feed gains the menu. */
export type SignalRow =
  | {
      kind: "gmail";
      /** Gmail message ID — the API takes this on /modify. */
      messageId: string;
      /** Subject line — used as the title for "Drop to Dock" /
       *  "Pin as King" / "Create Todoist Task" handoffs. */
      subject: string;
      /** Web URL for the thread — used for "Drop to Dock" link. */
      threadUrl: string;
      sender?: string | null;
    }
  | {
      kind: "todoist";
      taskId: string;
      content: string;
      taskUrl: string;
    }
  | {
      kind: "calendar";
      eventId: string;
      title: string;
      eventUrl: string;
    }
  | {
      kind: "generic";
      id: string;
      title: string;
      href: string;
    };

export type SignalActionKey =
  | "drop-to-dock"
  | "pin-as-king"
  | "create-todoist-task"
  | "archive-gmail"
  | "defer-todoist";

/** Display label for each action — kept here so the component
 *  doesn't maintain a parallel switch. */
export const SIGNAL_ACTION_LABELS: Record<SignalActionKey, string> = {
  "drop-to-dock": "Drop to Dock",
  "pin-as-king": "Pin as King",
  "create-todoist-task": "Create Todoist Task",
  "archive-gmail": "Archive",
  "defer-todoist": "Defer to tomorrow",
};

/**
 * Return the ordered list of actions applicable to a row. Order
 * matches the menu rendering order — "primary" (Drop to Dock /
 * Pin as King) actions first, then row-kind-specific actions.
 *
 * Applicability rules:
 *
 *   - **Drop to Dock** + **Pin as King** apply to every row.
 *   - **Create Todoist Task** applies to every kind EXCEPT
 *     `todoist` (no point converting a task into itself).
 *   - **Archive** is `gmail`-only.
 *   - **Defer to tomorrow** is `todoist`-only.
 *
 * Pure. Exposed for testability.
 */
export function applicableActions(row: SignalRow): SignalActionKey[] {
  const actions: SignalActionKey[] = ["drop-to-dock", "pin-as-king"];
  if (row.kind !== "todoist") {
    actions.push("create-todoist-task");
  }
  if (row.kind === "gmail") {
    actions.push("archive-gmail");
  }
  if (row.kind === "todoist") {
    actions.push("defer-todoist");
  }
  return actions;
}

/** Source key the dock proc accepts. Matches the `dock.add`
 *  Zod input which enumerates `["gmail", "gcal", "gsheet",
 *  "todoist", "url"]`. Pure mapper exposed for testability. */
export function dockSourceFor(
  kind: SignalRow["kind"]
): "gmail" | "gcal" | "todoist" | "url" {
  switch (kind) {
    case "gmail":
      return "gmail";
    case "calendar":
      return "gcal";
    case "todoist":
      return "todoist";
    case "generic":
    default:
      return "url";
  }
}

/** Title to use when handing the row off to a downstream proc
 *  (Drop to Dock / Create Todoist Task / Pin as King). Keeps the
 *  field-name lookup in one place — each variant has its own
 *  semantic title field. */
export function rowTitle(row: SignalRow): string {
  switch (row.kind) {
    case "gmail":
      return row.subject;
    case "todoist":
      return row.content;
    case "calendar":
      return row.title;
    case "generic":
      return row.title;
  }
}

/** The canonical URL for a row — what the dock chip points at,
 *  what the King of the Day deep-link uses. */
export function rowUrl(row: SignalRow): string {
  switch (row.kind) {
    case "gmail":
      return row.threadUrl;
    case "todoist":
      return row.taskUrl;
    case "calendar":
      return row.eventUrl;
    case "generic":
      return row.href;
  }
}
