/**
 * Tests for the dataset-upload pure helpers.
 *
 * These guard the wire vocabulary + state machine + progress
 * formatter that both the server-side runner and the client
 * progress dialog (Phase 2) consume. Any divergence between the
 * two implementations gets caught here at the type and behavior
 * level.
 */
import { describe, expect, it } from "vitest";
import {
  computeUploadChunkPlan,
  DATASET_KEYS,
  DATASET_UPLOAD_RAW_BYTES_PER_CHUNK,
  estimateRemainingMs,
  formatEstimatedRemaining,
  formatUploadProgress,
  isDatasetKey,
  isTerminalUploadStatus,
  isUploadStatus,
  isValidUploadStatusTransition,
  UPLOAD_STATUSES,
} from "./datasetUpload.helpers";

describe("isDatasetKey", () => {
  it("returns true for every recognized key", () => {
    for (const key of DATASET_KEYS) {
      expect(isDatasetKey(key)).toBe(true);
    }
  });

  it("returns false for unknown keys", () => {
    expect(isDatasetKey("")).toBe(false);
    expect(isDatasetKey("notADataset")).toBe(false);
    expect(isDatasetKey("SOLARAPPLICATIONS")).toBe(false); // case-sensitive
    expect(isDatasetKey("solar_applications")).toBe(false);
  });

  it("covers all 18 datasets the dashboard hydrates", () => {
    expect(DATASET_KEYS).toHaveLength(18);
  });
});

describe("isUploadStatus / isTerminalUploadStatus", () => {
  it("recognizes every declared status", () => {
    for (const s of UPLOAD_STATUSES) expect(isUploadStatus(s)).toBe(true);
  });

  it("rejects unknown statuses", () => {
    expect(isUploadStatus("running")).toBe(false);
    expect(isUploadStatus("")).toBe(false);
    expect(isUploadStatus("DONE")).toBe(false); // case-sensitive
  });

  it("only `done` and `failed` are terminal", () => {
    expect(isTerminalUploadStatus("done")).toBe(true);
    expect(isTerminalUploadStatus("failed")).toBe(true);
    expect(isTerminalUploadStatus("queued")).toBe(false);
    expect(isTerminalUploadStatus("uploading")).toBe(false);
    expect(isTerminalUploadStatus("parsing")).toBe(false);
    expect(isTerminalUploadStatus("writing")).toBe(false);
  });
});

describe("isValidUploadStatusTransition", () => {
  it("queued → uploading", () => {
    expect(isValidUploadStatusTransition("queued", "uploading")).toBe(true);
  });

  it("uploading → parsing", () => {
    expect(isValidUploadStatusTransition("uploading", "parsing")).toBe(true);
  });

  it("parsing → writing OR done", () => {
    expect(isValidUploadStatusTransition("parsing", "writing")).toBe(true);
    expect(isValidUploadStatusTransition("parsing", "done")).toBe(true);
  });

  it("writing → done", () => {
    expect(isValidUploadStatusTransition("writing", "done")).toBe(true);
  });

  it("any non-terminal can fail", () => {
    expect(isValidUploadStatusTransition("queued", "failed")).toBe(true);
    expect(isValidUploadStatusTransition("uploading", "failed")).toBe(true);
    expect(isValidUploadStatusTransition("parsing", "failed")).toBe(true);
    expect(isValidUploadStatusTransition("writing", "failed")).toBe(true);
  });

  it("rejects backwards transitions", () => {
    expect(isValidUploadStatusTransition("uploading", "queued")).toBe(false);
    expect(isValidUploadStatusTransition("parsing", "uploading")).toBe(false);
    expect(isValidUploadStatusTransition("writing", "parsing")).toBe(false);
  });

  it("rejects skip-ahead transitions (queued → parsing, etc.)", () => {
    expect(isValidUploadStatusTransition("queued", "parsing")).toBe(false);
    expect(isValidUploadStatusTransition("queued", "writing")).toBe(false);
    expect(isValidUploadStatusTransition("queued", "done")).toBe(false);
    expect(isValidUploadStatusTransition("uploading", "writing")).toBe(false);
    expect(isValidUploadStatusTransition("uploading", "done")).toBe(false);
  });

  it("terminal statuses are absorbing — no transitions out", () => {
    for (const target of UPLOAD_STATUSES) {
      expect(isValidUploadStatusTransition("done", target)).toBe(false);
      expect(isValidUploadStatusTransition("failed", target)).toBe(false);
    }
  });

  it("rejects same-state self-transitions", () => {
    for (const s of UPLOAD_STATUSES) {
      expect(isValidUploadStatusTransition(s, s)).toBe(false);
    }
  });

  it("rejects unknown target statuses", () => {
    expect(isValidUploadStatusTransition("queued", "running")).toBe(false);
    expect(isValidUploadStatusTransition("queued", "")).toBe(false);
  });
});

describe("estimateRemainingMs", () => {
  const NOW = new Date("2026-04-28T12:00:00Z");

  it("returns null when total is missing or zero", () => {
    expect(
      estimateRemainingMs(
        { observed: 100, total: 0, startedAt: NOW },
        NOW
      )
    ).toBeNull();
    expect(
      estimateRemainingMs(
        { observed: 100, total: -5, startedAt: NOW },
        NOW
      )
    ).toBeNull();
  });

  it("returns null when no observation yet", () => {
    expect(
      estimateRemainingMs(
        { observed: 0, total: 1000, startedAt: NOW },
        NOW
      )
    ).toBeNull();
  });

  it("returns 0 when the job is complete", () => {
    expect(
      estimateRemainingMs(
        { observed: 1000, total: 1000, startedAt: NOW },
        NOW
      )
    ).toBe(0);
    expect(
      estimateRemainingMs(
        { observed: 1500, total: 1000, startedAt: NOW },
        NOW
      )
    ).toBe(0);
  });

  it("returns null when startedAt is missing", () => {
    expect(
      estimateRemainingMs(
        { observed: 100, total: 1000, startedAt: null },
        NOW
      )
    ).toBeNull();
  });

  it("returns null when startedAt is in the future (clock skew)", () => {
    const future = new Date(NOW.getTime() + 60_000);
    expect(
      estimateRemainingMs(
        { observed: 100, total: 1000, startedAt: future },
        NOW
      )
    ).toBeNull();
  });

  it("estimates from observed throughput (linear)", () => {
    // Start 10 seconds ago. Done 100 of 1000 rows.
    // Throughput = 10 rows/sec → 900 remaining → 90s = 90,000ms.
    const startedAt = new Date(NOW.getTime() - 10_000);
    expect(
      estimateRemainingMs(
        { observed: 100, total: 1000, startedAt },
        NOW
      )
    ).toBe(90_000);
  });

  it("accepts an ISO string startedAt (wire payload)", () => {
    const startedAt = new Date(NOW.getTime() - 5_000).toISOString();
    expect(
      estimateRemainingMs(
        { observed: 100, total: 200, startedAt },
        NOW
      )
    ).toBe(5_000);
  });
});

describe("formatUploadProgress", () => {
  const NOW = new Date("2026-04-28T12:00:00Z");

  it("formats the queued stage with no progress", () => {
    const view = formatUploadProgress(
      {
        status: "queued",
        totalRows: null,
        rowsParsed: 0,
        rowsWritten: 0,
        uploadedChunks: 0,
        totalChunks: 5,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
      },
      NOW
    );
    expect(view.stageLabel).toBe("Queued");
    expect(view.pct).toBe(0);
    expect(view.detailLabel).toContain("5 chunks");
    expect(view.isTerminal).toBe(false);
  });

  it("formats the uploading stage from chunk progress", () => {
    const view = formatUploadProgress(
      {
        status: "uploading",
        totalRows: null,
        rowsParsed: 0,
        rowsWritten: 0,
        uploadedChunks: 3,
        totalChunks: 5,
        startedAt: new Date(NOW.getTime() - 1_000),
        completedAt: null,
        errorMessage: null,
      },
      NOW
    );
    expect(view.stageLabel).toBe("Uploading");
    expect(view.pct).toBe(0.6);
    expect(view.detailLabel).toBe("3 of 5 chunks");
    expect(view.isTerminal).toBe(false);
  });

  it("formats the parsing stage from row progress", () => {
    const view = formatUploadProgress(
      {
        status: "parsing",
        totalRows: 1000,
        rowsParsed: 250,
        rowsWritten: 0,
        uploadedChunks: 5,
        totalChunks: 5,
        startedAt: new Date(NOW.getTime() - 2_000),
        completedAt: null,
        errorMessage: null,
      },
      NOW
    );
    expect(view.stageLabel).toBe("Parsing");
    expect(view.pct).toBe(0.25);
    expect(view.detailLabel).toBe("250 of 1,000 rows");
  });

  it("formats the writing stage from rowsWritten", () => {
    const view = formatUploadProgress(
      {
        status: "writing",
        totalRows: 1000,
        rowsParsed: 1000,
        rowsWritten: 600,
        uploadedChunks: 5,
        totalChunks: 5,
        startedAt: new Date(NOW.getTime() - 5_000),
        completedAt: null,
        errorMessage: null,
      },
      NOW
    );
    expect(view.stageLabel).toBe("Writing rows");
    expect(view.pct).toBe(0.6);
    expect(view.detailLabel).toBe("600 of 1,000 rows");
  });

  it("done is 100% with totalRows in the detail", () => {
    const view = formatUploadProgress(
      {
        status: "done",
        totalRows: 1000,
        rowsParsed: 1000,
        rowsWritten: 1000,
        uploadedChunks: 5,
        totalChunks: 5,
        startedAt: new Date(NOW.getTime() - 10_000),
        completedAt: NOW,
        errorMessage: null,
      },
      NOW
    );
    expect(view.pct).toBe(1);
    expect(view.detailLabel).toBe("1,000 rows written");
    expect(view.isTerminal).toBe(true);
    expect(view.estimatedRemainingMs).toBe(0);
  });

  it("failed surfaces the errorMessage and is terminal", () => {
    const view = formatUploadProgress(
      {
        status: "failed",
        totalRows: null,
        rowsParsed: 0,
        rowsWritten: 0,
        uploadedChunks: 5,
        totalChunks: 5,
        startedAt: new Date(NOW.getTime() - 10_000),
        completedAt: NOW,
        errorMessage: "Parse error at row 42",
      },
      NOW
    );
    expect(view.stageLabel).toBe("Failed");
    expect(view.detailLabel).toBe("Parse error at row 42");
    expect(view.isTerminal).toBe(true);
    expect(view.estimatedRemainingMs).toBeNull();
  });

  it("falls back to a generic 'Upload failed' when errorMessage is missing", () => {
    const view = formatUploadProgress(
      {
        status: "failed",
        totalRows: null,
        rowsParsed: 0,
        rowsWritten: 0,
        uploadedChunks: 0,
        totalChunks: null,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
      },
      NOW
    );
    expect(view.detailLabel).toBe("Upload failed");
  });
});

describe("formatEstimatedRemaining", () => {
  it("returns empty string for null", () => {
    expect(formatEstimatedRemaining(null)).toBe("");
  });

  it("formats sub-second as 'less than a second'", () => {
    expect(formatEstimatedRemaining(0)).toBe("less than a second");
    expect(formatEstimatedRemaining(500)).toBe("less than a second");
  });

  it("formats seconds with pluralization", () => {
    expect(formatEstimatedRemaining(1_000)).toBe("1 second");
    expect(formatEstimatedRemaining(12_500)).toBe("13 seconds");
    expect(formatEstimatedRemaining(59_000)).toBe("59 seconds");
  });

  it("formats minutes with pluralization", () => {
    expect(formatEstimatedRemaining(60_000)).toBe("1 minute");
    expect(formatEstimatedRemaining(120_000)).toBe("2 minutes");
    expect(formatEstimatedRemaining(45 * 60_000)).toBe("45 minutes");
  });

  it("formats hours+minutes for >= 1h", () => {
    expect(formatEstimatedRemaining(60 * 60_000)).toBe("1h");
    expect(formatEstimatedRemaining(83 * 60_000)).toBe("1h 23m");
    expect(formatEstimatedRemaining(2 * 60 * 60_000 + 30 * 60_000)).toBe(
      "2h 30m"
    );
  });
});

describe("computeUploadChunkPlan", () => {
  it("returns an empty plan for non-positive file size", () => {
    expect(computeUploadChunkPlan(0)).toEqual({
      totalChunks: 0,
      rawBytesPerChunk: DATASET_UPLOAD_RAW_BYTES_PER_CHUNK,
      chunks: [],
    });
    expect(computeUploadChunkPlan(-100)).toEqual({
      totalChunks: 0,
      rawBytesPerChunk: DATASET_UPLOAD_RAW_BYTES_PER_CHUNK,
      chunks: [],
    });
  });

  it("returns an empty plan for non-finite inputs (defensive)", () => {
    expect(computeUploadChunkPlan(Number.NaN).chunks).toEqual([]);
    expect(computeUploadChunkPlan(Number.POSITIVE_INFINITY).chunks).toEqual(
      []
    );
    expect(computeUploadChunkPlan(100, 0).chunks).toEqual([]);
    expect(computeUploadChunkPlan(100, Number.NaN).chunks).toEqual([]);
  });

  it("plans a single chunk for a file smaller than the chunk size", () => {
    const plan = computeUploadChunkPlan(150_000);
    expect(plan.totalChunks).toBe(1);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]).toEqual({
      chunkIndex: 0,
      byteStart: 0,
      byteEnd: 150_000,
    });
  });

  it("plans an exact-multiple file as the right number of chunks", () => {
    // 4 chunks of 240,000 bytes each = 960,000 byte file.
    const plan = computeUploadChunkPlan(960_000);
    expect(plan.totalChunks).toBe(4);
    expect(plan.chunks).toHaveLength(4);
    expect(plan.chunks[0].byteStart).toBe(0);
    expect(plan.chunks[0].byteEnd).toBe(240_000);
    expect(plan.chunks[3].byteEnd).toBe(960_000);
  });

  it("plans a not-quite-multiple file with a smaller trailing chunk", () => {
    // 240_000 + 240_000 + 50_000 = 530_000.
    const plan = computeUploadChunkPlan(530_000);
    expect(plan.totalChunks).toBe(3);
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks[0].byteEnd).toBe(240_000);
    expect(plan.chunks[1].byteEnd).toBe(480_000);
    expect(plan.chunks[2].byteEnd).toBe(530_000);
  });

  it("respects an injected rawBytesPerChunk for testing", () => {
    const plan = computeUploadChunkPlan(100, 30);
    expect(plan.totalChunks).toBe(4);
    expect(plan.chunks.map((c) => c.byteEnd)).toEqual([30, 60, 90, 100]);
  });

  it("byte ranges are contiguous and cover the file exactly", () => {
    const fileSize = 1_234_567;
    const plan = computeUploadChunkPlan(fileSize);
    let expectedStart = 0;
    for (const chunk of plan.chunks) {
      expect(chunk.byteStart).toBe(expectedStart);
      expect(chunk.byteEnd).toBeGreaterThan(chunk.byteStart);
      expectedStart = chunk.byteEnd;
    }
    expect(expectedStart).toBe(fileSize);
  });
});
