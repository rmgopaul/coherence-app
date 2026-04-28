/**
 * Task 9.5 PR-2 (2026-04-28) — invoice status helper tests.
 *
 * Two layers exercised:
 *
 *   1. Pure rawRow parsers (`extractUtilityInvoiceFields`,
 *      `extractIccReportFields`, `paymentNumberSortKey`). No DB
 *      mocking needed — these are JSON-string-in / typed-object-out.
 *
 *   2. The DB-touching `getInvoiceStatusForCsgId` join chain. Mocks
 *      `_core` getDb + withDbRetry per the established pattern;
 *      the `preResolvedRegistry` option lets us bypass the upstream
 *      registry lookup so the focus stays on the invoice logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
}));

vi.mock("./_core", async () => {
  const actual = await vi.importActual<typeof import("./_core")>("./_core");
  return {
    ...actual,
    getDb: mocks.getDb,
    withDbRetry: mocks.withDbRetry,
  };
});

import {
  extractUtilityInvoiceFields,
  extractIccReportFields,
  paymentNumberSortKey,
  getInvoiceStatusForCsgId,
  resolveInvoiceStatusBatchIds,
} from "./systemInvoiceStatus";

type StubRow = Record<string, unknown>;

function makeDbStub(rowsByQueryIndex: StubRow[][]) {
  let idx = 0;
  function makeChain() {
    const my = idx;
    idx += 1;
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      then: (resolve: (rows: StubRow[]) => unknown) =>
        Promise.resolve(rowsByQueryIndex[my] ?? []).then(resolve),
    };
    return chain;
  }
  return { select: () => makeChain() };
}

beforeEach(() => {
  mocks.getDb.mockReset();
  mocks.withDbRetry.mockReset();
  mocks.withDbRetry.mockImplementation(async (_label, fn) => fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe("extractUtilityInvoiceFields", () => {
  it("parses canonical headers from the utility invoice CSV", () => {
    const raw = JSON.stringify({
      "System ID": "SYS-9",
      "Payment Number": "12",
      "Total RECS": "57",
      "REC Price": "0.045",
      "Invoice Amount ($)": "$2,565.00",
    });
    expect(extractUtilityInvoiceFields(raw)).toEqual({
      paymentNumber: "12",
      totalRecs: 57,
      recPrice: 0.045,
      invoiceAmount: 2565,
    });
  });

  it("falls back to the legacy 'Invoice Amount' header without $", () => {
    const raw = JSON.stringify({
      "Payment Number": "1",
      "REC Quantity": "100", // alias for Total RECS
      "Invoice Amount": "1234.56",
    });
    const parsed = extractUtilityInvoiceFields(raw);
    expect(parsed.totalRecs).toBe(100);
    expect(parsed.invoiceAmount).toBe(1234.56);
  });

  it("returns nulls when fields are missing or unparseable", () => {
    expect(extractUtilityInvoiceFields(null)).toEqual({
      paymentNumber: null,
      totalRecs: null,
      recPrice: null,
      invoiceAmount: null,
    });
    const raw = JSON.stringify({
      "Payment Number": "",
      "Total RECS": "garbage",
    });
    expect(extractUtilityInvoiceFields(raw)).toEqual({
      paymentNumber: null,
      totalRecs: null,
      recPrice: null,
      invoiceAmount: null,
    });
  });

  it("handles malformed JSON without throwing", () => {
    expect(extractUtilityInvoiceFields("{not json")).toEqual({
      paymentNumber: null,
      totalRecs: null,
      recPrice: null,
      invoiceAmount: null,
    });
  });
});

describe("extractIccReportFields", () => {
  it("returns the explicit GCV when present", () => {
    const raw = JSON.stringify({
      "Total REC Delivery Contract Value": "$50,000",
      "Total Quantity of RECs Contracted": "1000",
      "REC Price": "0.05",
    });
    expect(extractIccReportFields(raw, "APP-1")).toEqual({
      applicationId: "APP-1",
      grossContractValue: 50000,
      contractedRecs: 1000,
      recPrice: 0.05,
      scheduledEnergizationDate: null,
    });
  });

  it("computes GCV from qty × price when the explicit field is missing", () => {
    const raw = JSON.stringify({
      "Contracted SRECs": "500",
      "REC Price": "0.045",
    });
    const out = extractIccReportFields(raw, "APP-2");
    expect(out.grossContractValue).toBe(22.5); // 500 × 0.045
    expect(out.contractedRecs).toBe(500);
  });

  it("preserves the Report 2 scheduledEnergizationDate", () => {
    const raw = JSON.stringify({
      "Total REC Delivery Contract Value": "$10",
      "Scheduled Energization Date": "2024-08-15",
    });
    expect(extractIccReportFields(raw, "APP-3").scheduledEnergizationDate).toBe(
      "2024-08-15"
    );
  });

  it("returns nulls when no fields are present", () => {
    expect(extractIccReportFields(null, "APP-9")).toEqual({
      applicationId: "APP-9",
      grossContractValue: null,
      contractedRecs: null,
      recPrice: null,
      scheduledEnergizationDate: null,
    });
  });
});

describe("paymentNumberSortKey", () => {
  it("parses numeric strings", () => {
    expect(paymentNumberSortKey("12")).toBe(12);
    expect(paymentNumberSortKey("1.5")).toBe(1.5);
  });

  it("strips non-numeric characters", () => {
    expect(paymentNumberSortKey("Payment #15")).toBe(15);
    expect(paymentNumberSortKey("P-7")).toBe(-7);
  });

  it("returns -Infinity for unparseable values so they sort last", () => {
    expect(paymentNumberSortKey(null)).toBe(Number.NEGATIVE_INFINITY);
    expect(paymentNumberSortKey("")).toBe(Number.NEGATIVE_INFINITY);
    expect(paymentNumberSortKey("garbage")).toBe(Number.NEGATIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// resolveInvoiceStatusBatchIds
// ---------------------------------------------------------------------------

describe("resolveInvoiceStatusBatchIds", () => {
  it("returns nulls when no active versions exist", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const out = await resolveInvoiceStatusBatchIds("scope-1");
    expect(out).toEqual({
      abpUtilityInvoiceRows: null,
      abpIccReport3Rows: null,
      abpIccReport2Rows: null,
    });
  });

  it("maps each target dataset key to its batch id", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          { datasetKey: "abpUtilityInvoiceRows", batchId: "ui-1" },
          { datasetKey: "abpIccReport3Rows", batchId: "icc3-1" },
          { datasetKey: "abpIccReport2Rows", batchId: "icc2-1" },
          { datasetKey: "transferHistory", batchId: "ignored" },
        ],
      ])
    );
    const out = await resolveInvoiceStatusBatchIds("scope-1");
    expect(out).toEqual({
      abpUtilityInvoiceRows: "ui-1",
      abpIccReport3Rows: "icc3-1",
      abpIccReport2Rows: "icc2-1",
    });
  });
});

// ---------------------------------------------------------------------------
// getInvoiceStatusForCsgId
// ---------------------------------------------------------------------------

describe("getInvoiceStatusForCsgId", () => {
  const fakeRegistry = {
    csgId: "CSG-001",
    abpId: "SYS-9",
    applicationId: "APP-1",
    systemId: "SYS-9",
    trackingSystemRefId: "GATS-X",
    stateCertificationNumber: null,
    systemName: "Smith Site",
    installedKwAc: 7.5,
    installedKwDc: null,
    recPrice: null,
    totalContractAmount: null,
    annualRecs: null,
    contractType: null,
    installerName: null,
    county: null,
    state: null,
    zipCode: null,
    contractedDate: null,
  };

  it("short-circuits on blank csgId", async () => {
    const out = await getInvoiceStatusForCsgId("scope-1", "");
    expect(out.utilityInvoices.count).toBe(0);
    expect(out.iccReport).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns empty when no datasets are active for the scope", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. resolveInvoiceStatusBatchIds — empty
        [],
      ])
    );
    const out = await getInvoiceStatusForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.utilityInvoices.count).toBe(0);
    expect(out.iccReport).toBeNull();
  });

  it("aggregates utility invoices and pulls ICC report 3", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches
        [
          { datasetKey: "abpUtilityInvoiceRows", batchId: "ui-1" },
          { datasetKey: "abpIccReport3Rows", batchId: "icc3-1" },
        ],
        // 2. utility invoices — three rows for SYS-9
        [
          {
            rawRow: JSON.stringify({
              "Payment Number": "1",
              "Total RECS": "100",
              "REC Price": "0.05",
              "Invoice Amount ($)": "$5,000",
            }),
          },
          {
            rawRow: JSON.stringify({
              "Payment Number": "2",
              "Total RECS": "120",
              "REC Price": "0.05",
              "Invoice Amount ($)": "$6,000",
            }),
          },
          {
            rawRow: JSON.stringify({
              "Payment Number": "3",
              "Total RECS": "80",
              "REC Price": "0.05",
              "Invoice Amount ($)": "$4,000",
            }),
          },
        ],
        // 3. ICC report 3 — found by applicationId
        [
          {
            applicationId: "APP-1",
            rawRow: JSON.stringify({
              "Total REC Delivery Contract Value": "$50,000",
              "Total Quantity of RECs Contracted": "1000",
              "REC Price": "0.05",
            }),
          },
        ],
      ])
    );

    const out = await getInvoiceStatusForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });

    expect(out.utilityInvoices.count).toBe(3);
    expect(out.utilityInvoices.totalRecs).toBe(300);
    expect(out.utilityInvoices.totalInvoiceAmount).toBe(15000);
    // Sorted by paymentNumber desc: 3, 2, 1
    expect(out.utilityInvoices.rows.map((r) => r.paymentNumber)).toEqual([
      "3",
      "2",
      "1",
    ]);
    expect(out.iccReport?.applicationId).toBe("APP-1");
    expect(out.iccReport?.grossContractValue).toBe(50000);
    expect(out.iccReport?.contractedRecs).toBe(1000);
  });

  it("falls back to ICC report 2 when report 3 has no row", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches — both reports active
        [
          { datasetKey: "abpUtilityInvoiceRows", batchId: "ui-1" },
          { datasetKey: "abpIccReport3Rows", batchId: "icc3-1" },
          { datasetKey: "abpIccReport2Rows", batchId: "icc2-1" },
        ],
        // 2. utility invoices — none
        [],
        // 3. report 3 lookup by applicationId — empty
        [],
        // 4. report 3 lookup by systemId fallback — also empty
        // (fakeRegistry.systemId === "SYS-9" differs from
        //  applicationId "APP-1" so a second lookup runs)
        [],
        // 5. report 2 lookup by applicationId — found
        [
          {
            applicationId: "APP-1",
            rawRow: JSON.stringify({
              "Total REC Delivery Contract Value": "$10,000",
              "Scheduled Energization Date": "2024-09-01",
            }),
          },
        ],
      ])
    );

    const out = await getInvoiceStatusForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });

    expect(out.iccReport?.grossContractValue).toBe(10000);
    expect(out.iccReport?.scheduledEnergizationDate).toBe("2024-09-01");
  });

  it("returns null ICC + empty utility invoices when nothing matches", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches — only utility invoices active
        [{ datasetKey: "abpUtilityInvoiceRows", batchId: "ui-1" }],
        // 2. utility invoices — empty
        [],
      ])
    );
    const out = await getInvoiceStatusForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.utilityInvoices.count).toBe(0);
    expect(out.utilityInvoices.totalRecs).toBeNull();
    expect(out.utilityInvoices.totalInvoiceAmount).toBeNull();
    expect(out.iccReport).toBeNull();
  });
});
