import { describe, it, expect } from "vitest";
import { resolveHydrationKeys } from "./hydrationKeys";
import type { DatasetKey } from "../state/types";

const VALID_KEYS: readonly DatasetKey[] = [
  "abpReport",
  "solarApplications",
  "transferHistory",
  "deliveryScheduleBase",
];
const VALID_SET = new Set<string>(VALID_KEYS);
const isDatasetKey = (value: string): value is DatasetKey => VALID_SET.has(value);

describe("resolveHydrationKeys", () => {
  it("returns empty set when neither input has keys", () => {
    const result = resolveHydrationKeys({
      manifestKeys: [],
      priorityKeys: [],
      isDatasetKey,
    });
    expect(result.size).toBe(0);
  });

  it("includes every manifest entry that validates as a DatasetKey", () => {
    const result = resolveHydrationKeys({
      manifestKeys: ["abpReport", "solarApplications"],
      priorityKeys: [],
      isDatasetKey,
    });
    expect(result).toEqual(new Set(["abpReport", "solarApplications"]));
  });

  it("skips non-DatasetKey strings in the manifest", () => {
    const result = resolveHydrationKeys({
      manifestKeys: ["abpReport", "bogusKey", "another_nope"],
      priorityKeys: [],
      isDatasetKey,
    });
    expect(result).toEqual(new Set(["abpReport"]));
  });

  it("adds priority keys even if not in manifest", () => {
    const result = resolveHydrationKeys({
      manifestKeys: ["abpReport"],
      priorityKeys: ["transferHistory"],
      isDatasetKey,
    });
    expect(result).toEqual(new Set(["abpReport", "transferHistory"]));
  });

  it("dedupes overlapping manifest + priority keys", () => {
    const result = resolveHydrationKeys({
      manifestKeys: ["abpReport", "solarApplications"],
      priorityKeys: ["abpReport"],
      isDatasetKey,
    });
    expect(result).toEqual(new Set(["abpReport", "solarApplications"]));
  });

  it("returns priority-only set when manifest is empty", () => {
    const result = resolveHydrationKeys({
      manifestKeys: [],
      priorityKeys: ["abpReport", "solarApplications"],
      isDatasetKey,
    });
    expect(result).toEqual(new Set(["abpReport", "solarApplications"]));
  });
});
