import { describe, it, expect } from "vitest";
import { __test__ } from "./dinExtractor";

const {
  normalizeDin,
  collectDinsFromText,
  extractDinsFromQrPayload,
  extractSteIds,
  DIN_REGEX,
} = __test__;

describe("normalizeDin", () => {
  it("uppercases", () => {
    expect(normalizeDin("1538000-45-a-gf2230670002nb")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });

  it("collapses multi-dash runs to single dash", () => {
    expect(normalizeDin("1538000-45-A---GF2230670002NB")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });

  it("replaces whitespace with dash and collapses", () => {
    expect(normalizeDin("1538000 45 A  GF2230670002NB")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeDin("   1538000-45-A-GF2230670002NB  ")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });

  it("handles mixed whitespace and dashes", () => {
    expect(normalizeDin("1538000 - 45 - A - - - GF2230670002NB")).toBe(
      "1538000-45-A-GF2230670002NB"
    );
  });
});

describe("collectDinsFromText", () => {
  it("returns empty array on empty input", () => {
    expect(collectDinsFromText("", "claude")).toEqual([]);
  });

  it("returns empty array when no DIN is present", () => {
    expect(
      collectDinsFromText("No device identifier here.", "claude")
    ).toEqual([]);
  });

  it("extracts a canonical DIN with triple-dash", () => {
    const matches = collectDinsFromText(
      "DIN:1538000-45-A---GF2230670002NB\nOther text",
      "claude"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].dinValue).toBe("1538000-45-A-GF2230670002NB");
    expect(matches[0].extractedBy).toBe("claude");
  });

  it("extracts multiple distinct DINs from the same text", () => {
    const matches = collectDinsFromText(
      "DIN:1538000-45-A---GF2230670002NB and DIN:1538000-46-B---AB1234567890XY",
      "tesseract"
    );
    expect(matches).toHaveLength(2);
    const values = matches.map((m) => m.dinValue).sort();
    expect(values).toEqual([
      "1538000-45-A-GF2230670002NB",
      "1538000-46-B-AB1234567890XY",
    ]);
    expect(matches.every((m) => m.extractedBy === "tesseract")).toBe(true);
  });

  it("deduplicates identical DINs within the same text", () => {
    const matches = collectDinsFromText(
      "first DIN:1538000-45-A---GF2230670002NB then DIN:1538000-45-A---GF2230670002NB again",
      "pdfjs"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].dinValue).toBe("1538000-45-A-GF2230670002NB");
  });

  it("dedupes across dash/space variants that normalize to the same value", () => {
    const matches = collectDinsFromText(
      "DIN 1538000 45 A GF2230670002NB and DIN:1538000-45-A-GF2230670002NB",
      "claude"
    );
    expect(matches).toHaveLength(1);
  });

  it("tags extractedBy from the caller-provided value", () => {
    expect(
      collectDinsFromText(
        "DIN:1538000-45-A-GF2230670002NB",
        "pdfjs"
      )[0].extractedBy
    ).toBe("pdfjs");
  });
});

describe("DIN_REGEX", () => {
  it("matches the canonical sticker format", () => {
    const re = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    const match = re.exec("DIN:1538000-45-A---GF2230670002NB end");
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("1538000-45-A---GF2230670002NB");
  });

  it("does not match plainly non-DIN strings", () => {
    const re = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    expect(re.exec("phone: 555-123-4567")).toBeNull();
    expect(re.exec("serial ABC")).toBeNull();
  });

  it("requires the alphanumeric tail to be at least 4 chars", () => {
    // Widened from 6 -> 4 in the rotation/QR pass so OCR misreads
    // of the last segment don't silently drop valid DINs; the
    // normalization + dedup layer collapses truncated variants.
    const re = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    expect(re.exec("1538000-45-A-AB")).toBeNull();
    expect(re.exec("1538000-45-A-ABCD")).not.toBeNull();
  });

  it("accepts unicode dashes (en-dash, em-dash) as segment separators", () => {
    // OCR and Claude sometimes normalize the triple-dash in
    // "A---GF22300270021L0" to an em-dash or en-dash.
    const re1 = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    expect(re1.exec("1538000–45–A–GF22300270021L0")).not.toBeNull();
    const re2 = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    expect(re2.exec("1538000—45—A—GF22300270021L0")).not.toBeNull();
  });

  it("matches case-insensitively — OCR output is often lower-case", () => {
    // The `i` flag is load-bearing. If a future change drops it, this
    // guards the lower-case happy-path that real-world OCR produces.
    const re = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
    const match = re.exec("din:1538000-45-a-gf2230670002nb");
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("1538000-45-a-gf2230670002nb");
  });
});

describe("extractDinsFromQrPayload (Tesla format)", () => {
  // Real QR payloads captured from production inverter/meter photos.
  // Tesla Gateway encodes: WiFi credentials + split (P)<part> (S)<serial>.
  const realPayloads: Array<{ payload: string; expectedDin: string }> = [
    {
      payload:
        "WIFI:T:WPA;S:TEG-2DT;P:YTRBNPWUYF; (P)1538000-45-A (S)GF2230680002DT",
      expectedDin: "1538000-45-A-GF2230680002DT",
    },
    {
      payload:
        "WIFI:T:WPA;S:TEG-26H;P:KRSLDTTZGB; (P)1538000-45-A (S)GF22306800026H",
      expectedDin: "1538000-45-A-GF22306800026H",
    },
    {
      payload:
        "WIFI:T:WPA;S:TEG-2EB;P:CXGJCCZCDT; (P)1538000-35-F (S)GF2221250002EB",
      expectedDin: "1538000-35-F-GF2221250002EB",
    },
    {
      payload:
        "WIFI:T:WPA;S:TeslaPV_8D1771;P:UBHETKXWCM; (P)1538000-00-F (S)GF2222500001LH",
      expectedDin: "1538000-00-F-GF2222500001LH",
    },
  ];

  for (const { payload, expectedDin } of realPayloads) {
    it(`reassembles DIN from "${payload.slice(0, 40)}..."`, () => {
      const matches = extractDinsFromQrPayload(payload, "qr");
      expect(matches).toHaveLength(1);
      expect(matches[0].dinValue).toBe(expectedDin);
      expect(matches[0].extractedBy).toBe("qr");
    });
  }

  it("returns empty on a payload with no DIN-like content", () => {
    expect(
      extractDinsFromQrPayload("WIFI:T:WPA;S:SomeNet;P:pass", "qr")
    ).toEqual([]);
  });

  it("falls through to the contiguous DIN regex for non-split payloads", () => {
    const matches = extractDinsFromQrPayload(
      "DIN:1538000-45-A-GF2230680002DT",
      "qr"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].dinValue).toBe("1538000-45-A-GF2230680002DT");
  });

  it("dedupes when Tesla-split and contiguous forms both match", () => {
    // Contrived but makes sure the Pass-1 + Pass-2 dedup works.
    const matches = extractDinsFromQrPayload(
      "(P)1538000-45-A (S)GF2230680002DT alsosee DIN:1538000-45-A-GF2230680002DT",
      "qr"
    );
    expect(matches).toHaveLength(1);
  });

  // ── Colon-delimited formats observed in production (meters + non-Tesla inverters) ──
  describe("colon-delimited QR payloads", () => {
    const colonPayloads: Array<{ payload: string; expectedDin: string; label: string }> = [
      {
        payload: "P1112484-14-A:D55045:NVAH5105AB2867",
        expectedDin: "1112484-14-A-NVAH5105AB2867",
        label: "Neurio meter 3-field",
      },
      {
        payload: "P1546816-00-C:1TDI921327A00328",
        expectedDin: "1546816-00-C-1TDI921327A00328",
        label: "non-Tesla inverter 2-field",
      },
      {
        payload: "P1112484-14-A:D76188:NVAH5105AB1522",
        expectedDin: "1112484-14-A-NVAH5105AB1522",
        label: "Neurio meter variant",
      },
      {
        payload: "12484-14-A:S34939:NVAH5309AB1904",
        expectedDin: "12484-14-A-NVAH5309AB1904",
        label: "P prefix dropped by decoder",
      },
    ];

    for (const { payload, expectedDin, label } of colonPayloads) {
      it(`parses ${label}: "${payload}"`, () => {
        const matches = extractDinsFromQrPayload(payload, "qr");
        expect(matches).toHaveLength(1);
        expect(matches[0].dinValue).toBe(expectedDin);
        expect(matches[0].extractedBy).toBe("qr");
      });
    }

    it("doesn't misfire on colon-like non-DIN text", () => {
      // WiFi credentials shouldn't accidentally match the colon pattern.
      expect(
        extractDinsFromQrPayload("WIFI:T:WPA;S:TEG-Foo;P:PASS12345", "qr")
      ).toEqual([]);
    });
  });
});

describe("extractSteIds (Tesla System IDs)", () => {
  it("extracts from a canonical Tesla Powerhub-app screenshot", () => {
    // Real tesseract output from site 109885's WATSON-1.jpg — the
    // only site where we've recovered an STE ID via OCR so far.
    const ocrSample =
      "D TES Lm Powerhub Q STE20230612-00205\nDiagnostics Devices\n" +
      "A STE20230612-00205\nIdentify common diagnostic issues...";
    expect(extractSteIds(ocrSample)).toEqual(["STE20230612-00205"]);
  });

  it("dedupes multiple occurrences of the same STE ID", () => {
    expect(
      extractSteIds("STE20230612-00205 and again STE20230612-00205")
    ).toEqual(["STE20230612-00205"]);
  });

  it("extracts multiple distinct STE IDs", () => {
    const matches = extractSteIds(
      "STE20230612-00205 elsewhere STE20240819-12345"
    );
    expect(new Set(matches)).toEqual(
      new Set(["STE20230612-00205", "STE20240819-12345"])
    );
  });

  it("normalizes case — tesseract sometimes returns lowercase", () => {
    expect(extractSteIds("ste20230612-00205")).toEqual(["STE20230612-00205"]);
  });

  it("returns empty for text with no STE ID", () => {
    expect(extractSteIds("no system identifier here")).toEqual([]);
  });

  it("does NOT match truncated or malformed variants", () => {
    // Must have exactly 8 digits + dash + 5 digits.
    expect(extractSteIds("STE2023-00205")).toEqual([]);
    expect(extractSteIds("STE20230612-205")).toEqual([]);
    expect(extractSteIds("STE2023061200205")).toEqual([]);
  });
});
