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
