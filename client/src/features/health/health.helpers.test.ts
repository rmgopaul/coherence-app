import { describe, expect, it } from "vitest";
import {
  formatMetricValue,
  pairForCorrelation,
  parseTags,
  pearsonR,
  stringifyTags,
} from "./health.helpers";

describe("formatMetricValue", () => {
  it("returns em dash for null/undefined/non-finite", () => {
    expect(formatMetricValue("whoopRecoveryScore", null)).toBe("—");
    expect(formatMetricValue("whoopRecoveryScore", undefined)).toBe("—");
    expect(formatMetricValue("whoopRecoveryScore", Number.NaN)).toBe("—");
  });
  it("adds % suffix for percent metrics", () => {
    expect(formatMetricValue("whoopRecoveryScore", 67.4)).toBe("67%");
    expect(formatMetricValue("samsungSpo2AvgPercent", 97)).toBe("97%");
  });
  it("adds h suffix for hour metrics", () => {
    expect(formatMetricValue("whoopSleepHours", 7.3)).toBe("7.3h");
    expect(formatMetricValue("samsungSleepHours", 6)).toBe("6.0h");
  });
  it("adds ms for HRV", () => {
    expect(formatMetricValue("whoopHrvMs", 45.7)).toBe("46 ms");
  });
  it("adds bpm for resting HR", () => {
    expect(formatMetricValue("whoopRestingHr", 58.2)).toBe("58 bpm");
  });
  it("uses thousand separators for steps", () => {
    expect(formatMetricValue("samsungSteps", 12345)).toBe("12,345");
  });
});

describe("parseTags", () => {
  it("splits on commas and trims", () => {
    expect(parseTags("alcohol, travel , sick")).toEqual(["alcohol", "travel", "sick"]);
  });
  it("returns [] for null/undefined/empty", () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags("")).toEqual([]);
  });
  it("dedupes case-insensitively, preserves first-seen casing", () => {
    expect(parseTags("Alcohol, alcohol, ALCOHOL")).toEqual(["Alcohol"]);
  });
});

describe("stringifyTags", () => {
  it("round-trips through parseTags", () => {
    expect(stringifyTags(["alcohol", "travel"])).toBe("alcohol, travel");
  });
  it("returns null for empty list", () => {
    expect(stringifyTags([])).toBeNull();
  });
  it("dedupes on output", () => {
    expect(stringifyTags(["alcohol", "alcohol"])).toBe("alcohol");
  });
});

describe("pairForCorrelation", () => {
  it("drops rows with null or non-finite values", () => {
    const rows = [
      { dateKey: "2026-04-19", a: 70, b: 80 },
      { dateKey: "2026-04-20", a: null, b: 85 },
      { dateKey: "2026-04-21", a: 75, b: Number.NaN },
      { dateKey: "2026-04-22", a: 77, b: 83 },
    ];
    expect(pairForCorrelation(rows)).toEqual([
      { x: 70, y: 80 },
      { x: 77, y: 83 },
    ]);
  });
});

describe("pearsonR", () => {
  it("returns null for <3 points", () => {
    expect(pearsonR([])).toBeNull();
    expect(pearsonR([{ x: 1, y: 2 }])).toBeNull();
  });
  it("returns ~1 for a perfectly positive linear relationship", () => {
    const pts = [1, 2, 3, 4, 5].map((n) => ({ x: n, y: 2 * n + 1 }));
    expect(pearsonR(pts)).toBeCloseTo(1, 10);
  });
  it("returns ~-1 for a perfectly negative linear relationship", () => {
    const pts = [1, 2, 3, 4, 5].map((n) => ({ x: n, y: -3 * n + 10 }));
    expect(pearsonR(pts)).toBeCloseTo(-1, 10);
  });
  it("returns null when y is constant (zero variance)", () => {
    const pts = [1, 2, 3, 4].map((n) => ({ x: n, y: 5 }));
    expect(pearsonR(pts)).toBeNull();
  });
});
