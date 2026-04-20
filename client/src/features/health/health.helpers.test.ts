import { describe, expect, it } from "vitest";
import {
  formatMetricValue,
  meanAndStd,
  pairForCorrelation,
  parseTags,
  pearsonR,
  pearsonStrength,
  stringifyTags,
  topQuartileContrast,
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

describe("pearsonStrength", () => {
  it("buckets by |r|", () => {
    expect(pearsonStrength(null)).toBe("—");
    expect(pearsonStrength(0.05)).toBe("negligible");
    expect(pearsonStrength(-0.2)).toBe("weak");
    expect(pearsonStrength(0.4)).toBe("moderate");
    expect(pearsonStrength(-0.8)).toBe("strong");
  });
});

describe("meanAndStd", () => {
  it("returns null values for empty input", () => {
    expect(meanAndStd([])).toEqual({ mean: null, std: null });
  });
  it("computes mean", () => {
    expect(meanAndStd([1, 2, 3, 4, 5]).mean).toBe(3);
  });
  it("computes population std dev (n divisor)", () => {
    // pop var of [2,4,4,4,5,5,7,9] = 4 → std = 2
    expect(meanAndStd([2, 4, 4, 4, 5, 5, 7, 9]).std).toBeCloseTo(2, 10);
  });
  it("std is 0 when all values identical", () => {
    expect(meanAndStd([5, 5, 5, 5]).std).toBe(0);
  });
});

describe("topQuartileContrast", () => {
  it("returns nulls when too few points", () => {
    const pts = [
      { x: 1, y: 10 },
      { x: 2, y: 11 },
    ];
    expect(topQuartileContrast(pts).topMean).toBeNull();
  });

  it("computes top-quartile mean and overall mean", () => {
    // 20 points; y grows with x so top-quartile mean should exceed overall.
    const pts = Array.from({ length: 20 }, (_, i) => ({
      x: i,
      y: 10 + i,
    }));
    const result = topQuartileContrast(pts);
    expect(result.topN).toBeGreaterThanOrEqual(5);
    expect(result.topMean).not.toBeNull();
    expect(result.overallMean).not.toBeNull();
    expect(result.topMean!).toBeGreaterThan(result.overallMean!);
  });

  it("top-mean equals overall-mean when y is independent of x", () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 50 }));
    const result = topQuartileContrast(pts);
    expect(result.topMean).toBeCloseTo(result.overallMean!, 10);
  });
});
