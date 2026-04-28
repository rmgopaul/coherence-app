import { describe, expect, it, vi } from "vitest";
import { runJobWithAtomicCounters } from "./jobRunner";

const JOB_ID = "test-job";

function alwaysOk(_item: string) {
  return Promise.resolve({ outcome: "success" as const });
}

describe("runJobWithAtomicCounters", () => {
  it("returns zero counts on empty input + skips concurrency setup", async () => {
    const incrementCounter = vi.fn();
    const isCancelled = vi.fn().mockResolvedValue(false);

    const result = await runJobWithAtomicCounters({
      jobId: JOB_ID,
      pendingItems: [],
      concurrency: 3,
      isCancelled,
      processItem: alwaysOk,
      incrementCounter,
    });

    expect(result).toEqual({
      cancelled: false,
      processed: 0,
      successes: 0,
      failures: 0,
    });
    expect(incrementCounter).not.toHaveBeenCalled();
    expect(isCancelled).not.toHaveBeenCalled();
  });

  it("processes every item with success outcome and increments successCount per item", async () => {
    const incrementCounter = vi.fn().mockResolvedValue(undefined);
    const isCancelled = vi.fn().mockResolvedValue(false);
    const processItem = vi
      .fn()
      .mockResolvedValue({ outcome: "success" as const });

    const result = await runJobWithAtomicCounters({
      jobId: JOB_ID,
      pendingItems: ["a", "b", "c"],
      concurrency: 2,
      isCancelled,
      processItem,
      incrementCounter,
    });

    expect(result).toEqual({
      cancelled: false,
      processed: 3,
      successes: 3,
      failures: 0,
    });
    expect(processItem).toHaveBeenCalledTimes(3);
    expect(incrementCounter).toHaveBeenCalledTimes(3);
    expect(incrementCounter).toHaveBeenCalledWith("successCount");
  });

  it("counts processItem-thrown errors as failures + invokes logError", async () => {
    const incrementCounter = vi.fn().mockResolvedValue(undefined);
    const isCancelled = vi.fn().mockResolvedValue(false);
    const logError = vi.fn();
    const processItem = vi.fn(async (item: string) => {
      if (item === "bad") throw new Error("boom");
      return { outcome: "success" as const };
    });

    const result = await runJobWithAtomicCounters({
      jobId: JOB_ID,
      pendingItems: ["good", "bad", "good"],
      concurrency: 1,
      isCancelled,
      processItem,
      incrementCounter,
      logError,
    });

    expect(result).toEqual({
      cancelled: false,
      processed: 3,
      successes: 2,
      failures: 1,
    });
    expect(incrementCounter).toHaveBeenCalledWith("successCount");
    expect(incrementCounter).toHaveBeenCalledWith("failureCount");
    expect(logError).toHaveBeenCalledOnce();
    const logCall = logError.mock.calls[0][0];
    expect(logCall.jobId).toBe(JOB_ID);
    expect(logCall.item).toBe("bad");
    expect(logCall.phase).toBe("process");
  });

  it("respects per-item processItem outcome (failure without throwing)", async () => {
    // ContractScan-style: PDF parse fails, helper writes a result row
    // and returns outcome="failure" without throwing.
    const incrementCounter = vi.fn().mockResolvedValue(undefined);
    const processItem = vi.fn(async (item: string) => ({
      outcome: item === "fail-soft" ? ("failure" as const) : ("success" as const),
    }));

    const result = await runJobWithAtomicCounters({
      jobId: JOB_ID,
      pendingItems: ["ok", "fail-soft", "ok"],
      concurrency: 2,
      isCancelled: () => Promise.resolve(false),
      processItem,
      incrementCounter,
    });

    expect(result).toMatchObject({ successes: 2, failures: 1 });
    const successCalls = incrementCounter.mock.calls.filter(
      (c) => c[0] === "successCount"
    );
    const failureCalls = incrementCounter.mock.calls.filter(
      (c) => c[0] === "failureCount"
    );
    expect(successCalls.length).toBe(2);
    expect(failureCalls.length).toBe(1);
  });

  it("short-circuits remaining items when isCancelled flips to true", async () => {
    let calls = 0;
    const isCancelled = vi.fn(async () => {
      calls += 1;
      return calls > 2; // false on calls 1+2, true thereafter
    });
    const incrementCounter = vi.fn().mockResolvedValue(undefined);
    const processItem = vi
      .fn()
      .mockResolvedValue({ outcome: "success" as const });

    const result = await runJobWithAtomicCounters({
      jobId: JOB_ID,
      pendingItems: ["a", "b", "c", "d", "e"],
      concurrency: 1, // serial so the cancellation order is deterministic
      isCancelled,
      processItem,
      incrementCounter,
    });

    expect(result.cancelled).toBe(true);
    // First 2 items run, remaining 3 are skipped.
    expect(result.processed).toBe(2);
    expect(processItem).toHaveBeenCalledTimes(2);
  });

  it("counter-write failure is logged but accounting still tracks the outcome", async () => {
    const incrementCounter = vi
      .fn()
      .mockRejectedValue(new Error("DB hiccup"));
    const logError = vi.fn();
    const processItem = vi
      .fn()
      .mockResolvedValue({ outcome: "success" as const });

    const result = await runJobWithAtomicCounters({
      jobId: JOB_ID,
      pendingItems: ["x", "y"],
      concurrency: 1,
      isCancelled: () => Promise.resolve(false),
      processItem,
      incrementCounter,
      logError,
    });

    // Counter-write throws on every call, but the helper continues
    // and the local counts still reflect what processItem reported.
    expect(result).toMatchObject({
      processed: 2,
      successes: 2,
      failures: 0,
    });
    // logError fires once per failed counter write.
    const counterCalls = logError.mock.calls.filter(
      (c) => c[0].phase === "counter"
    );
    expect(counterCalls.length).toBe(2);
  });

  it("processItem can short-circuit mid-work via helpers.isCancelled", async () => {
    let externalCancelled = false;
    const incrementCounter = vi.fn().mockResolvedValue(undefined);
    const processItem = vi.fn(
      async (item: string, { isCancelled }) => {
        // Item "trigger" sets the external cancel flag; subsequent
        // items observe it via helpers.isCancelled — except the
        // helper polls before processItem is called, so this just
        // mirrors what mid-work code can do.
        if (item === "trigger") {
          externalCancelled = true;
          return { outcome: "success" as const };
        }
        // Mid-work cancellation poll. Caller's `isCancelled` is the
        // same function the outer helper polls.
        if (await isCancelled()) {
          return { outcome: "failure" as const };
        }
        return { outcome: "success" as const };
      }
    );

    const result = await runJobWithAtomicCounters({
      jobId: JOB_ID,
      pendingItems: ["trigger", "after-1"],
      concurrency: 1,
      isCancelled: () => Promise.resolve(externalCancelled),
      processItem,
      incrementCounter,
    });

    // First item triggers cancellation → succeeds and increments.
    // Second item is skipped before processItem is called (helper's
    // own cancellation check fires before per-item invocation).
    expect(result.cancelled).toBe(true);
    expect(result.processed).toBe(1);
    expect(processItem).toHaveBeenCalledTimes(1);
  });

  it("uses the configured concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const processItem = vi.fn(async () => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Tiny delay to overlap.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { outcome: "success" as const };
    });

    await runJobWithAtomicCounters({
      jobId: JOB_ID,
      pendingItems: Array.from({ length: 8 }, (_, i) => String(i)),
      concurrency: 3,
      isCancelled: () => Promise.resolve(false),
      processItem,
      incrementCounter: vi.fn().mockResolvedValue(undefined),
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });
});
