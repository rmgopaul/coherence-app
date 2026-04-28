/**
 * Task 10.3 (2026-04-28) — "📎 N linked notes" badge that appears
 * on row-based feed cells (Todoist tasks, Calendar events) when the
 * row has notes linked TO it via the Notebook→external handoff.
 *
 * Two variants:
 *
 *   1. **`<LinkedNotesBadge linkType externalId />`** — single-row
 *      mode. Self-fetches via `notes.listForExternal`. Useful when
 *      the parent doesn't have an N-row roll-up.
 *
 *   2. **`<LinkedNotesBadge linkType externalId count />`** — count-
 *      only mode. Caller passes the count from a batched
 *      `notes.countLinksByExternalIds` query. Saves N round-trips
 *      when the parent renders a list of rows.
 *
 * Click to see the linked note titles in a popover. Each title
 * is a link to the note in the Notebook.
 */
import { trpc } from "@/lib/trpc";
import { Paperclip } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type LinkType = "todoist_task" | "google_calendar_event";

interface BaseProps {
  linkType: LinkType;
  externalId: string;
  /** When present, the badge skips its own list query and uses this
   *  count for the badge label. The popover still self-fetches
   *  detail when opened. */
  count?: number;
  /** Class for the trigger button. Feed cells size the badge
   *  differently to fit their density. */
  className?: string;
}

export function LinkedNotesBadge({
  linkType,
  externalId,
  count,
  className,
}: BaseProps) {
  // Self-fetch when caller didn't pre-resolve a count. Cheap when
  // most rows have zero notes — the empty-result short-circuit in
  // the proc returns immediately.
  const listQuery = trpc.notes.listForExternal.useQuery(
    { linkType, externalId },
    {
      enabled: count === undefined,
      staleTime: 60_000,
    }
  );

  const inferredCount =
    count !== undefined
      ? count
      : (listQuery.data?.notes.length ?? 0);

  if (inferredCount === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={
            className ??
            "inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground"
          }
          aria-label={`${inferredCount} linked notes`}
          onClick={(e) => {
            // Don't bubble to a row-level <a>/<li onClick>.
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <Paperclip className="h-3 w-3" />
          <span>{inferredCount}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <LinkedNotesPopover
          linkType={linkType}
          externalId={externalId}
          // When the badge was rendered with a count, the popover
          // does its own fetch on open — same query, served from
          // cache if the badge already triggered it.
        />
      </PopoverContent>
    </Popover>
  );
}

function LinkedNotesPopover({
  linkType,
  externalId,
}: {
  linkType: LinkType;
  externalId: string;
}) {
  const detailQuery = trpc.notes.listForExternal.useQuery(
    { linkType, externalId },
    { staleTime: 60_000 }
  );

  if (detailQuery.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  if (detailQuery.error) {
    return (
      <p className="text-xs text-destructive">
        {detailQuery.error.message}
      </p>
    );
  }
  const notes = detailQuery.data?.notes ?? [];
  if (notes.length === 0) {
    return <p className="text-xs text-muted-foreground">No linked notes.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Linked notes
      </p>
      <ul className="space-y-1">
        {notes.map((note) => (
          <li key={note.id}>
            <a
              href={`/notebook?noteId=${encodeURIComponent(note.id)}`}
              className="block text-xs hover:underline"
              title={note.title ?? "(untitled)"}
            >
              <span className="font-medium">
                {note.title?.trim() || "(untitled)"}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {note.notebook}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
