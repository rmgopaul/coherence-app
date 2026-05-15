/**
 * Workspace linked-note badge that appears
 * on row-based feed cells (Todoist tasks, Calendar events) when the
 * row has workspace notes linked to it.
 *
 * Two variants:
 *
 *   1. **`<LinkedNotesBadge linkType externalId />`** — single-row
 *      mode. Self-fetches via `notes.listForExternal`. Useful when
 *      the parent doesn't have an N-row roll-up.
 *
 *   2. **`<LinkedNotesBadge linkType externalId count />`** — batch
 *      count mode. Caller passes the count from a batched
 *      `notes.countLinksByExternalIds` query. Saves N round-trips
 *      when the parent renders a list of rows.
 *
 * When `onCreateNote` is supplied, a zero-count row can still render
 * a compact "Create workspace note" affordance.
 */
import { trpc } from "@/lib/trpc";
import { FileText, Paperclip, Plus } from "lucide-react";
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
  /** Set by batched parents while the count query is still loading.
   *  Prevents the zero-count create affordance from flashing early. */
  countLoading?: boolean;
  /** Class for the trigger button. Feed cells size the badge
   *  differently to fit their density. */
  className?: string;
  /** Render the text label next to the icon instead of the count.
   *  Useful when the control is the primary "Open workspace" CTA. */
  showLabel?: boolean;
  /** Optional create callback. When present and the count is zero,
   *  the component renders a compact create-note affordance. */
  onCreateNote?: () => void;
  createLabel?: string;
  openLabel?: string;
}

export function LinkedNotesBadge({
  linkType,
  externalId,
  count,
  countLoading = false,
  className,
  showLabel = false,
  onCreateNote,
  createLabel = "Create workspace note",
  openLabel = "Open workspace",
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
    count !== undefined ? count : (listQuery.data?.notes.length ?? 0);

  const triggerClassName =
    className ??
    "inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground";

  if (
    (count === undefined && (listQuery.isLoading || listQuery.error)) ||
    (count !== undefined && countLoading)
  ) {
    return null;
  }

  if (inferredCount === 0) {
    if (!onCreateNote) return null;
    return (
      <button
        type="button"
        className={triggerClassName}
        aria-label={createLabel}
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          onCreateNote();
        }}
      >
        <Plus className="h-3 w-3" />
        <span>{createLabel}</span>
      </button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          aria-label={`${openLabel}: ${inferredCount} linked notes`}
          onClick={e => {
            // Don't bubble to a row-level <a>/<li onClick>.
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {showLabel ? (
            <FileText className="h-3 w-3" />
          ) : (
            <Paperclip className="h-3 w-3" />
          )}
          <span>{showLabel ? openLabel : inferredCount}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-2"
        onClick={e => e.stopPropagation()}
      >
        <LinkedNotesPopover
          linkType={linkType}
          externalId={externalId}
          onCreateNote={onCreateNote}
          createLabel={createLabel}
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
  onCreateNote,
  createLabel,
}: {
  linkType: LinkType;
  externalId: string;
  onCreateNote?: () => void;
  createLabel: string;
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
      <p className="text-xs text-destructive">{detailQuery.error.message}</p>
    );
  }
  const notes = detailQuery.data?.notes ?? [];
  if (notes.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">No linked notes.</p>
        {onCreateNote ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-foreground hover:underline"
            onClick={e => {
              e.preventDefault();
              e.stopPropagation();
              onCreateNote();
            }}
          >
            <Plus className="h-3 w-3" />
            {createLabel}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Workspace notes
      </p>
      <ul className="space-y-1">
        {notes.map(note => (
          <li key={note.id}>
            <a
              href={`/notes?noteId=${encodeURIComponent(note.id)}`}
              className="block text-xs hover:underline"
              title={note.title ?? "(untitled)"}
            >
              <span className="font-medium">
                {note.title?.trim() || "(untitled)"}
              </span>
              <span className="text-muted-foreground"> · {note.notebook}</span>
              {note.sourceTitle ? (
                <span className="block truncate text-[11px] text-muted-foreground">
                  Linked to {note.sourceTitle}
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
