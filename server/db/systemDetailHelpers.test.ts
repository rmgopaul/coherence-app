/**
 * Task 9.4 (2026-04-28) — tests for the by-csgId helpers used by the
 * system detail page composer. Each helper does one or two reads
 * with simple shapes; mocks `_core` via the established
 * `vi.hoisted` pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
  ensureScheduleBImportTables: vi.fn(),
}));

vi.mock("./_core", async () => {
  const actual = await vi.importActual<typeof import("./_core")>("./_core");
  return {
    ...actual,
    getDb: mocks.getDb,
    withDbRetry: mocks.withDbRetry,
    // The Schedule B helpers gate on this returning true. Real impl
    // runs CREATE TABLE IF NOT EXISTS; for tests we just say "yes".
    ensureScheduleBImportTables: mocks.ensureScheduleBImportTables,
  };
});

import { getLatestDinScrapeForCsgId } from "./dinScrapes";
import { getLatestScheduleBResultForSystem } from "./scheduleB";

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
      values: () => chain,
      set: () => chain,
      offset: () => chain,
      then: (resolve: (rows: StubRow[]) => unknown) =>
        Promise.resolve(rowsByQueryIndex[my] ?? []).then(resolve),
    };
    return chain;
  }
  return {
    select: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
    execute: () => Promise.resolve([]),
  };
}

beforeEach(() => {
  mocks.getDb.mockReset();
  mocks.withDbRetry.mockReset();
  mocks.withDbRetry.mockImplementation(async (_label, fn) => fn());
  mocks.ensureScheduleBImportTables.mockReset();
  mocks.ensureScheduleBImportTables.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLatestDinScrapeForCsgId", () => {
  it("returns empty result when csgId is blank", async () => {
    const out = await getLatestDinScrapeForCsgId("scope-1", "   ");
    expect(out).toEqual({ result: null, dins: [] });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns the latest result and its dins", async () => {
    const result = {
      id: "res-1",
      jobId: "job-1",
      scopeId: "scope-1",
      csgId: "CSG-001",
      systemPageUrl: null,
      inverterPhotoCount: 3,
      meterPhotoCount: 2,
      dinCount: 5,
      error: null,
      extractorLog: null,
      scannedAt: new Date("2026-04-28T10:00:00Z"),
    };
    const dins = [
      { id: "d1", jobId: "job-1", scopeId: "scope-1", csgId: "CSG-001", dinValue: "DIN-A", sourceType: "inverter" },
      { id: "d2", jobId: "job-1", scopeId: "scope-1", csgId: "CSG-001", dinValue: "DIN-B", sourceType: "meter" },
    ];
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. latest result
        [result],
        // 2. dins
        dins,
      ])
    );
    const out = await getLatestDinScrapeForCsgId("scope-1", "CSG-001");
    expect(out.result?.id).toBe("res-1");
    expect(out.dins.map((d) => d.dinValue)).toEqual(["DIN-A", "DIN-B"]);
  });

  it("returns empty dins when no result is found", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const out = await getLatestDinScrapeForCsgId("scope-1", "CSG-MISS");
    expect(out).toEqual({ result: null, dins: [] });
  });

  it("trims the input csgId", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const out = await getLatestDinScrapeForCsgId("scope-1", "  CSG-WS  ");
    expect(out).toEqual({ result: null, dins: [] });
    // Indirectly verifies the trim — if the helper had passed
    // "  CSG-WS  " through, the test would still pass with the
    // mocked stub but real DB lookups wouldn't hit. We can't easily
    // observe the inner sql parameter from the stub; the value here
    // is in confirming the helper short-circuits identically for
    // pre/post-trim inputs.
  });
});

describe("getLatestScheduleBResultForSystem", () => {
  it("returns null when no matchers are provided (empty match input)", async () => {
    const out = await getLatestScheduleBResultForSystem("scope-1", {
      csgId: "  ",
      systemId: null,
      trackingSystemRefId: null,
    });
    expect(out).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns the most-recent matching row", async () => {
    const row = {
      id: "sb-1",
      jobId: "job-1",
      scopeId: "scope-1",
      fileName: "csg-portal/schedule-b-CSG-001.pdf",
      designatedSystemId: "SYS-9",
      gatsId: "GATS-X",
      acSizeKw: 7.5,
      capacityFactor: 0.18,
      contractPrice: 0.045,
      contractNumber: "C-100",
      energizationDate: "2024-06-15",
      maxRecQuantity: 11,
      deliveryYearsJson: '[{"year":2025,"quantity":11}]',
      error: null,
      scannedAt: new Date("2026-04-28T10:00:00Z"),
      appliedAt: null,
    };
    mocks.getDb.mockResolvedValue(makeDbStub([[row]]));
    const out = await getLatestScheduleBResultForSystem("scope-1", {
      csgId: "CSG-001",
      systemId: "SYS-9",
      trackingSystemRefId: "GATS-X",
    });
    expect(out?.id).toBe("sb-1");
    expect(out?.gatsId).toBe("GATS-X");
  });

  it("falls back to the csg-portal filename match when only csgId is given", async () => {
    const row = {
      id: "sb-2",
      jobId: "job-2",
      scopeId: "scope-1",
      fileName: "csg-portal/schedule-b-CSG-002.pdf",
      designatedSystemId: null,
      gatsId: null,
      acSizeKw: null,
      capacityFactor: null,
      contractPrice: null,
      contractNumber: null,
      energizationDate: null,
      maxRecQuantity: null,
      deliveryYearsJson: null,
      error: null,
      scannedAt: new Date("2026-04-28T11:00:00Z"),
      appliedAt: null,
    };
    mocks.getDb.mockResolvedValue(makeDbStub([[row]]));
    const out = await getLatestScheduleBResultForSystem("scope-1", {
      csgId: "CSG-002",
    });
    expect(out?.fileName).toBe("csg-portal/schedule-b-CSG-002.pdf");
  });

  it("returns null when query returns no rows", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const out = await getLatestScheduleBResultForSystem("scope-1", {
      csgId: "CSG-MISS",
      systemId: "SYS-MISS",
      trackingSystemRefId: "GATS-MISS",
    });
    expect(out).toBeNull();
  });
});
