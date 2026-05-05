import { describe, expect, it } from "vitest";
import { buildAppendRowKey } from "./datasetRowPersistence";

describe("buildAppendRowKey", () => {
  it("uses the CSG portal kWh/Btu meter-read header for Account Solar Generation", () => {
    const key = buildAppendRowKey("accountSolarGeneration", {
      "GATS Gen ID": "NON305284",
      "Facility Name": "Bruce Thompson - 26157",
      "Month of Generation": "03/01/2026",
      "Last Meter Read Date": "04/01/2026",
      "Last Meter Read (kWh/Btu)": "66,988",
    });

    expect(key).toBe(
      "non305284|bruce thompson - 26157|03/01/2026|04/01/2026|66,988"
    );
  });

  it("keeps distinct two-meter rows distinct even when the legacy kWh header is absent", () => {
    const first = buildAppendRowKey("accountSolarGeneration", {
      "GATS Gen ID": "NON305284",
      "Facility Name": "Bruce Thompson - 26157",
      "Month of Generation": "03/01/2026",
      "Last Meter Read Date": "04/01/2026",
      "Last Meter Read (kWh/Btu)": "66,988",
    });
    const second = buildAppendRowKey("accountSolarGeneration", {
      "GATS Gen ID": "NON305284",
      "Facility Name": "Bruce Thompson - 26157",
      "Month of Generation": "03/01/2026",
      "Last Meter Read Date": "04/01/2026",
      "Last Meter Read (kWh/Btu)": "68,783",
    });

    expect(first).not.toBe(second);
  });
});
