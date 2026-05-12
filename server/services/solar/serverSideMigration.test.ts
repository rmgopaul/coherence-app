/**
 * Regression rail for the 2026-05-12 migration-unwrap bug.
 *
 * `loadDatasetPayload` returns CSV text that `migrateOneDataset`
 * (and `syncOneCoreDatasetFromStorage`) feeds to `parseCsvText` for
 * row-table ingest. The function handles three payload shapes:
 *
 *   1. Multi-source manifest (Schedule B / convertedReads style)
 *   2. Chunked-pointer manifest (legacy chunked-CSV path)
 *   3. Direct payload — raw CSV OR a v1 `saveDataset` JSON envelope
 *      `{ fileName, uploadedAt, headers, csvText }`
 *
 * Case 3 used to return the envelope verbatim, so `parseCsvText`
 * saw `fileName`/`uploadedAt`/`headers`/`csvText` as the dataset's
 * header row and the migration failed with "missing required
 * columns". abpQuickBooksRows, abpProjectApplicationRows, and
 * abpUtilityInvoiceRows were stuck on prod for weeks because of
 * this. The fix detects the envelope shape and extracts `csvText`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer so loadDatasetPayload doesn't try to talk to MySQL.
const mockGetSolarRecDashboardPayload = vi.fn();
vi.mock("../../db", () => ({
  getSolarRecDashboardPayload: (...args: unknown[]) =>
    mockGetSolarRecDashboardPayload(...args),
}));

// Helper modules that loadDatasetPayload imports — return null/empty
// for these so we exercise Case 3 (direct payload) cleanly.
vi.mock("../../routers/helpers", () => ({
  parseChunkPointerPayload: () => null,
  parseScheduleBRemoteSourceManifest: () => null,
}));

vi.mock("./coreDatasetSyncProgress", () => ({
  buildSyncProgress: (input: unknown) => input,
}));

import { loadDatasetPayload } from "./serverSideMigration";

beforeEach(() => {
  mockGetSolarRecDashboardPayload.mockReset();
});

describe("loadDatasetPayload Case 3 (direct payload)", () => {
  it("unwraps a v1 saveDataset JSON envelope and returns the inner csvText", async () => {
    const csvText = "applicationId,part1SubmissionDate\nAPP-1,2024-01-15\n";
    const envelope = JSON.stringify({
      fileName: "2026-04-09_ProjectApplication.csv",
      uploadedAt: "2026-04-30T22:25:03.399Z",
      headers: ["applicationId", "part1SubmissionDate"],
      csvText,
    });
    mockGetSolarRecDashboardPayload.mockResolvedValueOnce(envelope);

    const result = await loadDatasetPayload(1, "abpProjectApplicationRows");

    expect(result).toBe(csvText);
  });

  it("returns a raw CSV payload unchanged when there's no envelope shape", async () => {
    const csvText = "col1,col2\nval1,val2\nval3,val4\n";
    mockGetSolarRecDashboardPayload.mockResolvedValueOnce(csvText);

    const result = await loadDatasetPayload(1, "abpQuickBooksRows");

    expect(result).toBe(csvText);
  });

  it("returns null when there is no payload at all", async () => {
    mockGetSolarRecDashboardPayload.mockResolvedValueOnce(null);

    const result = await loadDatasetPayload(1, "missingDataset");

    expect(result).toBeNull();
  });

  it("returns the payload unchanged when it's malformed JSON (not an envelope)", async () => {
    // A CSV that happens to start with `{` — should NOT be parsed as JSON.
    const csvText = "{col1,{col2\n{val1,{val2";
    mockGetSolarRecDashboardPayload.mockResolvedValueOnce(csvText);

    const result = await loadDatasetPayload(1, "edgeCase");

    expect(result).toBe(csvText);
  });

  it("returns the payload unchanged when JSON parses but has no csvText field", async () => {
    // A JSON object without the expected envelope shape — could be a
    // future payload shape we don't know about. Return verbatim so the
    // downstream parser surfaces the failure with a useful message.
    const payload = JSON.stringify({ someOtherShape: true, data: [1, 2, 3] });
    mockGetSolarRecDashboardPayload.mockResolvedValueOnce(payload);

    const result = await loadDatasetPayload(1, "unknownShape");

    expect(result).toBe(payload);
  });

  it("returns the payload unchanged when csvText is present but not a string", async () => {
    // Defensive: an envelope where csvText was corrupted to a non-string.
    // Don't crash; return raw so the parser produces a clear error.
    const payload = JSON.stringify({
      fileName: "test.csv",
      csvText: { unexpected: "object" },
    });
    mockGetSolarRecDashboardPayload.mockResolvedValueOnce(payload);

    const result = await loadDatasetPayload(1, "corruptedEnvelope");

    expect(result).toBe(payload);
  });
});
