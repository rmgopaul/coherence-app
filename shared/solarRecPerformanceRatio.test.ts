import { describe, expect, it } from "vitest";
import {
  allocateContractDrawdown,
  type ContractDrawdownSystemInput,
} from "./solarRecPerformanceRatio";

const sys = (
  surplusShortfall: number,
  price: number | null,
  sortKey: string,
): ContractDrawdownSystemInput => ({ surplusShortfall, price, sortKey });

describe("allocateContractDrawdown", () => {
  it("nets surplus against shortfall within the contract (the 2026-05-15 bug)", () => {
    // System X over-delivers +30; System Y under-delivers -30.
    // The contract is net-whole — the pre-fix naive sum billed
    // 30 * $40 = $1,200; the correct answer is $0.
    const result = allocateContractDrawdown([
      sys(30, 40, "X"),
      sys(-30, 40, "Y"),
    ]);
    expect(result.surplusBeforeAllocation).toBe(30);
    expect(result.totalAllocatedRecs).toBe(30);
    expect(result.drawdownThisReport).toBe(0);
    // Y's deficit was fully covered → no payment. `-0 * 40` runs
    // through `Number((-0).toFixed(2))` which normalizes to +0.
    expect(result.perSystem[1]).toEqual({
      allocatedRecs: 30,
      drawdownPayment: 0,
    });
  });

  it("bills only the uncovered remainder, at the deficit system's own price", () => {
    // Surplus 10 covers part of a 30 deficit → 20 uncovered * $40.
    const result = allocateContractDrawdown([
      sys(10, 25, "A"),
      sys(-30, 40, "B"),
    ]);
    expect(result.surplusBeforeAllocation).toBe(10);
    expect(result.totalAllocatedRecs).toBe(10);
    // 20 uncovered * 40 = 800.
    expect(result.drawdownThisReport).toBe(800);
    expect(result.perSystem[1]).toEqual({
      allocatedRecs: 10,
      drawdownPayment: -800,
    });
  });

  it("allocates the shared pool cheapest-price-first across deficits", () => {
    // Pool = 20 (one +20 surplus). Two deficits of -20 each:
    // cheap @ $10, pricey @ $50. Cheapest-first means the $10
    // deficit is fully covered; the $50 deficit is left fully
    // uncovered → 20 * 50 = 1000 (NOT split, NOT covering the
    // expensive one first which would yield 20 * 10 = 200).
    const result = allocateContractDrawdown([
      sys(20, 0, "pool"),
      sys(-20, 50, "pricey"),
      sys(-20, 10, "cheap"),
    ]);
    expect(result.surplusBeforeAllocation).toBe(20);
    expect(result.totalAllocatedRecs).toBe(20);
    expect(result.drawdownThisReport).toBe(1000);
    // cheap (index 2) fully covered, pricey (index 1) fully billed.
    expect(result.perSystem[2]).toEqual({
      allocatedRecs: 20,
      drawdownPayment: 0,
    });
    expect(result.perSystem[1]).toEqual({
      allocatedRecs: 0,
      drawdownPayment: -1000,
    });
  });

  it("treats a null price as last in the sort and as $0 for the payment", () => {
    // Pool = 10. Deficits: priced -15 @ $30, unpriced -15 @ null.
    // null sorts last (Infinity) so the priced deficit gets the
    // pool first. Priced: 15-10 = 5 uncovered * 30 = 150. Unpriced:
    // 15 uncovered but price null → 0 billable.
    const result = allocateContractDrawdown([
      sys(10, 0, "pool"),
      sys(-15, null, "unpriced"),
      sys(-15, 30, "priced"),
    ]);
    expect(result.totalAllocatedRecs).toBe(10);
    expect(result.drawdownThisReport).toBe(150);
    expect(result.perSystem[2]).toEqual({
      allocatedRecs: 10,
      drawdownPayment: -150,
    });
    // Unpriced deficit: no pool left, price null → -0 normalized
    // to +0 by `Number((-0).toFixed(2))`.
    expect(result.perSystem[1]).toEqual({
      allocatedRecs: 0,
      drawdownPayment: 0,
    });
  });

  it("adds the carried-in previousSurplus to the pool (detail-view parity)", () => {
    // No in-contract surplus, but previousSurplus 25 covers part of
    // a -40 deficit → 15 uncovered * $20 = 300.
    const result = allocateContractDrawdown([sys(-40, 20, "only")], 25);
    expect(result.surplusBeforeAllocation).toBe(0);
    expect(result.totalAllocatedRecs).toBe(25);
    expect(result.drawdownThisReport).toBe(300);
  });

  it("returns an all-surplus contract with zero drawdown", () => {
    const result = allocateContractDrawdown([
      sys(10, 40, "A"),
      sys(5, 40, "B"),
    ]);
    expect(result.surplusBeforeAllocation).toBe(15);
    expect(result.totalAllocatedRecs).toBe(0);
    expect(result.drawdownThisReport).toBe(0);
    expect(result.perSystem).toEqual([
      { allocatedRecs: 0, drawdownPayment: 0 },
      { allocatedRecs: 0, drawdownPayment: 0 },
    ]);
  });

  it("preserves input order in perSystem regardless of the internal cheapest-first sort", () => {
    // Deficits supplied pricey-first; result array must still align
    // index-for-index to the INPUT order.
    const result = allocateContractDrawdown([
      sys(-10, 99, "z-pricey"),
      sys(-10, 1, "a-cheap"),
      sys(5, 0, "pool"),
    ]);
    // pool = 5. cheap (index 1) gets it: 10-5 = 5 uncovered * 1 = 5.
    // pricey (index 0) gets nothing: 10 * 99 = 990.
    expect(result.perSystem[0]).toEqual({
      allocatedRecs: 0,
      drawdownPayment: -990,
    });
    expect(result.perSystem[1]).toEqual({
      allocatedRecs: 5,
      drawdownPayment: -5,
    });
    expect(result.perSystem[2]).toEqual({
      allocatedRecs: 0,
      drawdownPayment: 0,
    });
    expect(result.drawdownThisReport).toBe(995);
  });

  it("breaks equal-price ties by natural-numeric sortKey for determinism", () => {
    // Pool 10, two -10 deficits at the same $5 price. sortKey "2"
    // must allocate before "10" (natural-numeric, not lexical).
    const result = allocateContractDrawdown([
      sys(10, 0, "pool"),
      sys(-10, 5, "10"),
      sys(-10, 5, "2"),
    ]);
    // "2" (index 2) covered first → fully covered. "10" (index 1)
    // left uncovered → 10 * 5 = 50.
    expect(result.perSystem[2]).toEqual({
      allocatedRecs: 10,
      drawdownPayment: 0,
    });
    expect(result.perSystem[1]).toEqual({
      allocatedRecs: 0,
      drawdownPayment: -50,
    });
    expect(result.drawdownThisReport).toBe(50);
  });

  it("rounds each payment to 2 decimals (detail-view byte-parity)", () => {
    // 7 uncovered * 3.333 = 23.331 → rounds to 23.33.
    const result = allocateContractDrawdown([sys(-7, 3.333, "x")]);
    expect(result.perSystem[0]?.drawdownPayment).toBe(-23.33);
    expect(result.drawdownThisReport).toBe(23.33);
  });

  it("handles an empty contract", () => {
    const result = allocateContractDrawdown([]);
    expect(result).toEqual({
      surplusBeforeAllocation: 0,
      totalAllocatedRecs: 0,
      drawdownThisReport: 0,
      perSystem: [],
    });
  });
});
