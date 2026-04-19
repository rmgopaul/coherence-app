import { describe, expect, it } from "vitest";
import {
  adherencePct,
  costExtremes,
  costPerDose,
  DAYS_PER_MONTH,
  dosesExpectedInRange,
  monthlyProtocolCost,
  type ProtocolDefinition,
} from "./supplements.math";

function makeDef(overrides: Partial<ProtocolDefinition> = {}): ProtocolDefinition {
  return {
    pricePerBottle: 30,
    quantityPerBottle: 60,
    isLocked: true,
    isActive: true,
    ...overrides,
  };
}

describe("costPerDose", () => {
  it("divides price by quantity", () => {
    expect(costPerDose({ pricePerBottle: 30, quantityPerBottle: 60 })).toBe(0.5);
  });

  it("returns null when price is missing", () => {
    expect(costPerDose({ pricePerBottle: null, quantityPerBottle: 60 })).toBeNull();
    expect(costPerDose({ pricePerBottle: undefined, quantityPerBottle: 60 })).toBeNull();
  });

  it("returns null when quantity is missing", () => {
    expect(costPerDose({ pricePerBottle: 30, quantityPerBottle: null })).toBeNull();
    expect(costPerDose({ pricePerBottle: 30, quantityPerBottle: undefined })).toBeNull();
  });

  it("returns null on non-finite input", () => {
    expect(costPerDose({ pricePerBottle: Number.NaN, quantityPerBottle: 60 })).toBeNull();
    expect(costPerDose({ pricePerBottle: 30, quantityPerBottle: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("returns null on zero or negative quantity", () => {
    expect(costPerDose({ pricePerBottle: 30, quantityPerBottle: 0 })).toBeNull();
    expect(costPerDose({ pricePerBottle: 30, quantityPerBottle: -10 })).toBeNull();
  });

  it("returns null on negative price (catches garbage inputs)", () => {
    expect(costPerDose({ pricePerBottle: -5, quantityPerBottle: 60 })).toBeNull();
  });

  it("allows zero price (free supplement)", () => {
    expect(costPerDose({ pricePerBottle: 0, quantityPerBottle: 60 })).toBe(0);
  });
});

describe("monthlyProtocolCost", () => {
  it("sums cost-per-dose × 30 across locked active definitions", () => {
    const defs = [
      makeDef({ pricePerBottle: 30, quantityPerBottle: 60 }), // 0.5/dose → 15/mo
      makeDef({ pricePerBottle: 20, quantityPerBottle: 40 }), // 0.5/dose → 15/mo
    ];
    expect(monthlyProtocolCost(defs)).toBe(30);
    expect(monthlyProtocolCost(defs)).toBe(0.5 * DAYS_PER_MONTH + 0.5 * DAYS_PER_MONTH);
  });

  it("ignores unlocked definitions", () => {
    const defs = [
      makeDef({ pricePerBottle: 30, quantityPerBottle: 60, isLocked: true }),
      makeDef({ pricePerBottle: 60, quantityPerBottle: 60, isLocked: false }),
    ];
    expect(monthlyProtocolCost(defs)).toBe(15);
  });

  it("ignores inactive definitions", () => {
    const defs = [
      makeDef({ pricePerBottle: 30, quantityPerBottle: 60, isActive: true }),
      makeDef({ pricePerBottle: 60, quantityPerBottle: 60, isActive: false }),
    ];
    expect(monthlyProtocolCost(defs)).toBe(15);
  });

  it("skips definitions with missing cost inputs (does not count as zero)", () => {
    const defs = [
      makeDef({ pricePerBottle: 30, quantityPerBottle: 60 }),
      makeDef({ pricePerBottle: null, quantityPerBottle: 60 }),
    ];
    expect(monthlyProtocolCost(defs)).toBe(15);
  });

  it("returns 0 for empty list", () => {
    expect(monthlyProtocolCost([])).toBe(0);
  });
});

describe("adherencePct", () => {
  it("computes ratio in [0, 1]", () => {
    expect(adherencePct(15, 30)).toBe(0.5);
    expect(adherencePct(30, 30)).toBe(1);
  });

  it("returns 0 when expected is 0", () => {
    expect(adherencePct(10, 0)).toBe(0);
    expect(adherencePct(0, 0)).toBe(0);
  });

  it("caps at 1 when over-logged", () => {
    expect(adherencePct(50, 30)).toBe(1);
  });

  it("returns 0 for negative taken", () => {
    expect(adherencePct(-1, 30)).toBe(0);
  });

  it("returns 0 for non-finite inputs", () => {
    expect(adherencePct(Number.NaN, 30)).toBe(0);
    expect(adherencePct(15, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("dosesExpectedInRange", () => {
  it("multiplies locked count by days", () => {
    expect(dosesExpectedInRange(5, 30)).toBe(150);
  });

  it("returns 0 on non-positive inputs", () => {
    expect(dosesExpectedInRange(0, 30)).toBe(0);
    expect(dosesExpectedInRange(5, 0)).toBe(0);
    expect(dosesExpectedInRange(-1, 30)).toBe(0);
  });
});

describe("costExtremes", () => {
  it("identifies cheapest and most expensive locked definition", () => {
    const cheap = makeDef({ pricePerBottle: 10, quantityPerBottle: 100 }); // 0.10
    const mid = makeDef({ pricePerBottle: 30, quantityPerBottle: 60 }); // 0.50
    const expensive = makeDef({ pricePerBottle: 60, quantityPerBottle: 30 }); // 2.00
    const result = costExtremes([mid, cheap, expensive]);
    expect(result.cheapest?.costPerDose).toBe(0.1);
    expect(result.mostExpensive?.costPerDose).toBe(2);
  });

  it("ignores unlocked or inactive definitions", () => {
    const unlocked = makeDef({ pricePerBottle: 1, quantityPerBottle: 100, isLocked: false });
    const inactive = makeDef({ pricePerBottle: 1000, quantityPerBottle: 1, isActive: false });
    const only = makeDef({ pricePerBottle: 30, quantityPerBottle: 60 });
    const result = costExtremes([unlocked, inactive, only]);
    expect(result.cheapest?.costPerDose).toBe(0.5);
    expect(result.mostExpensive?.costPerDose).toBe(0.5);
  });

  it("returns null/null when no locked def has computable cost", () => {
    const result = costExtremes([makeDef({ pricePerBottle: null, quantityPerBottle: null })]);
    expect(result.cheapest).toBeNull();
    expect(result.mostExpensive).toBeNull();
  });
});
