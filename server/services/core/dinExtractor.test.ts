import { describe, it, expect } from "vitest";
import { __test__ } from "./dinExtractor";

const { normalizeDin, collectDinsFromText, DIN_REGEX } = __test__;

describe("normalizeDin", () => {
  it("uppercases", () => {
    expect(normalizeDin("1538000-45-a-gf2230670002nb")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });

  it("collapses multi-dash runs to single dash", () => {
    expect(normalizeDin("1538000-45-A---GF2230670002NB")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });

  it("replaces whitespace with dash and collapses", () => {
    expect(normalizeDin("1538000 45 A  GF2230670002NB")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeDin("   1538000-45-A-GF2230670002NB  ")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });

  it("handles mixed whitespace and dashes", () => {
    expect(normalizeDin("1538000 - 45 - A - - - GF2230670002NB")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });
});

describe("collectDinsFromText", () => {
  it("returns empty array on empty input", () => {
    expect(collectDinsFromText("", "claude")).toEqual([]);
  });

  it("returns empty array when no DIN is present", () => {
    expect(
      collectDinsFromText("No device identifier here.", "claude")
    ).toEqual([]);
  });

  it("extracts a canonical DIN with triple-dash", () => {
    const matches = collectDinsFromText(
      "DIN:1538000-45-A---GF2230670002NB\nOther text",
      "claude"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].dinValue).toBe("1538000-45-A-GF2230670002NB");
    expect(matches[0].extractedBy).toBe("claude");
  });

  it("extracts multiple distinct DINs from the same text", () => {
    const matches = collectDinsFromText(
      "DIN:1538000-45-A---GF2230670002NB and DIN:1538000-46-B---AB1234567890XY",
      "tesseract"
    );
    expect(matches).toHaveLength(2);
    const values = matches.map((m) => m.dinValue).sort();
    expect(values).toEqual([
      "1538000-45-A-GF2230670002NB",
      "1538000-46-B-AB1234567890XY",
    ]);
    expect(matches.every((m) => m.extractedBy === "tesseract")).toBe(true);
  });

  it("deduplicates identical DINs within the same text", () => {
    const matches = collectDinsFromText(
      "first DIN:1538000-45-A---GF2230670002NB then DIN:1538000-45-A---GF2230670002NB again",
      "pdfjs"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].dinValue).toBe("1538000-45-A-GF2230670002NB");
  });

  it("dedupes across dash/space variants that normalize to the same value", () => {
    const matches = collectDinsFromText(
      "DIN 1538000 45 A GF2230670002NB and DIN:1538000-45-A-GF2230670002NB",
      "claude"
    );
    expect(matches).toHaveLength(1);
  });

  it("tags extractedBy from the caller-provided value", () => {
    expect(
      collectDinsFromText(
        "DIN:1538000-45-A-GF2230670002NB",
        "pdfjs"
      )[0].extractedBy
    ).toBe("pdfjs");
  });
});

describe("DIN_REGEX", () => {
  it("matches the canonical sticker format", () => {
    const re = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    const match = re.exec("DIN:1538000-45-A---GF2230670002NB end");
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("1538000-45-A---GF2230670002NB");
  });

  it("does not match plainly non-DIN strings", () => {
    const re = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    expect(re.exec("phone: 555-123-4567")).toBeNull();
    expect(re.exec("serial ABC")).toBeNull();
  });

  it("requires the alphanumeric tail to be at least 6 chars", () => {
    const re = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    expect(re.exec("1538000-45-A-SHORT")).toBeNull();
    expect(re.exec("1538000-45-A-ABCDEF")).not.toBeNull();
  });

  it("matches case-insensitively — OCR output is often lower-case", () => {
    // The `i` flag is load-bearing. If a future change drops it, this
    // guards the lower-case happy-path that real-world OCR produces.
    const re = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    const match = re.exec("din:1538000-45-a-gf2230670002nb");
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("1538000-45-a-gf2230670002nb");
  });
});
