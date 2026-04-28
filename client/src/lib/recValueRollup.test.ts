/**
 * Task 9.5 PR-4 (2026-04-28) — tests for the REC value rollup
 * helper that powers the system detail page's "REC value" section.
 * Pure function; no mocks needed.
 */
import { describe, expect, it } from "vitest";
import {
  buildRecValueRollup,
  recValueSourceLabel,
  type RecValueRollupInput,
} from "./recValueRollup";

const EMPTY_INPUT: RecValueRollupInput = {
  registry: null,
  contractScan: null,
  scheduleB: null,
  iccReport: null,
  utilityInvoices: null,
};

describe("buildRecValueRollup", () => {
  it("returns all-null when every source is empty", () => {
    const out = buildRecValueRollup(EMPTY_INPUT);
    expect(out.contractedRecs.value).toBeNull();
    expect(out.contractedRecPrice.value).toBeNull();
    expect(out.contractedTotalValue.value).toBeNull();
    expect(out.paidRecs).toBeNull();
    expect(out.paidTotalValue).toBeNull();
    expect(out.outstandingValue).toBeNull();
    expect(out.pctDelivered).toBeNull();
    expect(out.deliveryYears).toEqual([]);
  });

  it("prefers ICC report over Schedule B over contract scan for contracted RECs", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      contractScan: { recQuantity: 100, recPrice: null },
      scheduleB: {
        maxRecQuantity: 200,
        contractPrice: null,
        deliveryYearsJson: null,
      },
      iccReport: {
        contractedRecs: 300,
        recPrice: null,
        grossContractValue: null,
      },
    });
    expect(out.contractedRecs.value).toBe(300);
    expect(out.contractedRecs.source).toBe("icc-report");
  });

  it("falls through to Schedule B when ICC has no contractedRecs", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      contractScan: { recQuantity: 100, recPrice: null },
      scheduleB: {
        maxRecQuantity: 200,
        contractPrice: null,
        deliveryYearsJson: null,
      },
      iccReport: { contractedRecs: null, recPrice: null, grossContractValue: null },
    });
    expect(out.contractedRecs.value).toBe(200);
    expect(out.contractedRecs.source).toBe("schedule-b");
  });

  it("falls through to contract scan when ICC + Schedule B are empty", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      contractScan: { recQuantity: 100, recPrice: null },
    });
    expect(out.contractedRecs.value).toBe(100);
    expect(out.contractedRecs.source).toBe("contract-scan");
  });

  it("does NOT use registry.annualRecs as a fallback for contractedRecs", () => {
    // annualRecs is annual production, not lifetime contracted.
    // Mixing them would 20× inflate outstanding on a 20-year deal.
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      registry: {
        totalContractAmount: null,
        recPrice: null,
        annualRecs: 50, // would be wrong if used
      },
    });
    expect(out.contractedRecs.value).toBeNull();
    expect(out.contractedRecs.source).toBeNull();
  });

  it("prefers ICC > contract scan > registry > Schedule B for REC price", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      registry: {
        totalContractAmount: null,
        recPrice: 0.04,
        annualRecs: null,
      },
      contractScan: { recQuantity: null, recPrice: 0.045 },
      scheduleB: {
        maxRecQuantity: null,
        contractPrice: 0.05,
        deliveryYearsJson: null,
      },
      iccReport: { contractedRecs: null, recPrice: 0.055, grossContractValue: null },
    });
    expect(out.contractedRecPrice.value).toBe(0.055);
    expect(out.contractedRecPrice.source).toBe("icc-report");
  });

  it("computes total contract value from qty × price when no explicit GCV exists", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      contractScan: { recQuantity: 1000, recPrice: 0.045 },
    });
    expect(out.contractedTotalValue.value).toBe(45);
    expect(out.contractedTotalValue.source).toBe("computed");
  });

  it("prefers explicit GCV over computed", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      contractScan: { recQuantity: 1000, recPrice: 0.045 }, // would compute to 45
      iccReport: {
        contractedRecs: 1000,
        recPrice: 0.045,
        grossContractValue: 50000, // explicit value wins
      },
    });
    expect(out.contractedTotalValue.value).toBe(50000);
    expect(out.contractedTotalValue.source).toBe("icc-report");
  });

  it("falls back to registry.totalContractAmount when ICC has no GCV", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      registry: {
        totalContractAmount: 12345,
        recPrice: null,
        annualRecs: null,
      },
    });
    expect(out.contractedTotalValue.value).toBe(12345);
    expect(out.contractedTotalValue.source).toBe("registry");
  });

  it("computes outstanding value as contractedTotal - paidTotal", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      iccReport: { contractedRecs: null, recPrice: null, grossContractValue: 50000 },
      utilityInvoices: { totalRecs: null, totalInvoiceAmount: 30000 },
    });
    expect(out.outstandingValue).toBe(20000);
  });

  it("returns null outstanding when paid > contracted (data quality flag)", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      iccReport: { contractedRecs: null, recPrice: null, grossContractValue: 1000 },
      utilityInvoices: { totalRecs: null, totalInvoiceAmount: 5000 },
    });
    // Paid 5× contracted is suspicious; surface the components,
    // not a misleading negative outstanding.
    expect(out.outstandingValue).toBeNull();
  });

  it("returns null outstanding when either side is missing", () => {
    const out1 = buildRecValueRollup({
      ...EMPTY_INPUT,
      iccReport: { contractedRecs: null, recPrice: null, grossContractValue: 5000 },
    });
    expect(out1.outstandingValue).toBeNull();
    const out2 = buildRecValueRollup({
      ...EMPTY_INPUT,
      utilityInvoices: { totalRecs: null, totalInvoiceAmount: 100 },
    });
    expect(out2.outstandingValue).toBeNull();
  });

  it("computes pctDelivered as paid/contracted * 100", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      iccReport: { contractedRecs: 1000, recPrice: null, grossContractValue: null },
      utilityInvoices: { totalRecs: 250, totalInvoiceAmount: null },
    });
    expect(out.pctDelivered).toBe(25);
  });

  it("returns null pctDelivered when contractedRecs is 0 (avoid div-by-zero)", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      iccReport: { contractedRecs: 0, recPrice: null, grossContractValue: null },
      utilityInvoices: { totalRecs: 250, totalInvoiceAmount: null },
    });
    expect(out.pctDelivered).toBeNull();
  });

  it("parses deliveryYearsJson into a sorted DeliveryYear[]", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      scheduleB: {
        maxRecQuantity: null,
        contractPrice: null,
        deliveryYearsJson: JSON.stringify([
          { year: 2026, quantity: 100 },
          { year: 2024, quantity: 90 },
          { year: 2025, quantity: 95 },
        ]),
      },
    });
    expect(out.deliveryYears).toEqual([
      { year: 2024, quantity: 90 },
      { year: 2025, quantity: 95 },
      { year: 2026, quantity: 100 },
    ]);
  });

  it("returns empty deliveryYears for malformed JSON", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      scheduleB: {
        maxRecQuantity: null,
        contractPrice: null,
        deliveryYearsJson: "{not json",
      },
    });
    expect(out.deliveryYears).toEqual([]);
  });

  it("filters out malformed deliveryYears entries", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      scheduleB: {
        maxRecQuantity: null,
        contractPrice: null,
        deliveryYearsJson: JSON.stringify([
          { year: 2024, quantity: 50 },
          { year: "garbage" }, // wrong type
          null,
          { year: 2025, quantity: null }, // null qty is OK — gets surfaced
        ]),
      },
    });
    expect(out.deliveryYears).toEqual([
      { year: 2024, quantity: 50 },
      { year: 2025, quantity: null },
    ]);
  });

  it("treats utilityInvoices with all-null fields as no paid data", () => {
    const out = buildRecValueRollup({
      ...EMPTY_INPUT,
      iccReport: { contractedRecs: 100, recPrice: null, grossContractValue: 1000 },
      utilityInvoices: { totalRecs: null, totalInvoiceAmount: null },
    });
    expect(out.paidRecs).toBeNull();
    expect(out.paidTotalValue).toBeNull();
    expect(out.outstandingValue).toBeNull();
    expect(out.pctDelivered).toBeNull();
  });
});

describe("recValueSourceLabel", () => {
  it("maps every source code to a human label", () => {
    expect(recValueSourceLabel("icc-report")).toBe("ICC Report");
    expect(recValueSourceLabel("schedule-b")).toBe("Schedule B");
    expect(recValueSourceLabel("contract-scan")).toBe("Contract scan");
    expect(recValueSourceLabel("registry")).toBe("Solar Apps");
    expect(recValueSourceLabel("computed")).toBe("Computed");
    expect(recValueSourceLabel(null)).toBe("—");
  });
});
