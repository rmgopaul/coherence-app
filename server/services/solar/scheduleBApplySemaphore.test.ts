import { afterEach, describe, expect, it } from "vitest";
import {
  __getScheduleBSemaphoreSizeForTests,
  __resetScheduleBSemaphoreForTests,
  buildScheduleBApplyKey,
  withScheduleBApplySemaphore,
} from "./scheduleBApplySemaphore";

afterEach(() => {
  __resetScheduleBSemaphoreForTests();
});

describe("buildScheduleBApplyKey", () => {
  it("composes scopeId and jobId with a pipe separator", () => {
    expect(buildScheduleBApplyKey("scope-user-1", "job-abc")).toBe(
      "scope-user-1|job-abc"
    );
  });

  it("treats different scopes as different keys", () => {
    expect(buildScheduleBApplyKey("scope-a", "job-1")).not.toBe(
      buildScheduleBApplyKey("scope-b", "job-1")
    );
  });

  it("treats different jobIds as different keys", () => {
    expect(buildScheduleBApplyKey("scope-1", "job-a")).not.toBe(
      buildScheduleBApplyKey("scope-1", "job-b")
    );
  });
});

describe("withScheduleBApplySemaphore", () => {
  it("runs the apply function once for a single call", async () => {
    let calls = 0;
    const result = await withScheduleBApplySemaphore("k", async () => {
      calls += 1;
      return { ok: true };
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: true });
  });

  it("coalesces concurrent calls for the same key (single in-flight execution)", async () => {
    // The defining behavior: two callers race for the same key.
    // Only the first triggers the apply; the second receives the
    // same Promise and therefore the same result — without a
    // second `applyFn` call.
    let calls = 0;
    let resolveInner!: (value: { ok: boolean; counter: number }) => void;
    const apply = () => {
      calls += 1;
      return new Promise<{ ok: boolean; counter: number }>((res) => {
        resolveInner = res;
      });
    };

    const promiseA = withScheduleBApplySemaphore("same-key", apply);
    const promiseB = withScheduleBApplySemaphore("same-key", apply);

    expect(calls).toBe(1); // second call coalesced before any await
    expect(__getScheduleBSemaphoreSizeForTests()).toBe(1);

    // Both callers receive the exact same Promise.
    expect(promiseA).toBe(promiseB);

    resolveInner({ ok: true, counter: 42 });
    const [a, b] = await Promise.all([promiseA, promiseB]);
    expect(a).toEqual({ ok: true, counter: 42 });
    expect(b).toEqual({ ok: true, counter: 42 });
    // Same object reference (single shared apply, no duplication).
    expect(a).toBe(b);
  });

  it("runs different keys independently", async () => {
    let callsA = 0;
    let callsB = 0;
    const [resultA, resultB] = await Promise.all([
      withScheduleBApplySemaphore("key-a", async () => {
        callsA += 1;
        return "from-a";
      }),
      withScheduleBApplySemaphore("key-b", async () => {
        callsB += 1;
        return "from-b";
      }),
    ]);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
    expect(resultA).toBe("from-a");
    expect(resultB).toBe("from-b");
  });

  it("releases the registry slot after a successful apply", async () => {
    await withScheduleBApplySemaphore("k", async () => "ok");
    expect(__getScheduleBSemaphoreSizeForTests()).toBe(0);
  });

  it("releases the registry slot after a failed apply (rejection propagates)", async () => {
    await expect(
      withScheduleBApplySemaphore("k", async () => {
        throw new Error("apply blew up");
      })
    ).rejects.toThrow("apply blew up");
    expect(__getScheduleBSemaphoreSizeForTests()).toBe(0);
  });

  it("propagates rejection to all coalesced callers", async () => {
    let resolveInner!: () => void;
    const apply = async () => {
      await new Promise<void>((res) => {
        resolveInner = res;
      });
      throw new Error("apply failed mid-await");
    };

    const promiseA = withScheduleBApplySemaphore("k", apply);
    const promiseB = withScheduleBApplySemaphore("k", apply);

    resolveInner();
    await expect(promiseA).rejects.toThrow("apply failed mid-await");
    await expect(promiseB).rejects.toThrow("apply failed mid-await");
    // Slot released even after failure.
    expect(__getScheduleBSemaphoreSizeForTests()).toBe(0);
  });

  it("a fresh apply for the same key is admitted AFTER the prior one settles", async () => {
    let firstCalls = 0;
    let secondCalls = 0;

    await withScheduleBApplySemaphore("k", async () => {
      firstCalls += 1;
      return "first";
    });
    expect(__getScheduleBSemaphoreSizeForTests()).toBe(0);

    const result = await withScheduleBApplySemaphore("k", async () => {
      secondCalls += 1;
      return "second";
    });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(result).toBe("second");
  });

  // 2026-05-09 follow-up review remediation. The original PR
  // tested fresh-admit after success and rejection-propagation
  // separately; this test combines them — fresh-admit AFTER a
  // FAILED prior settle. Pins the slot-release-on-failure
  // contract end-to-end.
  it("a fresh apply for the same key is admitted AFTER the prior one FAILED", async () => {
    let firstCalls = 0;
    let secondCalls = 0;

    await expect(
      withScheduleBApplySemaphore("k", async () => {
        firstCalls += 1;
        throw new Error("first apply failed");
      })
    ).rejects.toThrow("first apply failed");
    expect(__getScheduleBSemaphoreSizeForTests()).toBe(0);

    const result = await withScheduleBApplySemaphore("k", async () => {
      secondCalls += 1;
      return "second-after-failure";
    });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(result).toBe("second-after-failure");
  });

  it("a third caller that arrives WHILE the second is still in flight coalesces with it (not the first)", async () => {
    let resolveFirst!: (value: string) => void;
    const firstApply = () =>
      new Promise<string>((res) => {
        resolveFirst = res;
      });

    const promise1 = withScheduleBApplySemaphore("k", firstApply);
    const promise2 = withScheduleBApplySemaphore("k", firstApply);

    resolveFirst("first-result");
    await Promise.all([promise1, promise2]);

    // Now the slot is free. A new apply starts.
    let resolveSecond!: (value: string) => void;
    let secondApplyCalls = 0;
    const secondApply = () => {
      secondApplyCalls += 1;
      return new Promise<string>((res) => {
        resolveSecond = res;
      });
    };

    const promise3 = withScheduleBApplySemaphore("k", secondApply);
    const promise4 = withScheduleBApplySemaphore("k", secondApply);
    expect(secondApplyCalls).toBe(1); // promise4 coalesces with promise3

    resolveSecond("second-result");
    const [r3, r4] = await Promise.all([promise3, promise4]);
    expect(r3).toBe("second-result");
    expect(r4).toBe("second-result");
    expect(r3).toBe(r4); // same reference (single-flight)
  });

  it("preserves the apply's return type via generics (no `unknown` widening)", async () => {
    type ApplyResult = { incoming: number; inserted: number };
    const result = await withScheduleBApplySemaphore<ApplyResult>(
      "typed-key",
      async () => ({ incoming: 11, inserted: 11 })
    );
    // Compile-time check: result.incoming + result.inserted are
    // typed as `number`. If the generic widened to `unknown`, the
    // arithmetic would error.
    expect(result.incoming + result.inserted).toBe(22);
  });
});
