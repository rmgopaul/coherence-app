import { describe, it, expect } from "vitest";
import { mapWithConcurrency, Semaphore } from "./concurrency";

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

describe("Semaphore", () => {
  it("runs a single task without queueing", async () => {
    const sem = new Semaphore(2);
    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
    expect(sem.stats()).toEqual({ active: 0, waiting: 0, limit: 2 });
  });

  it("caps concurrent executions to the limit", async () => {
    const sem = new Semaphore(3);
    let concurrent = 0;
    let maxConcurrent = 0;
    const workers = Array.from({ length: 10 }, () =>
      sem.run(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
      })
    );
    await Promise.all(workers);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(sem.stats().active).toBe(0);
    expect(sem.stats().waiting).toBe(0);
  });

  it("releases slot on error so queue drains", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const result = await sem.run(async () => "recovered");
    expect(result).toBe("recovered");
    expect(sem.stats().active).toBe(0);
  });

  it("queues FIFO when at limit", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    let release: (() => void) | null = null;
    // Start first task — it acquires the single slot and blocks on a
    // promise we control, giving the test deterministic control over
    // when later tasks can run.
    const first = sem.run(async () => {
      order.push(0);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    // Let the first task actually acquire the slot
    await new Promise((r) => setTimeout(r, 1));
    // Queue three more; they should drain in enqueue order 1, 2, 3
    const tasks = [1, 2, 3].map((n) =>
      sem.run(async () => {
        order.push(n);
      })
    );
    // Release the first task so the queue can drain
    release!();
    await first;
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("clamps limit < 1 to 1", () => {
    const sem = new Semaphore(0);
    expect(sem.stats().limit).toBe(1);
  });

  it("reports active + waiting counts while tasks run", async () => {
    const sem = new Semaphore(2);
    let release1: (() => void) | null = null;
    let release2: (() => void) | null = null;
    const t1 = sem.run(
      () => new Promise<void>((r) => (release1 = r))
    );
    const t2 = sem.run(
      () => new Promise<void>((r) => (release2 = r))
    );
    // Let both acquire
    await new Promise((r) => setTimeout(r, 1));
    const t3 = sem.run(async () => "third");
    await new Promise((r) => setTimeout(r, 1));
    expect(sem.stats()).toEqual({ active: 2, waiting: 1, limit: 2 });
    release1!();
    await t1;
    await t3;
    release2!();
    await t2;
    expect(sem.stats()).toEqual({ active: 0, waiting: 0, limit: 2 });
  });
});
