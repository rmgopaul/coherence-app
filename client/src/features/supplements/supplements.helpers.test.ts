import { describe, expect, it } from "vitest";
import type {
  SupplementDefinition,
  SupplementLog,
} from "@/features/dashboard/types";
import {
  buildDashboardSummary,
  buildProtocolRows,
  countLockedActive,
  countTakenLockedToday,
  formatAdherenceChip,
  formatAdherencePct,
  formatCostPerDose,
  formatCostPerDoseBare,
  formatMonthlyCostForDef,
  type AdherenceRow,
} from "./supplements.helpers";

function makeDef(overrides: Partial<SupplementDefinition> = {}): SupplementDefinition {
  return {
    id: "def-1",
    userId: 1,
    name: "Magnesium Glycinate",
    brand: null,
    dose: "400",
    doseUnit: "mg",
    dosePerUnit: null,
    productUrl: null,
    pricePerBottle: 30,
    quantityPerBottle: 60,
    timing: "am",
    isLocked: true,
    isActive: true,
    sortOrder: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as unknown as SupplementDefinition;
}

function makeLog(overrides: Partial<SupplementLog> = {}): SupplementLog {
  return {
    id: "log-1",
    userId: 1,
    definitionId: "def-1",
    name: "Magnesium Glycinate",
    dose: "400",
    doseUnit: "mg",
    timing: "am",
    autoLogged: false,
    notes: null,
    dateKey: "2026-04-19",
    takenAt: new Date("2026-04-19T13:00:00Z"),
    createdAt: new Date("2026-04-19T13:00:00Z"),
    updatedAt: new Date("2026-04-19T13:00:00Z"),
    ...overrides,
  } as unknown as SupplementLog;
}

describe("format helpers", () => {
  it("formatCostPerDose renders dollars + /dose suffix", () => {
    expect(formatCostPerDose({ pricePerBottle: 30, quantityPerBottle: 60 })).toBe("$0.50/dose");
  });

  it("formatCostPerDose renders em dash on missing inputs", () => {
    expect(formatCostPerDose({ pricePerBottle: null, quantityPerBottle: 60 })).toBe("—");
    expect(formatCostPerDose({ pricePerBottle: 30, quantityPerBottle: null })).toBe("—");
  });

  it("formatCostPerDoseBare omits the /dose suffix for tabular use", () => {
    expect(formatCostPerDoseBare({ pricePerBottle: 30, quantityPerBottle: 60 })).toBe("$0.50");
  });

  it("formatMonthlyCostForDef multiplies by 30 days", () => {
    expect(formatMonthlyCostForDef({ pricePerBottle: 30, quantityPerBottle: 60 })).toBe("$15.00");
  });

  it("formatAdherencePct rounds to whole percent", () => {
    expect(formatAdherencePct(13, 30)).toBe("43%");
    expect(formatAdherencePct(30, 30)).toBe("100%");
  });

  it("formatAdherencePct returns em dash when no expected doses", () => {
    expect(formatAdherencePct(0, 0)).toBe("—");
    expect(formatAdherencePct(5, 0)).toBe("—");
  });

  it("formatAdherenceChip prefixes with window label", () => {
    expect(formatAdherenceChip(7, 6, 7)).toBe("7d 86%");
    expect(formatAdherenceChip(30, 0, 0)).toBe("30d —");
  });
});

describe("countTakenLockedToday", () => {
  const today = "2026-04-19";

  it("counts logs matching today's dateKey for locked defs", () => {
    const a = makeDef({ id: "a" });
    const b = makeDef({ id: "b" });
    const defs = [a, b];
    const logs = [
      makeLog({ id: "l1", definitionId: "a", dateKey: today }),
      makeLog({ id: "l2", definitionId: "b", dateKey: today }),
    ];
    expect(countTakenLockedToday(defs, logs, today)).toBe(2);
  });

  it("does not double-count multiple logs for the same def on the same day", () => {
    const a = makeDef({ id: "a" });
    const logs = [
      makeLog({ id: "l1", definitionId: "a", dateKey: today }),
      makeLog({ id: "l2", definitionId: "a", dateKey: today }),
    ];
    expect(countTakenLockedToday([a], logs, today)).toBe(1);
  });

  it("ignores logs on other days", () => {
    const a = makeDef({ id: "a" });
    const logs = [makeLog({ id: "l1", definitionId: "a", dateKey: "2026-04-18" })];
    expect(countTakenLockedToday([a], logs, today)).toBe(0);
  });

  it("ignores logs for unlocked defs", () => {
    const a = makeDef({ id: "a", isLocked: false });
    const logs = [makeLog({ id: "l1", definitionId: "a", dateKey: today })];
    expect(countTakenLockedToday([a], logs, today)).toBe(0);
  });

  it("ignores logs without a definitionId (ad-hoc logs)", () => {
    const a = makeDef({ id: "a" });
    const logs = [makeLog({ id: "l1", definitionId: null, dateKey: today })];
    expect(countTakenLockedToday([a], logs, today)).toBe(0);
  });
});

describe("countLockedActive", () => {
  it("counts only locked + active defs", () => {
    const defs = [
      makeDef({ id: "1", isLocked: true, isActive: true }),
      makeDef({ id: "2", isLocked: false, isActive: true }),
      makeDef({ id: "3", isLocked: true, isActive: false }),
    ];
    expect(countLockedActive(defs)).toBe(1);
  });
});

describe("buildDashboardSummary", () => {
  const today = "2026-04-19";

  it("assembles lockedCount, takenLockedToday, monthlyProtocolCost, and adherence map", () => {
    const defs = [
      makeDef({ id: "a", pricePerBottle: 30, quantityPerBottle: 60, isLocked: true }),
      makeDef({ id: "b", pricePerBottle: 60, quantityPerBottle: 60, isLocked: true }),
      makeDef({ id: "c", isLocked: false }),
    ];
    const logs = [makeLog({ id: "l1", definitionId: "a", dateKey: today })];
    const adherence: AdherenceRow[] = [
      { definitionId: "a", takenDays: 6, expectedDays: 7 },
      { definitionId: "b", takenDays: 7, expectedDays: 7 },
    ];
    const summary = buildDashboardSummary(defs, logs, adherence, today);
    expect(summary.lockedCount).toBe(2);
    expect(summary.takenLockedToday).toBe(1);
    // a: 0.5/dose * 30 = 15 + b: 1.0/dose * 30 = 30 → 45
    expect(summary.monthlyProtocolCost).toBe(45);
    expect(summary.adherenceByDefinitionId).toEqual({
      a: 6 / 7,
      b: 1,
    });
  });
});

describe("buildProtocolRows", () => {
  it("joins adherence and latest log by definitionId", () => {
    const defs = [makeDef({ id: "a", pricePerBottle: 30, quantityPerBottle: 60 })];
    const logs = [
      makeLog({
        id: "older",
        definitionId: "a",
        takenAt: new Date("2026-04-18T12:00:00Z"),
      }),
      makeLog({
        id: "newer",
        definitionId: "a",
        takenAt: new Date("2026-04-19T13:00:00Z"),
      }),
    ];
    const adherence: AdherenceRow[] = [
      { definitionId: "a", takenDays: 20, expectedDays: 30 },
    ];
    const rows = buildProtocolRows(defs, logs, adherence);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.costPerDose).toBe(0.5);
    expect(row.monthlyCost).toBe(15);
    expect(row.adherenceTaken).toBe(20);
    expect(row.adherenceExpected).toBe(30);
    expect(row.adherencePct).toBeCloseTo(20 / 30);
    expect(row.lastLog?.id).toBe("newer");
  });

  it("returns null lastLog when no logs match the def", () => {
    const defs = [makeDef({ id: "a" })];
    const rows = buildProtocolRows(defs, [], []);
    expect(rows[0].lastLog).toBeNull();
    expect(rows[0].adherenceTaken).toBe(0);
    expect(rows[0].adherenceExpected).toBe(0);
  });
});
