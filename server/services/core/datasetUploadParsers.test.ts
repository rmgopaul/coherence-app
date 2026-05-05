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
    expect(
      pickField({ id: "", systemId: "fallback" }, ["id", "systemId"])
    ).toBe("fallback");
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

  // ── Separator normalization (post 2026-05-04 prod regression) ──
  //
  // Real-world prod CSVs from CSG, GATS, and ABP use snake_case
  // headers like `Part_2_App_Verification_Date` and
  // `Inverter_Size_kW_AC`. Pre-fix, every parser had to enumerate
  // the underscore form explicitly in its alias chain, and the
  // v2 upload pipeline shipped with chains that listed only the
  // space-separated form ("Part 2 App Verification Date"). 28k+
  // ABP rows landed with `part2AppVerificationDate=null` because
  // the underscore form silently failed to match. Foundation reads
  // the typed column, not rawRow, so every downstream tile
  // collapsed to zero. Normalizing separators (`_`, ` `, `-`) at
  // the lookup site makes the alias list a list of *concepts*
  // rather than every possible CSV spelling.
  describe("header separator normalization", () => {
    it("matches snake_case CSV header against space-separated alias", () => {
      expect(
        pickField({ Part_2_App_Verification_Date: "2024-12-01" }, [
          "Part 2 App Verification Date",
        ])
      ).toBe("2024-12-01");
    });

    it("matches Title_Case_Underscore CSV against camelCase alias", () => {
      expect(
        pickField({ Inverter_Size_kW_AC: "7.5" }, ["inverterSizeKwAc"])
      ).toBe("7.5");
    });

    it("matches snake_case CSV against snake_case alias (degenerate stays passing)", () => {
      expect(
        pickField({ state_certification_number: "X123" }, [
          "state_certification_number",
        ])
      ).toBe("X123");
    });

    it("matches space-separated CSV header against snake_case alias", () => {
      expect(pickField({ "Project Name": "Acme" }, ["project_name"])).toBe(
        "Acme"
      );
    });

    it("matches hyphenated CSV header against snake_case alias", () => {
      expect(
        pickField({ "contracted-date": "2026-04-01" }, ["contracted_date"])
      ).toBe("2026-04-01");
    });

    it("regression: ABP Report Part_2 column resolves with space-form alias", () => {
      // The actual prod row that was silently failing pre-fix.
      const row = {
        Application_ID: "128875",
        Project_Name: "Daniel Berry",
        Part_2_App_Verification_Date: "2024-12-01 17:32:11.566",
        Inverter_Size_kW_AC: "7.5",
      };
      expect(
        pickField(row, [
          "part2AppVerificationDate",
          "Part 2 App Verification Date",
          "Part 2 Verification Date",
        ])
      ).toBe("2024-12-01 17:32:11.566");
      expect(pickField(row, ["inverterSizeKwAc", "Inverter Size kW AC"])).toBe(
        "7.5"
      );
    });
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
    expect(getDatasetParser("contractedDate")).not.toBeNull();
  });

  it("returns a parser for every dataset that supports CSV upload", () => {
    // After Phase 4: every key returns a parser EXCEPT
    // `deliveryScheduleBase`, which is populated by the Schedule
    // B PDF scanner on the Delivery Tracker tab — not a direct
    // CSV upload.
    for (const key of DATASET_KEYS) {
      const parser = getDatasetParser(key);
      if (key === "deliveryScheduleBase") {
        expect(parser).toBeNull();
      } else {
        expect(parser).not.toBeNull();
      }
    }
  });

  it("returns null for unknown keys", () => {
    expect(getDatasetParser("notADataset")).toBeNull();
    expect(getDatasetParser("")).toBeNull();
  });
});

describe("listImplementedDatasetParsers", () => {
  it("returns 17 of 18 dataset keys (all but deliveryScheduleBase)", () => {
    const list = listImplementedDatasetParsers();
    expect(list).toHaveLength(17);
    expect(list).not.toContain("deliveryScheduleBase");
    expect(list).toContain("contractedDate");
    expect(list).toContain("solarApplications");
    expect(list).toContain("abpReport");
  });

  it("only returns DatasetKey values", () => {
    const known = new Set(DATASET_KEYS);
    for (const key of listImplementedDatasetParsers()) {
      expect(known.has(key)).toBe(true);
    }
  });
});

// ── Phase 4 — sample-row coverage for each parser ──────────────────
//
// One happy-path test per parser, plus the blank-row skip + the
// missing-required-field error for the parsers that gate on a
// required field. The full per-parser column matrix lives in the
// schema; this suite is the wire-vocabulary sanity check.
import {
  ABP_CSG_PORTAL_DATABASE_ROWS_PARSER,
  ABP_CSG_SYSTEM_MAPPING_PARSER,
  ABP_ICC_REPORT_2_ROWS_PARSER,
  ABP_ICC_REPORT_3_ROWS_PARSER,
  ABP_PORTAL_INVOICE_MAP_ROWS_PARSER,
  ABP_PROJECT_APPLICATION_ROWS_PARSER,
  ABP_QUICK_BOOKS_ROWS_PARSER,
  ABP_REPORT_PARSER,
  ABP_UTILITY_INVOICE_ROWS_PARSER,
  ACCOUNT_SOLAR_GENERATION_PARSER,
  ANNUAL_PRODUCTION_ESTIMATES_PARSER,
  CONVERTED_READS_PARSER,
  GENERATION_ENTRY_PARSER,
  GENERATOR_DETAILS_PARSER,
  pickNumber,
  SOLAR_APPLICATIONS_PARSER,
  TRANSFER_HISTORY_PARSER,
} from "./datasetUploadParsers";

const baseCtx = { scopeId: "scope-1", batchId: "batch-1", rowIndex: 0 };

describe("pickNumber", () => {
  it("parses plain numbers", () => {
    expect(pickNumber({ x: "42" }, ["x"])).toBe(42);
    expect(pickNumber({ x: "-3.14" }, ["x"])).toBe(-3.14);
  });

  it("strips $ and , formatting", () => {
    expect(pickNumber({ amount: "$1,234.56" }, ["amount"])).toBe(1234.56);
    expect(pickNumber({ amount: "  1 000.5  " }, ["amount"])).toBe(1000.5);
  });

  it("returns null on non-numeric or missing values", () => {
    expect(pickNumber({ x: "abc" }, ["x"])).toBeNull();
    expect(pickNumber({}, ["x"])).toBeNull();
    expect(pickNumber({ x: "" }, ["x"])).toBeNull();
  });
});

describe("SOLAR_APPLICATIONS_PARSER", () => {
  it("parses canonical headers + numeric coercion", () => {
    const out = SOLAR_APPLICATIONS_PARSER.parseRow(
      {
        applicationId: "APP-1",
        systemId: "SYS-1",
        trackingSystemRefId: "GATS-1",
        "Installed kW AC": "12.5",
        "REC Price": "$120.00",
        "Annual RECs": "10",
        installerName: "Acme",
        zipCode: "60601",
      },
      baseCtx
    );
    expect(out!.applicationId).toBe("APP-1");
    expect(out!.systemId).toBe("SYS-1");
    expect(out!.installedKwAc).toBe(12.5);
    expect(out!.recPrice).toBe(120);
    expect(out!.annualRecs).toBe(10);
    expect(out!.zipCode).toBe("60601");
    expect(out!.installerName).toBe("Acme");
    // rawRow always carries the full source row.
    const rawParsed = JSON.parse(out!.rawRow!);
    expect(rawParsed.installerName).toBe("Acme");
  });

  it("parses CSG portal-style snake_case Solar Applications headers", () => {
    const out = SOLAR_APPLICATIONS_PARSER.parseRow(
      {
        system_id: "113639",
        system_name: "Portal Site",
        tracking_system_ref_id: "NON447861",
        installed_system_size_kw_ac: "15",
        installed_system_size_kw_dc: "18.4",
        total_contract_amount: "$25,664.73",
        contract_type: "IL ABP",
        "partnerCompany.name": "Portal Installer",
        system_county: "Boone",
        system_state: "IL",
        system_zip: "61065",
      },
      baseCtx
    );

    expect(out!.systemId).toBe("113639");
    expect(out!.systemName).toBe("Portal Site");
    expect(out!.trackingSystemRefId).toBe("NON447861");
    expect(out!.installedKwAc).toBe(15);
    expect(out!.installedKwDc).toBe(18.4);
    expect(out!.totalContractAmount).toBe(25664.73);
    expect(out!.contractType).toBe("IL ABP");
    expect(out!.installerName).toBe("Portal Installer");
    expect(out!.county).toBe("Boone");
    expect(out!.state).toBe("IL");
    expect(out!.zipCode).toBe("61065");
  });

  it("returns null for blank rows", () => {
    expect(SOLAR_APPLICATIONS_PARSER.parseRow({}, baseCtx)).toBeNull();
  });
});

describe("ABP_REPORT_PARSER", () => {
  it("parses application-level fields", () => {
    const out = ABP_REPORT_PARSER.parseRow(
      {
        "Application ID": "APP-9",
        projectName: "Sunny Acres",
        "Inverter Size kW AC": "8.2",
      },
      baseCtx
    );
    expect(out!.applicationId).toBe("APP-9");
    expect(out!.projectName).toBe("Sunny Acres");
    expect(out!.inverterSizeKwAc).toBe(8.2);
  });

  it("parses Part II ABP inverter size headers", () => {
    const out = ABP_REPORT_PARSER.parseRow(
      {
        Application_ID: "APP-9",
        Project_Name: "Sunny Acres",
        Inverter_Size_kW_AC_Part_2: "7.6",
      },
      baseCtx
    );

    expect(out!.applicationId).toBe("APP-9");
    expect(out!.projectName).toBe("Sunny Acres");
    expect(out!.inverterSizeKwAc).toBe(7.6);
  });

  it("returns null for empty rows", () => {
    expect(ABP_REPORT_PARSER.parseRow({}, baseCtx)).toBeNull();
  });
});

describe("GENERATION_ENTRY_PARSER", () => {
  it("parses unit + monitoring fields", () => {
    const out = GENERATION_ENTRY_PARSER.parseRow(
      {
        "Unit ID": "U-1",
        "Facility Name": "Site A",
        onlineMonitoring: "enphaseV4",
        "Monitoring System ID": "1234",
      },
      baseCtx
    );
    expect(out!.unitId).toBe("U-1");
    expect(out!.facilityName).toBe("Site A");
    expect(out!.onlineMonitoring).toBe("enphaseV4");
    expect(out!.onlineMonitoringSystemId).toBe("1234");
  });
});

describe("ACCOUNT_SOLAR_GENERATION_PARSER", () => {
  it("parses GATS gen + month of generation", () => {
    const out = ACCOUNT_SOLAR_GENERATION_PARSER.parseRow(
      {
        "GATS Gen ID": "GEN-1",
        "Facility Name": "Site B",
        "Month of Generation": "2026-04",
        "Last Meter Read kWh": "12345",
      },
      baseCtx
    );
    expect(out!.gatsGenId).toBe("GEN-1");
    expect(out!.facilityName).toBe("Site B");
    expect(out!.monthOfGeneration).toBe("2026-04");
    expect(out!.lastMeterReadKwh).toBe("12345");
  });
});

describe("CONVERTED_READS_PARSER", () => {
  it("parses monitoring + meter-read fields", () => {
    const out = CONVERTED_READS_PARSER.parseRow(
      {
        monitoring: "solaredge",
        monitoring_system_id: "siteA",
        monitoring_system_name: "Site A",
        lifetime_meter_read_wh: "1500000",
        read_date: "2026-04-01",
      },
      baseCtx
    );
    expect(out!.monitoring).toBe("solaredge");
    expect(out!.monitoringSystemId).toBe("siteA");
    expect(out!.lifetimeMeterReadWh).toBe(1500000);
    expect(out!.readDate).toBe("2026-04-01");
  });
});

describe("ANNUAL_PRODUCTION_ESTIMATES_PARSER", () => {
  it("parses 12 month columns into typed doubles", () => {
    const out = ANNUAL_PRODUCTION_ESTIMATES_PARSER.parseRow(
      {
        "Unit ID": "U-1",
        Jan: "100",
        Feb: "110",
        Mar: "120",
        Apr: "130",
        May: "140",
        Jun: "150",
        Jul: "160",
        Aug: "170",
        Sep: "180",
        Oct: "190",
        Nov: "200",
        Dec: "210",
      },
      baseCtx
    );
    expect(out!.unitId).toBe("U-1");
    expect(out!.jan).toBe(100);
    expect(out!.feb).toBe(110);
    // The schema column is named `decMonth` because `dec` is reserved
    // in some MySQL versions.
    expect(out!.decMonth).toBe(210);
  });
});

describe("GENERATOR_DETAILS_PARSER", () => {
  it("parses gats + date online", () => {
    const out = GENERATOR_DETAILS_PARSER.parseRow(
      { "GATS Unit ID": "U-1", "Date Online": "2024-01-15" },
      baseCtx
    );
    expect(out!.gatsUnitId).toBe("U-1");
    expect(out!.dateOnline).toBe("2024-01-15");
  });
});

describe("ABP_UTILITY_INVOICE_ROWS_PARSER", () => {
  it("requires a systemId", () => {
    expect(ABP_UTILITY_INVOICE_ROWS_PARSER.parseRow({}, baseCtx)).toBeNull();
    const out = ABP_UTILITY_INVOICE_ROWS_PARSER.parseRow(
      { "System ID": "SYS-1", paymentNumber: "5" },
      baseCtx
    );
    expect(out!.systemId).toBe("SYS-1");
    // paymentNumber is not a typed column — survives in rawRow.
    expect(JSON.parse(out!.rawRow!).paymentNumber).toBe("5");
  });
});

describe("ABP_CSG_SYSTEM_MAPPING_PARSER", () => {
  it("parses csgId + systemId", () => {
    const out = ABP_CSG_SYSTEM_MAPPING_PARSER.parseRow(
      { "CSG ID": "CSG-1", "System ID": "SYS-1" },
      baseCtx
    );
    expect(out!.csgId).toBe("CSG-1");
    expect(out!.systemId).toBe("SYS-1");
  });
});

describe("ABP_QUICK_BOOKS_ROWS_PARSER", () => {
  it("parses invoiceNumber from QuickBooks `Num` header", () => {
    const out = ABP_QUICK_BOOKS_ROWS_PARSER.parseRow(
      { Num: "INV-100", description: "REC payment" },
      baseCtx
    );
    expect(out!.invoiceNumber).toBe("INV-100");
  });

  it("requires invoiceNumber", () => {
    expect(ABP_QUICK_BOOKS_ROWS_PARSER.parseRow({}, baseCtx)).toBeNull();
  });
});

describe("ABP_PROJECT_APPLICATION_ROWS_PARSER", () => {
  it("requires applicationId", () => {
    expect(
      ABP_PROJECT_APPLICATION_ROWS_PARSER.parseRow({}, baseCtx)
    ).toBeNull();
    const out = ABP_PROJECT_APPLICATION_ROWS_PARSER.parseRow(
      {
        "Application ID": "APP-1",
        "Part 1 Submission Date": "2024-03-01",
      },
      baseCtx
    );
    expect(out!.applicationId).toBe("APP-1");
    expect(out!.part1SubmissionDate).toBe("2024-03-01");
  });
});

describe("ABP_PORTAL_INVOICE_MAP_ROWS_PARSER", () => {
  it("parses csgId + invoiceNumber", () => {
    const out = ABP_PORTAL_INVOICE_MAP_ROWS_PARSER.parseRow(
      { "CSG ID": "CSG-1", "Invoice Number": "INV-1" },
      baseCtx
    );
    expect(out!.csgId).toBe("CSG-1");
    expect(out!.invoiceNumber).toBe("INV-1");
  });
});

describe("ABP_CSG_PORTAL_DATABASE_ROWS_PARSER", () => {
  it("parses systemId + csgId", () => {
    const out = ABP_CSG_PORTAL_DATABASE_ROWS_PARSER.parseRow(
      { systemId: "SYS-1", csgId: "CSG-1" },
      baseCtx
    );
    expect(out!.systemId).toBe("SYS-1");
    expect(out!.csgId).toBe("CSG-1");
  });
});

describe("ABP_ICC_REPORT_2_ROWS_PARSER", () => {
  it("requires applicationId", () => {
    expect(ABP_ICC_REPORT_2_ROWS_PARSER.parseRow({}, baseCtx)).toBeNull();
    const out = ABP_ICC_REPORT_2_ROWS_PARSER.parseRow(
      { "Application ID": "APP-2" },
      baseCtx
    );
    expect(out!.applicationId).toBe("APP-2");
  });
});

describe("ABP_ICC_REPORT_3_ROWS_PARSER", () => {
  it("requires applicationId", () => {
    expect(ABP_ICC_REPORT_3_ROWS_PARSER.parseRow({}, baseCtx)).toBeNull();
    const out = ABP_ICC_REPORT_3_ROWS_PARSER.parseRow(
      { "Application ID": "APP-3" },
      baseCtx
    );
    expect(out!.applicationId).toBe("APP-3");
  });
});

describe("TRANSFER_HISTORY_PARSER", () => {
  it("parses transactionId + transferor/transferee + quantity", () => {
    const out = TRANSFER_HISTORY_PARSER.parseRow(
      {
        "Transaction ID": "TXN-1",
        "Unit ID": "U-1",
        "Completion Date": "2026-04-01",
        Quantity: "1000",
        Transferor: "Alpha",
        Transferee: "Beta",
      },
      baseCtx
    );
    expect(out!.transactionId).toBe("TXN-1");
    expect(out!.unitId).toBe("U-1");
    expect(out!.transferCompletionDate).toBe("2026-04-01");
    expect(out!.quantity).toBe(1000);
    expect(out!.transferor).toBe("Alpha");
    expect(out!.transferee).toBe("Beta");
  });
});
