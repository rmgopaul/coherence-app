import { describe, it, expect } from "vitest";
import { sanitizeApiKey } from "./solarEdge";

describe("sanitizeApiKey", () => {
  it("returns empty string for non-strings", () => {
    expect(sanitizeApiKey(null)).toBe("");
    expect(sanitizeApiKey(undefined)).toBe("");
  });

  it("preserves a clean key", () => {
    expect(sanitizeApiKey("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")).toBe(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
    );
  });

  it("strips ordinary leading/trailing whitespace", () => {
    expect(sanitizeApiKey("  abc123  ")).toBe("abc123");
    expect(sanitizeApiKey("\tabc123\n")).toBe("abc123");
    expect(sanitizeApiKey("\r\nabc123\r\n")).toBe("abc123");
  });

  it("strips NBSP that survives .trim() in some runtimes", () => {
    expect(sanitizeApiKey(" abc123 ")).toBe("abc123");
  });

  it("strips zero-width chars at boundaries", () => {
    // ZWSP, ZWNJ, ZWJ
    expect(sanitizeApiKey("​abc123​")).toBe("abc123");
    expect(sanitizeApiKey("‌abc123‍")).toBe("abc123");
  });

  it("strips byte-order-mark / zero-width no-break space", () => {
    expect(sanitizeApiKey("﻿abc123﻿")).toBe("abc123");
  });

  it("strips word joiner", () => {
    expect(sanitizeApiKey("⁠abc123⁠")).toBe("abc123");
  });

  it("does NOT strip invisible chars from the middle", () => {
    // We only sanitize boundaries — a key with a real internal char
    // should be left alone so the upstream auth surface still rejects it
    // visibly rather than silently producing a different key.
    expect(sanitizeApiKey("abc​123")).toBe("abc​123");
  });

  it("strips line/paragraph separators", () => {
    expect(sanitizeApiKey(" abc123 ")).toBe("abc123");
  });

  it("returns empty for whitespace-only input", () => {
    expect(sanitizeApiKey("   \t\n ​")).toBe("");
  });
});
