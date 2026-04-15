import { clean } from "@/lib/helpers";
import {
  type PayeeMailingUpdateRow,
  type PaymentsReportRow,
  type ProjectApplicationLiteRow,
  type QuickBooksInvoice,
  type UtilityInvoiceRow,
} from "@/lib/abpSettlement";
import { parseNumericCell, toNumericCell } from "./csvUtils";
import { getRowValueByAliases } from "./parseUtils";

export type PersistedProjectApplicationRow = {
  applicationId: string;
  part1SubmissionDate: string | null;
  part1OriginalSubmissionDate: string | null;
  inverterSizeKwAcPart1: number | null;
};

export type PersistedQuickBooksInvoice = Omit<QuickBooksInvoice, "date"> & {
  date: string | null;
};

export type PersistedPaymentsReportRow = Omit<PaymentsReportRow, "paymentDate"> & {
  paymentDate: string | null;
};

export type PersistedPayeeUpdateRow = Omit<PayeeMailingUpdateRow, "requestDate"> & {
  requestDate: string | null;
};

export function utilityRowsToLinkedRows(rows: UtilityInvoiceRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    rowId: row.rowId,
    sourceFile: row.sourceFile,
    sourceSheet: row.sourceSheet,
    contractId: row.contractId ?? "",
    utilityName: row.utilityName ?? "",
    systemId: row.systemId,
    paymentNumber: toNumericCell(row.paymentNumber),
    recQuantity: toNumericCell(row.recQuantity),
    recPrice: toNumericCell(row.recPrice),
    invoiceAmount: toNumericCell(row.invoiceAmount),
    systemAddress: row.systemAddress,
  }));
}

export function linkedRowsToUtilityRows(rows: Array<Record<string, string>>, fallbackFileName: string): UtilityInvoiceRow[] {
  return rows
    .map((row, index) => {
      const systemId = getRowValueByAliases(row, ["systemId", "System ID", "state_certification_number"]);
      if (!systemId) return null;
      const sourceFile = getRowValueByAliases(row, ["sourceFile", "Source File"]) || fallbackFileName;
      const rowId = getRowValueByAliases(row, ["rowId", "Row ID"]) || `${sourceFile}:${index + 2}:${systemId}`;
      return {
        rowId,
        sourceFile,
        sourceSheet: getRowValueByAliases(row, ["sourceSheet", "Source Sheet"]) || "linked",
        contractId: getRowValueByAliases(row, ["contractId", "Contract ID"]) || null,
        utilityName: getRowValueByAliases(row, ["utilityName", "Utility"]) || null,
        systemId,
        paymentNumber: parseNumericCell(getRowValueByAliases(row, ["paymentNumber", "Payment Number"])),
        recQuantity: parseNumericCell(getRowValueByAliases(row, ["recQuantity", "Total RECS", "REC Quantity"])),
        recPrice: parseNumericCell(getRowValueByAliases(row, ["recPrice", "REC Price"])),
        invoiceAmount: parseNumericCell(
          getRowValueByAliases(row, ["invoiceAmount", "Invoice Amount", "Invoice Amount ($)"])
        ),
        systemAddress: getRowValueByAliases(row, ["systemAddress", "System Address"]),
      } satisfies UtilityInvoiceRow;
    })
    .filter((row): row is UtilityInvoiceRow => Boolean(row));
}

export function quickBooksInvoicesToLinkedRows(
  invoices: Map<string, QuickBooksInvoice>
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];

  Array.from(invoices.values()).forEach((invoice) => {
    const invoiceDate = invoice.date ? invoice.date.toISOString().slice(0, 10) : "";
    const lineItems = invoice.lineItems.length > 0 ? invoice.lineItems : [{ lineOrder: null, description: "", productService: "", amount: null }];
    lineItems.forEach((lineItem, index) => {
      rows.push({
        invoiceNumber: invoice.invoiceNumber,
        date: invoiceDate,
        customer: invoice.customer,
        amount: toNumericCell(invoice.amount),
        openBalance: toNumericCell(invoice.openBalance),
        cashReceived: toNumericCell(invoice.cashReceived),
        paymentStatus: invoice.paymentStatus,
        voided: invoice.voided,
        lineOrder: toNumericCell(lineItem.lineOrder ?? index + 1),
        description: lineItem.description,
        productService: lineItem.productService,
        lineAmount: toNumericCell(lineItem.amount),
      });
    });
  });

  return rows;
}

export function linkedRowsToQuickBooksInvoices(rows: Array<Record<string, string>>): Map<string, QuickBooksInvoice> {
  const grouped = new Map<string, QuickBooksInvoice>();

  rows.forEach((row) => {
    const invoiceNumber = getRowValueByAliases(row, ["invoiceNumber", "Num", "Invoice Number", "Invoice #"]);
    if (!invoiceNumber) return;

    const existing =
      grouped.get(invoiceNumber) ??
      ({
        invoiceNumber,
        amount: parseNumericCell(getRowValueByAliases(row, ["amount", "Amount", "Total"])),
        openBalance: parseNumericCell(getRowValueByAliases(row, ["openBalance", "Open balance", "Open Balance"])),
        cashReceived: parseNumericCell(getRowValueByAliases(row, ["cashReceived", "Cash Received"])),
        paymentStatus: getRowValueByAliases(row, ["paymentStatus", "Payment status", "Payment Status"]),
        voided: getRowValueByAliases(row, ["voided", "Voided"]),
        customer: getRowValueByAliases(row, ["customer", "Customer", "Customer full name", "Customer Full Name"]) || "Unknown",
        date: getRowValueByAliases(row, ["date", "Date"])
          ? new Date(getRowValueByAliases(row, ["date", "Date"]))
          : null,
        lineItems: [],
      } satisfies QuickBooksInvoice);

    if (existing.amount === null) {
      existing.amount = parseNumericCell(getRowValueByAliases(row, ["amount", "Amount", "Total"]));
    }
    if (existing.openBalance === null) {
      existing.openBalance = parseNumericCell(getRowValueByAliases(row, ["openBalance", "Open balance", "Open Balance"]));
    }
    if (existing.cashReceived === null) {
      existing.cashReceived = parseNumericCell(getRowValueByAliases(row, ["cashReceived", "Cash Received"]));
    }
    if (!existing.paymentStatus) {
      existing.paymentStatus = getRowValueByAliases(row, ["paymentStatus", "Payment status", "Payment Status"]);
    }
    if (!existing.voided) {
      existing.voided = getRowValueByAliases(row, ["voided", "Voided"]);
    }
    if (!existing.customer) {
      existing.customer =
        getRowValueByAliases(row, ["customer", "Customer", "Customer full name", "Customer Full Name"]) ||
        "Unknown";
    }
    const rowDate = getRowValueByAliases(row, ["date", "Date"]);
    if (!existing.date && rowDate) {
      const parsedDate = new Date(rowDate);
      existing.date = Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
    }

    const description = getRowValueByAliases(row, ["description", "Product/service description", "Description"]);
    const productService = getRowValueByAliases(row, ["productService", "Product/Service", "Product Service"]);
    const lineAmount = parseNumericCell(
      getRowValueByAliases(row, ["lineAmount", "Product/service amount line", "Line Amount"])
    );
    if (description || productService || lineAmount !== null) {
      existing.lineItems.push({
        lineOrder: parseNumericCell(getRowValueByAliases(row, ["lineOrder", "Line order", "Line Order"])),
        description,
        productService,
        amount: lineAmount,
      });
    }

    grouped.set(invoiceNumber, existing);
  });

  grouped.forEach((invoice) => {
    invoice.lineItems.sort((left, right) => {
      const leftOrder = left.lineOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.lineOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.description.localeCompare(right.description);
    });
  });

  return grouped;
}

export function serializeProjectApplications(rows: ProjectApplicationLiteRow[]): PersistedProjectApplicationRow[] {
  return rows.map((row) => ({
    applicationId: row.applicationId,
    part1SubmissionDate: row.part1SubmissionDate ? row.part1SubmissionDate.toISOString() : null,
    part1OriginalSubmissionDate: row.part1OriginalSubmissionDate
      ? row.part1OriginalSubmissionDate.toISOString()
      : null,
    inverterSizeKwAcPart1: row.inverterSizeKwAcPart1,
  }));
}

export function deserializeProjectApplications(rows: PersistedProjectApplicationRow[]): ProjectApplicationLiteRow[] {
  return rows.map((row) => ({
    applicationId: clean(row.applicationId),
    part1SubmissionDate: row.part1SubmissionDate ? new Date(row.part1SubmissionDate) : null,
    part1OriginalSubmissionDate: row.part1OriginalSubmissionDate
      ? new Date(row.part1OriginalSubmissionDate)
      : null,
    inverterSizeKwAcPart1:
      typeof row.inverterSizeKwAcPart1 === "number" && Number.isFinite(row.inverterSizeKwAcPart1)
        ? row.inverterSizeKwAcPart1
        : null,
  }));
}

export function serializeQuickBooksInvoices(invoices: Map<string, QuickBooksInvoice>): PersistedQuickBooksInvoice[] {
  return Array.from(invoices.values()).map((invoice) => ({
    ...invoice,
    date: invoice.date ? invoice.date.toISOString() : null,
  }));
}

export function deserializeQuickBooksInvoices(invoices: PersistedQuickBooksInvoice[]): Map<string, QuickBooksInvoice> {
  const map = new Map<string, QuickBooksInvoice>();
  invoices.forEach((invoice) => {
    const key = clean(invoice.invoiceNumber);
    if (!key) return;
    map.set(key, {
      ...invoice,
      date: invoice.date ? new Date(invoice.date) : null,
    });
  });
  return map;
}

export function serializePaymentsReportRows(rows: PaymentsReportRow[]): PersistedPaymentsReportRow[] {
  return rows.map((row) => ({
    ...row,
    paymentDate: row.paymentDate ? row.paymentDate.toISOString() : null,
  }));
}

export function deserializePaymentsReportRows(rows: PersistedPaymentsReportRow[]): PaymentsReportRow[] {
  return rows.map((row) => ({
    ...row,
    paymentDate: row.paymentDate ? new Date(row.paymentDate) : null,
  }));
}

export function serializePayeeUpdateRows(rows: PayeeMailingUpdateRow[]): PersistedPayeeUpdateRow[] {
  return rows.map((row) => ({
    ...row,
    requestDate: row.requestDate ? row.requestDate.toISOString() : null,
  }));
}

export function deserializePayeeUpdateRows(rows: PersistedPayeeUpdateRow[]): PayeeMailingUpdateRow[] {
  return rows.map((row) => ({
    ...row,
    requestDate: row.requestDate ? new Date(row.requestDate) : null,
  }));
}
