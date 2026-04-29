/**
 * DropDock chip — Phase E (2026-04-28).
 *
 * Extracted from DropDock.tsx so the chip's interactive state
 * (due-popover open/closed, datetime input value) doesn't bloat
 * the parent component. Each chip is an `<a>` (so middle-click /
 * Cmd-click opens in a new tab) decorated with:
 *
 *   - the source-color label (Gmail/Calendar/Sheets/Todoist/URL)
 *   - the title (markdown defensively stripped on render)
 *   - a due-date pill: shows "+ ⏰" when unset, the formatted label
 *     ("in 2h", "Tomorrow 9am", "3h overdue") when set
 *   - the × remove button
 *
 * Clicking the pill stops link navigation and opens a tiny popover
 * with a `datetime-local` input + Set / Clear actions. The pill's
 * background tracks the urgency category (overdue/due-soon/upcoming)
 * so the eye finds the most-imminent items first; chips with
 * overdue or due-soon dates also escalate their own border/shadow.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  categorizeDockDueDate,
  chipFallbackLabel,
  formatDockDueLabel,
  shouldCopyDockChipUrl,
  stripMarkdownLinks,
  type DockSource,
} from "@shared/dropdock.helpers";
import { formatDateInput } from "@shared/dateKey";

const SOURCE_LABEL: Record<DockSource, string> = {
  gmail: "GMAIL",
  gcal: "GCAL",
  gsheet: "SHEET",
  todoist: "TODO",
  url: "LINK",
};

const SOURCE_COLOR: Record<DockSource, string> = {
  gmail: "fp-dock-chip__src--gmail",
  gcal: "fp-dock-chip__src--gcal",
  gsheet: "fp-dock-chip__src--gsheet",
  todoist: "fp-dock-chip__src--todoist",
  url: "fp-dock-chip__src--url",
};

export interface DockChipItem {
  id: string;
  source: string;
  url: string;
  title: string | null;
  dueAt?: string | null;
}

interface DockChipProps {
  item: DockChipItem;
  /** 0/1/2 cycling tilt class index — the parent owns the cycle. */
  tiltIndex: number;
  onRemove: (id: string) => void;
}

/**
 * Convert a `Date` to the local-time `YYYY-MM-DDTHH:MM` string
 * that `<input type="datetime-local">` expects. The native input
 * doesn't accept ISO strings with timezone offsets, so we splice
 * the canonical date-key against the locale hour/minute. Reusing
 * `formatDateInput` keeps the lint that forbids inline date-key
 * templates happy.
 */
function toLocalDatetimeInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${formatDateInput(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const DockChip = forwardRef<HTMLAnchorElement, DockChipProps>(
  function DockChip({ item, tiltIndex, onRemove }, ref) {
    const utils = trpc.useUtils();
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [draftDueAt, setDraftDueAt] = useState("");
    const popoverRef = useRef<HTMLDivElement>(null);

    const setDueAt = trpc.dock.setDueAt.useMutation({
      onSuccess: async (result) => {
        if (!result.updated) {
          toast.error("Chip vanished — refreshing.");
        }
        await utils.dock.list.invalidate();
        await utils.dock.listUpcoming.invalidate();
      },
      onError: (err) => {
        toast.error(`Failed to set reminder: ${err.message}`);
      },
    });

    // Self-heal: when a chip mounts with no stored title, fire the
    // server-side enrichment in the background and refresh the dock
    // list on success. Covers chips added before the gcal htmlLink
    // classification fix and any other path that stored a null
    // title. The mutation itself short-circuits on chips that
    // already have a title so re-renders don't replay the fetch.
    const refreshTitle = trpc.dock.refreshTitle.useMutation({
      onSuccess: (result) => {
        if (result.refreshed) {
          void utils.dock.list.invalidate();
        }
      },
    });
    const hasResolvedTitle =
      stripMarkdownLinks(item.title ?? "").trim().length > 0;
    const refreshTitleMutate = refreshTitle.mutate;
    useEffect(() => {
      if (hasResolvedTitle) return;
      // `useMutation` itself doesn't dedupe across re-mounts — guard
      // by checking the mutation's pending/idle state so a tab-
      // refocus cascade doesn't re-fire enrichment for the same
      // chip. This is best-effort: an in-flight result might race
      // with a same-id chip in another mount, but the proc is
      // idempotent so the worst case is a duplicate fetch.
      refreshTitleMutate({ id: item.id });
      // eslint-disable-next-line react-hooks/exhaustive-deps -- we
      // intentionally fire only when (id, hasResolvedTitle) flips;
      // the mutation reference is stable.
    }, [item.id, hasResolvedTitle]);

    // Manual retry — fires `dock.refreshTitle` and surfaces the
    // result via toast. Visible only on chips with no resolved
    // title; gives the user diagnostic feedback when auto-heal
    // ran but couldn't resolve a title (token expired, source
    // unsupported, upstream API down).
    const handleManualRefresh = useCallback(() => {
      refreshTitle.mutate(
        { id: item.id },
        {
          onSuccess: (result) => {
            if (result.title) {
              toast.success(`Title resolved: ${result.title.slice(0, 60)}`);
            } else {
              const reasonMessage =
                result.reason === "enrich-null"
                  ? `Enrichment returned no title (source: ${("effectiveSource" in result && result.effectiveSource) || "unknown"}). Token may be expired or the source may be unreachable.`
                  : result.reason === "not-found"
                    ? "Chip not found"
                    : "Couldn't resolve a title.";
              toast.error(reasonMessage);
            }
          },
          onError: (err) => toast.error(`Refresh failed: ${err.message}`),
        }
      );
    }, [item.id, refreshTitle]);

    // Close popover on outside click. Listening at the document
    // level keeps us from having to hand-thread refs through every
    // chip; the popoverRef + chip anchor target are the only two
    // elements that should keep the popover open.
    useEffect(() => {
      if (!popoverOpen) return;
      function onDocPointer(e: PointerEvent) {
        if (!popoverRef.current) return;
        if (popoverRef.current.contains(e.target as Node)) return;
        setPopoverOpen(false);
      }
      document.addEventListener("pointerdown", onDocPointer);
      return () => {
        document.removeEventListener("pointerdown", onDocPointer);
      };
    }, [popoverOpen]);

    const dueCategory = categorizeDockDueDate(item.dueAt ?? null);
    const dueLabel = formatDockDueLabel(item.dueAt ?? null);
    const hasDue = dueCategory !== "none";

    const openPopover = useCallback(() => {
      // Seed the input with the current due value (in local time)
      // when one is set, otherwise default to "now + 1h" rounded
      // to the next 15 minutes — close enough for "remind me later
      // this afternoon" without the user retyping the date.
      const seed = item.dueAt ? new Date(item.dueAt) : null;
      if (seed && !Number.isNaN(seed.getTime())) {
        setDraftDueAt(toLocalDatetimeInputValue(seed));
      } else {
        const next = new Date();
        next.setMinutes(next.getMinutes() + 60);
        next.setMinutes(Math.round(next.getMinutes() / 15) * 15, 0, 0);
        setDraftDueAt(toLocalDatetimeInputValue(next));
      }
      setPopoverOpen(true);
    }, [item.dueAt]);

    const handleSet = useCallback(() => {
      if (!draftDueAt) return;
      const local = new Date(draftDueAt);
      if (Number.isNaN(local.getTime())) {
        toast.error("Invalid date");
        return;
      }
      setDueAt.mutate({ id: item.id, dueAt: local.toISOString() });
      setPopoverOpen(false);
    }, [draftDueAt, item.id, setDueAt]);

    const handleClear = useCallback(() => {
      setDueAt.mutate({ id: item.id, dueAt: null });
      setPopoverOpen(false);
    }, [item.id, setDueAt]);

    return (
      <span className="fp-dock-chip-wrap" style={{ position: "relative" }}>
        <a
          ref={ref}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          role="listitem"
          className={cn(
            "fp-dock-chip",
            tiltIndex % 3 === 0 && "fp-dock-chip--tilt-a",
            tiltIndex % 3 === 1 && "fp-dock-chip--tilt-b",
            tiltIndex % 3 === 2 && "fp-dock-chip--tilt-c",
            dueCategory === "overdue" && "fp-dock-chip--overdue",
            dueCategory === "due-soon" && "fp-dock-chip--due-soon",
            dueCategory === "upcoming" && "fp-dock-chip--upcoming"
          )}
          title={`${item.url}\n(⌘C / Ctrl+C to copy)`}
          onKeyDown={(e) => {
            if (!shouldCopyDockChipUrl(e)) return;
            e.preventDefault();
            if (
              typeof navigator === "undefined" ||
              !navigator.clipboard?.writeText
            ) {
              toast.error("Clipboard API not available");
              return;
            }
            navigator.clipboard
              .writeText(item.url)
              .then(() => toast.success("URL copied"))
              .catch(() => toast.error("Failed to copy"));
          }}
        >
          <span
            className={cn(
              "fp-dock-chip__src",
              SOURCE_COLOR[item.source as DockSource]
            )}
          >
            {SOURCE_LABEL[item.source as DockSource] ?? "LINK"}
          </span>
          <span className="fp-dock-chip__title">
            {stripMarkdownLinks(item.title ?? "").trim() ||
              chipFallbackLabel(item.source as DockSource, item.url)}
          </span>
          {/* Manual retry — only visible while the chip has no
              resolved title. Click triggers the same self-heal
              mutation the useEffect fires on mount, but surfaces
              the result via toast so failures (token expired,
              source unsupported, upstream API down) become
              visible instead of silent. */}
          {!hasResolvedTitle && (
            <button
              type="button"
              className="fp-dock-chip__due"
              aria-label="Retry title fetch"
              title={
                refreshTitle.isPending
                  ? "Fetching title…"
                  : "Retry title fetch"
              }
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (refreshTitle.isPending) return;
                handleManualRefresh();
              }}
              disabled={refreshTitle.isPending}
            >
              {refreshTitle.isPending ? "…" : "↻"}
            </button>
          )}
          <button
            type="button"
            className={cn(
              "fp-dock-chip__due",
              !hasDue && "fp-dock-chip__due--unset"
            )}
            aria-label={
              hasDue
                ? `Edit reminder (${dueLabel})`
                : "Add reminder"
            }
            onClick={(e) => {
              // Stop the parent <a> from navigating when the user
              // clicks the pill — they want to set a date, not
              // open the link.
              e.preventDefault();
              e.stopPropagation();
              if (popoverOpen) setPopoverOpen(false);
              else openPopover();
            }}
          >
            {hasDue ? dueLabel : "⏰"}
          </button>
          <button
            type="button"
            className="fp-dock-chip__x"
            aria-label={`Remove ${item.title ?? item.url}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove(item.id);
            }}
          >
            ×
          </button>
        </a>

        {popoverOpen && (
          <div
            ref={popoverRef}
            className="fp-dock-chip__due-popover"
            style={{ top: "calc(100% + 4px)", left: 0 }}
            role="dialog"
            aria-label="Set chip reminder"
          >
            <label className="mono-label" htmlFor={`due-${item.id}`}>
              Reminder
            </label>
            <input
              id={`due-${item.id}`}
              type="datetime-local"
              value={draftDueAt}
              onChange={(e) => setDraftDueAt(e.target.value)}
            />
            <div className="fp-dock-chip__due-actions">
              {hasDue && (
                <button
                  type="button"
                  className="fp-dock-chip__due-clear"
                  onClick={handleClear}
                  disabled={setDueAt.isPending}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={() => setPopoverOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="fp-dock-chip__due-set"
                onClick={handleSet}
                disabled={setDueAt.isPending || !draftDueAt}
              >
                Set
              </button>
            </div>
          </div>
        )}
      </span>
    );
  }
);
