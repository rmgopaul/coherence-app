/**
 * Pure-helper tests for the cross-domain insights generator. Mirrors
 * the structure of `weeklyReview.test.ts` — the network-bound public
 * function `generateInsightsForUser` is not tested here (would require
 * Anthropic + DB mocks); the testable surface is the JSON parsing,
 * day aggregation, and prompt-shape stability.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateDays,
  buildInsightsPrompt,
  parseInsightsResponse,
} from "./insights";

function snap(overrides: {
  dateKey: string;
  whoop?: object | null;
  samsung?: object | null;
  supplements?: object | null;
  habits?: object | null;
  todoistCompletedCount?: number | null;
}) {
  return {
    dateKey: overrides.dateKey,
    whoopPayload:
      overrides.whoop === undefined ? null : JSON.stringify(overrides.whoop),
    samsungPayload:
      overrides.samsung === undefined
        ? null
        : JSON.stringify(overrides.samsung),
    supplementsPayload:
      overrides.supplements === undefined
        ? null
        : JSON.stringify(overrides.supplements),
    habitsPayload:
      overrides.habits === undefined ? null : JSON.stringify(overrides.habits),
    todoistCompletedCount: overrides.todoistCompletedCount ?? null,
  };
}

describe("aggregateDays", () => {
  it("drops empty days and surfaces signals from each domain", () => {
    const result = aggregateDays(
      [
        snap({ dateKey: "2026-04-01" }), // empty — should drop
        snap({
          dateKey: "2026-04-02",
          whoop: { recoveryScore: 67, hrvRmssdMilli: 56, sleepHours: 7.5 },
          supplements: { names: ["L-theanine", "Multi"] },
          todoistCompletedCount: 8,
        }),
        snap({
          dateKey: "2026-04-03",
          samsung: { energyScore: 73, sleepScore: 82, sleepDurationMs: 28_800_000 },
          habits: { names: ["meditation"] },
        }),
      ],
      [
        { dateKey: "2026-04-02", energyLevel: 7, wentWell: "shipped X", didntGo: null, tomorrowOneThing: null },
      ]
    );
    expect(result).toHaveLength(2);
    const [a, b] = result;
    expect(a.dateKey).toBe("2026-04-02");
    expect(a.supplements).toEqual(["L-theanine", "Multi"]);
    expect(a.whoopRecovery).toBe(67);
    expect(a.todoistCompleted).toBe(8);
    expect(a.reflectionEnergy).toBe(7);
    expect(b.samsungSleepHours).toBe(8);
    expect(b.habits).toEqual(["meditation"]);
    expect(b.reflectionEnergy).toBeNull();
  });

  it("treats malformed payloads as no signal rather than failing", () => {
    const result = aggregateDays(
      [
        {
          dateKey: "2026-04-02",
          whoopPayload: "{not json",
          samsungPayload: null,
          supplementsPayload: null,
          habitsPayload: null,
          todoistCompletedCount: 5,
        },
      ],
      []
    );
    expect(result).toHaveLength(1);
    expect(result[0].whoopRecovery).toBeNull();
    expect(result[0].todoistCompleted).toBe(5);
  });
});

describe("buildInsightsPrompt", () => {
  it("produces a prompt with the expected schema directive and per-day rows", () => {
    const { system, user } = buildInsightsPrompt(
      [
        {
          dateKey: "2026-04-02",
          supplements: ["Multi"],
          habits: [],
          whoopRecovery: 67,
          whoopHrv: 55,
          whoopSleepHours: 7.5,
          whoopStrain: 12,
          samsungEnergy: 71,
          samsungSleepScore: 80,
          samsungSleepHours: 7.4,
          reflectionEnergy: 7,
          reflectionWentWell: "shipped X",
          todoistCompleted: 8,
        },
      ],
      "Rhett"
    );
    expect(system).toContain("Rhett");
    expect(system).toContain('"insights"');
    expect(system).toContain('"confidence"');
    expect(user).toContain("2026-04-02");
    expect(user).toContain("Multi");
    expect(user).toContain("Return JSON only.");
  });

  it("falls back to 'the user' when no name is provided", () => {
    const { system } = buildInsightsPrompt([], null);
    expect(system).toContain("the user");
  });
});

describe("parseInsightsResponse", () => {
  it("parses a clean JSON object", () => {
    const text = `{"insights":[{"title":"On L-theanine days, evening energy +1.4","body":"Across 12 logged L-theanine days, reflection energy averaged 7.4 vs 6.0 on non-L-theanine days.","confidence":"high"}]}`;
    const out = parseInsightsResponse(text);
    expect(out).toEqual([
      {
        title: "On L-theanine days, evening energy +1.4",
        body: "Across 12 logged L-theanine days, reflection energy averaged 7.4 vs 6.0 on non-L-theanine days.",
        confidence: "high",
      },
    ]);
  });

  it("strips markdown fences", () => {
    const text =
      "```json\n{\"insights\":[{\"title\":\"x\",\"body\":\"y\",\"confidence\":\"medium\"}]}\n```";
    const out = parseInsightsResponse(text);
    expect(out).toHaveLength(1);
    expect(out?.[0].title).toBe("x");
  });

  it("drops malformed items but keeps valid ones", () => {
    const text = `{"insights":[{"title":"","body":"empty title"},{"title":"keep","body":"good","confidence":"low"},{"title":"keep2","body":"good2"}]}`;
    const out = parseInsightsResponse(text);
    expect(out).toHaveLength(2);
    expect(out?.[0].title).toBe("keep");
    expect(out?.[0].confidence).toBe("low");
    expect(out?.[1].confidence).toBe("medium"); // default
  });

  it("returns null for non-JSON text", () => {
    expect(parseInsightsResponse("sorry I cannot")).toBeNull();
  });

  it("returns null when 'insights' is not an array", () => {
    expect(parseInsightsResponse(`{"insights":"oops"}`)).toBeNull();
  });

  it("caps at 5 items", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`,
      body: `b${i}`,
      confidence: "medium",
    }));
    const text = JSON.stringify({ insights: items });
    const out = parseInsightsResponse(text);
    expect(out).toHaveLength(5);
  });
});
