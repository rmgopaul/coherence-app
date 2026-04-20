/**
 * Concurrent mapping utility — processes items in parallel with bounded
 * concurrency while preserving input order.
 *
 * Previously duplicated in routers.ts, apsystems.ts, and monitoring.service.ts.
 * The monitoring.service.ts version used Promise.race + push() which did NOT
 * preserve order — this canonical version uses indexed assignment.
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  if (items.length === 0) return [];

  const safeConcurrency = Math.max(1, Math.floor(concurrency));
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  };

  const workerCount = Math.min(safeConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Process-wide semaphore that caps the number of concurrent executions
 * of a wrapped function across unrelated callers.
 *
 * Unlike mapWithConcurrency (which bounds parallelism for a single
 * array-mapping call) and loadDashboardPayloadSingleFlight (which
 * dedupes callers sharing an identical key), Semaphore bounds the
 * TOTAL number of in-flight operations across all keys and callers.
 *
 * Used on the dataset-load path to prevent chunk-storm fan-outs from
 * stacking up in Node heap even when each individual chunk key is
 * distinct (and therefore immune to single-flight dedupe).
 *
 * Excess callers queue FIFO. Exceptions in the wrapped function
 * propagate normally; the slot is always released via try/finally.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Claim a slot. Awaited callers own `active += 1` by the time the
   * promise resolves — no "gap" between resolution and increment where
   * another caller could race in and observe the limit as not-yet-hit.
   *
   * Fast path: no queue, slot free, increment synchronously.
   * Slow path: push a resolver; release() will both set `active += 1`
   * AND call the resolver, atomically handing the slot over.
   */
  private acquire(): Promise<void> {
    if (this.queue.length === 0 && this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) {
      // The resolver hands ownership to the next waiter. We increment
      // `active` HERE (before the resolver fires) so there's no window
      // in which a new caller can enter acquire() and observe
      // `active < limit` while a waiter is mid-transition.
      this.active += 1;
      next();
    }
  }

  stats(): { active: number; waiting: number; limit: number } {
    return { active: this.active, waiting: this.queue.length, limit: this.limit };
  }
}
