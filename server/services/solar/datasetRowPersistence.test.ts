import { describe, expect, it } from "vitest";
import { buildAppendRowKey } from "./datasetRowPersistence";

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
