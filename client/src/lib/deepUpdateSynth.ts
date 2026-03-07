import * as XLSX from "xlsx";

export type DeepUpdateReportKey =
  | "portal"
  | "abpReport"
  | "sd"
  | "iccReport1"
  | "iccReport2"
  | "iccReport3"
  | "portalPayments";

export type DeepUpdateReportData = {
  key: DeepUpdateReportKey;
  fileName: string;
  sheetName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
};

type CalcStepValue = number | null;

type SynthesisContext = {
  sdStatus: string;
  contractStatus: string;
  part1Status: string;
  part2Status: string;
  batchStatus: string;
  internalStatus: string;
  atLeast20Paid: string;
  furthestStepComplete: number | null;
};

export type SynthesisRow = {
  id: string;
  systemName: string;
  internalStatus: string;
  internalStatusValue: number | null;
  calculatedStep: string;
  calcStepValue: CalcStepValue;
  shouldBeUpdated: boolean;
  deepUpdateRow: DeepUpdateRow;
};

export type DeepUpdateRow = {
  id: string;
  est_payment_date: string;
  state_approval_date2: string;
  state_approval_date: string;
  standing_order_utility: string;
  rec_price: string;
  part1_submitted_date: string;
  part2_submitted_date: string;
  total_contract_amount: string;
  state_registration_approval_deadline: string;
  utility_contract_number: string;
};

export type DeepUpdateSynthesisResult = {
  rows: SynthesisRow[];
  deepUpdateCsvText: string;
  statusCsvText: string;
  warnings: string[];
  summary: {
    totalPortalRows: number;
    synthesizedRows: number;
    rowsNeedingUpdate: number;
    rowsMissingAbpMatch: number;
    rowsMissingIccMatch: number;
  };
};

const REPORT_SHEET_HINTS: Record<DeepUpdateReportKey, string[]> = {
  portal: ["Portal"],
  abpReport: ["ABP Report"],
  sd: ["SD"],
  iccReport1: ["ICC Report 1"],
  iccReport2: ["ICC  Report 2", "ICC Report 2"],
  iccReport3: ["ICC Report 3"],
  portalPayments: ["Portal Payments"],
};

const DEFAULT_EST_PAYMENT_MESSAGE = "System has not been approved, no estimate is available";

const STEP_LABELS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Step 0.0 - Declined / Terminated" },
  { value: 1.1, label: "Step 0.0 - SD Withdrawn" },
  { value: 1.2, label: "Step 0.0 - Submission on Hold" },
  { value: 1.21, label: "Step 0.0 - Submission on Hold" },
  { value: 2, label: "Step 1.1 - SD Awaiting Information" },
  { value: 3, label: "Step 1.2 - SD Sent, Awaiting Signature" },
  { value: 4, label: "Step 2.1 - SREC Contract Awaiting Information" },
  { value: 5, label: "Step 2.2 - SREC Contract Send Pending" },
  { value: 6, label: "Step 2.3 - SREC Contract Sent, Awaiting Signature" },
  { value: 6.1, label: "Step 2.4 - SREC Contract Signed, DF Signature and Invoice Payment Needed" },
  { value: 6.2, label: "Step 2.5 - SREC Contract Signed, DF Signature Needed" },
  { value: 7, label: "Step 3.1 - ABP Part 1 Internal Review Required" },
  { value: 8, label: "Step 3.2 - ABP Part 1 Needs Additional Information" },
  { value: 9, label: "Step 3.3 - ABP Part 1 Submitted to IL Shines" },
  { value: 10, label: "Step 3.4 - ABP Part 1 IL Shines Needs More Information" },
  { value: 10.1, label: "Step 3.4.b - ABP Part 1 IL Shines Needs More Information - Info sent to IL Shines" },
  { value: 10.2, label: "Step 3.4.c - ABP Part 1 Verified Pending ICC Approval" },
  { value: 11, label: "Step 3.5 - ABP ICC Approved Part 2 Awaiting Information" },
  { value: 12, label: "Step 3.6 - ABP ICC Approved Part 2 Internal Review Required" },
  { value: 13, label: "Step 3.7 - ABP Part 2 Needs Additional Information" },
  { value: 13.5, label: "Step 3.7.b - Part 2 Task Completed, Internal Review Required" },
  { value: 14, label: "Step 3.8 - ABP Part 2 Submitted to IL Shines" },
  { value: 15, label: "Step 3.9 - ABP Part 2 IL Shines Needs More Information" },
  { value: 15.1, label: "Step 3.9.b - ABP Part 2 IL Shines Needs More Information - Info sent to IL Shines" },
  { value: 16, label: "Step 3.10 - ABP Part 2 IL Shines Verified" },
  { value: 17, label: "Step 4.1 - Project Queued for Payment" },
  { value: 21, label: "Step 4.3 - Payments On Hold" },
  { value: 22, label: "Step 4.2 - Initial Payment Has Been Sent to Customer" },
  { value: 23, label: "Step 5.1 - Contract Completed" },
];

const STEP_LABEL_BY_VALUE = new Map<number, string>(STEP_LABELS.map((entry) => [entry.value, entry.label]));
const STEP_VALUE_BY_LABEL = new Map<string, number>(
  STEP_LABELS.map((entry) => [normalizeStatus(entry.label), entry.value])
);

const ACTIVE_CONTRACT_STATUSES = ["COMPLETED - ACTIVE", "TO BE TERMINATED", "TRANSFERRING OWNERSHIP", "TERMINATED"];
const CONTRACT_FLOW_STATUSES = ["CONTRACT SEND PENDING", "AWAITING INFORMATION", "SENT", "VOIDED", "DELETED", "VIEWED", "DECLINED"];
const SD_ACCEPTED_STATUSES = ["COMPLETED", "SUBMITTED", "AWAITING SIGNATURE", "WITHDRAWN", "IN PROGRESS", "INVALID"];
const APPROVED_BATCH_STATUSES = ["ICC_APPROVED", "APPROVED"];

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeHeader(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeStatus(value: string): string {
  return clean(value).replace(/\s+/g, " ").toUpperCase();
}

function isZeroish(value: string): boolean {
  const raw = clean(value);
  return raw === "0" || raw === "0.0" || raw === "";
}

function parseNumber(value: string): number | null {
  const normalized = clean(value).replace(/[$,%\s]/g, "").replaceAll(",", "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const excelEpoch = Date.UTC(1899, 11, 30);
  const dateMs = excelEpoch + Math.round(serial * 24 * 60 * 60 * 1000);
  const date = new Date(dateMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDate(value: string): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const numeric = parseNumber(raw);
  if (numeric !== null && numeric > 1000) {
    const excelDate = excelSerialToDate(numeric);
    if (excelDate) return excelDate;
  }

  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const year = Number(us[3]) < 100 ? Number(us[3]) + 2000 : Number(us[3]);
    const date = new Date(year, Number(us[1]) - 1, Number(us[2]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function formatDate(value: Date | null): string {
  if (!value) return "";
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const year = value.getFullYear();
  return `${month}/${day}/${year}`;
}

function normalizeUtility(value: string): string {
  const trimmed = clean(value);
  if (!trimmed) return "";
  if (trimmed === "ComEd") return "Com-ED";
  if (trimmed === "AmerenIllinois") return "Ameren";
  if (trimmed === "MidAmerican") return "MidAmerican";
  return trimmed;
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

function toCsv(headers: string[], rows: Array<Record<string, string>>): string {
  const lines = [headers.map(escapeCsv).join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCsv(clean(row[header]))).join(","));
  });
  return lines.join("\n");
}

function pickByHeaders(row: Record<string, string>, candidates: string[]): string {
  for (const candidate of candidates) {
    const exact = clean(row[candidate]);
    if (exact) return exact;
  }

  const normalizedCandidates = new Set(candidates.map(normalizeHeader));
  for (const [header, value] of Object.entries(row)) {
    if (!normalizedCandidates.has(normalizeHeader(header))) continue;
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function pickHeaderByIncludes(headers: string[], terms: string[]): string | null {
  const required = terms.map((term) => normalizeHeader(term));
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (required.every((term) => normalized.includes(term))) return header;
  }
  return null;
}

function deriveEstimatedPaymentDate(part2VerificationDateRaw: string): string {
  const part2Date = parseDate(part2VerificationDateRaw);
  if (!part2Date) return DEFAULT_EST_PAYMENT_MESSAGE;
  const projected = new Date(part2Date.getFullYear(), part2Date.getMonth() + 3, 15);
  return `Estimated Payment Date: ${formatDate(projected)}`;
}

function compareStepValues(calcStep: CalcStepValue, internalStep: number | null): boolean {
  if (calcStep === null || internalStep === null) return false;
  return calcStep > internalStep;
}

function toStepLabel(step: CalcStepValue): string {
  if (step === null) return "Unknown";
  return STEP_LABEL_BY_VALUE.get(step) ?? `Step ${step}`;
}

function toInternalStatusValue(internalStatus: string): number | null {
  return STEP_VALUE_BY_LABEL.get(normalizeStatus(internalStatus)) ?? null;
}

function inStatus(value: string, allowed: string[]): boolean {
  return allowed.includes(normalizeStatus(value));
}

function inStatusOrZero(value: string, allowed: string[]): boolean {
  return inStatus(value, allowed) || isZeroish(value);
}

function computeCalcStepValue(context: SynthesisContext): CalcStepValue {
  const sdStatus = normalizeStatus(context.sdStatus);
  const contractStatus = normalizeStatus(context.contractStatus);
  const part1Status = normalizeStatus(context.part1Status);
  const part2Status = normalizeStatus(context.part2Status);
  const batchStatus = normalizeStatus(context.batchStatus);
  const internalStatus = normalizeStatus(context.internalStatus);
  const paidFlag = normalizeStatus(context.atLeast20Paid);
  const furthestStep = context.furthestStepComplete;

  const sdAccepted = SD_ACCEPTED_STATUSES.includes(sdStatus) || isZeroish(context.sdStatus);
  const activeContract = ACTIVE_CONTRACT_STATUSES.includes(contractStatus);
  const contractFlow = CONTRACT_FLOW_STATUSES.includes(contractStatus) || isZeroish(context.contractStatus);
  const approvedBatch = APPROVED_BATCH_STATUSES.includes(batchStatus);
  const part2NeedInfo = part2Status === "NEED_INFO" || part2Status === "NI_UNRESPONSIVE_AV";
  const part1NeedInfo = part1Status === "NEED_INFO" || part1Status === "NI_UNRESPONSIVE_AV";

  if (sdAccepted && contractStatus === "DECLINED") return 1;
  if (sdAccepted && activeContract && part1Status === "WITHDRAWN") return 1;
  if (sdAccepted && activeContract && part2Status === "WITHDRAWN") return 1;
  if (sdAccepted && activeContract && part1Status === "REMOVED") return 1;
  if (sdAccepted && activeContract && part2Status === "REMOVED") return 1;
  if (internalStatus === "STEP 0.0 - DECLINED / TERMINATED") return 1;
  if (internalStatus === "INTERNAL REVIEW REQUIRED") return 1;
  if (internalStatus === "DECLINED / TERMINATED") return 1;

  if (sdStatus === "WITHDRAWN" && ["VIEWED", "DELETED", "VOIDED", "DECLINED"].includes(contractStatus)) return 1.1;
  if (internalStatus === "STEP 0.0 - SD WITHDRAWN") return 1.1;
  if (internalStatus === "STEP 0.0 - SUBMISSION ON HOLD") return 1.2;
  if (internalStatus === "SUBMISSION ON HOLD") return 1.21;

  if (
    inStatusOrZero(context.sdStatus, ["SUBMITTED", "WITHDRAWN", "IN PROGRESS", "INVALID"]) &&
    contractFlow
  ) {
    return 2;
  }

  if (sdStatus === "COMPLETED" && activeContract && part1Status === "VERIFIED" && part2Status === "VERIFIED" && approvedBatch) {
    if (paidFlag === "PAID" && internalStatus === "STEP 4.3 - PAYMENTS ON HOLD") return 21;
    if (contractStatus === "TERMINATED") return 23;
    if (paidFlag === "PAID") return 22;
    return 16;
  }

  if (sdStatus === "COMPLETED" && activeContract && part1Status === "VERIFIED" && part2NeedInfo && approvedBatch) return 15;
  if (sdStatus === "COMPLETED" && activeContract && part1Status === "VERIFIED" && part2Status === "SUBMITTED" && approvedBatch) return 14;
  if (sdStatus === "COMPLETED" && activeContract && part1Status === "VERIFIED" && part2Status === "INPROGRESS" && approvedBatch) {
    if (furthestStep !== null && Math.abs(furthestStep - 2.5) < 0.0001) return 12;
    return 11;
  }
  if (sdStatus === "COMPLETED" && activeContract && part1Status === "VERIFIED" && batchStatus === "PAID") return 10.2;
  if (sdStatus === "COMPLETED" && activeContract && part1NeedInfo && batchStatus === "PAID") return 10;
  if (sdStatus === "COMPLETED" && activeContract && part1Status === "SUBMITTED") return 9;

  if (
    inStatusOrZero(context.sdStatus, ["SUBMITTED", "AWAITING SIGNATURE", "WITHDRAWN", "IN PROGRESS", "INVALID", "COMPLETED"]) &&
    activeContract
  ) {
    return 7;
  }

  if (sdStatus === "COMPLETED" && ["SENT", "VOIDED", "DELETED", "VIEWED", "DECLINED"].includes(contractStatus)) return 6;
  if (sdStatus === "COMPLETED" && contractStatus === "CONTRACT SEND PENDING") return 5;
  if (sdStatus === "COMPLETED" && (contractStatus === "AWAITING INFORMATION" || isZeroish(context.contractStatus))) return 4;

  if (sdStatus === "AWAITING SIGNATURE" && contractFlow) return 3;
  return null;
}

export async function parseDeepUpdateReportFile(file: File, key: DeepUpdateReportKey): Promise<DeepUpdateReportData> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", raw: false, cellDates: false });
  const preferredSheet = REPORT_SHEET_HINTS[key].find((candidate) => workbook.SheetNames.includes(candidate));
  const sheetName = preferredSheet ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    const availableSheets = (workbook.SheetNames ?? []).filter(Boolean);
    const availableSheetLabel = availableSheets.length > 0 ? availableSheets.join(", ") : "none detected";
    const fileExtension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const workbookFiles = (workbook as { files?: Record<string, unknown> }).files;
    const hasWorksheetXml =
      !!workbookFiles &&
      Object.keys(workbookFiles).some((path) => path.toLowerCase().includes("xl/worksheets/"));

    if (["xlsx", "xlsm", "xls"].includes(fileExtension) && hasWorksheetXml) {
      throw new Error(
        `Could not read worksheet for ${key}. This Excel file appears to use a malformed worksheet format that the browser parser cannot load. ` +
          `Detected sheet name(s): ${availableSheetLabel}. Please open the file in Excel or Google Sheets and save it as CSV (recommended) or a newly-saved XLSX, then upload again.`
      );
    }

    throw new Error(
      `Could not read worksheet for ${key}. Detected sheet name(s): ${availableSheetLabel}. ` +
        `Please verify the file and try again.`
    );
  }

  const headersRow = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
    range: 0,
  });
  const headers = (headersRow[0] ?? []).map((value) => clean(value)).filter((value) => !!value);

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: "",
    blankrows: false,
  }).map((row) => {
    const normalizedRow: Record<string, string> = {};
    Object.entries(row).forEach(([header, value]) => {
      normalizedRow[header] = clean(value);
    });
    return normalizedRow;
  });

  return {
    key,
    fileName: file.name,
    sheetName,
    headers,
    rows,
  };
}

function assertRequiredReports(
  reports: Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>>
): asserts reports is Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>> & {
  portal: DeepUpdateReportData;
  abpReport: DeepUpdateReportData;
  sd: DeepUpdateReportData;
  iccReport2: DeepUpdateReportData;
  iccReport3: DeepUpdateReportData;
} {
  const missing: string[] = [];
  if (!reports.portal) missing.push("Portal");
  if (!reports.abpReport) missing.push("ABP Report");
  if (!reports.sd) missing.push("SD");
  if (!reports.iccReport2) missing.push("ICC Report 2");
  if (!reports.iccReport3) missing.push("ICC Report 3");
  if (missing.length > 0) {
    throw new Error(`Missing required report(s): ${missing.join(", ")}`);
  }
}

export function synthesizeDeepUpdate(
  reports: Partial<Record<DeepUpdateReportKey, DeepUpdateReportData>>
): DeepUpdateSynthesisResult {
  assertRequiredReports(reports);

  const warnings: string[] = [];
  const abpByApplicationId = new Map<string, Record<string, string>>();
  const abpByDisclosureFormId = new Map<string, Record<string, string>>();
  const sdStatusByFormId = new Map<string, string>();
  const icc2ByApplicationId = new Map<string, Record<string, string>>();
  const icc3ByApplicationId = new Map<string, Record<string, string>>();
  const paymentsByPortalId = new Map<string, number>();

  reports.abpReport.rows.forEach((row) => {
    const applicationId = pickByHeaders(row, ["Application_ID", "Application ID"]);
    if (applicationId && !abpByApplicationId.has(applicationId)) {
      abpByApplicationId.set(applicationId, row);
    }
    const disclosureId = pickByHeaders(row, ["Disclosure_Form_ID", "disclosure_form_id"]);
    if (disclosureId && !abpByDisclosureFormId.has(disclosureId)) {
      abpByDisclosureFormId.set(disclosureId, row);
    }
  });

  reports.sd.rows.forEach((row) => {
    const formId = pickByHeaders(row, ["FormID", "Form Id", "form_id"]);
    const status = pickByHeaders(row, ["Status", "status"]);
    if (formId && status) {
      sdStatusByFormId.set(formId, status);
    }
  });

  reports.iccReport2.rows.forEach((row) => {
    const applicationId = pickByHeaders(row, ["Application ID", "Application_ID", "application_id"]);
    if (applicationId && !icc2ByApplicationId.has(applicationId)) {
      icc2ByApplicationId.set(applicationId, row);
    }
  });

  reports.iccReport3.rows.forEach((row) => {
    const applicationId = pickByHeaders(row, ["Application ID", "Application_ID", "application_id"]);
    if (applicationId && !icc3ByApplicationId.has(applicationId)) {
      icc3ByApplicationId.set(applicationId, row);
    }
  });

  if (reports.portalPayments) {
    const idHeader =
      pickHeaderByIncludes(reports.portalPayments.headers, ["system", "id"]) ??
      pickHeaderByIncludes(reports.portalPayments.headers, ["portal", "id"]) ??
      pickHeaderByIncludes(reports.portalPayments.headers, ["id"]);
    const amountHeader =
      pickHeaderByIncludes(reports.portalPayments.headers, ["payment", "amount"]) ??
      pickHeaderByIncludes(reports.portalPayments.headers, ["amount"]);

    reports.portalPayments.rows.forEach((row) => {
      const id = idHeader ? clean(row[idHeader]) : "";
      const amountRaw = amountHeader ? clean(row[amountHeader]) : "";
      if (!id) return;
      const amount = parseNumber(amountRaw) ?? 0;
      paymentsByPortalId.set(id, (paymentsByPortalId.get(id) ?? 0) + amount);
    });
  }

  let rowsMissingAbpMatch = 0;
  let rowsMissingIccMatch = 0;
  const synthesizedRows: SynthesisRow[] = [];

  reports.portal.rows.forEach((portalRow) => {
    const id = pickByHeaders(portalRow, ["system_id", "id", "portal_id"]);
    if (!id) return;

    const systemName = pickByHeaders(portalRow, ["system_name", "Project_Name"]);
    const internalStatus = pickByHeaders(portalRow, ["internal_status"]);
    const stateCertificationNumber = pickByHeaders(portalRow, ["state_certification_number"]);
    const stateApplicationRefId = pickByHeaders(portalRow, ["state_application_ref_id"]);
    const sdId = pickByHeaders(portalRow, ["sd_id", "FormID"]);
    const contractStatus = pickByHeaders(portalRow, ["contract_status"]);
    const portalSdStatus = pickByHeaders(portalRow, ["sd_status"]);
    const furthestStepComplete = parseNumber(
      pickByHeaders(portalRow, ["furthest_step_complete", "Furthest Step Complete", "farthest_step_complete"])
    );

    const abpMatchId = stateCertificationNumber || stateApplicationRefId;
    const abpRow =
      (abpMatchId ? abpByApplicationId.get(abpMatchId) : undefined) ??
      (sdId ? abpByDisclosureFormId.get(sdId) : undefined);
    if (!abpRow) rowsMissingAbpMatch += 1;

    const applicationId = abpRow
      ? pickByHeaders(abpRow, ["Application_ID", "Application ID"])
      : "";

    const part1Status = abpRow ? pickByHeaders(abpRow, ["Part_1_Status", "Part I Application Status"]) : "";
    const part2Status = abpRow ? pickByHeaders(abpRow, ["Part_2_Status"]) : "";
    const batchStatus = abpRow ? pickByHeaders(abpRow, ["Batch_Status"]) : "";
    const part1SubmittedDate =
      (abpRow ? pickByHeaders(abpRow, ["Part_1_Submission_Date", "Part I Application Submission Date"]) : "") ||
      (abpRow ? pickByHeaders(abpRow, ["Part_1_AppVerification_Date"]) : "");
    const part2SubmittedDate =
      (abpRow ? pickByHeaders(abpRow, ["Part_2_Submission_Date", "Part II Application Submission Date"]) : "") ||
      (abpRow ? pickByHeaders(abpRow, ["Part_2_App_Verification_Date"]) : "");
    const part2VerificationDate = abpRow ? pickByHeaders(abpRow, ["Part_2_App_Verification_Date"]) : "";
    const tradeDate = abpRow ? pickByHeaders(abpRow, ["Trade_Date"]) : "";
    const contractUtility = abpRow ? pickByHeaders(abpRow, ["Assigned_Contracting_Utility", "Counterparty Utility"]) : "";
    const utilityContractNumber = abpRow ? pickByHeaders(abpRow, ["Contract_ID", "contract_id"]) : "";

    const sdStatus = normalizeStatus(part1Status) === "VERIFIED" ? "completed" : (portalSdStatus || sdStatusByFormId.get(sdId) || "");

    const icc2Row = applicationId ? icc2ByApplicationId.get(applicationId) : undefined;
    const icc3Row = applicationId ? icc3ByApplicationId.get(applicationId) : undefined;
    if (applicationId && !icc2Row && !icc3Row) rowsMissingIccMatch += 1;

    const recPrice = (icc3Row ? pickByHeaders(icc3Row, ["REC Price"]) : "") || (icc2Row ? pickByHeaders(icc2Row, ["REC Price"]) : "");
    const totalContractAmount =
      (icc3Row ? pickByHeaders(icc3Row, ["Total REC Delivery Contract Value", "REC Delivery Contract Value"]) : "") ||
      (icc2Row ? pickByHeaders(icc2Row, ["REC Delivery Contract Value", "Total REC Delivery Contract Value"]) : "");
    const scheduledEnergizationDate = icc2Row ? pickByHeaders(icc2Row, ["Scheduled Energization Date"]) : "";

    const payments = paymentsByPortalId.get(id) ?? 0;
    const contractAmountValue = parseNumber(totalContractAmount);
    const atLeast20Paid =
      contractAmountValue !== null && contractAmountValue > 0 && payments / contractAmountValue > 0.2 ? "Paid" : "";

    const calcStepValue = computeCalcStepValue({
      sdStatus,
      contractStatus,
      part1Status,
      part2Status,
      batchStatus,
      internalStatus,
      atLeast20Paid,
      furthestStepComplete,
    });

    const calculatedStep = toStepLabel(calcStepValue);
    const internalStatusValue = toInternalStatusValue(internalStatus);
    const shouldBeUpdated = compareStepValues(calcStepValue, internalStatusValue);

    const deepUpdateRow: DeepUpdateRow = {
      id,
      est_payment_date: deriveEstimatedPaymentDate(part2VerificationDate),
      state_approval_date2: part2VerificationDate || "NULL",
      state_approval_date: tradeDate || "NULL",
      standing_order_utility: normalizeUtility(contractUtility) || "NULL",
      rec_price: recPrice || "NULL",
      part1_submitted_date: part1SubmittedDate || "NULL",
      part2_submitted_date: part2SubmittedDate || "NULL",
      total_contract_amount: totalContractAmount || "NULL",
      state_registration_approval_deadline: scheduledEnergizationDate || "NULL",
      utility_contract_number: utilityContractNumber || "NULL",
    };

    synthesizedRows.push({
      id,
      systemName,
      internalStatus,
      internalStatusValue,
      calculatedStep,
      calcStepValue,
      shouldBeUpdated,
      deepUpdateRow,
    });
  });

  if (!reports.portalPayments) {
    warnings.push(
      "Portal Payments was not uploaded, so payment-based calc steps (for example Step 4.2/4.3) may be incomplete."
    );
  }
  if (rowsMissingAbpMatch > 0) {
    warnings.push(`${rowsMissingAbpMatch} portal rows did not find a matching ABP row.`);
  }
  if (rowsMissingIccMatch > 0) {
    warnings.push(`${rowsMissingIccMatch} rows did not find matching ICC Report 2/3 rows.`);
  }

  const deepUpdateHeaders = [
    "id",
    "est_payment_date",
    "state_approval_date2",
    "state_approval_date",
    "standing_order_utility",
    "rec_price",
    "part1_submitted_date",
    "part2_submitted_date",
    "total_contract_amount",
    "state_registration_approval_deadline",
    "utility_contract_number",
  ];

  const statusHeaders = [
    "system_id",
    "system_name",
    "internal_status",
    "internal_status_value",
    "calculated_step",
    "calc_step_value",
    "should_be_updated",
  ];

  const deepUpdateCsvRows = synthesizedRows.map((row) => ({
    ...row.deepUpdateRow,
  }));

  const statusCsvRows = synthesizedRows.map((row) => ({
    system_id: row.id,
    system_name: row.systemName,
    internal_status: row.internalStatus,
    internal_status_value: row.internalStatusValue === null ? "" : String(row.internalStatusValue),
    calculated_step: row.calculatedStep,
    calc_step_value: row.calcStepValue === null ? "" : String(row.calcStepValue),
    should_be_updated: row.shouldBeUpdated ? "Yes" : "No",
  }));

  return {
    rows: synthesizedRows,
    deepUpdateCsvText: toCsv(deepUpdateHeaders, deepUpdateCsvRows),
    statusCsvText: toCsv(statusHeaders, statusCsvRows),
    warnings,
    summary: {
      totalPortalRows: reports.portal.rows.length,
      synthesizedRows: synthesizedRows.length,
      rowsNeedingUpdate: synthesizedRows.filter((row) => row.shouldBeUpdated).length,
      rowsMissingAbpMatch,
      rowsMissingIccMatch,
    },
  };
}
