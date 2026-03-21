import { describe, expect, it } from "vitest";
import {
  buildQuickBooksPaidUpfrontLedger,
  buildSettlementCsv,
  computeSettlementRows,
  parseCsgPortalDatabase,
  parseProjectApplications,
  parseQuickBooksDetailedReport,
  parseUtilityInvoiceMatrix,
  type ContractTerms,
  type InstallerSettlementRule,
  type CsgSystemIdMappingRow,
  type ProjectApplicationLiteRow,
  type QuickBooksPaidUpfrontLedger,
  type UtilityInvoiceRow,
} from "../client/src/lib/abpSettlement";

function createLedgerBySystem(input: {
  systemId: string;
  applicationFee?: number;
  utilityCollateral?: number;
  utilityCollateralReimbursement?: number;
  additionalCollateral?: number;
  ccFee?: number;
  vendorFee?: number;
}): QuickBooksPaidUpfrontLedger {
  const bySystemId = new Map([
    [
      input.systemId,
      {
        applicationFeePaidUpfront: input.applicationFee ?? 0,
        utilityCollateralPaidUpfront: input.utilityCollateral ?? 0,
        utilityCollateralReimbursementToPartnerCompanyAmount:
          input.utilityCollateralReimbursement ?? 0,
        additionalCollateralPaidUpfront: input.additionalCollateral ?? 0,
        ccFeePaidUpfront: input.ccFee ?? 0,
        vendorFeePaidUpfront: input.vendorFee ?? 0,
        matchedLines: [],
      },
    ],
  ]);

  return {
    bySystemId,
    unmatchedLines: [],
  };
}

function baseUtilityRow(input: {
  rowId: string;
  systemId: string;
  paymentNumber: number;
  invoiceAmount: number;
  recQuantity?: number;
  recPrice?: number;
}): UtilityInvoiceRow {
  return {
    rowId: input.rowId,
    sourceFile: "utility.xlsx",
    sourceSheet: "Sheet1",
    contractId: "999",
    utilityName: "ComEd",
    systemId: input.systemId,
    paymentNumber: input.paymentNumber,
    recQuantity: input.recQuantity ?? 100,
    recPrice: input.recPrice ?? 10,
    invoiceAmount: input.invoiceAmount,
    systemAddress: "",
  };
}

function baseContractTerms(csgId: string, overrides?: Partial<ContractTerms>): ContractTerms {
  return {
    csgId,
    fileName: `${csgId}.pdf`,
    vendorFeePercent: 7,
    additionalCollateralPercent: 5,
    ccAuthorizationCompleted: true,
    ccCardAsteriskCount: 4,
    recQuantity: null,
    recPrice: null,
    paymentMethod: "Check",
    payeeName: "Test Payee",
    mailingAddress1: "123 Main St",
    mailingAddress2: null,
    cityStateZip: "Chicago, IL 60601",
    city: "Chicago",
    state: "IL",
    zip: "60601",
    ...overrides,
  };
}

describe("ABP parser coverage", () => {
  it("parses utility invoice matrix and skips totals rows", () => {
    const rows = parseUtilityInvoiceMatrix(
      [
        ["ComEd Contract 123"],
        [
          "System ID",
          "Payment Number",
          "Total RECS",
          "REC Price",
          "Invoice Amount ($)",
          "System Address",
        ],
        ["1001", "1", "100", "10", "1000", "123 Main St"],
        ["1002", "2", "90", "10", "450", "456 Main St"],
        ["Total", "", "", "", "1450", ""],
      ],
      "invoice.xlsx",
      "Sheet1"
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].systemId).toBe("1001");
    expect(rows[1].systemId).toBe("1002");
    expect(rows[0].paymentNumber).toBe(1);
    expect(rows[1].invoiceAmount).toBe(450);
  });

  it("parses QuickBooks detailed report and derives cash received", () => {
    const parsed = parseQuickBooksDetailedReport({
      headers: [],
      rows: [],
      matrix: [
        ["Report", "ABP"],
        [
          "Date",
          "Num",
          "Customer",
          "Payment status",
          "Amount",
          "Open balance",
          "Product/service description",
          "Product/service amount line",
          "Line order",
        ],
        ["03/01/2026", "INV-1", "Customer A", "Paid", "100", "0", "Application Fee 1001", "60", "2"],
        ["03/01/2026", "INV-1", "Customer A", "Paid", "", "", "Utility-held collateral 1001", "40", "1"],
        ["03/02/2026", "INV-2", "Customer B", "Partially Paid", "200", "50", "Application Fee 1002", "200", "1"],
      ],
    });

    const inv1 = parsed.get("INV-1");
    const inv2 = parsed.get("INV-2");

    expect(parsed.size).toBe(2);
    expect(inv1?.cashReceived).toBe(100);
    expect(inv1?.lineItems[0].lineOrder).toBe(1);
    expect(inv2?.cashReceived).toBe(150);
  });

  it("triages reimbursed utility collateral into partner reimbursement bucket", () => {
    const ledger = buildQuickBooksPaidUpfrontLedger({
      knownSystemIds: new Set(["1001"]),
      quickBooksByInvoice: new Map([
        [
          "INV-9",
          {
            invoiceNumber: "INV-9",
            amount: 100,
            openBalance: 0,
            cashReceived: 100,
            paymentStatus: "Paid",
            voided: "",
            customer: "Partner Company",
            date: new Date("2026-03-01T00:00:00.000Z"),
            lineItems: [
              {
                lineOrder: 1,
                description: "5% ABP collateral reimbursed to installer 1001",
                productService: "",
                amount: 50,
              },
              {
                lineOrder: 2,
                description: "5% ABP collateral 1001",
                productService: "",
                amount: 50,
              },
            ],
          },
        ],
      ]),
    });

    const system = ledger.bySystemId.get("1001");
    expect(system?.utilityCollateralReimbursementToPartnerCompanyAmount).toBe(50);
    expect(system?.utilityCollateralPaidUpfront).toBe(50);
  });

  it("parses ProjectApplication rows by Application_ID", () => {
    const rows = parseProjectApplications({
      headers: [
        "Application_ID",
        "Part_1_Submission_Date",
        "Part_1_Original_Submission_Date",
        "Inverter_Size_kW_AC_Part_1",
      ],
      rows: [
        {
          Application_ID: "1001",
          Part_1_Submission_Date: "2024-05-15",
          Part_1_Original_Submission_Date: "2024-05-12",
          Inverter_Size_kW_AC_Part_1: "11.2",
        },
      ],
      matrix: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].applicationId).toBe("1001");
    expect(rows[0].inverterSizeKwAcPart1).toBe(11.2);
    expect(rows[0].part1SubmissionDate?.toISOString().slice(0, 10)).toBe("2024-05-15");
  });

  it("parses CSG portal database rows with installer and reimbursement flag", () => {
    const rows = parseCsgPortalDatabase({
      headers: [
        "System ID",
        "CSG ID",
        "Installer Company",
        "Partner Company",
        "Customer Email",
        "Alt Email",
        "System Address",
        "Collateral Reimbursed",
      ],
      rows: [
        {
          "System ID": "1001",
          "CSG ID": "2001",
          "Installer Company": "ADT Solar",
          "Partner Company": "Partner Alpha",
          "Customer Email": "customer@example.com",
          "Alt Email": "customer+alt@example.com",
          "System Address": "123 Main St",
          "Collateral Reimbursed": "Yes",
        },
      ],
      matrix: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].systemId).toBe("1001");
    expect(rows[0].installerName).toBe("ADT Solar");
    expect(rows[0].customerEmail).toBe("customer@example.com");
    expect(rows[0].customerAltEmail).toBe("customer+alt@example.com");
    expect(rows[0].systemAddress).toBe("123 Main St");
    expect(rows[0].collateralReimbursedToPartner).toBe(true);
  });

  it("parses CSG portal database rows when CSG ID header is named ID", () => {
    const rows = parseCsgPortalDatabase({
      headers: ["ID", "Installer Company"],
      rows: [
        {
          ID: "2001",
          "Installer Company": "ADT Solar",
        },
      ],
      matrix: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].csgId).toBe("2001");
    expect(rows[0].installerName).toBe("ADT Solar");
  });

  it("parses CSG portal database rows when CSG ID header is named system_id", () => {
    const rows = parseCsgPortalDatabase({
      headers: ["system_id", "Installer Company"],
      rows: [
        {
          system_id: "2002",
          "Installer Company": "Installer B",
        },
      ],
      matrix: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].csgId).toBe("2002");
    expect(rows[0].installerName).toBe("Installer B");
  });

  it("throws when CSG portal database is missing the CSG ID column", () => {
    expect(() =>
      parseCsgPortalDatabase({
        headers: ["System ID", "Installer Company"],
        rows: [
          {
            "System ID": "1001",
            "Installer Company": "Installer X",
          },
        ],
        matrix: [],
      })
    ).toThrow(/CSG ID column/i);
  });

  it("throws when a non-empty CSG portal database row is missing CSG ID value", () => {
    expect(() =>
      parseCsgPortalDatabase({
        headers: ["CSG ID", "System ID", "Installer Company"],
        rows: [
          {
            "CSG ID": "",
            "System ID": "1001",
            "Installer Company": "Installer X",
          },
        ],
        matrix: [],
      })
    ).toThrow(/missing CSG ID values/i);
  });
});

describe("ABP formula and carryforward", () => {
  it("applies application fee cutoff and caps", () => {
    const utilityRows: UtilityInvoiceRow[] = [
      baseUtilityRow({ rowId: "sysA-1", systemId: "1001", paymentNumber: 1, invoiceAmount: 1000 }),
      baseUtilityRow({ rowId: "sysB-1", systemId: "1002", paymentNumber: 1, invoiceAmount: 1000 }),
    ];

    const mappings: CsgSystemIdMappingRow[] = [
      { csgId: "2001", systemId: "1001" },
      { csgId: "2002", systemId: "1002" },
    ];

    const projectApps: ProjectApplicationLiteRow[] = [
      {
        applicationId: "1001",
        part1SubmissionDate: new Date("2024-05-31T00:00:00.000Z"),
        part1OriginalSubmissionDate: null,
        inverterSizeKwAcPart1: 600,
      },
      {
        applicationId: "1002",
        part1SubmissionDate: new Date("2024-06-01T00:00:00.000Z"),
        part1OriginalSubmissionDate: null,
        inverterSizeKwAcPart1: 900,
      },
    ];

    const terms = new Map<string, ContractTerms>([
      ["2001", baseContractTerms("2001", { vendorFeePercent: 0, additionalCollateralPercent: 0 })],
      ["2002", baseContractTerms("2002", { vendorFeePercent: 0, additionalCollateralPercent: 0 })],
    ]);

    const result = computeSettlementRows({
      utilityRows,
      csgSystemMappings: mappings,
      projectApplications: projectApps,
      quickBooksPaidUpfrontLedger: { bySystemId: new Map(), unmatchedLines: [] },
      contractTermsByCsgId: terms,
    });

    const rowA = result.rows.find((row) => row.systemId === "1001");
    const rowB = result.rows.find((row) => row.systemId === "1002");

    expect(rowA?.applicationFeeAmount).toBe(5000);
    expect(rowB?.applicationFeeAmount).toBe(15000);
  });

  it("keeps category overpayments isolated and does not cross-offset", () => {
    const result = computeSettlementRows({
      utilityRows: [baseUtilityRow({ rowId: "r1", systemId: "1001", paymentNumber: 1, invoiceAmount: 1000 })],
      csgSystemMappings: [{ csgId: "2001", systemId: "1001" }],
      projectApplications: [
        {
          applicationId: "1001",
          part1SubmissionDate: new Date("2024-05-01T00:00:00.000Z"),
          part1OriginalSubmissionDate: null,
          inverterSizeKwAcPart1: 10,
        },
      ],
      quickBooksPaidUpfrontLedger: createLedgerBySystem({
        systemId: "1001",
        utilityCollateral: 80,
        applicationFee: 20,
        additionalCollateral: 0,
      }),
      contractTermsByCsgId: new Map([["2001", baseContractTerms("2001", { vendorFeePercent: 0, additionalCollateralPercent: 5 })]]),
    });

    const row = result.rows[0];
    // gross 1000, utility outstanding 0 (overpaid), app outstanding 80, addl outstanding 50.
    // first net = 1000 - 0 - 0 - 50 - 80 - 0 = 870.
    expect(row.firstPaymentFormulaNetAmount).toBe(870);
  });

  it("does not credit customer collateral upfront when reimbursement to partner is detected", () => {
    const result = computeSettlementRows({
      utilityRows: [baseUtilityRow({ rowId: "r2", systemId: "1001", paymentNumber: 1, invoiceAmount: 1000 })],
      csgSystemMappings: [{ csgId: "2001", systemId: "1001" }],
      projectApplications: [
        {
          applicationId: "1001",
          part1SubmissionDate: new Date("2024-05-01T00:00:00.000Z"),
          part1OriginalSubmissionDate: null,
          inverterSizeKwAcPart1: 10,
        },
      ],
      quickBooksPaidUpfrontLedger: createLedgerBySystem({
        systemId: "1001",
        utilityCollateral: 0,
        utilityCollateralReimbursement: 50,
      }),
      contractTermsByCsgId: new Map([
        ["2001", baseContractTerms("2001", { vendorFeePercent: 0, additionalCollateralPercent: 0 })],
      ]),
    });

    const row = result.rows[0];
    expect(row.utilityHeldCollateralPaidUpfront).toBe(0);
    expect(row.collateralReimbursementToPartnerCompanyAmount).toBe(50);
    expect(row.firstPaymentFormulaNetAmount).toBe(850);
  });

  it("applies installer rules for forced collateral reimbursement and referral fee", () => {
    const installerRules: InstallerSettlementRule[] = [
      {
        id: "adt-rule",
        name: "ADT Rule",
        active: true,
        matchField: "installerName",
        matchValue: "ADT Solar",
        forceUtilityCollateralReimbursement: true,
        referralFeePercent: 5,
        notes: "",
      },
    ];

    const result = computeSettlementRows({
      utilityRows: [baseUtilityRow({ rowId: "r3", systemId: "1001", paymentNumber: 1, invoiceAmount: 1000 })],
      csgSystemMappings: [{ csgId: "2001", systemId: "1001" }],
      projectApplications: [
        {
          applicationId: "1001",
          part1SubmissionDate: new Date("2024-05-01T00:00:00.000Z"),
          part1OriginalSubmissionDate: null,
          inverterSizeKwAcPart1: 10,
        },
      ],
      quickBooksPaidUpfrontLedger: createLedgerBySystem({
        systemId: "1001",
        utilityCollateral: 50,
      }),
      csgPortalDatabaseRows: [
        {
          systemId: "1001",
          csgId: "2001",
          installerName: "ADT Solar",
          partnerCompanyName: "PartnerCo",
          customerEmail: null,
          customerAltEmail: null,
          systemAddress: null,
          collateralReimbursedToPartner: null,
        },
      ],
      installerRules,
      contractTermsByCsgId: new Map([
        ["2001", baseContractTerms("2001", { vendorFeePercent: 0, additionalCollateralPercent: 0 })],
      ]),
    });

    const row = result.rows[0];
    expect(row.utilityHeldCollateralPaidUpfront).toBe(0);
    expect(row.collateralReimbursementToPartnerCompanyAmount).toBe(50);
    expect(row.referralFeePercent).toBe(5);
    expect(row.referralFeeAmount).toBe(50);
    expect(row.appliedInstallerRuleName).toBe("ADT Rule");
  });

  it("flags unknown classification when outside tolerance", () => {
    const result = computeSettlementRows({
      utilityRows: [
        baseUtilityRow({
          rowId: "r1",
          systemId: "1001",
          paymentNumber: 2,
          invoiceAmount: 47,
          recQuantity: 100,
          recPrice: 10,
        }),
      ],
      csgSystemMappings: [{ csgId: "2001", systemId: "1001" }],
      projectApplications: [],
      quickBooksPaidUpfrontLedger: { bySystemId: new Map(), unmatchedLines: [] },
      contractTermsByCsgId: new Map([["2001", baseContractTerms("2001")]]),
    });

    expect(result.rows[0].classification).toBe("unknown");
    expect(result.rows[0].confidenceFlags.join(" ")).toContain("outside tolerance");
  });

  it("rolls carryforward from payment 1 into payment 2 and 3 until recovered", () => {
    const result = computeSettlementRows({
      utilityRows: [
        baseUtilityRow({ rowId: "p1", systemId: "1001", paymentNumber: 1, invoiceAmount: 200 }),
        baseUtilityRow({ rowId: "p2", systemId: "1001", paymentNumber: 2, invoiceAmount: 50 }),
        baseUtilityRow({ rowId: "p3", systemId: "1001", paymentNumber: 3, invoiceAmount: 50 }),
      ],
      csgSystemMappings: [{ csgId: "2001", systemId: "1001" }],
      projectApplications: [
        {
          applicationId: "1001",
          part1SubmissionDate: new Date("2024-05-01T00:00:00.000Z"),
          part1OriginalSubmissionDate: null,
          inverterSizeKwAcPart1: 10,
        },
      ],
      quickBooksPaidUpfrontLedger: createLedgerBySystem({
        systemId: "1001",
        utilityCollateral: 30,
        applicationFee: 20,
        additionalCollateral: 0,
      }),
      contractTermsByCsgId: new Map([["2001", baseContractTerms("2001", { vendorFeePercent: 7, additionalCollateralPercent: 5 })]]),
    });

    const row1 = result.rows.find((row) => row.rowId === "p1");
    const row2 = result.rows.find((row) => row.rowId === "p2");
    const row3 = result.rows.find((row) => row.rowId === "p3");

    expect(row1?.carryforwardIn).toBe(220);
    expect(row1?.carryforwardOut).toBe(20);
    expect(row2?.carryforwardIn).toBe(20);
    expect(row2?.carryforwardOut).toBe(0);
    expect(row3?.carryforwardIn).toBe(0);
    expect(row3?.carryforwardOut).toBe(0);
  });

  it("uses stored carryforward seed when payment sequence starts above 1", () => {
    const result = computeSettlementRows({
      utilityRows: [baseUtilityRow({ rowId: "p2", systemId: "1001", paymentNumber: 2, invoiceAmount: 50 })],
      csgSystemMappings: [{ csgId: "2001", systemId: "1001" }],
      projectApplications: [],
      quickBooksPaidUpfrontLedger: { bySystemId: new Map(), unmatchedLines: [] },
      contractTermsByCsgId: new Map([["2001", baseContractTerms("2001")]]),
      previousCarryforwardBySystemId: { "1001": 40 },
    });

    expect(result.rows[0].carryforwardIn).toBe(40);
    expect(result.rows[0].carryforwardOut).toBe(0);
    expect(result.rows[0].netPayoutThisRow).toBe(10);
  });

  it("produces deterministic CSV for end-to-end fixture", () => {
    const result = computeSettlementRows({
      utilityRows: [baseUtilityRow({ rowId: "r1", systemId: "1001", paymentNumber: 1, invoiceAmount: 1000 })],
      csgSystemMappings: [{ csgId: "2001", systemId: "1001" }],
      projectApplications: [
        {
          applicationId: "1001",
          part1SubmissionDate: new Date("2024-05-01T00:00:00.000Z"),
          part1OriginalSubmissionDate: null,
          inverterSizeKwAcPart1: 10,
        },
      ],
      quickBooksPaidUpfrontLedger: { bySystemId: new Map(), unmatchedLines: [] },
      contractTermsByCsgId: new Map([["2001", baseContractTerms("2001", { vendorFeePercent: 0, additionalCollateralPercent: 0 })]]),
    });

    const csv = buildSettlementCsv(result.rows);
    expect(csv).toContain("CSG ID,System ID,Invoice Amount");
    expect(csv).toContain("2001,1001,1000.00");
    expect(csv.split("\n").length).toBe(2);
  });
});
