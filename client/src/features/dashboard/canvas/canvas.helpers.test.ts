import { describe, expect, it } from "vitest";
import {
  applyDragDelta,
  clamp,
  COLOR_CYCLE,
  computeInitialPlacement,
  nextStickyColor,
  partitionDockItems,
  type DockItemLike,
} from "./canvas.helpers";

describe("clamp", () => {
  it("clamps within bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("works with negative bounds", () => {
    expect(clamp(-100, -50, 50)).toBe(-50);
    expect(clamp(0, -50, 50)).toBe(0);
  });
});

describe("partitionDockItems", () => {
  function item(
    id: string,
    overrides: Partial<DockItemLike> = {}
  ): DockItemLike {
    return {
      id,
      source: "url",
      url: `https://example.com/${id}`,
      title: `Item ${id}`,
      meta: {},
      ...overrides,
    };
  }

  it("splits items with x+y onto board, others to dock-only", () => {
    const out = partitionDockItems([
      item("a"),
      item("b", { x: 100, y: 200 }),
      item("c", { x: 50, y: 50, tilt: 5, color: "yellow" }),
      item("d", { x: 0 }), // missing y → dock only
    ]);
    expect(out.stickies.map((s) => s.id)).toEqual(["b", "c"]);
    expect(out.dockOnly.map((s) => s.id)).toEqual(["a", "d"]);
  });

  it("defaults tilt to 0 and color to 'paper' when missing", () => {
    const out = partitionDockItems([item("a", { x: 0, y: 0 })]);
    expect(out.stickies[0].tilt).toBe(0);
    expect(out.stickies[0].color).toBe("paper");
  });

  it("preserves an explicit color", () => {
    const out = partitionDockItems([
      item("a", { x: 0, y: 0, color: "blue" }),
    ]);
    expect(out.stickies[0].color).toBe("blue");
  });

  it("returns empty buckets for an empty list", () => {
    expect(partitionDockItems([])).toEqual({ stickies: [], dockOnly: [] });
  });
});

describe("nextStickyColor", () => {
  it("cycles through every color and wraps back to paper", () => {
    let c = COLOR_CYCLE[0];
    const seen = [c];
    for (let i = 0; i < COLOR_CYCLE.length; i++) {
      c = nextStickyColor(c);
      seen.push(c);
    }
    expect(seen).toEqual([
      "paper",
      "yellow",
      "red",
      "blue",
      "black",
      "paper",
    ]);
  });
});

describe("computeInitialPlacement", () => {
  it("centers within the board minus the sticky offset", () => {
    const out = computeInitialPlacement({
      boardWidth: 800,
      boardHeight: 600,
      jitter: () => 0,
      tiltRandom: () => 0,
    });
    expect(out.x).toBe(800 / 2 - 130);
    expect(out.y).toBe(600 / 2 - 60);
    expect(out.tilt).toBe(0);
  });

  it("respects custom jitter and tilt fns", () => {
    const out = computeInitialPlacement({
      boardWidth: 1000,
      boardHeight: 800,
      jitter: () => 10,
      tiltRandom: () => 1,
    });
    expect(out.x).toBe(1000 / 2 - 130 + 10);
    expect(out.y).toBe(800 / 2 - 60 + 10);
    expect(out.tilt).toBe(3);
  });

  it("rounds tilt to an integer", () => {
    const out = computeInitialPlacement({
      boardWidth: 100,
      boardHeight: 100,
      jitter: () => 0,
      tiltRandom: () => -0.66,
    });
    expect(out.tilt).toBe(-2);
  });
});

describe("applyDragDelta", () => {
  const baseDrag = {
    pointerStart: { x: 100, y: 100 },
    noteStart: { x: 200, y: 300 },
    current: { x: 200, y: 300 },
  };

  it("translates the note by the pointer delta", () => {
    const out = applyDragDelta(baseDrag, { x: 150, y: 90 });
    expect(out.current).toEqual({ x: 250, y: 290 });
  });

  it("clamps within the default board bounds", () => {
    const out = applyDragDelta(baseDrag, { x: 100_000, y: 100_000 });
    expect(out.current).toEqual({ x: 4000, y: 4000 });
  });

  it("clamps to the lower bound when dragged off-screen", () => {
    const out = applyDragDelta(baseDrag, { x: -100_000, y: -100_000 });
    expect(out.current).toEqual({ x: -20, y: -20 });
  });

  it("respects custom bounds", () => {
    const out = applyDragDelta(baseDrag, { x: 200, y: 200 }, { min: 0, max: 240 });
    expect(out.current).toEqual({ x: 240, y: 240 });
  });

  it("preserves pointerStart and noteStart on each move", () => {
    const out = applyDragDelta(baseDrag, { x: 110, y: 110 });
    expect(out.pointerStart).toEqual(baseDrag.pointerStart);
    expect(out.noteStart).toEqual(baseDrag.noteStart);
  });
});
