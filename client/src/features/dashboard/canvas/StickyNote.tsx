/**
 * StickyNote — single absolutely-positioned chip on the Canvas board.
 * Drag to reposition; the parent <Canvas /> tracks pointer state and
 * commits the new x/y to the server on drop.
 */
import { useEffect, type CSSProperties, type MouseEvent } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  chipFallbackLabel,
  stripMarkdownLinks,
  type DockSource,
} from "@shared/dropdock.helpers";

export type StickyColor = "paper" | "yellow" | "red" | "blue" | "black";

export interface StickyData {
  id: string;
  source: string;
  url: string;
  title: string | null;
  meta: Record<string, string>;
  x: number;
  y: number;
  tilt: number;
  color: StickyColor;
}

interface StickyNoteProps {
  sticky: StickyData;
  dragging: boolean;
  onPointerDown: (e: MouseEvent<HTMLDivElement>) => void;
  onCycleColor: () => void;
  onRemoveFromBoard: () => void;
}

const SOURCE_LABEL: Record<string, string> = {
  gmail: "GMAIL",
  gcal: "GCAL",
  gsheet: "SHEET",
  todoist: "TODO",
  url: "LINK",
};

export function StickyNote({
  sticky,
  dragging,
  onPointerDown,
  onCycleColor,
  onRemoveFromBoard,
}: StickyNoteProps) {
  const utils = trpc.useUtils();
  // Self-heal: chips with no stored title trigger background
  // enrichment so the sticky note shows the actual task / event /
  // email subject instead of the friendly fallback. Same proc the
  // DropDock chip uses; cache invalidation refreshes both
  // surfaces in one pass.
  const refreshTitle = trpc.dock.refreshTitle.useMutation({
    onSuccess: (result) => {
      if (result.refreshed) {
        void utils.dock.list.invalidate();
      }
    },
  });
  const cleanedTitle = stripMarkdownLinks(sticky.title ?? "").trim();
  const hasResolvedTitle = cleanedTitle.length > 0;
  const refreshTitleMutate = refreshTitle.mutate;
  useEffect(() => {
    if (hasResolvedTitle) return;
    refreshTitleMutate({ id: sticky.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutation
    // ref is stable; we want one fire per (id, has-title) flip.
  }, [sticky.id, hasResolvedTitle]);

  const displayTitle =
    cleanedTitle || chipFallbackLabel(sticky.source as DockSource, sticky.url);
  const style: CSSProperties = {
    left: sticky.x,
    top: sticky.y,
    transform: `rotate(${sticky.tilt}deg)`,
  };
  return (
    <div
      className={cn(
        "fp-sticky",
        `fp-sticky--${sticky.color}`,
        dragging && "fp-sticky--dragging"
      )}
      style={style}
      onMouseDown={onPointerDown}
    >
      <div className="fp-sticky__tape" aria-hidden="true" />
      <div className="fp-sticky__head">
        <span className="fp-sticky__cat">
          {SOURCE_LABEL[sticky.source] ?? "LINK"}
        </span>
        <button
          type="button"
          className="fp-sticky__color"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onCycleColor}
          title="Cycle color"
          aria-label="Cycle color"
        >
          ◐
        </button>
        <button
          type="button"
          className="fp-sticky__x"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onRemoveFromBoard}
          title="Take off the board (chip stays in dock)"
          aria-label="Remove from board"
        >
          ×
        </button>
      </div>
      <h4 className="fp-sticky__title">{displayTitle}</h4>
      <a
        href={sticky.url}
        target="_blank"
        rel="noopener noreferrer"
        className="fp-sticky__open"
        onMouseDown={(e) => e.stopPropagation()}
      >
        OPEN ↗
      </a>
    </div>
  );
}

export default StickyNote;
