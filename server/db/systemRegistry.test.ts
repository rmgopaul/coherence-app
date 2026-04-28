/**
 * Task 9.1 (2026-04-28) — getSystemByCsgId join-chain tests.
 *
 * Mocks the `_core` db barrel so we can feed canned rows for each
 * of the four queries the helper makes (active-batch resolver →
 * mapping lookup → applications lookup → contracted-date lookup).
 *
 * The drizzle builder is opaque to vitest, so the stub fakes a
 * builder whose terminal methods (`limit`, `where` when not chained)
 * return the canned row arrays in registration order.
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
  getSystemByCsgId,
  resolveSystemRegistryBatchIds,
} from "./systemRegistry";

type StubRow = Record<string, unknown>;

/**
 * Build a fake db that yields each of the supplied row arrays in
 * order — one per query made via the builder. Each query in
 * `getSystemByCsgId` ends with either `.where(...).limit(1)` or
 * `.where(...)`, both of which become awaitable arrays. We expose
 * a single thenable per builder chain to handle both.
 */
function makeDbStub(rowsByQueryIndex: StubRow[][]) {
  let idx = 0;
  // We build a fresh chain per `db.select(...)` call so each query
  // gets a clean cursor through the array. The `then` shim lets the
  // caller `await` the chain regardless of whether they invoked
  // `.limit()` first.
  function makeChain() {
    const my = idx;
    idx += 1;
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      then: (resolve: (rows: StubRow[]) => unknown) => {
        const rows = rowsByQueryIndex[my] ?? [];
        return Promise.resolve(rows).then(resolve);
      },
    };
    return chain;
  }
  return {
    select: () => makeChain(),
  };
}

beforeEach(() => {
  mocks.getDb.mockReset();
  mocks.withDbRetry.mockReset();
  mocks.withDbRetry.mockImplementation(async (_label, fn) => fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSystemRegistryBatchIds", () => {
  it("returns nulls when no active versions exist", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const out = await resolveSystemRegistryBatchIds("scope-1");
    expect(out).toEqual({
      solarApplications: null,
      abpCsgSystemMapping: null,
      contractedDate: null,
    });
  });

  it("maps each active row to its slot in the result", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          { datasetKey: "solarApplications", batchId: "batch-A" },
          { datasetKey: "abpCsgSystemMapping", batchId: "batch-B" },
          { datasetKey: "contractedDate", batchId: "batch-C" },
        ],
      ])
    );
    const out = await resolveSystemRegistryBatchIds("scope-1");
    expect(out).toEqual({
      solarApplications: "batch-A",
      abpCsgSystemMapping: "batch-B",
      contractedDate: "batch-C",
    });
  });

  it("ignores active rows for other dataset keys", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          { datasetKey: "solarApplications", batchId: "batch-A" },
          // Other dataset keys come back from the same `inArray`-less
          // query path and should be ignored. The actual SQL filters
          // these out, but the stub doesn't implement the filter so
          // we exercise the defensive switch in the helper.
          { datasetKey: "transferHistory", batchId: "batch-IGNORED" },
        ],
      ])
    );
    const out = await resolveSystemRegistryBatchIds("scope-1");
    expect(out.solarApplications).toBe("batch-A");
    expect(out.abpCsgSystemMapping).toBeNull();
    expect(out.contractedDate).toBeNull();
  });
});

describe("getSystemByCsgId", () => {
  it("returns null when the input csgId is empty", async () => {
    const result = await getSystemByCsgId("scope-1", "");
    expect(result).toBeNull();
    // Should short-circuit before touching the DB.
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns null when no Solar Applications dataset is active", async () => {
    mocks.getDb.mockResolvedValue(
      // Query 1: active batches — only mapping is active
      makeDbStub([
        [{ datasetKey: "abpCsgSystemMapping", batchId: "batch-mapping" }],
      ])
    );
    const result = await getSystemByCsgId("scope-1", "CSG-001");
    expect(result).toBeNull();
  });

  it("joins mapping → applications → contracted date", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches
        [
          { datasetKey: "solarApplications", batchId: "batch-apps" },
          { datasetKey: "abpCsgSystemMapping", batchId: "batch-mapping" },
          { datasetKey: "contractedDate", batchId: "batch-dates" },
        ],
        // 2. mapping lookup — csgId → systemId
        [{ csgId: "CSG-001", systemId: "SYS-9" }],
        // 3. applications lookup
        [
          {
            applicationId: "APP-123",
            systemId: "SYS-9",
            trackingSystemRefId: "GATS-X",
            stateCertificationNumber: "CERT-7",
            systemName: "Smith Residence",
            installedKwAc: 7.5,
            installedKwDc: 8.2,
            recPrice: 0.045,
            totalContractAmount: 12345.67,
            annualRecs: 11,
            contractType: "Standard",
            installerName: "Acme Solar",
            county: "Cook",
            state: "IL",
            zipCode: "60601",
          },
        ],
        // 4. contracted date lookup
        [{ contractedDate: "2024-06-15" }],
      ])
    );

    const result = await getSystemByCsgId("scope-1", "CSG-001");
    expect(result).toEqual({
      csgId: "CSG-001",
      abpId: "SYS-9",
      applicationId: "APP-123",
      systemId: "SYS-9",
      trackingSystemRefId: "GATS-X",
      stateCertificationNumber: "CERT-7",
      systemName: "Smith Residence",
      installedKwAc: 7.5,
      installedKwDc: 8.2,
      recPrice: 0.045,
      totalContractAmount: 12345.67,
      annualRecs: 11,
      contractType: "Standard",
      installerName: "Acme Solar",
      county: "Cook",
      state: "IL",
      zipCode: "60601",
      contractedDate: "2024-06-15",
    });
  });

  it("falls back to legacy applicationId === csgId when mapping is missing", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches — mapping is active but contains no row
        // for this csgId
        [
          { datasetKey: "solarApplications", batchId: "batch-apps" },
          { datasetKey: "abpCsgSystemMapping", batchId: "batch-mapping" },
        ],
        // 2. mapping lookup — empty result
        [],
        // 3. applications lookup matches via legacy applicationId
        [
          {
            applicationId: "CSG-LEGACY",
            systemId: null,
            trackingSystemRefId: null,
            stateCertificationNumber: null,
            systemName: "Legacy Site",
            installedKwAc: 5.0,
            installedKwDc: null,
            recPrice: null,
            totalContractAmount: null,
            annualRecs: null,
            contractType: null,
            installerName: null,
            county: null,
            state: null,
            zipCode: null,
          },
        ],
        // 4. contracted date lookup never runs because resolvedSystemId
        // came from applicationId == "CSG-LEGACY" but contractedDate
        // dataset isn't active. The helper short-circuits when no
        // contractedDate batch is active.
      ])
    );

    const result = await getSystemByCsgId("scope-1", "CSG-LEGACY");
    expect(result).not.toBeNull();
    expect(result?.applicationId).toBe("CSG-LEGACY");
    expect(result?.abpId).toBeNull();
    expect(result?.systemName).toBe("Legacy Site");
    expect(result?.contractedDate).toBeNull();
  });

  it("returns null contractedDate when the dataset isn't active", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches — contracted date NOT active
        [
          { datasetKey: "solarApplications", batchId: "batch-apps" },
          { datasetKey: "abpCsgSystemMapping", batchId: "batch-mapping" },
        ],
        // 2. mapping lookup
        [{ csgId: "CSG-002", systemId: "SYS-22" }],
        // 3. applications lookup
        [
          {
            applicationId: "APP-22",
            systemId: "SYS-22",
            trackingSystemRefId: null,
            stateCertificationNumber: null,
            systemName: "No Date Site",
            installedKwAc: null,
            installedKwDc: null,
            recPrice: null,
            totalContractAmount: null,
            annualRecs: null,
            contractType: null,
            installerName: null,
            county: null,
            state: null,
            zipCode: null,
          },
        ],
      ])
    );

    const result = await getSystemByCsgId("scope-1", "CSG-002");
    expect(result?.csgId).toBe("CSG-002");
    expect(result?.abpId).toBe("SYS-22");
    expect(result?.contractedDate).toBeNull();
  });

  it("returns null when no Solar Applications row matches", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. active batches — all active
        [
          { datasetKey: "solarApplications", batchId: "batch-apps" },
          { datasetKey: "abpCsgSystemMapping", batchId: "batch-mapping" },
          { datasetKey: "contractedDate", batchId: "batch-dates" },
        ],
        // 2. mapping lookup — empty
        [],
        // 3. applications lookup — empty (no legacy match either)
        [],
      ])
    );

    const result = await getSystemByCsgId("scope-1", "CSG-MISSING");
    expect(result).toBeNull();
  });

  it("trims whitespace on the input csgId", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [{ datasetKey: "solarApplications", batchId: "batch-apps" }],
        // mapping not active so query is skipped; applications query
        // is the next one to run with the trimmed csgId.
        [
          {
            applicationId: "  ABC  ",
            systemId: null,
            trackingSystemRefId: null,
            stateCertificationNumber: null,
            systemName: null,
            installedKwAc: null,
            installedKwDc: null,
            recPrice: null,
            totalContractAmount: null,
            annualRecs: null,
            contractType: null,
            installerName: null,
            county: null,
            state: null,
            zipCode: null,
          },
        ],
      ])
    );

    const result = await getSystemByCsgId("scope-1", "  CSG-WS  ");
    expect(result?.csgId).toBe("CSG-WS");
  });
});
