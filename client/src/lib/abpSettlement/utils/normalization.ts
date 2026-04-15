import { clean } from "@/lib/helpers";
import {
  type CsgPortalDatabaseRow,
  type InstallerSettlementRule,
  type InvoiceNumberMapRow,
} from "@/lib/abpSettlement";
import { parseBooleanText, parseNumericCell } from "./csvUtils";
import {
  type PersistedPayeeUpdateRow,
  type PersistedPaymentsReportRow,
  type PersistedProjectApplicationRow,
} from "./rowConversion";

export function normalizeInstallerRules(
  rules: InstallerSettlementRule[] | null | undefined,
  defaultRules: InstallerSettlementRule[]
): InstallerSettlementRule[] {
  const source = Array.isArray(rules) ? rules : defaultRules;
  return source.map((rule, index) => ({
    id: clean(rule.id) || `installer-rule-${index + 1}`,
    name: clean(rule.name) || `Installer Rule ${index + 1}`,
    active: rule.active !== false,
    matchField: rule.matchField === "partnerCompanyName" ? "partnerCompanyName" : "installerName",
    matchValue: clean(rule.matchValue),
    forceUtilityCollateralReimbursement: Boolean(rule.forceUtilityCollateralReimbursement),
    referralFeePercent: parseNumericCell(rule.referralFeePercent) ?? 0,
    notes: clean(rule.notes),
  }));
}

export function normalizeCsgPortalDatabaseRows(rows: unknown[]): CsgPortalDatabaseRow[] {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const source = row as Record<string, unknown>;
      const csgId = clean(source.csgId);
      if (!csgId) return null;

      return {
        systemId: clean(source.systemId),
        csgId,
        installerName: clean(source.installerName) || null,
        partnerCompanyName: clean(source.partnerCompanyName) || null,
        customerEmail: clean(source.customerEmail) || null,
        customerAltEmail: clean(source.customerAltEmail) || null,
        systemAddress: clean(source.systemAddress) || null,
        systemCity: clean(source.systemCity) || null,
        systemState: clean(source.systemState).toUpperCase() || null,
        systemZip: clean(source.systemZip) || null,
        paymentNotes: clean(source.paymentNotes) || null,
        collateralReimbursedToPartner: parseBooleanText(source.collateralReimbursedToPartner),
      } satisfies CsgPortalDatabaseRow;
    })
    .filter((row): row is CsgPortalDatabaseRow => Boolean(row));
}

export function normalizeProjectApplicationRows(rows: PersistedProjectApplicationRow[]): PersistedProjectApplicationRow[] {
  return rows
    .map((row) => ({
      applicationId: clean(row.applicationId),
      part1SubmissionDate: clean(row.part1SubmissionDate) || null,
      part1OriginalSubmissionDate: clean(row.part1OriginalSubmissionDate) || null,
      inverterSizeKwAcPart1:
        typeof row.inverterSizeKwAcPart1 === "number" && Number.isFinite(row.inverterSizeKwAcPart1)
          ? row.inverterSizeKwAcPart1
          : null,
    }))
    .filter((row) => row.applicationId.length > 0);
}

export function normalizeInvoiceNumberMapRows(rows: unknown[]): InvoiceNumberMapRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const source = row as Record<string, unknown>;
      const csgId = clean(source.csgId);
      const invoiceNumber = clean(source.invoiceNumber);
      if (!csgId || !invoiceNumber) return null;
      return {
        csgId,
        invoiceNumber,
      } satisfies InvoiceNumberMapRow;
    })
    .filter((row): row is InvoiceNumberMapRow => Boolean(row));
}

export function normalizePaymentsReportRows(rows: unknown[]): PersistedPaymentsReportRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const source = row as Record<string, unknown>;
      const rowId = clean(source.rowId);
      if (!rowId) return null;
      const sourceRowNumber = parseNumericCell(source.sourceRowNumber);
      return {
        rowId,
        sourceRowNumber:
          sourceRowNumber !== null && Number.isFinite(sourceRowNumber)
            ? Math.max(1, Math.floor(sourceRowNumber))
            : 1,
        systemId: clean(source.systemId),
        csgId: clean(source.csgId),
        paymentNumber: parseNumericCell(source.paymentNumber),
        paymentType: clean(source.paymentType),
        paymentDate: clean(source.paymentDate) || null,
        amount: parseNumericCell(source.amount),
        appliesToContract:
          source.appliesToContract === true || source.appliesToContract === "true"
            ? true
            : source.appliesToContract === false || source.appliesToContract === "false"
              ? false
              : null,
      } satisfies PersistedPaymentsReportRow;
    })
    .filter((row): row is PersistedPaymentsReportRow => Boolean(row));
}

export function normalizePayeeUpdateRows(rows: unknown[]): PersistedPayeeUpdateRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const source = row as Record<string, unknown>;
      const rowId = clean(source.rowId);
      if (!rowId) return null;
      const sourceRowNumber = parseNumericCell(source.sourceRowNumber);
      return {
        rowId,
        sourceRowNumber:
          sourceRowNumber !== null && Number.isFinite(sourceRowNumber)
            ? Math.max(1, Math.floor(sourceRowNumber))
            : 1,
        requestDate: clean(source.requestDate) || null,
        requestDateRaw: clean(source.requestDateRaw) || null,
        responderEmail: clean(source.responderEmail).toLowerCase() || null,
        enteredCsgId: clean(source.enteredCsgId) || null,
        paymentMethod: clean(source.paymentMethod) || null,
        payeeName: clean(source.payeeName) || null,
        mailingAddress1: clean(source.mailingAddress1) || null,
        mailingAddress2: clean(source.mailingAddress2) || null,
        city: clean(source.city) || null,
        state: clean(source.state).toUpperCase() || null,
        zip: clean(source.zip) || null,
        cityStateZip: clean(source.cityStateZip) || null,
      } satisfies PersistedPayeeUpdateRow;
    })
    .filter((row): row is PersistedPayeeUpdateRow => Boolean(row));
}

export function normalizeAiMailingModifiedFieldsByCsgId(
  value: Record<string, string[]> | null | undefined
): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};

  const normalized: Record<string, string[]> = {};
  Object.entries(value).forEach(([rawCsgId, rawFields]) => {
    const csgId = clean(rawCsgId);
    if (!csgId || !Array.isArray(rawFields)) return;
    const fields = Array.from(new Set(rawFields.map((entry) => clean(entry)).filter(Boolean)));
    if (fields.length > 0) normalized[csgId] = fields;
  });

  return normalized;
}
