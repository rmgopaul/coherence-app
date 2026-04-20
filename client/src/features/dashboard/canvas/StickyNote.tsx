/**
 * StickyNote — single absolutely-positioned chip on the Canvas board.
 * Drag to reposition; the parent <Canvas /> tracks pointer state and
 * commits the new x/y to the server on drop.
 */
import { cn } from "@/lib/utils";
import type { CSSProperties, MouseEvent } from "react";

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
      <h4 className="fp-sticky__title">{sticky.title ?? sticky.url}</h4>
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
