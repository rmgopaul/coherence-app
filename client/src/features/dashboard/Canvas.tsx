/**
 * Canvas — D4 view (Phase F8).
 *
 * Route: /dashboard/canvas
 *
 * A sticky-note board backed by `dockItems`. Any chip with a non-null
 * (x, y) renders absolutely positioned; "Add to board" promotes a
 * dock chip to a sticky note. Drag to move (HTML5 mouse events,
 * commits on drop via trpc.dock.move).
 *
 * Spec: handoff/Productivity Hub Reimagined (2).html §D4
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { trpc } from "@/lib/trpc";
import { DashboardViewsNav } from "./DashboardViewsNav";
import { StickyNote, type StickyData } from "./canvas/StickyNote";
import {
  applyDragDelta,
  computeInitialPlacement,
  nextStickyColor,
  partitionDockItems,
} from "./canvas/canvas.helpers";
import "./frontpage/dashboard.css";

interface DragState {
  id: string;
  pointerStart: { x: number; y: number };
  noteStart: { x: number; y: number };
  current: { x: number; y: number };
}

export default function Canvas() {
  const utils = trpc.useUtils();
  const { data: items = [], isLoading } = trpc.dock.list.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  const moveMut = trpc.dock.move.useMutation({
    // We optimistic-update the cache locally during drag; the next
    // refetch reconciles. No invalidate on success — keeps the drop
    // feeling instant.
  });

  const [drag, setDrag] = useState<DragState | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);

  const { stickies, dockOnly } = useMemo(
    () => partitionDockItems(items),
    [items]
  );

  // ---- Drag handlers --------------------------------------------------

  const onStickyPointerDown = useCallback(
    (sticky: StickyData) =>
      (e: ReactMouseEvent<HTMLDivElement>) => {
        // Only respond to primary button.
        if (e.button !== 0) return;
        e.preventDefault();
        setDrag({
          id: sticky.id,
          pointerStart: { x: e.clientX, y: e.clientY },
          noteStart: { x: sticky.x, y: sticky.y },
          current: { x: sticky.x, y: sticky.y },
        });
      },
    []
  );

  useEffect(() => {
    if (!drag) return;
    function onMove(e: MouseEvent) {
      setDrag((d) => {
        if (!d) return d;
        const updated = applyDragDelta(d, { x: e.clientX, y: e.clientY });
        return { ...d, current: updated.current };
      });
    }
    function onUp() {
      setDrag((d) => {
        if (!d) return null;
        // Commit on release — fire-and-forget.
        moveMut.mutate({ id: d.id, x: d.current.x, y: d.current.y });
        return null;
      });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, moveMut]);

  // ---- Action handlers ------------------------------------------------

  function placeOnBoard(itemId: string) {
    const board = boardRef.current?.getBoundingClientRect();
    const placement = computeInitialPlacement({
      boardWidth: board?.width ?? 800,
      boardHeight: board?.height ?? 600,
    });
    moveMut.mutate(
      { id: itemId, ...placement },
      { onSuccess: () => void utils.dock.list.invalidate() }
    );
  }

  function removeFromBoard(itemId: string) {
    moveMut.mutate(
      { id: itemId, x: null, y: null, tilt: null },
      { onSuccess: () => void utils.dock.list.invalidate() }
    );
  }

  function cycleColor(sticky: StickyData) {
    moveMut.mutate(
      { id: sticky.id, color: nextStickyColor(sticky.color) },
      { onSuccess: () => void utils.dock.list.invalidate() }
    );
  }

  // ---- Render ---------------------------------------------------------

  return (
    <div className="fp-root fp-canvas-root">
      <DashboardViewsNav />
      <div className="fp-canvas">
        <header className="fp-canvas__head">
          <h1>
            CANVAS{" "}
            <em className="fp-canvas__head-em">— pin what matters.</em>
          </h1>
          <p className="fp-canvas__sub mono-label">
            DROP CHIPS FROM THE DOCK ONTO THE BOARD · DRAG TO REARRANGE
          </p>
        </header>

        <div ref={boardRef} className="fp-canvas__board" aria-label="Sticky note board">
          {isLoading && (
            <p className="fp-empty fp-canvas__empty">loading the board…</p>
          )}
          {!isLoading && stickies.length === 0 && (
            <p className="fp-empty fp-canvas__empty">
              empty board. drop a chip from the dock below.
            </p>
          )}
          {stickies.map((sticky) => {
            const isDragging = drag?.id === sticky.id;
            const liveSticky = isDragging
              ? { ...sticky, x: drag.current.x, y: drag.current.y }
              : sticky;
            return (
              <StickyNote
                key={sticky.id}
                sticky={liveSticky}
                dragging={isDragging}
                onPointerDown={onStickyPointerDown(sticky)}
                onCycleColor={() => cycleColor(sticky)}
                onRemoveFromBoard={() => removeFromBoard(sticky.id)}
              />
            );
          })}
        </div>

        <section className="fp-canvas__dock-shelf" aria-label="Dock chips not on board">
          <header className="fp-canvas__dock-head">
            <span className="mono-label">DOCK · NOT ON BOARD</span>
            <span className="mono-label">{dockOnly.length} CHIPS</span>
          </header>
          {dockOnly.length === 0 ? (
            <p className="fp-empty">all dock chips are pinned to the board.</p>
          ) : (
            <div className="fp-canvas__dock-row">
              {dockOnly.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className="fp-canvas__shelf-chip"
                  onClick={() => placeOnBoard(it.id)}
                  title="Click to pin onto the board"
                >
                  <span className="fp-canvas__shelf-src">{it.source.toUpperCase()}</span>
                  <span className="fp-canvas__shelf-title">
                    {it.title?.trim() || it.url}
                  </span>
                  <span className="fp-canvas__shelf-add">＋ pin</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
