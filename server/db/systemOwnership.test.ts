/**
 * Task 9.5 PR-5 (2026-04-28) — ownership / transfer-history helper
 * tests. Two layers: pure date-key sort helper + the DB-touching
 * `getOwnershipForCsgId` join chain (mocked via the established
 * `vi.hoisted` pattern).
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
  getOwnershipForCsgId,
  resolveTransferHistoryBatchId,
  transferDateSortKey,
} from "./systemOwnership";

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

describe("transferDateSortKey", () => {
  it("returns ISO dates as their leading 10 chars", () => {
    expect(transferDateSortKey("2024-06-15")).toBe("2024-06-15");
    expect(transferDateSortKey("2024-06-15T10:30:00Z")).toBe("2024-06-15");
  });

  it("converts non-ISO formats via Date", () => {
    expect(transferDateSortKey("06/15/2024")).toBe("2024-06-15");
    expect(transferDateSortKey("June 15, 2024")).toBe("2024-06-15");
  });

  it("returns empty string for null/empty/garbage", () => {
    expect(transferDateSortKey(null)).toBe("");
    expect(transferDateSortKey("")).toBe("");
    expect(transferDateSortKey("not a date")).toBe("");
  });
});

describe("resolveTransferHistoryBatchId", () => {
  it("returns null when no active version exists", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    expect(await resolveTransferHistoryBatchId("scope-1")).toBeNull();
  });

  it("returns the batchId when active", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[{ batchId: "th-1" }]]));
    expect(await resolveTransferHistoryBatchId("scope-1")).toBe("th-1");
  });
});

describe("getOwnershipForCsgId", () => {
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
    const out = await getOwnershipForCsgId("scope-1", "");
    expect(out.count).toBe(0);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns empty when registry has no trackingSystemRefId", async () => {
    const noTracking = { ...fakeRegistry, trackingSystemRefId: null };
    const out = await getOwnershipForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: noTracking,
    });
    expect(out.count).toBe(0);
    expect(out.transfers).toEqual([]);
  });

  it("returns empty when transferHistory dataset isn't active", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // resolveTransferHistoryBatchId — empty
        [],
      ])
    );
    const out = await getOwnershipForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.count).toBe(0);
  });

  it("rolls up transfers + sorts by date desc", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. resolve batch
        [{ batchId: "th-1" }],
        // 2. transfer rows
        [
          {
            transactionId: "TXN-3",
            transferCompletionDate: "2024-06-15",
            quantity: 50,
            transferor: "Acme Solar LLC",
            transferee: "Sunrise Co",
          },
          {
            transactionId: "TXN-1",
            transferCompletionDate: "2024-01-10",
            quantity: 30,
            transferor: "Acme Solar LLC",
            transferee: "Beta Holdings",
          },
          {
            transactionId: "TXN-2",
            transferCompletionDate: "2024-03-20",
            quantity: 40,
            transferor: "Beta Holdings",
            transferee: "Sunrise Co",
          },
        ],
      ])
    );

    const out = await getOwnershipForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });

    expect(out.count).toBe(3);
    expect(out.totalQuantityTransferred).toBe(120);
    expect(out.latestTransferDate).toBe("2024-06-15");
    expect(out.uniqueTransferors).toEqual(["Acme Solar LLC", "Beta Holdings"]);
    expect(out.uniqueTransferees).toEqual(["Beta Holdings", "Sunrise Co"]);
    // App-side sort uses transferDateSortKey desc.
    expect(out.transfers.map((t) => t.transactionId)).toEqual([
      "TXN-3",
      "TXN-2",
      "TXN-1",
    ]);
  });

  it("falls back gracefully when quantities are null", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [{ batchId: "th-1" }],
        [
          {
            transactionId: "TXN-X",
            transferCompletionDate: "2024-01-01",
            quantity: null,
            transferor: "A",
            transferee: "B",
          },
        ],
      ])
    );
    const out = await getOwnershipForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    expect(out.totalQuantityTransferred).toBeNull();
  });

  it("dedupes counterparties + sorts alphabetically", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [{ batchId: "th-1" }],
        [
          {
            transactionId: "T1",
            transferCompletionDate: "2024-01-01",
            quantity: 10,
            transferor: "  Zeta Corp  ",
            transferee: "Alpha LLC",
          },
          {
            transactionId: "T2",
            transferCompletionDate: "2024-02-01",
            quantity: 10,
            transferor: "Alpha LLC",
            transferee: "Zeta Corp",
          },
        ],
      ])
    );
    const out = await getOwnershipForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
    });
    // Trims, dedupes, sorts.
    expect(out.uniqueTransferors).toEqual(["Alpha LLC", "Zeta Corp"]);
    expect(out.uniqueTransferees).toEqual(["Alpha LLC", "Zeta Corp"]);
  });

  it("clamps the limit to [1, 200]", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([[{ batchId: "th-1" }], []])
    );
    // Limit of 99999 should not throw — clamp is documented in the
    // helper. Actual LIMIT clause inspection requires a real DB;
    // this confirms the clamp doesn't blow up the call.
    const out = await getOwnershipForCsgId("scope-1", "CSG-001", {
      preResolvedRegistry: fakeRegistry,
      limit: 99999,
    });
    expect(out.transfers).toEqual([]);
  });
});
