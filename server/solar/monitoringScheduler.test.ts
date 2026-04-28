import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  shouldRunMonthlyMonitoring,
  nextScheduledDateKey,
  getMonthlyScheduleTokens,
  getScheduledHour,
} from "./monitoringScheduler";

const ENV_DAYS = "SOLAR_REC_MONITOR_DAYS";
const ENV_HOUR = "SOLAR_REC_MONITOR_HOUR";

describe("monitoringScheduler config helpers", () => {
  let savedDays: string | undefined;
  let savedHour: string | undefined;

  beforeEach(() => {
    savedDays = process.env[ENV_DAYS];
    savedHour = process.env[ENV_HOUR];
  });
  afterEach(() => {
    if (savedDays === undefined) delete process.env[ENV_DAYS];
    else process.env[ENV_DAYS] = savedDays;
    if (savedHour === undefined) delete process.env[ENV_HOUR];
    else process.env[ENV_HOUR] = savedHour;
  });

  it("getScheduledHour defaults to 8", () => {
    delete process.env[ENV_HOUR];
    expect(getScheduledHour()).toBe(8);
  });

  it("getScheduledHour respects valid env override", () => {
    process.env[ENV_HOUR] = "23";
    expect(getScheduledHour()).toBe(23);
  });

  it("getScheduledHour falls back to 8 for invalid env", () => {
    process.env[ENV_HOUR] = "not-a-number";
    expect(getScheduledHour()).toBe(8);
  });

  it("getMonthlyScheduleTokens defaults to 1, 12, 15, last", () => {
    delete process.env[ENV_DAYS];
    expect(getMonthlyScheduleTokens()).toEqual(["1", "12", "15", "last"]);
  });

  it("getMonthlyScheduleTokens parses CSV env override", () => {
    process.env[ENV_DAYS] = "5,20,last";
    expect(getMonthlyScheduleTokens()).toEqual(["5", "20", "last"]);
  });
});

describe("shouldRunMonthlyMonitoring", () => {
  let savedDays: string | undefined;
  beforeEach(() => {
    savedDays = process.env[ENV_DAYS];
  });
  afterEach(() => {
    if (savedDays === undefined) delete process.env[ENV_DAYS];
    else process.env[ENV_DAYS] = savedDays;
  });

  it("returns true on day 1, 12, 15 with default config", () => {
    delete process.env[ENV_DAYS];
    expect(shouldRunMonthlyMonitoring("2026-04-01")).toBe(true);
    expect(shouldRunMonthlyMonitoring("2026-04-12")).toBe(true);
    expect(shouldRunMonthlyMonitoring("2026-04-15")).toBe(true);
  });

  it("returns true on the last day of the month", () => {
    delete process.env[ENV_DAYS];
    expect(shouldRunMonthlyMonitoring("2026-04-30")).toBe(true);
    expect(shouldRunMonthlyMonitoring("2026-02-28")).toBe(true); // 2026 not leap
    expect(shouldRunMonthlyMonitoring("2024-02-29")).toBe(true); // 2024 leap
    expect(shouldRunMonthlyMonitoring("2026-03-31")).toBe(true);
  });

  it("returns false on non-scheduled days", () => {
    delete process.env[ENV_DAYS];
    expect(shouldRunMonthlyMonitoring("2026-04-28")).toBe(false);
    expect(shouldRunMonthlyMonitoring("2026-04-13")).toBe(false);
  });

  it("daily mode returns true every day", () => {
    process.env[ENV_DAYS] = "daily";
    expect(shouldRunMonthlyMonitoring("2026-04-28")).toBe(true);
    expect(shouldRunMonthlyMonitoring("2026-04-13")).toBe(true);
  });
});

describe("nextScheduledDateKey", () => {
  let savedDays: string | undefined;
  beforeEach(() => {
    savedDays = process.env[ENV_DAYS];
  });
  afterEach(() => {
    if (savedDays === undefined) delete process.env[ENV_DAYS];
    else process.env[ENV_DAYS] = savedDays;
  });

  it("from April 28 with default config → April 30 (last)", () => {
    delete process.env[ENV_DAYS];
    expect(nextScheduledDateKey("2026-04-28")).toBe("2026-04-30");
  });

  it("from April 30 with default config → May 1", () => {
    delete process.env[ENV_DAYS];
    expect(nextScheduledDateKey("2026-04-30")).toBe("2026-05-01");
  });

  it("from May 2 with default config → May 12", () => {
    delete process.env[ENV_DAYS];
    expect(nextScheduledDateKey("2026-05-02")).toBe("2026-05-12");
  });

  it("daily mode returns null", () => {
    process.env[ENV_DAYS] = "daily";
    expect(nextScheduledDateKey("2026-04-28")).toBeNull();
  });

  it("custom config", () => {
    process.env[ENV_DAYS] = "5,20";
    expect(nextScheduledDateKey("2026-04-21")).toBe("2026-05-05");
  });
});
