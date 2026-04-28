/**
 * Phase E (2026-04-28) — tests for the AI Weekly Review pure
 * helpers. The Anthropic-calling generator is exercised by manual
 * smoke; these tests pin the behavior of the rollup + prompt +
 * parse helpers so the LLM contract stays stable.
 */
import { describe, expect, it } from "vitest";
import {
  summarizeSnapshots,
  buildWeeklyReviewPrompts,
  parseWeeklyReviewResponse,
  previousWeekKey,
} from "./weeklyReview";

function snap(overrides: Record<string, unknown> = {}) {
  return {
    dateKey: "2026-04-20",
    whoopPayload: null,
    samsungPayload: null,
    supplementsPayload: null,
    habitsPayload: null,
    todoistCompletedCount: null,
    ...overrides,
  } as Parameters<typeof summarizeSnapshots>[0][number];
}

describe("summarizeSnapshots", () => {
  it("returns zeros + nulls for empty input", () => {
    const out = summarizeSnapshots([]);
    expect(out.daysWithData).toBe(0);
    expect(out.todoistCompletedTotal).toBeNull();
    expect(out.whoopRecoveryAvg).toBeNull();
    expect(out.sleepHoursAvg).toBeNull();
    expect(out.supplementsLogged).toBe(0);
    expect(out.habitsCompleted).toBe(0);
  });

  it("aggregates todoist completed counts", () => {
    const out = summarizeSnapshots([
      snap({ todoistCompletedCount: 3 }),
      snap({ todoistCompletedCount: 5 }),
      snap({ todoistCompletedCount: null }),
    ]);
    expect(out.todoistCompletedTotal).toBe(8);
    expect(out.daysWithData).toBe(3);
  });

  it("averages whoop recoveryScore across days where it exists", () => {
    const out = summarizeSnapshots([
      snap({ whoopPayload: JSON.stringify({ recoveryScore: 60 }) }),
      snap({ whoopPayload: JSON.stringify({ recoveryScore: 80 }) }),
      // Missing field — doesn't drag the average down.
      snap({ whoopPayload: JSON.stringify({}) }),
      // Malformed JSON — treated as no data.
      snap({ whoopPayload: "{not json" }),
    ]);
    expect(out.whoopRecoveryAvg).toBe(70);
    expect(out.whoopRecoverySamples).toBe(2);
  });

  it("converts samsung sleepDurationMs to hours", () => {
    const out = summarizeSnapshots([
      snap({
        samsungPayload: JSON.stringify({ sleepDurationMs: 7 * 3_600_000 }),
      }),
      snap({
        samsungPayload: JSON.stringify({ sleepDurationMs: 8 * 3_600_000 }),
      }),
    ]);
    expect(out.sleepHoursAvg).toBe(7.5);
    expect(out.sleepSamples).toBe(2);
  });

  it("ignores zero/negative sleepDurationMs (data-quality guard)", () => {
    const out = summarizeSnapshots([
      snap({ samsungPayload: JSON.stringify({ sleepDurationMs: 0 }) }),
      snap({
        samsungPayload: JSON.stringify({ sleepDurationMs: 7 * 3_600_000 }),
      }),
    ]);
    expect(out.sleepHoursAvg).toBe(7);
    expect(out.sleepSamples).toBe(1);
  });

  it("sums supplements logCount + habits completedCount", () => {
    const out = summarizeSnapshots([
      snap({ supplementsPayload: JSON.stringify({ logCount: 3 }) }),
      snap({ supplementsPayload: JSON.stringify({ logCount: 4 }) }),
      snap({ habitsPayload: JSON.stringify({ completedCount: 2 }) }),
      snap({ habitsPayload: JSON.stringify({ completedCount: 5 }) }),
    ]);
    expect(out.supplementsLogged).toBe(7);
    expect(out.habitsCompleted).toBe(7);
  });
});

describe("buildWeeklyReviewPrompts", () => {
  const range = { startDateKey: "2026-04-20", endDateKey: "2026-04-26" };
  const baseMetrics = {
    daysWithData: 7,
    todoistCompletedTotal: 12,
    whoopRecoveryAvg: 72,
    whoopRecoverySamples: 7,
    sleepHoursAvg: 7.6,
    sleepSamples: 7,
    supplementsLogged: 14,
    habitsCompleted: 21,
  };

  it("includes the schema rules in the system prompt", () => {
    const { system } = buildWeeklyReviewPrompts(
      "2026-W17",
      range,
      baseMetrics
    );
    expect(system).toContain('"headline"');
    expect(system).toContain('"contentMarkdown"');
    expect(system).toContain("STRICT JSON ONLY");
  });

  it("includes the week range + metrics in the user prompt", () => {
    const { user } = buildWeeklyReviewPrompts(
      "2026-W17",
      range,
      baseMetrics
    );
    expect(user).toContain("2026-W17");
    expect(user).toContain("2026-04-20 → 2026-04-26");
    expect(user).toContain("Whoop recovery avg: 72");
    expect(user).toContain("Sleep avg: 7.6h");
    expect(user).toContain("Supplements logged: 14");
  });

  it("omits null metrics from the user prompt (tells LLM not to hallucinate)", () => {
    const { user } = buildWeeklyReviewPrompts("2026-W17", range, {
      daysWithData: 5,
      todoistCompletedTotal: null,
      whoopRecoveryAvg: null,
      whoopRecoverySamples: 0,
      sleepHoursAvg: null,
      sleepSamples: 0,
      supplementsLogged: 0,
      habitsCompleted: 0,
    });
    expect(user).not.toContain("Whoop recovery avg");
    expect(user).not.toContain("Sleep avg");
    expect(user).not.toContain("Supplements logged");
    expect(user).not.toContain("Todoist completed");
    expect(user).toContain("Days with snapshots: 5");
  });
});

describe("parseWeeklyReviewResponse", () => {
  it("extracts headline + contentMarkdown from raw JSON", () => {
    const raw = JSON.stringify({
      headline: "Sleep crept down 30 min. Recovery followed.",
      contentMarkdown: "- Sleep avg: 7.0h (down from 7.5h)\n- Recovery: 62 (down from 71)",
    });
    const out = parseWeeklyReviewResponse(raw);
    expect(out?.headline).toBe(
      "Sleep crept down 30 min. Recovery followed."
    );
    expect(out?.contentMarkdown).toContain("Sleep avg");
  });

  it("strips ```json fences when the model adds them", () => {
    const raw = '```json\n{"headline":"X","contentMarkdown":"Y"}\n```';
    const out = parseWeeklyReviewResponse(raw);
    expect(out?.headline).toBe("X");
    expect(out?.contentMarkdown).toBe("Y");
  });

  it("returns null for missing fields", () => {
    expect(parseWeeklyReviewResponse('{"headline":""}')).toBeNull();
    expect(
      parseWeeklyReviewResponse('{"contentMarkdown":"only this"}')
    ).toBeNull();
  });

  it("returns null for unparseable JSON", () => {
    expect(parseWeeklyReviewResponse("not json at all")).toBeNull();
    expect(parseWeeklyReviewResponse("{not closed")).toBeNull();
  });

  it("clamps headline at 280 chars", () => {
    const long = "a".repeat(400);
    const raw = JSON.stringify({
      headline: long,
      contentMarkdown: "ok",
    });
    const out = parseWeeklyReviewResponse(raw);
    expect(out?.headline.length).toBe(280);
  });
});

describe("previousWeekKey", () => {
  it("returns the ISO week key for 7 days ago", () => {
    // 2026-04-27 is a Monday in W18; previous week is W17.
    const result = previousWeekKey(new Date(Date.UTC(2026, 3, 27, 12)));
    expect(result).toBe("2026-W17");
  });

  it("handles year boundaries", () => {
    // 2026-01-05 is a Monday in W02; previous week is 2026-W01.
    const result = previousWeekKey(new Date(Date.UTC(2026, 0, 5, 12)));
    expect(result).toBe("2026-W01");
  });
});
