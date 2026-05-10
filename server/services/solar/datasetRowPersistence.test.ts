import { describe, expect, it } from "vitest";
import {
  buildAccountSolarGenerationStoredRowKey,
  buildAppendRowKey,
} from "./datasetRowPersistence";

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
