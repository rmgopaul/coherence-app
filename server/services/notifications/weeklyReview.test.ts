/**
 * Phase E (2026-04-28), upgraded 2026-06-01 — tests for the AI Weekly
 * Review pure helpers. The Anthropic-calling generator is exercised by
 * manual smoke; these tests pin the behavior of the multi-source join
 * (`buildWeekRecords`), the rollup (`summarizeWeek`), the prompt
 * builder, and the response parser so the LLM contract stays stable.
 */
import { describe, expect, it } from "vitest";
import {
  buildWeekRecords,
  summarizeWeek,
  buildWeeklyReviewPrompts,
  parseWeeklyReviewResponse,
  previousWeekKey,
  type WeekDayRecord,
} from "./weeklyReview";

function metricRow(overrides: Record<string, unknown> = {}) {
  return {
    dateKey: "2026-04-20",
    whoopRecoveryScore: null,
    whoopDayStrain: null,
    whoopSleepHours: null,
    whoopHrvMs: null,
    whoopRestingHr: null,
    samsungSteps: null,
    samsungSleepHours: null,
    samsungSpo2AvgPercent: null,
    samsungSleepScore: null,
    samsungEnergyScore: null,
    todoistCompletedCount: null,
    ...overrides,
  } as Parameters<typeof buildWeekRecords>[0][number];
}

function snap(overrides: Record<string, unknown> = {}) {
  return {
    dateKey: "2026-04-20",
    supplementsPayload: null,
    habitsPayload: null,
    todoistCompletedCount: null,
    ...overrides,
  } as Parameters<typeof buildWeekRecords>[1][number];
}

function reflection(overrides: Record<string, unknown> = {}) {
  return {
    dateKey: "2026-04-20",
    energyLevel: null,
    wentWell: null,
    didntGo: null,
    tomorrowOneThing: null,
    ...overrides,
  } as Parameters<typeof buildWeekRecords>[2][number];
}

describe("buildWeekRecords", () => {
  it("returns an empty array for empty input", () => {
    expect(buildWeekRecords([], [], [])).toEqual([]);
  });

  it("joins metrics + supplements + habits + reflections by dateKey", () => {
    const records = buildWeekRecords(
      [
        metricRow({
          dateKey: "2026-04-20",
          whoopRecoveryScore: 70,
          whoopHrvMs: 55,
          whoopSleepHours: 7.5,
          todoistCompletedCount: 4,
        }),
      ],
      [
        snap({
          dateKey: "2026-04-20",
          supplementsPayload: JSON.stringify({
            definitions: [],
            logs: [{ name: "Magnesium" }, { name: "L-theanine" }],
          }),
          habitsPayload: JSON.stringify([
            { name: "Meditate", completed: true },
            { name: "Read", completed: false },
          ]),
        }),
      ],
      [
        reflection({
          dateKey: "2026-04-20",
          energyLevel: 8,
          wentWell: "Deep work",
        }),
      ]
    );
    expect(records).toHaveLength(1);
    const d = records[0];
    expect(d.recovery).toBe(70);
    expect(d.hrv).toBe(55);
    expect(d.sleepHours).toBe(7.5);
    expect(d.tasksDone).toBe(4);
    expect(d.supplements).toEqual(["Magnesium", "L-theanine"]);
    expect(d.habitsDone).toEqual(["Meditate"]);
    expect(d.habitsTotal).toBe(2);
    expect(d.reflectionEnergy).toBe(8);
    expect(d.wentWell).toBe("Deep work");
  });

  it("falls back to Samsung sleep hours when WHOOP sleep is missing", () => {
    const [d] = buildWeekRecords(
      [metricRow({ whoopSleepHours: null, samsungSleepHours: 6.8 })],
      [],
      []
    );
    expect(d.sleepHours).toBe(6.8);
  });

  it("drops days that carry no usable signal", () => {
    const records = buildWeekRecords(
      [metricRow({ dateKey: "2026-04-21" })], // all-null metric row
      [],
      []
    );
    expect(records).toEqual([]);
  });

  it("sorts joined days ascending by dateKey", () => {
    const records = buildWeekRecords(
      [
        metricRow({ dateKey: "2026-04-22", whoopRecoveryScore: 60 }),
        metricRow({ dateKey: "2026-04-20", whoopRecoveryScore: 80 }),
      ],
      [],
      []
    );
    expect(records.map(r => r.dateKey)).toEqual(["2026-04-20", "2026-04-22"]);
  });

  it("tolerates malformed payload JSON", () => {
    const [d] = buildWeekRecords(
      [metricRow({ whoopRecoveryScore: 50 })],
      [snap({ supplementsPayload: "{not json", habitsPayload: "nope" })],
      []
    );
    expect(d.supplements).toEqual([]);
    expect(d.habitsTotal).toBe(0);
  });
});

describe("summarizeWeek", () => {
  function rec(overrides: Partial<WeekDayRecord>): WeekDayRecord {
    return {
      dateKey: "2026-04-20",
      recovery: null,
      hrv: null,
      strain: null,
      restingHr: null,
      sleepHours: null,
      samsungSleepScore: null,
      samsungEnergy: null,
      steps: null,
      spo2: null,
      tasksDone: null,
      supplements: [],
      habitsDone: [],
      habitsTotal: 0,
      reflectionEnergy: null,
      wentWell: null,
      didntGo: null,
      tomorrowOneThing: null,
      ...overrides,
    };
  }

  it("averages recovery only over days where it exists", () => {
    const m = summarizeWeek([
      rec({ recovery: 60 }),
      rec({ recovery: 80 }),
      rec({ recovery: null }),
    ]);
    expect(m.whoopRecoveryAvg).toBe(70);
    expect(m.whoopRecoverySamples).toBe(2);
    expect(m.daysWithData).toBe(3);
  });

  it("totals task completions and counts distinct supplements", () => {
    const m = summarizeWeek([
      rec({ tasksDone: 3, supplements: ["Mag", "Zinc"] }),
      rec({ tasksDone: 5, supplements: ["mag"] }),
    ]);
    expect(m.todoistCompletedTotal).toBe(8);
    expect(m.supplementsLogged).toBe(3);
    expect(m.distinctSupplements).toBe(2); // case-insensitive dedupe
  });

  it("computes habit consistency from completions over opportunities", () => {
    const m = summarizeWeek([
      rec({ habitsDone: ["A"], habitsTotal: 2 }),
      rec({ habitsDone: ["A", "B"], habitsTotal: 2 }),
    ]);
    expect(m.habitsCompleted).toBe(3);
    expect(m.habitOpportunities).toBe(4);
    expect(m.habitConsistencyPct).toBe(75);
  });

  it("returns null averages when no samples exist", () => {
    const m = summarizeWeek([rec({})]);
    expect(m.whoopRecoveryAvg).toBeNull();
    expect(m.habitConsistencyPct).toBeNull();
    expect(m.todoistCompletedTotal).toBeNull();
  });
});

describe("buildWeeklyReviewPrompts", () => {
  const range = { startDateKey: "2026-04-20", endDateKey: "2026-04-26" };
  const records = buildWeekRecords(
    [
      metricRow({
        dateKey: "2026-04-20",
        whoopRecoveryScore: 72,
        whoopSleepHours: 7.6,
      }),
      metricRow({
        dateKey: "2026-04-21",
        whoopRecoveryScore: 68,
        whoopSleepHours: 7.2,
      }),
      metricRow({
        dateKey: "2026-04-22",
        whoopRecoveryScore: 75,
        whoopSleepHours: 7.8,
      }),
    ],
    [
      snap({
        dateKey: "2026-04-20",
        supplementsPayload: JSON.stringify({ logs: [{ name: "Mag" }] }),
      }),
    ],
    [reflection({ dateKey: "2026-04-20", wentWell: "Shipped the review" })]
  );
  const metrics = summarizeWeek(records);

  it("includes the schema + analyst instructions in the system prompt", () => {
    const { system } = buildWeeklyReviewPrompts(
      "2026-W17",
      range,
      records,
      metrics,
      null
    );
    expect(system).toContain('"headline"');
    expect(system).toContain('"contentMarkdown"');
    expect(system).toContain("STRICT JSON ONLY");
    expect(system).toContain("CORRELATIONS");
  });

  it("includes the week range, metrics, and per-day rows in the user prompt", () => {
    const { user } = buildWeeklyReviewPrompts(
      "2026-W17",
      range,
      records,
      metrics,
      null
    );
    expect(user).toContain("2026-W17");
    expect(user).toContain("2026-04-20 → 2026-04-26");
    expect(user).toContain("WHOOP recovery avg");
    expect(user).toContain("Per-day records");
    expect(user).toContain("Shipped the review"); // reflection surfaced
  });

  it("renders week-over-week deltas when prior metrics are supplied", () => {
    const priorRecords = buildWeekRecords(
      [metricRow({ dateKey: "2026-04-13", whoopRecoveryScore: 60 })],
      [],
      []
    );
    const prior = summarizeWeek(priorRecords);
    const { user } = buildWeeklyReviewPrompts(
      "2026-W17",
      range,
      records,
      metrics,
      prior
    );
    expect(user).toContain("vs prior 60");
  });
});

describe("parseWeeklyReviewResponse", () => {
  it("extracts headline + contentMarkdown from raw JSON", () => {
    const raw = JSON.stringify({
      headline: "Sleep crept down 30 min. Recovery followed.",
      contentMarkdown: "## Wins\n- Sleep avg **7.0h**",
    });
    const out = parseWeeklyReviewResponse(raw);
    expect(out?.headline).toBe("Sleep crept down 30 min. Recovery followed.");
    expect(out?.contentMarkdown).toContain("## Wins");
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
    const raw = JSON.stringify({ headline: long, contentMarkdown: "ok" });
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
