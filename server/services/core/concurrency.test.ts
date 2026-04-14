import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("returns empty array for empty input", async () => {
    const result = await mapWithConcurrency([], 3, async (x) => x);
    expect(result).toEqual([]);
  });

  it("maps all items", async () => {
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => x * 2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it("preserves input order", async () => {
    const delays = [50, 10, 30, 5, 40];
    const result = await mapWithConcurrency(delays, 3, async (ms, index) => {
      await new Promise((r) => setTimeout(r, ms));
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it("respects concurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    await mapWithConcurrency(Array.from({ length: 10 }), 3, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("works with concurrency of 1 (sequential)", async () => {
    const order: number[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (x) => {
      order.push(x);
      return x;
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("works when concurrency exceeds item count", async () => {
    const result = await mapWithConcurrency([1, 2], 100, async (x) => x + 1);
    expect(result).toEqual([2, 3]);
  });

  it("passes index to mapper", async () => {
    const result = await mapWithConcurrency(["a", "b", "c"], 2, async (_, i) => i);
    expect(result).toEqual([0, 1, 2]);
  });

  it("propagates errors", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      })
    ).rejects.toThrow("boom");
  });

  it("handles concurrency < 1 gracefully", async () => {
    const result = await mapWithConcurrency([1, 2], 0, async (x) => x);
    expect(result).toEqual([1, 2]);
  });
});
