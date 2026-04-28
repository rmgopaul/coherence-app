/**
 * Task 9.3 (2026-04-28) — tests for the paste-IDs parser used by
 * `<WorksetSelector />` and every job page that takes a list of
 * CSG IDs from the user.
 *
 * Pure function; no mocks needed.
 */
import { describe, expect, it } from "vitest";
import { parseCsgIdInput } from "./csgIdInput";

describe("parseCsgIdInput", () => {
  it("splits on newlines and trims surrounding whitespace", () => {
    expect(parseCsgIdInput("CSG-1\nCSG-2\n  CSG-3  \n")).toEqual([
      "CSG-1",
      "CSG-2",
      "CSG-3",
    ]);
  });

  it("splits on commas with arbitrary spacing", () => {
    expect(parseCsgIdInput("CSG-1, CSG-2,CSG-3 ,CSG-4")).toEqual([
      "CSG-1",
      "CSG-2",
      "CSG-3",
      "CSG-4",
    ]);
  });

  it("splits on tabs (CSV / spreadsheet copy-paste)", () => {
    expect(parseCsgIdInput("CSG-1\tCSG-2\tCSG-3")).toEqual([
      "CSG-1",
      "CSG-2",
      "CSG-3",
    ]);
  });

  it("handles mixed delimiters in one input", () => {
    expect(
      parseCsgIdInput("CSG-1,CSG-2\nCSG-3\tCSG-4,\nCSG-5")
    ).toEqual(["CSG-1", "CSG-2", "CSG-3", "CSG-4", "CSG-5"]);
  });

  it("drops empty fragments + pure-whitespace lines", () => {
    expect(parseCsgIdInput("CSG-1\n\n   \n\nCSG-2")).toEqual([
      "CSG-1",
      "CSG-2",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseCsgIdInput("")).toEqual([]);
    expect(parseCsgIdInput("   \n  \t  ")).toEqual([]);
  });

  it("preserves duplicates (dedupe is the server-side helper's job)", () => {
    // Intentional — the WorksetSelector counter shows raw pastes so
    // users see exactly what they typed; `worksets.create` dedupes
    // server-side via `normalizeCsgIds` in `db/idWorksets.ts`.
    expect(parseCsgIdInput("CSG-1\nCSG-1\nCSG-2")).toEqual([
      "CSG-1",
      "CSG-1",
      "CSG-2",
    ]);
  });

  it("preserves first-occurrence order", () => {
    expect(parseCsgIdInput("zebra\napple\nmango")).toEqual([
      "zebra",
      "apple",
      "mango",
    ]);
  });
});
