import { describe, expect, it } from "vitest";
import { extractScheduleBDeliveryYearsFromText } from "./scheduleBScannerServer";

describe("extractScheduleBDeliveryYearsFromText", () => {
  it("parses delivery year and REC quantity pairs from flat text streams", () => {
    const text =
      "June 01, 2020 1,300.0000 kW (AC Rating) Fixed Mount System 22.110000% 0.5% " +
      "2020-2021 2,606 2021-2022 2,593 2022-2023 2,580 2023-2024 2,567 2024-2025 2,554";

    expect(extractScheduleBDeliveryYearsFromText(text)).toEqual([
      { label: "2020-2021", startYear: 2020, recQuantity: 2606 },
      { label: "2021-2022", startYear: 2021, recQuantity: 2593 },
      { label: "2022-2023", startYear: 2022, recQuantity: 2580 },
      { label: "2023-2024", startYear: 2023, recQuantity: 2567 },
      { label: "2024-2025", startYear: 2024, recQuantity: 2554 },
    ]);
  });
});
