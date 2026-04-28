/**
 * Phase E (2026-04-28) — tests for the supplements "Log all AM/PM"
 * eligibility filter. Pure function, no mocks needed.
 */
import { describe, expect, it } from "vitest";
import { selectUnloggedDefinitionsForTiming } from "./supplements";

interface TestDef {
  id: string;
  isActive: boolean;
  timing: string;
  name: string;
}

interface TestLog {
  timing: string;
  definitionId: string | null;
}

function def(overrides: Partial<TestDef> = {}): TestDef {
  return {
    id: overrides.id ?? "d1",
    isActive: overrides.isActive ?? true,
    timing: overrides.timing ?? "am",
    name: overrides.name ?? "Vitamin D",
  };
}

function log(overrides: Partial<TestLog> = {}): TestLog {
  return {
    timing: overrides.timing ?? "am",
    definitionId: overrides.definitionId ?? null,
  };
}

describe("selectUnloggedDefinitionsForTiming", () => {
  it("returns every active matching-timing definition when no logs exist", () => {
    const defs = [
      def({ id: "d1", timing: "am" }),
      def({ id: "d2", timing: "am" }),
      def({ id: "d3", timing: "pm" }),
    ];
    const result = selectUnloggedDefinitionsForTiming(defs, [], "am");
    expect(result.map((d) => d.id)).toEqual(["d1", "d2"]);
  });

  it("excludes definitions that already have a log for the timing today", () => {
    const defs = [
      def({ id: "d1", timing: "am" }),
      def({ id: "d2", timing: "am" }),
      def({ id: "d3", timing: "am" }),
    ];
    const logs = [
      log({ timing: "am", definitionId: "d2" }),
    ];
    const result = selectUnloggedDefinitionsForTiming(defs, logs, "am");
    expect(result.map((d) => d.id)).toEqual(["d1", "d3"]);
  });

  it("skips inactive definitions", () => {
    const defs = [
      def({ id: "d1", timing: "am", isActive: false }),
      def({ id: "d2", timing: "am", isActive: true }),
    ];
    const result = selectUnloggedDefinitionsForTiming(defs, [], "am");
    expect(result.map((d) => d.id)).toEqual(["d2"]);
  });

  it("skips definitions with the wrong timing", () => {
    const defs = [
      def({ id: "d1", timing: "am" }),
      def({ id: "d2", timing: "pm" }),
    ];
    const amResult = selectUnloggedDefinitionsForTiming(defs, [], "am");
    const pmResult = selectUnloggedDefinitionsForTiming(defs, [], "pm");
    expect(amResult.map((d) => d.id)).toEqual(["d1"]);
    expect(pmResult.map((d) => d.id)).toEqual(["d2"]);
  });

  it("ignores logs for a different timing (am log doesn't block pm log)", () => {
    const defs = [def({ id: "d1", timing: "pm" })];
    const logs = [log({ timing: "am", definitionId: "d1" })];
    const result = selectUnloggedDefinitionsForTiming(defs, logs, "pm");
    expect(result.map((d) => d.id)).toEqual(["d1"]);
  });

  it("ignores logs with null definitionId (manual one-off logs)", () => {
    const defs = [def({ id: "d1", timing: "am" })];
    const logs = [log({ timing: "am", definitionId: null })];
    const result = selectUnloggedDefinitionsForTiming(defs, logs, "am");
    expect(result.map((d) => d.id)).toEqual(["d1"]);
  });

  it("returns empty when every definition is already logged", () => {
    const defs = [
      def({ id: "d1", timing: "am" }),
      def({ id: "d2", timing: "am" }),
    ];
    const logs = [
      log({ timing: "am", definitionId: "d1" }),
      log({ timing: "am", definitionId: "d2" }),
    ];
    const result = selectUnloggedDefinitionsForTiming(defs, logs, "am");
    expect(result).toEqual([]);
  });

  it("returns empty when no definitions exist", () => {
    expect(selectUnloggedDefinitionsForTiming([], [], "am")).toEqual([]);
  });

  it("preserves the original definition order", () => {
    const defs = [
      def({ id: "z", timing: "am" }),
      def({ id: "a", timing: "am" }),
      def({ id: "m", timing: "am" }),
    ];
    const result = selectUnloggedDefinitionsForTiming(defs, [], "am");
    // Order matches the input — sorting is the caller's job.
    expect(result.map((d) => d.id)).toEqual(["z", "a", "m"]);
  });
});
