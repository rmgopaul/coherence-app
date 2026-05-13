import { describe, it, expect } from "vitest";
import {
  MAX_SYNC_NOTICE_LENGTH,
  formatTruncatedHeaderList,
} from "./datasetIngestErrorMessages";

describe("MAX_SYNC_NOTICE_LENGTH", () => {
  it("matches the SolarRecDashboard client-truncation cap", () => {
    // The client slices `info.message.slice(0, 200)` in the sync-
    // issues banner — anything longer gets visually truncated.
    expect(MAX_SYNC_NOTICE_LENGTH).toBe(200);
  });
});

describe("formatTruncatedHeaderList", () => {
  it("joins the headers with comma-space when count <= maxCount", () => {
    expect(formatTruncatedHeaderList(["a", "b", "c"], 6)).toBe("a, b, c");
  });

  it("truncates with ellipsis when the list exceeds maxCount", () => {
    expect(
      formatTruncatedHeaderList(["a", "b", "c", "d", "e", "f", "g"], 6)
    ).toBe("a, b, c, d, e, f, …");
  });

  it("returns empty string for an empty input", () => {
    expect(formatTruncatedHeaderList([], 6)).toBe("");
  });

  it("does NOT append the ellipsis when count exactly equals maxCount", () => {
    expect(formatTruncatedHeaderList(["a", "b", "c"], 3)).toBe("a, b, c");
  });

  it("respects different maxCount values across call sites", () => {
    // v1 uses 6; v2 uses 12. Pin both behaviours.
    const headers = Array.from({ length: 15 }, (_, i) => `h${i + 1}`);
    expect(formatTruncatedHeaderList(headers, 6)).toBe(
      "h1, h2, h3, h4, h5, h6, …"
    );
    expect(formatTruncatedHeaderList(headers, 12)).toBe(
      "h1, h2, h3, h4, h5, h6, h7, h8, h9, h10, h11, h12, …"
    );
  });
});
