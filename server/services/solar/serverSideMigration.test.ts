/**
 * Regression rail for the 2026-05-12 migration-unwrap bug.
 *
 * `loadDatasetPayload` returns CSV text that `migrateOneDataset`
 * (and `syncOneCoreDatasetFromStorage`) feeds to `parseCsvText` for
 * row-table ingest. The function handles three payload shapes:
 *
 *   1. Multi-source manifest (Schedule B / convertedReads style)
 *   2. Chunked-pointer manifest (legacy chunked-CSV path) —
 *      `splitTextIntoChunks(serializeDatasetForRemote(...), 250KB)`
 *      on the client; reassembly concatenates back into the
 *      original `{fileName, uploadedAt, headers, csvText}` envelope.
 *   3. Direct payload — raw CSV OR a v1 `saveDataset` JSON envelope.
 *
 * The bug: Case 2 returned the reassembled string verbatim and
 * Case 3 returned the direct payload verbatim. Both paths now
 * run through `maybeUnwrapV1Envelope` which detects the envelope
 * shape (parses as JSON, has a string `csvText`) and extracts the
 * inner CSV.
 *
 * On prod (2026-05-12) three ABP datasets were stuck:
 *   - abpQuickBooksRows (4.76 MB → chunked → Case 2)
 *   - abpProjectApplicationRows (1.21 MB → chunked → Case 2)
 *   - abpUtilityInvoiceRows (0.31 MB → either Case 2 or 3 depending
 *     on the chunker's exact threshold)
 *
 * The first revision of this PR only fixed Case 3; the meticulous
 * code-review pass caught that the two larger datasets hit Case 2
 * and would still fail. Hence both Case 2 and Case 3 regression
 * tests below.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer so loadDatasetPayload doesn't try to talk to MySQL.
const mockGetSolarRecDashboardPayload = vi.fn();
vi.mock("../../db", () => ({
  getSolarRecDashboardPayload: (...args: unknown[]) =>
    mockGetSolarRecDashboardPayload(...args),
}));

// Helper modules — manifest parsers return null/empty for the
// envelope-shape payloads we're testing (the envelope has no
// `_rawSourcesV1` or `_chunkedDataset` sentinels). Chunk-pointer
// behavior is overridden per-test via mockReturnValueOnce.
const mockParseChunkPointerPayload = vi.fn();
const mockParseScheduleBRemoteSourceManifest = vi.fn();
vi.mock("../../routers/helpers", () => ({
  parseChunkPointerPayload: (...args: unknown[]) =>
    mockParseChunkPointerPayload(...args),
  parseScheduleBRemoteSourceManifest: (...args: unknown[]) =>
    mockParseScheduleBRemoteSourceManifest(...args),
}));

vi.mock("./coreDatasetSyncProgress", () => ({
  buildSyncProgress: (input: unknown) => input,
}));

import { loadDatasetPayload, maybeUnwrapV1Envelope } from "./serverSideMigration";

beforeEach(() => {
  mockGetSolarRecDashboardPayload.mockReset();
  mockParseChunkPointerPayload.mockReset();
  mockParseScheduleBRemoteSourceManifest.mockReset();
  // Default: both manifest parsers return null (envelope payloads
  // have no sentinel fields). Tests that want chunk-pointer behavior
  // override per-call via mockReturnValueOnce.
  mockParseChunkPointerPayload.mockReturnValue(null);
  mockParseScheduleBRemoteSourceManifest.mockReturnValue(null);
});

describe("maybeUnwrapV1Envelope (pure helper)", () => {
  it("returns the inner csvText when the payload is a v1 envelope", () => {
    const csvText = "a,b\n1,2\n";
    const envelope = JSON.stringify({
      fileName: "test.csv",
      uploadedAt: "2026-05-12T00:00:00.000Z",
      headers: ["a", "b"],
      csvText,
    });
    expect(maybeUnwrapV1Envelope(envelope)).toBe(csvText);
  });

  it("returns the payload unchanged when it's raw CSV", () => {
    const csvText = "a,b\n1,2\n";
    expect(maybeUnwrapV1Envelope(csvText)).toBe(csvText);
  });

  it("returns the payload unchanged when JSON parses but has no csvText", () => {
    const payload = JSON.stringify({ someOtherShape: true });
    expect(maybeUnwrapV1Envelope(payload)).toBe(payload);
  });

  it("returns the payload unchanged when csvText is non-string", () => {
    const payload = JSON.stringify({ csvText: { not: "a string" } });
    expect(maybeUnwrapV1Envelope(payload)).toBe(payload);
  });
});

describe("loadDatasetPayload Case 2 (chunked-pointer reassembly)", () => {
  it("unwraps a v1 envelope after reassembling its chunks", async () => {
    // Simulate the prod scenario: a 4.76 MB envelope split into ~20
    // chunks of ≤250 KB each. We use 3 small chunks here for
    // readability; the reassembly is identical.
    const csvText =
      "applicationId,part1SubmissionDate,inverterSizeKwAcPart1\n" +
      "APP-1,2024-01-15,5.4\n" +
      "APP-2,2024-02-20,7.2\n";
    const envelopeJson = JSON.stringify({
      fileName: "ProjectApplication.csv",
      uploadedAt: "2026-04-09T12:34:56.789Z",
      headers: ["applicationId", "part1SubmissionDate", "inverterSizeKwAcPart1"],
      csvText,
    });
    // Split the envelope into 3 chunks (mimics REMOTE_DATASET_CHUNK_CHAR_LIMIT)
    const chunkSize = Math.ceil(envelopeJson.length / 3);
    const chunks = [
      envelopeJson.slice(0, chunkSize),
      envelopeJson.slice(chunkSize, chunkSize * 2),
      envelopeJson.slice(chunkSize * 2),
    ];
    const chunkKeys = ["abpProjectApplicationRows_chunk_0001", "_chunk_0002", "_chunk_0003"];

    // First getSolarRecDashboardPayload call: the chunk-pointer manifest itself
    // (returns a JSON string that parseChunkPointerPayload would decode).
    mockGetSolarRecDashboardPayload
      .mockResolvedValueOnce("(chunk pointer payload — mocked)") // basePayload (Case 2 input)
      .mockResolvedValueOnce(chunks[0])
      .mockResolvedValueOnce(chunks[1])
      .mockResolvedValueOnce(chunks[2]);

    // parseChunkPointerPayload returns the list of chunk keys.
    mockParseChunkPointerPayload.mockReturnValueOnce(chunkKeys);

    const result = await loadDatasetPayload(1, "abpProjectApplicationRows");

    expect(result).toBe(csvText);
  });

  it("returns the reassembled string unchanged when chunks contain raw CSV (not an envelope)", async () => {
    // A purely hypothetical case — the v1 client always wraps via
    // serializeDatasetForRemote(), so this shouldn't happen in
    // production, but the unwrap helper must passthrough cleanly.
    const csvText = "a,b,c\n1,2,3\n4,5,6\n";
    const chunkKeys = ["k_0001", "k_0002"];
    mockGetSolarRecDashboardPayload
      .mockResolvedValueOnce("(chunk pointer payload)")
      .mockResolvedValueOnce(csvText.slice(0, 8))
      .mockResolvedValueOnce(csvText.slice(8));
    mockParseChunkPointerPayload.mockReturnValueOnce(chunkKeys);

    const result = await loadDatasetPayload(1, "rawChunkedDataset");

    expect(result).toBe(csvText);
  });

  it("throws when a chunk is missing (mid-reassembly)", async () => {
    mockGetSolarRecDashboardPayload
      .mockResolvedValueOnce("(chunk pointer payload)")
      .mockResolvedValueOnce("chunk1-partial")
      .mockResolvedValueOnce(null); // missing chunk
    mockParseChunkPointerPayload.mockReturnValueOnce(["k_1", "k_2"]);

    await expect(
      loadDatasetPayload(1, "missingChunkDataset")
    ).rejects.toThrow(/Missing chunk/);
  });
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

  it("returns the payload unchanged when JSON parses but has no csvText field", async () => {
    const payload = JSON.stringify({ someOtherShape: true, data: [1, 2, 3] });
    mockGetSolarRecDashboardPayload.mockResolvedValueOnce(payload);

    const result = await loadDatasetPayload(1, "unknownShape");

    expect(result).toBe(payload);
  });

  it("returns the payload unchanged when csvText is present but not a string", async () => {
    const payload = JSON.stringify({
      fileName: "test.csv",
      csvText: { unexpected: "object" },
    });
    mockGetSolarRecDashboardPayload.mockResolvedValueOnce(payload);

    const result = await loadDatasetPayload(1, "corruptedEnvelope");

    expect(result).toBe(payload);
  });
});
