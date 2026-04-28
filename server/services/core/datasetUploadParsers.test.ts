/**
 * Tests for the per-dataset parser registry — Phase 1 of the
 * server-side dashboard refactor.
 *
 * Pure tests: no DB, no fixtures larger than a few rows. The
 * registry's `null` entries (not-yet-implemented Phase 4 datasets)
 * get a smoke check so that adding a parser later won't silently
 * skip wiring it through `getDatasetParser`.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACTED_DATE_PARSER,
  getDatasetParser,
  listImplementedDatasetParsers,
  pickField,
} from "./datasetUploadParsers";
import { DATASET_KEYS } from "../../../shared/datasetUpload.helpers";

describe("pickField", () => {
  it("returns the first matching alias's value", () => {
    expect(pickField({ id: "abc" }, ["id", "systemId"])).toBe("abc");
    expect(pickField({ systemId: "abc" }, ["id", "systemId"])).toBe("abc");
  });

  it("trims whitespace", () => {
    expect(pickField({ id: "  abc  " }, ["id"])).toBe("abc");
  });

  it("treats empty / whitespace-only values as missing", () => {
    expect(pickField({ id: "" }, ["id", "systemId"])).toBeNull();
    expect(pickField({ id: "   " }, ["id"])).toBeNull();
  });

  it("falls through to the next alias when the first is empty", () => {
    expect(pickField({ id: "", systemId: "fallback" }, ["id", "systemId"])).toBe(
      "fallback"
    );
  });

  it("matches case-insensitively on the second-pass scan", () => {
    expect(pickField({ "CSG ID": "x" }, ["csg id"])).toBe("x");
    expect(pickField({ SystemId: "x" }, ["systemId"])).toBe("x");
  });

  it("returns null when no alias matches", () => {
    expect(pickField({ foo: "bar" }, ["id", "name"])).toBeNull();
  });

  it("returns null on empty alias list", () => {
    expect(pickField({ id: "abc" }, [])).toBeNull();
  });
});

describe("CONTRACTED_DATE_PARSER", () => {
  const ctx = { scopeId: "scope-1", batchId: "batch-1", rowIndex: 0 };

  it("parses the canonical {id, contracted} shape", () => {
    const row = { id: "csg-123", contracted: "2026-04-01" };
    const result = CONTRACTED_DATE_PARSER.parseRow(row, ctx);
    expect(result).not.toBeNull();
    expect(result!.systemId).toBe("csg-123");
    expect(result!.contractedDate).toBe("2026-04-01");
    expect(result!.scopeId).toBe("scope-1");
    expect(result!.batchId).toBe("batch-1");
    expect(result!.id).toBeTruthy();
    expect(result!.createdAt).toBeInstanceOf(Date);
  });

  it("accepts the systemId alias", () => {
    const row = { systemId: "csg-456", contractedDate: "2026-04-02" };
    const result = CONTRACTED_DATE_PARSER.parseRow(row, ctx);
    expect(result!.systemId).toBe("csg-456");
    expect(result!.contractedDate).toBe("2026-04-02");
  });

  it("accepts the CSG ID + ContractedDate header variants", () => {
    const row = { "CSG ID": "csg-789", ContractedDate: "2026-04-03" };
    const result = CONTRACTED_DATE_PARSER.parseRow(row, ctx);
    expect(result!.systemId).toBe("csg-789");
    expect(result!.contractedDate).toBe("2026-04-03");
  });

  it("returns null for a fully blank row (silent skip)", () => {
    expect(CONTRACTED_DATE_PARSER.parseRow({}, ctx)).toBeNull();
    expect(
      CONTRACTED_DATE_PARSER.parseRow({ id: "", contracted: "" }, ctx)
    ).toBeNull();
  });

  it("throws on a partial row missing the systemId", () => {
    expect(() =>
      CONTRACTED_DATE_PARSER.parseRow({ contracted: "2026-04-01" }, ctx)
    ).toThrow(/missing systemId/);
  });

  it("accepts a row missing the contractedDate (it's nullable)", () => {
    // The schema's contractedDate is varchar(32) nullable — a row
    // with only systemId is valid (it asserts existence without
    // claiming a date yet). Don't reject these.
    const result = CONTRACTED_DATE_PARSER.parseRow({ id: "csg-1" }, ctx);
    expect(result!.systemId).toBe("csg-1");
    expect(result!.contractedDate).toBeNull();
  });
});

describe("getDatasetParser", () => {
  it("returns the parser for `contractedDate`", () => {
    const parser = getDatasetParser("contractedDate");
    expect(parser).not.toBeNull();
  });

  it("returns null for unimplemented (Phase 4) dataset keys", () => {
    // Whichever Phase 4 datasets remain null today — pick one
    // that's expected to be unimplemented in this PR's scope.
    expect(getDatasetParser("solarApplications")).toBeNull();
    expect(getDatasetParser("abpReport")).toBeNull();
  });

  it("returns null for unknown keys", () => {
    expect(getDatasetParser("notADataset")).toBeNull();
    expect(getDatasetParser("")).toBeNull();
  });
});

describe("listImplementedDatasetParsers", () => {
  it("includes contractedDate", () => {
    expect(listImplementedDatasetParsers()).toContain("contractedDate");
  });

  it("only returns DatasetKey values", () => {
    const known = new Set(DATASET_KEYS);
    for (const key of listImplementedDatasetParsers()) {
      expect(known.has(key)).toBe(true);
    }
  });
});
