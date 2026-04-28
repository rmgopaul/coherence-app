/**
 * Dock Reminders — Phase E (2026-04-28).
 *
 * Front-page strip that surfaces dock chips with a `dueAt` set,
 * ordered by closest-due first. Backed by `dock.listUpcoming`
 * which filters server-side to "overdue + within the next 36h"
 * so the strip only renders the items the user actually needs to
 * act on right now.
 *
 * Renders nothing when no chips have a reminder — keeps the
 * dashboard quiet for users who haven't adopted dock dueAt yet.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  categorizeDockDueDate,
  formatDockDueLabel,
  stripMarkdownLinks,
  type DockSource,
} from "@shared/dropdock.helpers";

const SOURCE_LABEL: Record<DockSource, string> = {
  gmail: "GMAIL",
  gcal: "GCAL",
  gsheet: "SHEET",
  todoist: "TODO",
  url: "LINK",
};

export function DockReminders() {
  const { data: rows = [], isLoading } = trpc.dock.listUpcoming.useQuery(
    { windowHours: 36 },
    {
      // Refetch every 5 minutes so the labels ("in 2h" → "in 1h")
      // stay roughly current without thrashing the network. The
      // chip categories also re-evaluate on every render via
      // `categorizeDockDueDate(... new Date())`.
      refetchInterval: 5 * 60_000,
      refetchOnWindowFocus: true,
    }
  );

  const buckets = useMemo(() => {
    const now = new Date();
    const overdue: typeof rows = [];
    const dueSoon: typeof rows = [];
    const upcoming: typeof rows = [];
    for (const r of rows) {
      const cat = categorizeDockDueDate(r.dueAt ?? null, now);
      if (cat === "overdue") overdue.push(r);
      else if (cat === "due-soon") dueSoon.push(r);
      else if (cat === "upcoming") upcoming.push(r);
      // "future" never lands here because the server filters by 36h
      // window; guard anyway so a future window-knob bump doesn't
      // double-count.
    }
    return { overdue, dueSoon, upcoming };
  }, [rows]);

  if (isLoading) return null;
  if (rows.length === 0) return null;

  return (
    <section
      className="fp-dock-reminders"
      aria-label="Upcoming dock reminders"
    >
      <header className="fp-dock-reminders__head">
        <span className="mono-label">Upcoming</span>
        <span className="fp-dock-reminders__sub">
          {rows.length} reminder{rows.length === 1 ? "" : "s"}
        </span>
      </header>
      <ul className="fp-dock-reminders__list">
        {buckets.overdue.map((r) => (
          <ReminderItem key={r.id} item={r} category="overdue" />
        ))}
        {buckets.dueSoon.map((r) => (
          <ReminderItem key={r.id} item={r} category="due-soon" />
        ))}
        {buckets.upcoming.map((r) => (
          <ReminderItem key={r.id} item={r} category="upcoming" />
        ))}
      </ul>
    </section>
  );
}

function ReminderItem({
  item,
  category,
}: {
  item: {
    id: string;
    source: string;
    url: string;
    title: string | null;
    dueAt: string | null;
  };
  category: "overdue" | "due-soon" | "upcoming";
}) {
  const cleanTitle =
    stripMarkdownLinks(item.title ?? "").trim() || item.url;
  const label = formatDockDueLabel(item.dueAt ?? null);
  const sourceTag = SOURCE_LABEL[item.source as DockSource] ?? "LINK";
  return (
    <li className={cn("fp-dock-reminders__item", `fp-dock-reminders__item--${category}`)}>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="fp-dock-reminders__link"
      >
        <span className="fp-dock-reminders__pill">{label}</span>
        <span className="fp-dock-reminders__source">{sourceTag}</span>
        <span className="fp-dock-reminders__title">{cleanTitle}</span>
      </a>
    </li>
  );
}

export default DockReminders;
