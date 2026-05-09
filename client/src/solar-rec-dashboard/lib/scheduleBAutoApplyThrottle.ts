/**
 * Schedule B auto-apply throttle decision helper.
 *
 * 2026-05-09 — Bug #3 from the prod QA walk: clicking the Delivery
 * Tracker tab fires 11 concurrent
 * `applyScheduleBToDeliveryObligations` POSTs. Two contributing
 * causes both addressed by PR-3:
 *
 *   1. The auto-apply `useEffect` in `ScheduleBImport.tsx` had
 *      `applyScheduleBToDeliveryObligations` (a `useMutation()`
 *      result) and `notifyServerDataChanged` (a `useCallback`) in
 *      its dep array. Both get fresh references on parent re-renders.
 *      Consecutive renders re-fire the effect; each re-fire schedules
 *      a new `setTimeout` whose body has multiple await points. The
 *      cleanup-cancels-the-pending-timer pattern only works for
 *      timers that haven't yet fired — once the timer body starts,
 *      the cleanup `cancelled` flag is checked only at the very top
 *      and the body proceeds across awaits without re-checking.
 *      Multiple bodies racing across awaits → multiple
 *      mutateAsync calls in flight.
 *
 *   2. The throttle-state ref (`autoApplyStateRef.current.count`)
 *      is updated AFTER `mutateAsync` resolves. Until then, every
 *      newly-fired timer body sees the same "we have N new results,
 *      none applied yet" condition and proceeds.
 *
 * This module isolates the decision logic so it can be unit-tested
 * (vitest is Node-env only — no jsdom — and the effect itself can't
 * be mounted there).
 */

export type AutoApplyDecisionInput = {
  /**
   * Number of successful (non-error) Schedule B results currently in
   * the component's `scheduleBResults` state. The effect short-
   * circuits when this is zero.
   */
  successfulResultCount: number;
  /**
   * Last value of `autoApplyStateRef.current.count` — the
   * `successfulResultCount` recorded on the most recent successful
   * apply. The throttle short-circuits when no NEW results arrived
   * since then.
   */
  lastAppliedCount: number;
  /**
   * Last apply timestamp (ms since epoch). 0 means "never applied
   * yet" — the throttle delay is 0 in that case (or driven by
   * `jobIsComplete` instead).
   */
  lastAppliedAtMs: number;
  /** Current wall-clock time in ms. */
  nowMs: number;
  /**
   * Whether the upstream Schedule B import job is in a terminal
   * state. When complete, the throttle delay is 0 (a tab activation
   * after a finished scan should fire immediately, once). When the
   * job is still running, full throttle applies.
   */
  jobIsComplete: boolean;
  /**
   * Throttle window in ms. Production setting is 30_000 (see
   * `AUTO_APPLY_MIN_INTERVAL_MS` in `ScheduleBImport.tsx`); the test
   * suite passes shorter values for fast-path coverage.
   */
  minIntervalMs: number;
  /**
   * Whether a previously-scheduled apply is still running. When
   * true, the decision is "skip" regardless of any other condition
   * — the in-flight body will record the new
   * `lastAppliedCount` on completion, and the effect can re-evaluate
   * on its next fire.
   */
  applyInFlight: boolean;
};

export type AutoApplyDecision =
  | { kind: "skip"; reason: "no-results" | "no-new-results" | "in-flight" }
  | { kind: "schedule"; delayMs: number };

/**
 * Decide whether the auto-apply effect should schedule a fresh
 * `setTimeout` and, if so, with what delay.
 *
 * Pure function — no I/O, no React state. The effect calls this
 * on every fire, treats `kind: "skip"` as an early-return, and
 * passes `kind: "schedule"`'s `delayMs` to `setTimeout`.
 */
export function decideAutoApply(
  input: AutoApplyDecisionInput
): AutoApplyDecision {
  if (input.successfulResultCount === 0) {
    return { kind: "skip", reason: "no-results" };
  }
  if (input.successfulResultCount <= input.lastAppliedCount) {
    return { kind: "skip", reason: "no-new-results" };
  }
  if (input.applyInFlight) {
    return { kind: "skip", reason: "in-flight" };
  }
  if (input.jobIsComplete) {
    return { kind: "schedule", delayMs: 0 };
  }
  const elapsed = input.nowMs - input.lastAppliedAtMs;
  const delayMs = Math.max(0, input.minIntervalMs - elapsed);
  return { kind: "schedule", delayMs };
}
