import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeMidnight } from "./useTodayKey";

describe("subscribeMidnight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires at the next local midnight, not before", () => {
    vi.setSystemTime(new Date(2026, 3, 23, 23, 59, 50));
    let count = 0;
    const unsubscribe = subscribeMidnight(() => {
      count += 1;
    });

    vi.advanceTimersByTime(9_999);
    expect(count).toBe(0);

    vi.advanceTimersByTime(1);
    expect(count).toBe(1);

    unsubscribe();
  });

  it("re-arms for subsequent midnights", () => {
    vi.setSystemTime(new Date(2026, 3, 23, 23, 59, 50));
    let count = 0;
    const unsubscribe = subscribeMidnight(() => {
      count += 1;
    });

    vi.advanceTimersByTime(10_000);
    expect(count).toBe(1);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(count).toBe(2);

    unsubscribe();
  });

  it("clears the pending timer when unsubscribed", () => {
    vi.setSystemTime(new Date(2026, 3, 23, 23, 59, 50));
    let count = 0;
    const unsubscribe = subscribeMidnight(() => {
      count += 1;
    });

    unsubscribe();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(count).toBe(0);
  });
});
