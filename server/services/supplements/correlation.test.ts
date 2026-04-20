import { describe, expect, it } from "vitest";
import {
  analyzeCorrelation,
  MIN_GROUP_SIZE,
  type CorrelationInput,
} from "./correlation";

function metric(dateKey: string, value: number | null) {
  return { dateKey, value };
}

function makeInput(
  overrides: Partial<CorrelationInput> = {}
): CorrelationInput {
  return {
    suppLogDates: new Set(),
    metrics: [],
    lagDays: 0,
    ...overrides,
  };
}

describe("analyzeCorrelation", () => {
  it("flags insufficientData when on-group is below threshold", () => {
    // 14 days total, supplement logged on 3 → onN = 3 < 7
    const metrics = Array.from({ length: 14 }, (_, i) =>
      metric(`2026-04-${String(i + 1).padStart(2, "0")}`, 60 + i)
    );
    const logged = new Set(["2026-04-01", "2026-04-02", "2026-04-03"]);
    const result = analyzeCorrelation(makeInput({ suppLogDates: logged, metrics }));
    expect(result.insufficientData).toBe(true);
    expect(result.onN).toBe(3);
    expect(result.offN).toBe(11);
  });

  it("flags insufficientData when off-group is below threshold", () => {
    const metrics = Array.from({ length: 14 }, (_, i) =>
      metric(`2026-04-${String(i + 1).padStart(2, "0")}`, 60)
    );
    // 13 days logged → offN = 1
    const logged = new Set(
      metrics.slice(0, 13).map((m) => m.dateKey)
    );
    const result = analyzeCorrelation(makeInput({ suppLogDates: logged, metrics }));
    expect(result.insufficientData).toBe(true);
    expect(result.offN).toBe(1);
  });

  it("meets threshold when both groups have >= MIN_GROUP_SIZE", () => {
    expect(MIN_GROUP_SIZE).toBe(7);
    // 14 days, logged on exactly half
    const metrics = Array.from({ length: 14 }, (_, i) =>
      metric(`2026-04-${String(i + 1).padStart(2, "0")}`, 60)
    );
    const logged = new Set(metrics.slice(0, 7).map((m) => m.dateKey));
    const result = analyzeCorrelation(makeInput({ suppLogDates: logged, metrics }));
    expect(result.insufficientData).toBe(false);
    expect(result.onN).toBe(7);
    expect(result.offN).toBe(7);
  });

  it("computes on/off means correctly", () => {
    const metrics = [
      metric("2026-04-01", 70),
      metric("2026-04-02", 80),
      metric("2026-04-03", 90),
      metric("2026-04-04", 40),
      metric("2026-04-05", 50),
      metric("2026-04-06", 60),
    ];
    const logged = new Set(["2026-04-01", "2026-04-02", "2026-04-03"]);
    const result = analyzeCorrelation(makeInput({ suppLogDates: logged, metrics }));
    expect(result.onMean).toBe(80); // (70+80+90)/3
    expect(result.offMean).toBe(50); // (40+50+60)/3
  });

  it("returns positive Cohen's d when on-group is higher", () => {
    // Include within-group variance so pooled SD > 0.
    const onGroupValues = [75, 78, 80, 82, 85, 78, 82];
    const offGroupValues = [55, 58, 60, 62, 65, 58, 62];
    const metrics = [
      ...onGroupValues.map((v, i) =>
        metric(`2026-04-${String(i + 1).padStart(2, "0")}`, v)
      ),
      ...offGroupValues.map((v, i) =>
        metric(`2026-04-${String(i + 8).padStart(2, "0")}`, v)
      ),
    ];
    const logged = new Set(metrics.slice(0, 7).map((m) => m.dateKey));
    const result = analyzeCorrelation(makeInput({ suppLogDates: logged, metrics }));
    expect(result.insufficientData).toBe(false);
    expect(result.cohensD).not.toBeNull();
    expect(result.cohensD!).toBeGreaterThan(0);
  });

  it("skips metric rows with null values", () => {
    const metrics = [
      metric("2026-04-01", 70),
      metric("2026-04-02", null),
      metric("2026-04-03", 80),
    ];
    const logged = new Set(["2026-04-01", "2026-04-02", "2026-04-03"]);
    const result = analyzeCorrelation(makeInput({ suppLogDates: logged, metrics }));
    expect(result.onN).toBe(2); // only 04-01 and 04-03 count
    expect(result.points).toHaveLength(2);
  });

  it("applies lag: lagDays=1 shifts supplement check back one day", () => {
    // Metric at 04-02 checks supp log at 04-01 (when lag=1)
    const metrics = [metric("2026-04-02", 80)];
    const loggedOnDay1 = new Set(["2026-04-01"]);

    const withLag1 = analyzeCorrelation({
      suppLogDates: loggedOnDay1,
      metrics,
      lagDays: 1,
    });
    expect(withLag1.points[0].logged).toBe(true);

    const noLag = analyzeCorrelation({
      suppLogDates: loggedOnDay1,
      metrics,
      lagDays: 0,
    });
    expect(noLag.points[0].logged).toBe(false);
  });

  it("handles empty metrics gracefully", () => {
    const result = analyzeCorrelation(makeInput());
    expect(result.insufficientData).toBe(true);
    expect(result.onN).toBe(0);
    expect(result.offN).toBe(0);
    expect(result.onMean).toBeNull();
    expect(result.offMean).toBeNull();
    expect(result.cohensD).toBeNull();
    expect(result.pearsonR).toBeNull();
  });

  it("returns null Pearson r when all metric values are identical (no variance)", () => {
    const metrics = Array.from({ length: 14 }, (_, i) =>
      metric(`2026-04-${String(i + 1).padStart(2, "0")}`, 50)
    );
    const logged = new Set(metrics.slice(0, 7).map((m) => m.dateKey));
    const result = analyzeCorrelation(makeInput({ suppLogDates: logged, metrics }));
    expect(result.pearsonR).toBeNull();
  });

  it("clamps lagDays above 3 to 3", () => {
    // With lag=5 passed, internal clamping to 3 should still produce a sensible result
    const metrics = [metric("2026-04-04", 80)];
    const loggedOn01 = new Set(["2026-04-01"]);
    const result = analyzeCorrelation({
      suppLogDates: loggedOn01,
      metrics,
      lagDays: 5,
    });
    // lag clamped to 3 → checks 04-04 minus 3 = 04-01 which is logged
    expect(result.points[0].logged).toBe(true);
  });
});
