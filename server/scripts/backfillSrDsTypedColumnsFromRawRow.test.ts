/**
 * Backfill safety rails (PR #361 follow-up).
 *
 * The script repairs `srDs*` rows by reparsing `rawRow` JSON and
 * UPDATEing typed columns the v2 parser dropped pre-fix. On
 * production-sized tables the original implementation had three
 * structural problems flagged by Codex:
 *
 *   F1: `db.execute(sql\`SELECT...\`)` returns the mysql2
 *       `[rows, fields]` tuple. Treating it as the rows array
 *       silently iterates two items and updates nothing.
 *   F2: The default loop included `srDsContractedDate`, which has
 *       no `rawRow` column — the SELECT would error.
 *   F3: Every parseable row triggered an UPDATE, even when typed
 *       columns already matched. On 400k+ rows this is hundreds
 *       of thousands of unnecessary TiDB writes.
 *
 * This file locks in the fixes:
 *   - `unwrapExecuteRows` correctly extracts rows from the tuple.
 *   - `selectDatasetsToBackfill` rejects contractedDate /
 *     deliveryScheduleBase explicitly with a useful message.
 *   - `diffTypedColumns` only returns keys that actually changed,
 *     so `Object.keys(changed).length === 0` short-circuits the
 *     UPDATE.
 *   - `parseRawRowJson` is null-safe and JSON-error-safe.
 */
import { describe, expect, it } from "vitest";
import {
  diffTypedColumns,
  parseRawRowJson,
  parseArgs,
  unwrapExecuteRows,
  PRESERVE_KEYS,
  DATASETS_WITH_RAW_ROW,
  __TEST_ONLY__,
} from "./backfillSrDsTypedColumnsFromRawRow";

describe("unwrapExecuteRows (Codex F1: tuple-vs-rows)", () => {
  it("extracts rows from the [rows, fields] tuple shape", () => {
    const tuple = [
      [
        { id: "a", rawRow: "{}" },
        { id: "b", rawRow: "{}" },
      ],
      [{ name: "id" }, { name: "rawRow" }], // mysql2 fields metadata
    ];
    expect(unwrapExecuteRows<{ id: string }>(tuple)).toEqual([
      { id: "a", rawRow: "{}" },
      { id: "b", rawRow: "{}" },
    ]);
  });

  it("returns the input as rows when already-unwrapped", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(unwrapExecuteRows<{ id: string }>(rows)).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
  });

  it("returns an empty array on null/undefined input", () => {
    expect(unwrapExecuteRows(null)).toEqual([]);
    expect(unwrapExecuteRows(undefined)).toEqual([]);
  });

  it("returns an empty array on a non-array input", () => {
    expect(unwrapExecuteRows({ not: "rows" })).toEqual([]);
  });

  it("regression: pre-fix script would have iterated [rows, fields] as 2 items", () => {
    // Documents the BROKEN behaviour the helper guards against:
    // a tuple has length 2, so `(result as Array<...>).length === 2`
    // even though the actual row count is much larger. Without
    // unwrap, the script reported `candidates=2` and updated
    // nothing.
    const tuple = [
      [
        { id: "a", rawRow: '{"x":1}' },
        { id: "b", rawRow: '{"x":2}' },
        { id: "c", rawRow: '{"x":3}' },
      ],
      [{ name: "id" }],
    ];
    expect((tuple as Array<unknown>).length).toBe(2); // the bug
    expect(unwrapExecuteRows<{ id: string }>(tuple)).toHaveLength(3); // the fix
  });
});

describe("selectDatasetsToBackfill (Codex F2: contractedDate guard)", () => {
  it("default list excludes contractedDate", () => {
    const datasets = __TEST_ONLY__.selectDatasetsToBackfill({
      dryRun: true,
      scopeId: null,
      datasetKey: null,
      pageSize: 500,
    });
    expect(datasets).not.toContain("contractedDate");
    expect(datasets).not.toContain("deliveryScheduleBase");
    // Sanity: at least one dataset that does have rawRow.
    expect(datasets).toContain("abpReport");
    expect(datasets).toContain("solarApplications");
  });

  it("default list matches DATASETS_WITH_RAW_ROW exactly", () => {
    const datasets = __TEST_ONLY__.selectDatasetsToBackfill({
      dryRun: true,
      scopeId: null,
      datasetKey: null,
      pageSize: 500,
    });
    expect(new Set(datasets)).toEqual(new Set(DATASETS_WITH_RAW_ROW));
  });

  it("explicit --dataset contractedDate fails fast with a clear message", () => {
    expect(() =>
      __TEST_ONLY__.selectDatasetsToBackfill({
        dryRun: true,
        scopeId: null,
        datasetKey: "contractedDate",
        pageSize: 500,
      })
    ).toThrow(/contractedDate.*rawRow/i);
  });

  it("explicit --dataset deliveryScheduleBase fails fast", () => {
    expect(() =>
      __TEST_ONLY__.selectDatasetsToBackfill({
        dryRun: true,
        scopeId: null,
        datasetKey: "deliveryScheduleBase",
        pageSize: 500,
      })
    ).toThrow(/Schedule B PDF scanner/i);
  });

  it("accepts a valid explicit dataset like abpReport", () => {
    const datasets = __TEST_ONLY__.selectDatasetsToBackfill({
      dryRun: true,
      scopeId: null,
      datasetKey: "abpReport",
      pageSize: 500,
    });
    expect(datasets).toEqual(["abpReport"]);
  });
});

describe("diffTypedColumns (Codex F3: diff-based writes)", () => {
  it("returns no changes when typed columns already match", () => {
    const current = {
      id: "row-1",
      scopeId: "scope-A",
      batchId: "batch-1",
      rawRow: "{}",
      createdAt: new Date("2026-05-01T00:00:00Z"),
      applicationId: "APP-1",
      part2AppVerificationDate: "2024-12-01",
      inverterSizeKwAc: 7.5,
    };
    const parsed = {
      id: "row-1",
      scopeId: "scope-A",
      batchId: "batch-1",
      rawRow: "{}",
      createdAt: new Date("2026-06-01T00:00:00Z"), // different but PRESERVED
      applicationId: "APP-1",
      part2AppVerificationDate: "2024-12-01",
      inverterSizeKwAc: 7.5,
    };
    expect(diffTypedColumns(current, parsed)).toEqual({});
  });

  it("returns only the changed key when one typed column flips from null", () => {
    const current = {
      id: "row-2",
      applicationId: "APP-2",
      part2AppVerificationDate: null, // pre-fix: parser missed this
      inverterSizeKwAc: 5,
    };
    const parsed = {
      id: "row-2",
      applicationId: "APP-2",
      part2AppVerificationDate: "2024-12-01", // post-fix: parser picks it up
      inverterSizeKwAc: 5,
    };
    expect(diffTypedColumns(current, parsed)).toEqual({
      part2AppVerificationDate: "2024-12-01",
    });
  });

  it("returns multiple keys when several typed columns differ", () => {
    const current = {
      id: "row-3",
      contractType: null,
      annualRecs: null,
      installerName: "Acme Solar",
    };
    const parsed = {
      id: "row-3",
      contractType: "REC",
      annualRecs: 12,
      installerName: "Acme Solar",
    };
    expect(diffTypedColumns(current, parsed)).toEqual({
      contractType: "REC",
      annualRecs: 12,
    });
  });

  it("treats null and undefined as equal", () => {
    const current = { id: "row-4", x: null };
    const parsed = { id: "row-4", x: undefined };
    expect(diffTypedColumns(current, parsed)).toEqual({});
  });

  it("treats Date objects with the same instant as equal", () => {
    const t = "2026-05-04T12:00:00Z";
    const current = { id: "row-5", lastUpdated: new Date(t) };
    const parsed = { id: "row-5", lastUpdated: new Date(t) };
    expect(diffTypedColumns(current, parsed)).toEqual({});
  });

  it("flags Date objects with different instants as changed", () => {
    const current = {
      id: "row-6",
      lastUpdated: new Date("2026-05-04T12:00:00Z"),
    };
    const parsed = {
      id: "row-6",
      lastUpdated: new Date("2026-05-04T13:00:00Z"),
    };
    const changed = diffTypedColumns(current, parsed);
    expect(Object.keys(changed)).toEqual(["lastUpdated"]);
  });

  it("never includes preserved keys (id/scopeId/batchId/rawRow/createdAt) even when they 'differ'", () => {
    // The script preserves these columns and would never write
    // them. We exercise the guard explicitly: a parsed value that
    // differs MUST NOT appear in the changed set.
    const current = {
      id: "row-7",
      scopeId: "scope-A",
      batchId: "batch-old",
      rawRow: "{}",
      createdAt: new Date("2026-05-01T00:00:00Z"),
      contractType: null,
    };
    const parsed = {
      id: "row-7-NEW", // would be a tenancy bug to write
      scopeId: "scope-B-NEW",
      batchId: "batch-NEW",
      rawRow: '{"different":"json"}',
      createdAt: new Date("2099-01-01T00:00:00Z"),
      contractType: "REC", // legitimately changed
    };
    const changed = diffTypedColumns(current, parsed);
    expect(changed).toEqual({ contractType: "REC" });
    for (const key of PRESERVE_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(changed, key)).toBe(false);
    }
  });
});

describe("parseRawRowJson", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(parseRawRowJson(null)).toBeNull();
    expect(parseRawRowJson(undefined)).toBeNull();
    expect(parseRawRowJson("")).toBeNull();
  });

  it("returns null on JSON parse error", () => {
    expect(parseRawRowJson("not-json")).toBeNull();
    expect(parseRawRowJson("{")).toBeNull();
  });

  it("stringifies non-string values for parser consumption", () => {
    const out = parseRawRowJson(
      JSON.stringify({
        Application_ID: 128875,
        Part_2_App_Verification_Date: "2024-12-01",
        Inverter_Size_kW_AC: 7.5,
      })
    );
    expect(out).toEqual({
      Application_ID: "128875",
      Part_2_App_Verification_Date: "2024-12-01",
      Inverter_Size_kW_AC: "7.5",
    });
  });

  it("converts null values inside JSON to empty string (parser-safe)", () => {
    const out = parseRawRowJson(
      JSON.stringify({ Application_ID: "X", optional: null })
    );
    expect(out).toEqual({ Application_ID: "X", optional: "" });
  });
});

describe("parseArgs", () => {
  it("defaults dry-run off and pageSize 500", () => {
    const opts = parseArgs([]);
    expect(opts.dryRun).toBe(false);
    expect(opts.scopeId).toBeNull();
    expect(opts.datasetKey).toBeNull();
    expect(opts.batchId).toBeNull();
    expect(opts.pageSize).toBe(500);
  });

  it("parses --dry-run", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("parses --scope <id>", () => {
    expect(parseArgs(["--scope", "scope-X"]).scopeId).toBe("scope-X");
  });

  it("parses --dataset <key>", () => {
    expect(parseArgs(["--dataset", "abpReport"]).datasetKey).toBe("abpReport");
  });

  it("parses --batch <batchId>", () => {
    // Targeted backfill: limit to one import batch (typically the
    // active one read by slim summary + dashboard tabs). Lets a
    // multi-hour scan over 273k+ rows shrink to a 10-50 min run on
    // the active 32k.
    expect(parseArgs(["--batch", "abc123"]).batchId).toBe("abc123");
  });

  it("composes --scope + --batch + --dataset together", () => {
    // Realistic operator invocation: pin the backfill to the
    // active batch of one dataset in one scope.
    const opts = parseArgs([
      "--scope",
      "scope-user-1",
      "--dataset",
      "solarApplications",
      "--batch",
      "active-batch-id",
    ]);
    expect(opts.scopeId).toBe("scope-user-1");
    expect(opts.datasetKey).toBe("solarApplications");
    expect(opts.batchId).toBe("active-batch-id");
  });

  it("parses --page-size <n>", () => {
    expect(parseArgs(["--page-size", "1000"]).pageSize).toBe(1000);
  });

  it("ignores invalid --page-size values (keeps default 500)", () => {
    expect(parseArgs(["--page-size", "abc"]).pageSize).toBe(500);
    expect(parseArgs(["--page-size", "-5"]).pageSize).toBe(500);
    expect(parseArgs(["--page-size", "0"]).pageSize).toBe(500);
  });
});
