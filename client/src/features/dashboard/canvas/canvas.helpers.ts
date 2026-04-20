/**
 * Pure helpers for the Canvas (D4) board. Drag-state math, color
 * cycling, and the splitting of dock items into on-board / off-board.
 *
 * The component itself owns React state + tRPC mutation wiring; these
 * helpers stay framework-free so they can be tested without mounting.
 */
import type { StickyColor, StickyData } from "./StickyNote";

export const COLOR_CYCLE: StickyColor[] = [
  "paper",
  "yellow",
  "red",
  "blue",
  "black",
];

export interface DockItemLike {
  id: string;
  source: string;
  url: string;
  title: string | null;
  meta: Record<string, string>;
  x?: number | null;
  y?: number | null;
  tilt?: number | null;
  color?: string | null;
}

export interface PartitionedDock {
  stickies: StickyData[];
  dockOnly: DockItemLike[];
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Bucket dock items into the absolutely-positioned stickies (have both
 * x and y) and the off-board chips that sit on the shelf below the
 * board.
 */
export function partitionDockItems(items: DockItemLike[]): PartitionedDock {
  const stickies: StickyData[] = [];
  const dockOnly: DockItemLike[] = [];
  for (const it of items) {
    if (typeof it.x === "number" && typeof it.y === "number") {
      stickies.push({
        id: it.id,
        source: it.source,
        url: it.url,
        title: it.title,
        meta: it.meta,
        x: it.x,
        y: it.y,
        tilt: typeof it.tilt === "number" ? it.tilt : 0,
        color: ((it.color as StickyColor | null) ?? "paper") as StickyColor,
      });
    } else {
      dockOnly.push(it);
    }
  }
  return { stickies, dockOnly };
}

/** Cycles paper → yellow → red → blue → black → paper. */
export function nextStickyColor(current: StickyColor): StickyColor {
  const idx = COLOR_CYCLE.indexOf(current);
  return COLOR_CYCLE[(idx + 1) % COLOR_CYCLE.length];
}

export interface PlacementOptions {
  boardWidth: number;
  boardHeight: number;
  jitter?: () => number; // injectable for tests; defaults to random
  tiltRandom?: () => number; // -1..1 → -3°..+3°
}

/**
 * Compute a starting x/y/tilt for a chip being promoted onto the board.
 * Default: roughly center with a small random offset so two consecutive
 * adds don't perfectly overlap.
 */
export function computeInitialPlacement({
  boardWidth,
  boardHeight,
  jitter = () => Math.round((Math.random() - 0.5) * 80),
  tiltRandom = () => (Math.random() - 0.5) * 2,
}: PlacementOptions): { x: number; y: number; tilt: number } {
  const baseX = boardWidth / 2 - 130;
  const baseY = boardHeight / 2 - 60;
  return {
    x: Math.round(baseX + jitter()),
    y: Math.round(baseY + jitter()),
    tilt: Math.round(tiltRandom() * 3),
  };
}

export interface DragDelta {
  pointerStart: { x: number; y: number };
  noteStart: { x: number; y: number };
  current: { x: number; y: number };
}

/**
 * Apply a pointer-move event to the drag state. Clamps the result so
 * the sticky can't be flung into nowhere.
 */
export function applyDragDelta(
  drag: DragDelta,
  pointer: { x: number; y: number },
  bounds: { min: number; max: number } = { min: -20, max: 4000 }
): DragDelta {
  const dx = pointer.x - drag.pointerStart.x;
  const dy = pointer.y - drag.pointerStart.y;
  return {
    ...drag,
    current: {
      x: clamp(drag.noteStart.x + dx, bounds.min, bounds.max),
      y: clamp(drag.noteStart.y + dy, bounds.min, bounds.max),
    },
  };
}
