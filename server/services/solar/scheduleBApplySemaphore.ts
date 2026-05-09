/**
 * In-process single-flight semaphore for the
 * `applyScheduleBToDeliveryObligations` mutation.
 *
 * 2026-05-09 follow-up to PR-3 (#532). PR-3 fixed the client-side
 * dep-array churn that caused 11 concurrent `mutateAsync` calls to
 * fan out from a single tab activation. The mutation handler itself
 * has no server-side concurrency guard — a defective client OR a
 * race between PR-3's `autoApplyInFlightRef` reset and a fresh effect
 * fire could still produce concurrent requests. This module is the
 * defense-in-depth layer.
 *
 * **What it does.** Per `(scopeId, jobId)` pair, only one apply runs
 * at a time. Concurrent calls with the same key wait for the
 * in-flight call and receive its result (single-flight coalescing).
 * Calls with different keys run independently.
 *
 * **What it doesn't do.** This is in-process; it doesn't help across
 * server instances. CLAUDE.md hard rule #8 mandates DB-backed
 * registries for job runners, but a request-coalescing semaphore is
 * a different concern (it doesn't survive process restarts and
 * doesn't need to — each restart starts fresh, with no in-flight
 * applies). For multi-instance prod, the client throttle (PR-3) is
 * the load-bearing defense; the in-process semaphore is belt-and-
 * braces for the local-process race window.
 *
 * **Result coalescing semantics.** Two callers requesting the same
 * key receive the IDENTICAL result object — the second caller does
 * NOT trigger a fresh apply. This is correct for an idempotent
 * apply (the second apply would have re-merged the same incoming
 * rows against the now-updated baseline and produced the same final
 * state), but importantly it also means side effects fire ONCE: a
 * single `setLastServerApply` on the client, a single
 * `notifyServerDataChanged` invalidation. Without coalescing, a
 * client-side race could double-fire those side effects.
 */

const inFlightApplies = new Map<string, Promise<unknown>>();

export type ScheduleBApplyKey = string;

/**
 * Build a stable single-flight key for `(scopeId, jobId)`. Both
 * components are required because:
 *
 * - Different `scopeId`s are different tenants; they must run
 *   independently.
 * - Different `jobId`s within the same scope are different scans
 *   (e.g., a manual upload's job ID vs. an automated scan's
 *   job ID); they must also run independently.
 *
 * The pipe separator is safe because neither scopeId nor jobId
 * contain pipes in any extant format.
 */
export function buildScheduleBApplyKey(
  scopeId: string,
  jobId: string
): ScheduleBApplyKey {
  return `${scopeId}|${jobId}`;
}

/**
 * Run `apply` exclusively for the given key. Concurrent calls with
 * the same key receive the same Promise (single-flight). The
 * registry slot is released after the inner Promise settles —
 * success OR failure — so a transient failure doesn't leave the
 * key permanently locked.
 *
 * Generic over the apply result type so callers can preserve their
 * exact shape (the apply mutation's full result envelope).
 */
export function withScheduleBApplySemaphore<T>(
  key: ScheduleBApplyKey,
  apply: () => Promise<T>
): Promise<T> {
  const existing = inFlightApplies.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  // Two-phase init so the IIFE's finally can compare against the
  // assigned Promise. Synchronous order: the IIFE's body
  // (`apply()`) doesn't run until the next microtask, so the
  // assignment to `promiseHolder.value` lands BEFORE the finally
  // ever fires. Using a holder object instead of a `let` avoids
  // TypeScript's "used before assigned" error in the finally
  // block, which is structurally a closure over the outer scope.
  const promiseHolder: { value: Promise<T> | null } = { value: null };
  const promise: Promise<T> = (async () => {
    try {
      return await apply();
    } finally {
      // Only delete if this Promise is still the current entry. A
      // pathological re-entry pattern could in principle observe a
      // newer entry under the same key (e.g., if a finally handler
      // registered a fresh apply); the identity check ensures we
      // don't accidentally drop the newer one.
      if (
        promiseHolder.value !== null &&
        inFlightApplies.get(key) === promiseHolder.value
      ) {
        inFlightApplies.delete(key);
      }
    }
  })();
  promiseHolder.value = promise;
  inFlightApplies.set(key, promise as Promise<unknown>);
  return promise;
}

/**
 * Test-only helper to inspect the registry state. Production code
 * never calls this; its presence here means tests can assert that
 * a key is or isn't currently in flight without exposing the Map.
 */
export function __getScheduleBSemaphoreSizeForTests(): number {
  return inFlightApplies.size;
}

/**
 * Test-only helper to clear the registry between test cases.
 * Production code never calls this.
 */
export function __resetScheduleBSemaphoreForTests(): void {
  inFlightApplies.clear();
}
