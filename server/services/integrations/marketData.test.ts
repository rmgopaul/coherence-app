import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateLimitCooldown } from "./marketData";

describe("RateLimitCooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts inactive", () => {
    const cd = new RateLimitCooldown();
    expect(cd.isActive()).toBe(false);
  });

  it("becomes active after trip()", () => {
    const cd = new RateLimitCooldown({ baseMs: 60_000 });
    cd.trip();
    expect(cd.isActive()).toBe(true);
  });

  it("expires after baseMs on first trip", () => {
    const cd = new RateLimitCooldown({ baseMs: 60_000, maxMs: 600_000 });
    cd.trip();
    expect(cd.isActive()).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(cd.isActive()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(cd.isActive()).toBe(false);
  });

  it("applies exponential backoff on consecutive trips", () => {
    const cd = new RateLimitCooldown({ baseMs: 60_000, maxMs: 10 * 60_000 });
    cd.trip(); // 1 min
    vi.advanceTimersByTime(60_001);
    expect(cd.isActive()).toBe(false);

    cd.trip(); // 2 min
    vi.advanceTimersByTime(60_000);
    expect(cd.isActive()).toBe(true);
    vi.advanceTimersByTime(60_001);
    expect(cd.isActive()).toBe(false);

    cd.trip(); // 4 min
    vi.advanceTimersByTime(3 * 60_000);
    expect(cd.isActive()).toBe(true);
    vi.advanceTimersByTime(60_001);
    expect(cd.isActive()).toBe(false);
  });

  it("caps backoff at maxMs regardless of consecutive trips", () => {
    const cd = new RateLimitCooldown({
      baseMs: 1_000,
      maxMs: 10_000,
      maxHits: 100,
    });
    for (let i = 0; i < 20; i += 1) cd.trip();
    // Should be capped at 10_000ms — not 1_000 × 2^19.
    vi.advanceTimersByTime(10_001);
    expect(cd.isActive()).toBe(false);
  });

  it("clear() resets cooldown AND consecutive-hit count", () => {
    const cd = new RateLimitCooldown({ baseMs: 60_000, maxMs: 600_000 });
    cd.trip();
    cd.trip();
    cd.trip();
    cd.clear();
    expect(cd.isActive()).toBe(false);

    // After clear, the NEXT trip starts from baseMs again, not from
    // the escalated backoff. Verifies consecutive-hit counter reset.
    cd.trip();
    vi.advanceTimersByTime(60_001);
    expect(cd.isActive()).toBe(false);
  });

  it("respects maxHits ceiling to cap the exponent", () => {
    const cd = new RateLimitCooldown({
      baseMs: 1_000,
      maxMs: 1_000_000_000, // effectively no cap
      maxHits: 3,
    });
    for (let i = 0; i < 10; i += 1) cd.trip();
    // Exponent caps at maxHits-1=2, so backoff is 1_000 × 2^2 = 4_000.
    vi.advanceTimersByTime(4_001);
    expect(cd.isActive()).toBe(false);
  });

  it("independent instances don't share state", () => {
    const cdA = new RateLimitCooldown();
    const cdB = new RateLimitCooldown();
    cdA.trip();
    expect(cdA.isActive()).toBe(true);
    expect(cdB.isActive()).toBe(false);
  });
});
