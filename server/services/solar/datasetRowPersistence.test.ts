import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAccountSolarGenerationStoredRowKey,
  buildAppendRowKey,
} from "./datasetRowPersistence";

function readPersistenceSource(): string {
  return readFileSync(
    new URL("./datasetRowPersistence.ts", import.meta.url),
    "utf8"
  );
}

describe("buildAppendRowKey", () => {
  it("uses the CSG portal kWh/Btu meter-read header for Account Solar Generation", () => {
    const key = buildAppendRowKey("accountSolarGeneration", {
      "GATS Gen ID": "NON305284",
      "Facility Name": "Bruce Thompson - 26157",
      "Month of Generation": "03/01/2026",
      "Last Meter Read Date": "04/01/2026",
      "Meter ID": "1",
      "Last Meter Read (kWh/Btu)": "66,988",
    });

    expect(key).toBe(
      "non305284|bruce thompson - 26157|03/01/2026|04/01/2026|1|66,988"
    );
  });

  it("keeps distinct two-meter rows distinct even when the legacy kWh header is absent", () => {
    const first = buildAppendRowKey("accountSolarGeneration", {
      "GATS Gen ID": "NON305284",
      "Facility Name": "Bruce Thompson - 26157",
      "Month of Generation": "03/01/2026",
      "Last Meter Read Date": "04/01/2026",
      "Meter ID": "1",
      "Last Meter Read (kWh/Btu)": "66,988",
    });
    const second = buildAppendRowKey("accountSolarGeneration", {
      "GATS Gen ID": "NON305284",
      "Facility Name": "Bruce Thompson - 26157",
      "Month of Generation": "03/01/2026",
      "Last Meter Read Date": "04/01/2026",
      "Meter ID": "2",
      "Last Meter Read (kWh/Btu)": "68,783",
    });

    expect(first).not.toBe(second);
  });

  it("matches Account Solar Generation camel and snake headers without blanking the key", () => {
    const key = buildAppendRowKey("accountSolarGeneration", {
      gats_gen_id: "NON305284",
      facilityName: "Bruce Thompson - 26157",
      month_of_generation: "03/01/2026",
      lastMeterReadDate: "04/01/2026",
      meter_id: "1",
      lastMeterReadKwh: "66,988",
    });

    expect(key).toBe(
      "non305284|bruce thompson - 26157|03/01/2026|04/01/2026|1|66,988"
    );
  });

  it("keeps Account Solar Generation rows distinct by meter id", () => {
    const first = buildAppendRowKey("accountSolarGeneration", {
      "GATS Gen ID": "NON305284",
      "Facility Name": "Bruce Thompson - 26157",
      "Month of Generation": "03/01/2026",
      "Last Meter Read Date": "04/01/2026",
      "Meter ID": "1",
      "Last Meter Read (kWh/Btu)": "66,988",
    });
    const second = buildAppendRowKey("accountSolarGeneration", {
      "GATS Gen ID": "NON305284",
      "Facility Name": "Bruce Thompson - 26157",
      "Month of Generation": "03/01/2026",
      "Last Meter Read Date": "04/01/2026",
      "Meter ID": "2",
      "Last Meter Read (kWh/Btu)": "66,988",
    });

    expect(first).not.toBe(second);
  });

  // 2026-05-10 — regression-pin for the typed-col-vs-rawRow
  // dedup-divergence bug fixed by PR #549.
  //
  // Pre-fix this test asserted the OPPOSITE: the stored key
  // matched the upload key even when typed `lastMeterReadKwh`
  // was null (because the stored-key builder fell back to rawRow
  // for the meter-read value). That fallback was the bug — it made
  // re-uploads of fresh data dedup-skip against legacy null-typed-
  // col rows, leaving the typed column null forever and the
  // aggregator (which only reads typed cols) blank-blind forever.
  //
  // Post-fix `lastMeterReadKwh` reads ONLY the typed column on the
  // stored side. A row with null typed col + populated rawRow
  // intentionally produces a DIFFERENT key from a row with
  // populated typed col, so a fresh re-upload's row lands as a new
  // insert (not dedup-skipped) and compaction picks the typed-
  // populated keeper by `lastMeterReadDate` + `createdAt`.
  it("REGRESSION: stored key differs from upload key when typed lastMeterReadKwh is null (no rawRow fallback)", () => {
    const uploadKey = buildAppendRowKey("accountSolarGeneration", {
      gats_gen_id: "NON305284",
      facilityName: "Bruce Thompson - 26157",
      month_of_generation: "03/01/2026",
      lastMeterReadDate: "04/01/2026",
      "meter id": "2",
      last_meter_read_kwh: "68,783",
    });
    const storedKey = buildAccountSolarGenerationStoredRowKey({
      gatsGenId: "NON305284",
      facilityName: "Bruce Thompson - 26157",
      monthOfGeneration: "03/01/2026",
      lastMeterReadDate: "04/01/2026",
      lastMeterReadKwh: null, // <-- the legacy bug shape
      rawRow: JSON.stringify({
        "meter id": "2",
        last_meter_read_kwh: "68,783",
      }),
    });

    // Different keys: upload key has the populated meter-read,
    // stored key has empty (typed col is null). These rows are
    // intentionally not deduped — both will land, compaction
    // picks newest.
    expect(storedKey).not.toBe(uploadKey);
    expect(uploadKey).toContain("|68,783");
    // Stored key ends with empty meter-read-kwh part because the
    // typed column was null and we no longer fall back to rawRow
    // for that field.
    expect(storedKey.endsWith("|")).toBe(true);
    // The meter-id segment IS still derived from rawRow (necessary
    // because there's no `meterId` typed column on the schema).
    // That fallback is safe — the aggregator never reads meterId
    // for value computation.
    expect(storedKey).toContain("|2|");
  });

  it("stored key matches upload key when typed lastMeterReadKwh is populated (post-backfill / fresh-upload state)", () => {
    const uploadKey = buildAppendRowKey("accountSolarGeneration", {
      gats_gen_id: "NON305284",
      facilityName: "Bruce Thompson - 26157",
      month_of_generation: "03/01/2026",
      lastMeterReadDate: "04/01/2026",
      "Meter ID": "2",
      "Last Meter Read (kWh/Btu)": "68,783",
    });
    const storedKey = buildAccountSolarGenerationStoredRowKey({
      gatsGenId: "NON305284",
      facilityName: "Bruce Thompson - 26157",
      monthOfGeneration: "03/01/2026",
      lastMeterReadDate: "04/01/2026",
      lastMeterReadKwh: "68,783", // <-- typed column populated
      rawRow: JSON.stringify({
        "Meter ID": "2",
        "Last Meter Read (kWh/Btu)": "68,783",
      }),
    });

    expect(storedKey).toBe(uploadKey);
    expect(storedKey).toContain("|2|68,783");
  });

  // Belt-and-braces: even if a future ingest path leaves rawRow
  // with a *different* meter-read value than the typed column,
  // the dedup key reflects the typed column only (the canonical
  // value the aggregator reads). Without this invariant, a stale
  // rawRow field could silently flip the dedup behavior.
  it("dedup key uses typed lastMeterReadKwh even when rawRow disagrees", () => {
    const storedKey = buildAccountSolarGenerationStoredRowKey({
      gatsGenId: "NON305284",
      facilityName: "Bruce Thompson - 26157",
      monthOfGeneration: "03/01/2026",
      lastMeterReadDate: "04/01/2026",
      lastMeterReadKwh: "70,000", // typed col is the truth
      rawRow: JSON.stringify({
        "Meter ID": "2",
        "Last Meter Read (kWh/Btu)": "68,783", // rawRow has stale value
      }),
    });
    expect(storedKey).toContain("|70,000");
    expect(storedKey).not.toContain("|68,783");
  });

  it("matches Converted Reads title-case headers accepted by the parser", () => {
    const key = buildAppendRowKey("convertedReads", {
      Monitoring: "eGauge",
      "Monitoring System ID": "EG-1",
      "Monitoring System Name": "North Roof",
      "Lifetime Meter Read Wh": "1,234,000",
      "Read Date": "2026-05-01",
    });

    expect(key).toBe("egauge|eg-1|north roof|1234000|2026-05-01");
    expect(key).not.toBe("||||");
  });

  it("matches Transfer History Txn ID as the canonical key", () => {
    const key = buildAppendRowKey("transferHistory", {
      "Txn ID": "TX-123",
      "Completion Date": "3/7/26 3:48",
      Qty: "12",
    });

    expect(key).toBe("tx:tx-123");
  });

  it("matches Transfer History fallback aliases when transaction id is absent", () => {
    const key = buildAppendRowKey("transferHistory", {
      "GATS Unit ID": "NON305284",
      "Completion Date": "3/7/26 3:48",
      Qty: "12",
    });

    expect(key).toBe("non305284|3/7/26 3:48|12");
  });
});

// 2026-05-13 — regression rails for the append-mode batch cloners.
//
// Pre-fix `cloneTransferHistoryBatch` (and `cloneAccountSolarGenerationBatch`)
// issued a single `INSERT INTO ... SELECT FROM <self>` against the
// source batch. On prod scope-user-1 the transferHistory active
// batch holds ~649k rows; the single statement exceeded TiDB's
// default `txn-total-size-limit` (100 MB) and surfaced as a generic
// Drizzle `Failed query` with no further context.
//
// `cloneConvertedReadsBatch` had ALREADY been paginated (cursor +
// LIMIT APPEND_PREP_PAGE_SIZE) for exactly this reason — its
// convertedReads active batch holds ~1.58M rows on the same scope
// and would have hit the same wall. The post-fix transferHistory
// and accountSolarGen cloners mirror that cursor-paged pattern.
//
// Post the 2026-05-13 `makeBatchCloner` factory extraction the
// 3 cloners are thin call sites that share one paginated body.
// These rails assert (a) the factory body itself still emits the
// id-cursor + LIMIT idiom and (b) every cloner call site routes
// through the factory with the canonical `tableName` + `retryLabel`
// — a future refactor that quietly collapses any cloner back to a
// single statement, or that adds a new bypass cloner, will fail
// here before it can ship.
describe("batch-row cloners — pagination rails", () => {
  it("all three append-mode cloners route through the makeBatchCloner factory", () => {
    const src = readPersistenceSource();

    // The factory itself must exist and be the only producer of
    // paginated cloners. (A future regression that hand-rolls a
    // bypass cloner would not appear here.)
    expect(src).toContain("function makeBatchCloner(");

    // Each cloner's tableName must appear as a `tableName:` factory
    // arg — pins the per-dataset call sites against accidental
    // deletion.
    expect(src).toMatch(/tableName:\s*"srDsTransferHistory"/);
    expect(src).toMatch(/tableName:\s*"srDsAccountSolarGeneration"/);
    expect(src).toMatch(/tableName:\s*"srDsConvertedReads"/);

    // Each cloner's retryLabel substring must appear as a
    // `retryLabel:` factory arg — together with the factory's
    // `\`page ${retryLabel} clone ids\`` / `\`clone ${retryLabel}
    // batch page\`` template literals, this guarantees the compiled
    // `withDbRetry` label substrings (`page transfer history clone
    // ids`, etc.) still flow through to retry-log output.
    expect(src).toMatch(/retryLabel:\s*"transfer history"/);
    expect(src).toMatch(/retryLabel:\s*"account solar generation"/);
    expect(src).toMatch(/retryLabel:\s*"converted reads"/);

    // The factory body wires the retryLabel into both retry labels.
    expect(src).toContain("`page ${retryLabel} clone ids`");
    expect(src).toContain("`clone ${retryLabel} batch page`");
  });

  it("makeBatchCloner emits an INSERT...SELECT page-bounded by 'AND id <='", () => {
    const src = readPersistenceSource();

    // Find the makeBatchCloner function body. Its INSERT block is
    // the only paginated cloner emitter in this file post-factory
    // extraction.
    const factoryStart = src.indexOf("function makeBatchCloner(");
    expect(
      factoryStart,
      "makeBatchCloner factory must exist in datasetRowPersistence.ts"
    ).toBeGreaterThan(-1);

    // Slice from the factory definition to the next top-level
    // `const ` declaration (the first factory call site). That
    // window contains the factory body.
    const tail = src.slice(factoryStart);
    const factoryEnd = tail.indexOf("\nconst ");
    expect(
      factoryEnd,
      "expected to find a const declaration after the factory body"
    ).toBeGreaterThan(-1);
    const factoryBody = tail.slice(0, factoryEnd);

    // The paginated SELECT must use APPEND_PREP_PAGE_SIZE.
    expect(factoryBody).toContain("APPEND_PREP_PAGE_SIZE");
    // The INSERT...SELECT inside the factory body must be page-
    // bounded — `AND id <= ${chunkEndId}` is the load-bearing
    // upper bound that keeps each transaction under TiDB's
    // `txn-total-size-limit`. A future refactor that drops this
    // predicate would reintroduce the production failure mode.
    expect(factoryBody).toMatch(/INSERT INTO \$\{table\}/);
    expect(factoryBody).toMatch(/AND id <= \$\{chunkEndId\}/);
  });

  it("no append-mode cloner uses a hand-rolled INSERT...SELECT against its self table", () => {
    const src = readPersistenceSource();

    // The pre-factory shape: a literal `INSERT INTO srDs...` text
    // (i.e. a hand-rolled SQL string targeting one of the 3
    // append-mode tables). After the factory extraction the only
    // INSERTs to these tables come from `INSERT INTO ${table}`
    // inside `makeBatchCloner`. If a future PR adds a hand-rolled
    // bypass cloner against one of these tables, this rail catches
    // it before merge.
    for (const table of [
      "srDsTransferHistory",
      "srDsAccountSolarGeneration",
      "srDsConvertedReads",
    ]) {
      expect(
        src,
        `bare 'INSERT INTO ${table}' string would indicate a hand-rolled bypass cloner — route through makeBatchCloner instead`
      ).not.toMatch(new RegExp(`INSERT INTO ${table}\\b`));
    }
  });
});
