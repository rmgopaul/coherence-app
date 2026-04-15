/**
 * Application Pipeline tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 4 of the
 * god-component decomposition. Owns:
 *   - 5 useStates (4 range toggles + pipelineReportLoading)
 *   - 6 useMemos (pipelineMonthlyRows, pipelineRows3Year, pipelineRows12Month,
 *     pipelineCashFlowRows, cashFlowRows3Year, cashFlowRows12Month)
 *   - 1 useRef (cashFlowRows12MonthRef for the PDF generator closure)
 *   - 1 tRPC mutation (generatePipelineReport) - owned locally now
 *   - 1 massive useCallback (handleGeneratePipelineReport) that builds the
 *     ~330-line jsPDF + autoTable ChatGPT-assisted pipeline report
 *
 * The parent still owns:
 *   - `systems` (master system list)
 *   - `part2VerifiedAbpRows` (ABP rows filtered by Part 2 verification)
 *   - `contractScanResultsQuery` (tRPC query shared with Overview +
 *     Financials + Pipeline)
 *   - `financialCsgIds` (length check for the cash flow "data available"
 *     indicator)
 *   - `localOverrides` (Financials-tab override cache, used by the cash
 *     flow aggregator)
 *
 * Those four values come in via props. Switching away from the tab
 * unmounts this component, so none of the pipeline memos run when the
 * user is on any other tab.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import jsPDF from "jspdf";
import autoTable, { type CellHookData } from "jspdf-autotable";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/helpers";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import {
  buildPipelineBands,
  formatNumber,
  parseAbpAcSizeKw,
  parseDate,
  parseDateOnlineAsMidMonth,
  parseGeneratorDetailsAcSizeKw,
  parseNumber,
  parsePart2VerificationDate,
  pipelineRowGroupIndex,
  resolvePart2ProjectIdentity,
  roundMoney,
} from "@/solar-rec-dashboard/lib/helpers";
import { clean } from "@/lib/helpers";
import type {
  ContractScanResultRow,
  CsvDataset,
  CsvRow,
  PipelineCashFlowRow,
  PipelineMonthRow,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AppPipelineTabProps {
  // Raw datasets
  abpReport: CsvDataset | null;
  generatorDetails: CsvDataset | null;
  abpCsgSystemMapping: CsvDataset | null;
  abpIccReport3Rows: CsvDataset | null;

  // Upstream computed data from the parent
  systems: SystemRecord[];
  part2VerifiedAbpRows: CsvRow[];
  contractScanResults: ContractScanResultRow[];
  localOverrides: Map<string, { vfp: number; acp: number }>;
  financialCsgIdCount: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AppPipelineTab(props: AppPipelineTabProps) {
  const {
    abpReport,
    generatorDetails,
    abpCsgSystemMapping,
    abpIccReport3Rows,
    systems,
    part2VerifiedAbpRows,
    contractScanResults,
    localOverrides,
    financialCsgIdCount,
  } = props;

  // --- Range toggles ---
  const [pipelineCountRange, setPipelineCountRange] = useState<"3year" | "12month">("3year");
  const [pipelineKwRange, setPipelineKwRange] = useState<"3year" | "12month">("3year");
  const [pipelineInterconnectedRange, setPipelineInterconnectedRange] = useState<
    "3year" | "12month"
  >("3year");
  const [pipelineCashFlowRange, setPipelineCashFlowRange] = useState<"3year" | "12month">(
    "3year",
  );

  // --- PDF report generation state + tRPC mutation ---
  const [pipelineReportLoading, setPipelineReportLoading] = useState(false);
  const generatePipelineReport = trpc.openai.generatePipelineReport.useMutation();

  // -------------------------------------------------------------------------
  // Part 1 / Part 2 / Interconnected monthly buckets from ABP + Generator CSVs
  // -------------------------------------------------------------------------
  const pipelineMonthlyRows = useMemo<PipelineMonthRow[]>(() => {
    type RawBucket = {
      part1Count: number;
      part2Count: number;
      part1KwAc: number;
      part2KwAc: number;
      interconnectedCount: number;
      interconnectedKwAc: number;
    };
    const buckets = new Map<string, RawBucket>();

    const ensureBucket = (month: string) => {
      if (!buckets.has(month)) {
        buckets.set(month, {
          part1Count: 0,
          part2Count: 0,
          part1KwAc: 0,
          part2KwAc: 0,
          interconnectedCount: 0,
          interconnectedKwAc: 0,
        });
      }
      return buckets.get(month)!;
    };

    const today = new Date();
    const isFuture = (d: Date) => d > today;

    // Part 1 and Part 2 come from ABP report rows, deduped by canonical
    // project key.
    const seenPart1 = new Set<string>();
    const seenPart2 = new Set<string>();
    (abpReport?.rows ?? []).forEach((row, index) => {
      const { dedupeKey } = resolvePart2ProjectIdentity(row, index);

      // Part 1: keyed on Part_1_submission_date, kW from Inverter_Size_kW_AC_Part_1
      if (!seenPart1.has(dedupeKey)) {
        const submissionDate =
          parseDate(row.Part_1_submission_date) ??
          parseDate(row.Part_1_Submission_Date) ??
          parseDate(row.Part_1_Original_Submission_Date);
        if (submissionDate && !isFuture(submissionDate)) {
          seenPart1.add(dedupeKey);
          const month = `${submissionDate.getFullYear()}-${String(
            submissionDate.getMonth() + 1,
          ).padStart(2, "0")}`;
          const bucket = ensureBucket(month);
          bucket.part1Count += 1;

          const acKw = parseNumber(row.Inverter_Size_kW_AC_Part_1);
          if (acKw !== null) bucket.part1KwAc += acKw;
        }
      }

      // Part 2: keyed on Part_2_App_Verification_Date, kW from
      // Inverter_Size_kW_AC_Part_2
      if (!seenPart2.has(dedupeKey)) {
        const part2DateRaw =
          clean(row.Part_2_App_Verification_Date) ||
          clean(row.part_2_app_verification_date);
        const verificationDate = parsePart2VerificationDate(part2DateRaw);
        if (verificationDate && !isFuture(verificationDate)) {
          seenPart2.add(dedupeKey);
          const month = `${verificationDate.getFullYear()}-${String(
            verificationDate.getMonth() + 1,
          ).padStart(2, "0")}`;
          const bucket = ensureBucket(month);
          bucket.part2Count += 1;

          const acKw = parseAbpAcSizeKw(row);
          if (acKw !== null) bucket.part2KwAc += acKw;
        }
      }
    });

    // Interconnected comes from GATS Generator Details: Date Online /
    // Interconnection date by GATS Unit ID.
    const fallbackAcKwByTrackingId = new Map<string, number>();
    systems.forEach((system) => {
      const trackingId = clean(system.trackingSystemRefId);
      if (!trackingId || system.installedKwAc === null) return;
      if (!fallbackAcKwByTrackingId.has(trackingId)) {
        fallbackAcKwByTrackingId.set(trackingId, system.installedKwAc);
      }
    });

    const seenInterconnectedTrackingIds = new Set<string>();
    (generatorDetails?.rows ?? []).forEach((row) => {
      const trackingId =
        clean(row["GATS Unit ID"]) ||
        clean(row.gats_unit_id) ||
        clean(row["Unit ID"]) ||
        clean(row.unit_id);
      if (!trackingId || seenInterconnectedTrackingIds.has(trackingId)) return;

      const onlineDate =
        parseDateOnlineAsMidMonth(
          row["Date Online"] ??
            row["Date online"] ??
            row.date_online ??
            row.date_online_month_year,
        ) ??
        parseDate(row.Interconnection_Approval_Date_UTC_Part_2) ??
        parseDate(row.Project_Online_Date_Part_2) ??
        parseDate(row["Date Online"] ?? row.date_online);
      if (!onlineDate || isFuture(onlineDate)) return;
      seenInterconnectedTrackingIds.add(trackingId);

      const month = `${onlineDate.getFullYear()}-${String(
        onlineDate.getMonth() + 1,
      ).padStart(2, "0")}`;
      const bucket = ensureBucket(month);
      bucket.interconnectedCount += 1;

      const acKw =
        parseGeneratorDetailsAcSizeKw(row) ??
        fallbackAcKwByTrackingId.get(trackingId) ??
        null;
      if (acKw !== null) bucket.interconnectedKwAc += acKw;
    });

    // Build rows with prior-year comparison
    const rawRows = Array.from(buckets.entries())
      .map(([month, data]) => ({ month, ...data }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Index raw data by month for prior-year lookup
    const byMonth = new Map(rawRows.map((r) => [r.month, r]));

    return rawRows.map((row) => {
      const [yearStr, monthStr] = row.month.split("-");
      const prevMonth = `${Number(yearStr) - 1}-${monthStr}`;
      const prev = byMonth.get(prevMonth);
      return {
        ...row,
        prevPart1Count: prev?.part1Count ?? 0,
        prevPart2Count: prev?.part2Count ?? 0,
        prevPart1KwAc: prev?.part1KwAc ?? 0,
        prevPart2KwAc: prev?.part2KwAc ?? 0,
        prevInterconnectedCount: prev?.interconnectedCount ?? 0,
        prevInterconnectedKwAc: prev?.interconnectedKwAc ?? 0,
      };
    });
  }, [abpReport, generatorDetails, systems]);

  const pipelineRows3Year = useMemo(() => {
    const now = new Date();
    const cutoff = `${now.getFullYear() - 3}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return pipelineMonthlyRows.filter((row) => row.month >= cutoff);
  }, [pipelineMonthlyRows]);

  const pipelineRows12Month = useMemo(() => {
    const now = new Date();
    const cutoffDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}`;
    return pipelineMonthlyRows.filter((row) => row.month >= cutoff);
  }, [pipelineMonthlyRows]);

  // -------------------------------------------------------------------------
  // Cash flow aggregator — walks ABP Part II + CSG mapping + ICC + scan
  // results to project monthly vendor fee / CC auth / additional collateral.
  // Cash flow month = Part II verification month + 1.
  // -------------------------------------------------------------------------
  const pipelineCashFlowRows = useMemo<PipelineCashFlowRow[]>(() => {
    if (contractScanResults.length === 0) return [];

    // Build lookup maps (mirrors financialProfitData join chain)
    const scanByCsgId = new Map<string, ContractScanResultRow>();
    for (const r of contractScanResults) scanByCsgId.set(r.csgId, r);

    const mappingRows = abpCsgSystemMapping?.rows ?? [];
    const csgIdByAppId = new Map<string, string>();
    for (const row of mappingRows) {
      const csgId = (row.csgId || row["CSG ID"] || "").trim();
      const systemId = (row.systemId || row["System ID"] || "").trim();
      if (csgId && systemId) csgIdByAppId.set(systemId, csgId);
    }

    const iccRows = abpIccReport3Rows?.rows ?? [];
    const iccByAppId = new Map<string, { grossContractValue: number }>();
    for (const row of iccRows) {
      const appId = (
        row["Application ID"] ||
        row.Application_ID ||
        row.application_id ||
        ""
      ).trim();
      if (!appId) continue;
      const gcv =
        parseNumber(
          row["Total REC Delivery Contract Value"] ||
            row["REC Delivery Contract Value"] ||
            row["Total Contract Value"],
        ) ?? 0;
      const rq =
        parseNumber(
          row["Total Quantity of RECs Contracted"] ||
            row["Contracted SRECs"] ||
            row.SRECs,
        ) ?? 0;
      const rp = parseNumber(row["REC Price"]) ?? 0;
      const gross = gcv > 0 ? gcv : rq * rp;
      if (gross > 0) iccByAppId.set(appId, { grossContractValue: gross });
    }

    // Aggregate into monthly buckets keyed on cash-flow month (Part II month + 1)
    type CfBucket = {
      vendorFee: number;
      ccAuth: number;
      addlColl: number;
      count: number;
    };
    const byMonth = new Map<string, CfBucket>();
    const now = new Date();

    for (const abpRow of part2VerifiedAbpRows) {
      const appId = (abpRow.Application_ID || abpRow.application_id || "").trim();
      if (!appId) continue;

      const csgId = csgIdByAppId.get(appId);
      if (!csgId) continue;
      const scan = scanByCsgId.get(csgId);
      const icc = iccByAppId.get(appId);
      if (!scan || !icc) continue;

      // Parse Part II verification date
      const p2Raw =
        abpRow.Part_2_App_Verification_Date ||
        abpRow.part_2_app_verification_date ||
        "";
      const p2Date = parsePart2VerificationDate(p2Raw);
      if (!p2Date || p2Date > now) continue;

      // Cash flow month = verification month + 1
      const cfDate = new Date(p2Date.getFullYear(), p2Date.getMonth() + 1, 1);
      const cfMonth = `${cfDate.getFullYear()}-${String(cfDate.getMonth() + 1).padStart(2, "0")}`;

      const gcv = icc.grossContractValue;
      const localOv = localOverrides.get(csgId);
      const vfp =
        localOv?.vfp ?? scan.overrideVendorFeePercent ?? scan.vendorFeePercent ?? 0;
      const vendorFee = roundMoney(gcv * (vfp / 100));
      const ccAuth =
        scan.ccAuthorizationCompleted === false ? roundMoney(gcv * 0.05) : 0;
      const acp =
        localOv?.acp ??
        scan.overrideAdditionalCollateralPercent ??
        scan.additionalCollateralPercent ??
        0;
      const addlColl = roundMoney(gcv * (acp / 100));

      const bucket = byMonth.get(cfMonth) ?? {
        vendorFee: 0,
        ccAuth: 0,
        addlColl: 0,
        count: 0,
      };
      bucket.vendorFee = roundMoney(bucket.vendorFee + vendorFee);
      bucket.ccAuth = roundMoney(bucket.ccAuth + ccAuth);
      bucket.addlColl = roundMoney(bucket.addlColl + addlColl);
      bucket.count += 1;
      byMonth.set(cfMonth, bucket);
    }

    // Build rows with prior-year comparison
    const sortedMonths = Array.from(byMonth.keys()).sort();
    return sortedMonths.map((month) => {
      const b = byMonth.get(month)!;
      const [yearStr, monthStr] = month.split("-");
      const prevMonth = `${Number(yearStr) - 1}-${monthStr}`;
      const pb = byMonth.get(prevMonth);
      return {
        month,
        vendorFee: b.vendorFee,
        ccAuthCollateral: b.ccAuth,
        additionalCollateral: b.addlColl,
        totalCashFlow: roundMoney(b.vendorFee + b.ccAuth + b.addlColl),
        projectCount: b.count,
        prevVendorFee: pb?.vendorFee ?? 0,
        prevCcAuthCollateral: pb?.ccAuth ?? 0,
        prevAdditionalCollateral: pb?.addlColl ?? 0,
        prevTotalCashFlow: pb
          ? roundMoney(pb.vendorFee + pb.ccAuth + pb.addlColl)
          : 0,
        prevProjectCount: pb?.count ?? 0,
      };
    });
  }, [
    abpCsgSystemMapping,
    abpIccReport3Rows,
    contractScanResults,
    localOverrides,
    part2VerifiedAbpRows,
  ]);

  const cashFlowRows3Year = useMemo(() => {
    const now = new Date();
    const cutoff = `${now.getFullYear() - 3}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return pipelineCashFlowRows.filter((row) => row.month >= cutoff);
  }, [pipelineCashFlowRows]);

  const cashFlowRows12Month = useMemo(() => {
    const now = new Date();
    const cutoffDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}`;
    return pipelineCashFlowRows.filter((row) => row.month >= cutoff);
  }, [pipelineCashFlowRows]);

  // Ref so the PDF report's memoized callback can read the latest cash
  // flow rows without having to re-create the callback on every
  // aggregation change.
  const cashFlowRows12MonthRef = useRef<PipelineCashFlowRow[]>([]);
  cashFlowRows12MonthRef.current = cashFlowRows12Month;

  // -------------------------------------------------------------------------
  // PDF report generator — builds a ChatGPT-assisted jsPDF report with
  // the 12-month / 3-year summaries, YoY comparison, monthly detail,
  // and cash flow section.
  // -------------------------------------------------------------------------
  const handleGeneratePipelineReport = useCallback(async () => {
    if (pipelineReportLoading) return;
    setPipelineReportLoading(true);
    try {
      // Exclude the current (incomplete) month — only use fully completed months
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const completed3Year = pipelineRows3Year.filter((r) => r.month < currentMonth);
      const completed12Month = pipelineRows12Month.filter((r) => r.month < currentMonth);

      // Compute summary totals
      const sumFields = (rows: PipelineMonthRow[]) => ({
        totalPart1: rows.reduce((s, r) => s + r.part1Count, 0),
        totalPart2: rows.reduce((s, r) => s + r.part2Count, 0),
        totalPart1KwAc: rows.reduce((s, r) => s + r.part1KwAc, 0),
        totalPart2KwAc: rows.reduce((s, r) => s + r.part2KwAc, 0),
        totalInterconnected: rows.reduce((s, r) => s + r.interconnectedCount, 0),
        totalInterconnectedKwAc: rows.reduce((s, r) => s + r.interconnectedKwAc, 0),
      });
      const summaryTotals = {
        threeYear: sumFields(completed3Year),
        twelveMonth: sumFields(completed12Month),
      };

      // Build cash flow summary for the report
      const completedCashFlow12Mo = cashFlowRows12MonthRef.current.filter(
        (r) => r.month < currentMonth,
      );
      const cashFlowSummary =
        completedCashFlow12Mo.length > 0
          ? {
              rows12Month: completedCashFlow12Mo.map((r) => ({
                month: r.month,
                vendorFee: r.vendorFee,
                ccAuthCollateral: r.ccAuthCollateral,
                additionalCollateral: r.additionalCollateral,
                totalCashFlow: r.totalCashFlow,
                projectCount: r.projectCount,
              })),
              totalVendorFee12Mo: completedCashFlow12Mo.reduce(
                (s, r) => s + r.vendorFee,
                0,
              ),
              totalCollateral12Mo: completedCashFlow12Mo.reduce(
                (s, r) => s + r.ccAuthCollateral + r.additionalCollateral,
                0,
              ),
              totalCashFlow12Mo: completedCashFlow12Mo.reduce(
                (s, r) => s + r.totalCashFlow,
                0,
              ),
            }
          : undefined;

      // Call ChatGPT for analysis
      let result: { analysis: string };
      try {
        result = await generatePipelineReport.mutateAsync({
          generatedAt: new Date().toISOString(),
          rows3Year: completed3Year,
          rows12Month: completed12Month,
          summaryTotals,
          cashFlowSummary,
        });
      } catch (apiErr: unknown) {
        const apiMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
        alert(`ChatGPT API call failed:\n\n${apiMsg}`);
        setPipelineReportLoading(false);
        return;
      }

      // Build PDF
      const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const ml = 48; // margin left
      const mr = 48;
      const cw = pageWidth - ml - mr; // content width
      let y = 0;

      const navy: [number, number, number] = [15, 35, 75];
      const accent: [number, number, number] = [37, 99, 235];
      const slate500: [number, number, number] = [100, 116, 139];
      const slate200: [number, number, number] = [226, 232, 240];

      /** Ensure enough room; add page if not. Returns true if a new page was added. */
      const footerReserve = 52; // space for footer line + text
      const ensureSpace = (needed: number) => {
        if (y + needed > pageHeight - footerReserve) {
          doc.addPage();
          y = 48;
        }
      };

      // ── Header banner ──
      doc.setFillColor(...navy);
      doc.rect(0, 0, pageWidth, 80, "F");
      doc.setFontSize(22);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(255, 255, 255);
      doc.text("Application Pipeline Report", ml, 42);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(180, 200, 230);
      doc.text(
        `Generated ${new Date().toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })}`,
        ml,
        62,
      );
      y = 104;

      // ── Helper: section heading with accent line ──
      const sectionHeading = (title: string) => {
        ensureSpace(40);
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...navy);
        doc.text(title, ml, y);
        y += 4;
        doc.setDrawColor(...accent);
        doc.setLineWidth(2);
        doc.line(ml, y, ml + 80, y);
        doc.setDrawColor(0);
        y += 14;
      };

      // ── Render markdown analysis ──
      const bodySize = 10;
      const lineH = 14;
      const bulletIndent = 14;
      const textWidth = cw - 2; // slight buffer to prevent right-edge truncation
      const analysisLines = result.analysis.split("\n");

      for (const line of analysisLines) {
        const trimmed = line.trim();
        if (!trimmed) {
          y += 6;
          continue;
        }

        // ## Heading → section heading
        if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
          y += 8;
          const heading = trimmed.replace(/^#+\s+/, "").replace(/\*\*/g, "");
          sectionHeading(heading);
          continue;
        }

        ensureSpace(lineH * 2);

        // Bold-only line
        if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
          doc.setFontSize(bodySize);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(30, 30, 30);
          const text = trimmed.replace(/\*\*/g, "");
          const wrapped = doc.splitTextToSize(text, textWidth) as string[];
          for (const wline of wrapped) {
            ensureSpace(lineH);
            doc.text(wline, ml, y);
            y += lineH;
          }
          doc.setFont("helvetica", "normal");
          continue;
        }

        // Bullet point
        const isBullet = trimmed.startsWith("- ") || trimmed.startsWith("• ");
        if (isBullet) {
          const text = trimmed.slice(2).replace(/\*\*/g, "");
          doc.setFontSize(bodySize);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(50, 50, 50);
          // Bullet marker
          doc.setFillColor(...accent);
          doc.circle(ml + 4, y - 3, 2, "F");
          const bulletTextWidth = textWidth - bulletIndent - 4;
          const wrapped = doc.splitTextToSize(text, bulletTextWidth) as string[];
          for (const wline of wrapped) {
            ensureSpace(lineH);
            doc.text(wline, ml + bulletIndent, y);
            y += lineH;
          }
          y += 2;
          continue;
        }

        // Regular paragraph text — handle inline **bold** segments
        doc.setFontSize(bodySize);
        doc.setTextColor(50, 50, 50);
        const cleanText = trimmed.replace(/\*\*/g, "");
        doc.setFont("helvetica", "normal");
        const wrapped = doc.splitTextToSize(cleanText, textWidth) as string[];
        for (const wline of wrapped) {
          ensureSpace(lineH);
          doc.text(wline, ml, y);
          y += lineH;
        }
      }

      // ── Summary Statistics Table ──
      y += 16;
      sectionHeading("Summary Statistics");

      autoTable(doc, {
        startY: y,
        margin: { left: ml, right: mr },
        head: [["Metric", "Last 12 Months", "Last 3 Years"]],
        body: [
          [
            "Part I Submitted (Count)",
            formatNumber(summaryTotals.twelveMonth.totalPart1),
            formatNumber(summaryTotals.threeYear.totalPart1),
          ],
          [
            "Part II Verified (Count)",
            formatNumber(summaryTotals.twelveMonth.totalPart2),
            formatNumber(summaryTotals.threeYear.totalPart2),
          ],
          [
            "Part I Submitted (kW AC)",
            formatNumber(summaryTotals.twelveMonth.totalPart1KwAc, 1),
            formatNumber(summaryTotals.threeYear.totalPart1KwAc, 1),
          ],
          [
            "Part II Verified (kW AC)",
            formatNumber(summaryTotals.twelveMonth.totalPart2KwAc, 1),
            formatNumber(summaryTotals.threeYear.totalPart2KwAc, 1),
          ],
          [
            "Interconnected (Count)",
            formatNumber(summaryTotals.twelveMonth.totalInterconnected),
            formatNumber(summaryTotals.threeYear.totalInterconnected),
          ],
          [
            "Interconnected (kW AC)",
            formatNumber(summaryTotals.twelveMonth.totalInterconnectedKwAc, 1),
            formatNumber(summaryTotals.threeYear.totalInterconnectedKwAc, 1),
          ],
        ],
        styles: { fontSize: 9, cellPadding: 6, lineColor: slate200, lineWidth: 0.5 },
        headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", fontSize: 9 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
      });

      y = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
        ?.finalY
        ? (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
            .finalY + 28
        : y + 140;

      // ── Year-over-Year Comparison Table ──
      sectionHeading("Year-over-Year Comparison (Trailing 12 Months)");

      const pyTotals = {
        part1: completed12Month.reduce((s, r) => s + r.prevPart1Count, 0),
        part2: completed12Month.reduce((s, r) => s + r.prevPart2Count, 0),
        part1Kw: completed12Month.reduce((s, r) => s + r.prevPart1KwAc, 0),
        part2Kw: completed12Month.reduce((s, r) => s + r.prevPart2KwAc, 0),
        ic: completed12Month.reduce((s, r) => s + r.prevInterconnectedCount, 0),
        icKw: completed12Month.reduce((s, r) => s + r.prevInterconnectedKwAc, 0),
      };
      const t12 = summaryTotals.twelveMonth;
      const pctChg = (cur: number, prev: number) =>
        prev === 0
          ? cur > 0
            ? "+∞"
            : "—"
          : `${cur >= prev ? "+" : ""}${(((cur - prev) / prev) * 100).toFixed(1)}%`;

      autoTable(doc, {
        startY: y,
        margin: { left: ml, right: mr },
        head: [["Metric", "Current Period", "Prior Year", "Change"]],
        body: [
          [
            "Part I Submitted (Count)",
            formatNumber(t12.totalPart1),
            formatNumber(pyTotals.part1),
            pctChg(t12.totalPart1, pyTotals.part1),
          ],
          [
            "Part II Verified (Count)",
            formatNumber(t12.totalPart2),
            formatNumber(pyTotals.part2),
            pctChg(t12.totalPart2, pyTotals.part2),
          ],
          [
            "Part I Submitted (kW AC)",
            formatNumber(t12.totalPart1KwAc, 1),
            formatNumber(pyTotals.part1Kw, 1),
            pctChg(t12.totalPart1KwAc, pyTotals.part1Kw),
          ],
          [
            "Part II Verified (kW AC)",
            formatNumber(t12.totalPart2KwAc, 1),
            formatNumber(pyTotals.part2Kw, 1),
            pctChg(t12.totalPart2KwAc, pyTotals.part2Kw),
          ],
          [
            "Interconnected (Count)",
            formatNumber(t12.totalInterconnected),
            formatNumber(pyTotals.ic),
            pctChg(t12.totalInterconnected, pyTotals.ic),
          ],
          [
            "Interconnected (kW AC)",
            formatNumber(t12.totalInterconnectedKwAc, 1),
            formatNumber(pyTotals.icKw, 1),
            pctChg(t12.totalInterconnectedKwAc, pyTotals.icKw),
          ],
        ],
        styles: { fontSize: 9, cellPadding: 6, lineColor: slate200, lineWidth: 0.5 },
        headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", fontSize: 9 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: {
          1: { halign: "right" },
          2: { halign: "right" },
          3: { halign: "right" },
        },
        didParseCell: (data: CellHookData) => {
          // Color the Change column: green for positive, red for negative
          if (data.section === "body" && data.column.index === 3) {
            const val = data.cell.raw as string;
            if (val.startsWith("+")) data.cell.styles.textColor = [22, 163, 74];
            else if (val.startsWith("-")) data.cell.styles.textColor = [220, 38, 38];
          }
        },
      });

      y = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
        ?.finalY
        ? (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
            .finalY + 28
        : y + 140;

      // ── Monthly Detail Table ──
      sectionHeading("Monthly Detail (Last 12 Months)");

      autoTable(doc, {
        startY: y,
        margin: { left: ml, right: mr },
        head: [
          [
            "Month",
            "Part I (#)",
            "Part II (#)",
            "Part I (kW)",
            "Part II (kW)",
            "Interconn. (#)",
            "Interconn. (kW)",
          ],
        ],
        body: completed12Month.map((r) => [
          r.month,
          formatNumber(r.part1Count),
          formatNumber(r.part2Count),
          formatNumber(r.part1KwAc, 1),
          formatNumber(r.part2KwAc, 1),
          formatNumber(r.interconnectedCount),
          formatNumber(r.interconnectedKwAc, 1),
        ]),
        styles: { fontSize: 8, cellPadding: 5, lineColor: slate200, lineWidth: 0.5 },
        headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: {
          1: { halign: "right" },
          2: { halign: "right" },
          3: { halign: "right" },
          4: { halign: "right" },
          5: { halign: "right" },
          6: { halign: "right" },
        },
      });
      y = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
        ?.finalY
        ? (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
            .finalY + 28
        : y + 140;

      // ── Cash Flow Table ──
      if (cashFlowSummary && cashFlowSummary.rows12Month.length > 0) {
        ensureSpace(120);
        sectionHeading("Cash Flow Summary (Last 12 Months)");

        autoTable(doc, {
          startY: y,
          margin: { left: ml, right: mr },
          head: [["Month", "Vendor Fee", "CC Auth", "Add'l Coll.", "Total", "Projects"]],
          body: cashFlowSummary.rows12Month.map((r) => [
            r.month,
            formatCurrency(r.vendorFee),
            formatCurrency(r.ccAuthCollateral),
            formatCurrency(r.additionalCollateral),
            formatCurrency(r.totalCashFlow),
            formatNumber(r.projectCount),
          ]),
          styles: { fontSize: 8, cellPadding: 5, lineColor: slate200, lineWidth: 0.5 },
          headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", fontSize: 8 },
          alternateRowStyles: { fillColor: [248, 250, 252] },
          columnStyles: {
            1: { halign: "right" },
            2: { halign: "right" },
            3: { halign: "right" },
            4: { halign: "right" },
            5: { halign: "right" },
          },
          foot: [
            [
              "Total",
              formatCurrency(cashFlowSummary.totalVendorFee12Mo),
              formatCurrency(
                cashFlowSummary.rows12Month.reduce(
                  (s, r) => s + r.ccAuthCollateral,
                  0,
                ),
              ),
              formatCurrency(
                cashFlowSummary.rows12Month.reduce(
                  (s, r) => s + r.additionalCollateral,
                  0,
                ),
              ),
              formatCurrency(cashFlowSummary.totalCashFlow12Mo),
              formatNumber(
                cashFlowSummary.rows12Month.reduce(
                  (s, r) => s + r.projectCount,
                  0,
                ),
              ),
            ],
          ],
          footStyles: {
            fillColor: [241, 245, 249],
            textColor: navy,
            fontStyle: "bold",
            fontSize: 8,
          },
        });
      }

      // ── Footer on every page ──
      const totalPages = doc.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...slate500);
        doc.text("Coherence — Application Pipeline Report", ml, pageHeight - 24);
        doc.text(`Page ${p} of ${totalPages}`, pageWidth - mr, pageHeight - 24, {
          align: "right",
        });
        // thin line above footer
        doc.setDrawColor(...slate200);
        doc.setLineWidth(0.5);
        doc.line(ml, pageHeight - 36, pageWidth - mr, pageHeight - 36);
      }

      // Download
      const pdfBlob = doc.output("blob");
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Pipeline_Report_${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      console.error("PDF build error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`PDF generation failed:\n\n${msg}`);
    } finally {
      setPipelineReportLoading(false);
    }
  }, [pipelineReportLoading, pipelineRows3Year, pipelineRows12Month, generatePipelineReport]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  // Suppress unused Area import (recharts types require it even if we
  // don't use <Area/> currently — keeping to match parent imports).
  void Area;

  const countRows =
    pipelineCountRange === "3year" ? pipelineRows3Year : pipelineRows12Month;
  const kwRows = pipelineKwRange === "3year" ? pipelineRows3Year : pipelineRows12Month;
  const icRows =
    pipelineInterconnectedRange === "3year" ? pipelineRows3Year : pipelineRows12Month;
  const cashFlowRows =
    pipelineCashFlowRange === "3year" ? cashFlowRows3Year : cashFlowRows12Month;

  return (
    <div className="space-y-4 mt-4">
      {/* ====== Application Pipeline (Count) ====== */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Application Pipeline (Count)</CardTitle>
              <CardDescription>
                Monthly count of Part I Submitted and Part II Verified
                applications, deduplicated by Application ID. Prior-year
                values shown for comparison.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={pipelineCountRange === "3year" ? "default" : "outline"}
                size="sm"
                onClick={() => setPipelineCountRange("3year")}
              >
                Last 3 Years
              </Button>
              <Button
                variant={pipelineCountRange === "12month" ? "default" : "outline"}
                size="sm"
                onClick={() => setPipelineCountRange("12month")}
              >
                Last 12 Months
              </Button>
              <div className="w-px h-6 bg-slate-200 mx-1" />
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-800"
                disabled={pipelineReportLoading || pipelineMonthlyRows.length === 0}
                onClick={handleGeneratePipelineReport}
              >
                {pipelineReportLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                {pipelineReportLoading ? "Generating…" : "PDF Report"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={countRows} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                {buildPipelineBands(countRows).map((band) => (
                  <ReferenceArea
                    key={band.x1}
                    x1={band.x1}
                    x2={band.x2}
                    fill="#f1f5f9"
                    fillOpacity={0.7}
                    ifOverflow="extendDomain"
                  />
                ))}
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={50}
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="part1Count" fill="#3b82f6" name="Part I Submitted" />
                <Bar dataKey="part2Count" fill="#16a34a" name="Part II Verified" />
                <Line
                  type="monotone"
                  dataKey="prevPart1Count"
                  stroke="#93c5fd"
                  strokeDasharray="5 3"
                  strokeWidth={2}
                  dot={false}
                  name="Part I (Prior Year)"
                />
                <Line
                  type="monotone"
                  dataKey="prevPart2Count"
                  stroke="#86efac"
                  strokeDasharray="5 3"
                  strokeWidth={2}
                  dot={false}
                  name="Part II (Prior Year)"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Part I Submitted</TableHead>
                  <TableHead className="text-right text-blue-300">
                    Part I (Prior Yr)
                  </TableHead>
                  <TableHead className="text-right">Part II Verified</TableHead>
                  <TableHead className="text-right text-emerald-300">
                    Part II (Prior Yr)
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {countRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-slate-500">
                      No pipeline data available. Upload ABP Report files.
                    </TableCell>
                  </TableRow>
                ) : (
                  countRows.map((row) => {
                    const groupIdx = pipelineRowGroupIndex(countRows, row.month);
                    const shaded = groupIdx % 2 === 1;
                    return (
                      <TableRow key={row.month} className={shaded ? "bg-slate-50" : ""}>
                        <TableCell className="font-medium">{row.month}</TableCell>
                        <TableCell className="text-right">
                          {formatNumber(row.part1Count)}
                        </TableCell>
                        <TableCell className="text-right text-slate-400">
                          {formatNumber(row.prevPart1Count)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatNumber(row.part2Count)}
                        </TableCell>
                        <TableCell className="text-right text-slate-400">
                          {formatNumber(row.prevPart2Count)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ====== Application Pipeline (kW AC) ====== */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Application Pipeline (kW AC)</CardTitle>
              <CardDescription>
                Monthly sum of inverter capacity — Inverter_Size_kW_AC_Part_1
                for Part I, Inverter_Size_kW_AC_Part_2 for Part II. Prior-year
                values shown for comparison.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant={pipelineKwRange === "3year" ? "default" : "outline"}
                size="sm"
                onClick={() => setPipelineKwRange("3year")}
              >
                Last 3 Years
              </Button>
              <Button
                variant={pipelineKwRange === "12month" ? "default" : "outline"}
                size="sm"
                onClick={() => setPipelineKwRange("12month")}
              >
                Last 12 Months
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={kwRows} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                {buildPipelineBands(kwRows).map((band) => (
                  <ReferenceArea
                    key={band.x1}
                    x1={band.x1}
                    x2={band.x2}
                    fill="#f1f5f9"
                    fillOpacity={0.7}
                    ifOverflow="extendDomain"
                  />
                ))}
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={50}
                />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value: number) => formatNumber(value, 1) + " kW"} />
                <Legend />
                <Bar dataKey="part1KwAc" fill="#3b82f6" name="Part I kW AC" />
                <Bar dataKey="part2KwAc" fill="#16a34a" name="Part II kW AC" />
                <Line
                  type="monotone"
                  dataKey="prevPart1KwAc"
                  stroke="#93c5fd"
                  strokeDasharray="5 3"
                  strokeWidth={2}
                  dot={false}
                  name="Part I kW AC (Prior Year)"
                />
                <Line
                  type="monotone"
                  dataKey="prevPart2KwAc"
                  stroke="#86efac"
                  strokeDasharray="5 3"
                  strokeWidth={2}
                  dot={false}
                  name="Part II kW AC (Prior Year)"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Part I kW AC</TableHead>
                  <TableHead className="text-right text-blue-300">
                    Part I kW (Prior Yr)
                  </TableHead>
                  <TableHead className="text-right">Part II kW AC</TableHead>
                  <TableHead className="text-right text-emerald-300">
                    Part II kW (Prior Yr)
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kwRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-slate-500">
                      No pipeline data available. Upload ABP Report files.
                    </TableCell>
                  </TableRow>
                ) : (
                  kwRows.map((row) => {
                    const groupIdx = pipelineRowGroupIndex(kwRows, row.month);
                    const shaded = groupIdx % 2 === 1;
                    return (
                      <TableRow key={row.month} className={shaded ? "bg-slate-50" : ""}>
                        <TableCell className="font-medium">{row.month}</TableCell>
                        <TableCell className="text-right">
                          {formatNumber(row.part1KwAc, 1)}
                        </TableCell>
                        <TableCell className="text-right text-slate-400">
                          {formatNumber(row.prevPart1KwAc, 1)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatNumber(row.part2KwAc, 1)}
                        </TableCell>
                        <TableCell className="text-right text-slate-400">
                          {formatNumber(row.prevPart2KwAc, 1)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ====== Capacity Interconnected (kW AC by Energization_Date) ====== */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Capacity Interconnected (kW AC)</CardTitle>
              <CardDescription>
                Monthly interconnections from GATS Generator Details (`Date
                Online` + `GATS Unit ID`). kW AC uses Generator Details size
                fields when present, with tracking-ID fallback to portfolio
                AC size. Prior-year values shown for comparison.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant={pipelineInterconnectedRange === "3year" ? "default" : "outline"}
                size="sm"
                onClick={() => setPipelineInterconnectedRange("3year")}
              >
                Last 3 Years
              </Button>
              <Button
                variant={pipelineInterconnectedRange === "12month" ? "default" : "outline"}
                size="sm"
                onClick={() => setPipelineInterconnectedRange("12month")}
              >
                Last 12 Months
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={icRows} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                {buildPipelineBands(icRows).map((band) => (
                  <ReferenceArea
                    key={band.x1}
                    x1={band.x1}
                    x2={band.x2}
                    fill="#f1f5f9"
                    fillOpacity={0.7}
                    ifOverflow="extendDomain"
                  />
                ))}
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={50}
                />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value: number) => formatNumber(value, 1) + " kW"} />
                <Legend />
                <Bar dataKey="interconnectedKwAc" fill="#8b5cf6" name="Interconnected kW AC" />
                <Line
                  type="monotone"
                  dataKey="prevInterconnectedKwAc"
                  stroke="#c4b5fd"
                  strokeDasharray="5 3"
                  strokeWidth={2}
                  dot={false}
                  name="Interconnected kW AC (Prior Year)"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto rounded-md border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Systems Interconnected</TableHead>
                  <TableHead className="text-right text-violet-300">
                    Systems (Prior Yr)
                  </TableHead>
                  <TableHead className="text-right">kW AC Interconnected</TableHead>
                  <TableHead className="text-right text-violet-300">
                    kW AC (Prior Yr)
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {icRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-slate-500">
                      No interconnection data available. Upload GATS Generator
                      Details with `GATS Unit ID` and `Date Online`.
                    </TableCell>
                  </TableRow>
                ) : (
                  icRows.map((row) => {
                    const groupIdx = pipelineRowGroupIndex(icRows, row.month);
                    const shaded = groupIdx % 2 === 1;
                    return (
                      <TableRow key={row.month} className={shaded ? "bg-slate-50" : ""}>
                        <TableCell className="font-medium">{row.month}</TableCell>
                        <TableCell className="text-right">
                          {formatNumber(row.interconnectedCount)}
                        </TableCell>
                        <TableCell className="text-right text-slate-400">
                          {formatNumber(row.prevInterconnectedCount)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatNumber(row.interconnectedKwAc, 1)}
                        </TableCell>
                        <TableCell className="text-right text-slate-400">
                          {formatNumber(row.prevInterconnectedKwAc, 1)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ====== Cash Flow Pipeline ====== */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Cash Flow Pipeline</CardTitle>
              <CardDescription>
                Projected monthly cash flow to CSG. Part II verified in month
                M triggers an invoice on the 1st of M+1, with payment by end
                of M+1. Shows vendor fee revenue and collateral obligations.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={pipelineCashFlowRange === "3year" ? "default" : "outline"}
                size="sm"
                onClick={() => setPipelineCashFlowRange("3year")}
              >
                Last 3 Years
              </Button>
              <Button
                variant={pipelineCashFlowRange === "12month" ? "default" : "outline"}
                size="sm"
                onClick={() => setPipelineCashFlowRange("12month")}
              >
                Last 12 Months
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {financialCsgIdCount === 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Cash flow data requires <strong>ABP CSG-System Mapping</strong>,{" "}
              <strong>ICC Report 3</strong>, and <strong>Contract Scan</strong> results.
              Upload these datasets and ensure contracts have been scanned to see
              projected cash flow.
            </div>
          ) : (
            <>
              <div className="h-80 rounded-md border border-slate-200 bg-white p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={cashFlowRows}
                    margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    {buildPipelineBands(cashFlowRows).map((band) => (
                      <ReferenceArea
                        key={band.x1}
                        x1={band.x1}
                        x2={band.x2}
                        fill="#f1f5f9"
                        fillOpacity={0.7}
                        ifOverflow="extendDomain"
                      />
                    ))}
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 11 }}
                      angle={-45}
                      textAnchor="end"
                      height={50}
                    />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      tickFormatter={(v: number) => `$${formatNumber(v)}`}
                    />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Legend />
                    <Bar dataKey="vendorFee" stackId="cf" fill="#16a34a" name="Vendor Fee" />
                    <Bar
                      dataKey="ccAuthCollateral"
                      stackId="cf"
                      fill="#f59e0b"
                      name="CC Auth Collateral"
                    />
                    <Bar
                      dataKey="additionalCollateral"
                      stackId="cf"
                      fill="#ef4444"
                      name="Add'l Collateral"
                    />
                    <Line
                      type="monotone"
                      dataKey="prevTotalCashFlow"
                      stroke="#94a3b8"
                      strokeDasharray="5 3"
                      strokeWidth={2}
                      dot={false}
                      name="Total (Prior Year)"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="overflow-x-auto rounded-md border border-slate-200">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Vendor Fee</TableHead>
                      <TableHead className="text-right">CC Auth</TableHead>
                      <TableHead className="text-right">Add'l Coll.</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Projects</TableHead>
                      <TableHead className="text-right text-slate-400">
                        Prior Yr Total
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cashFlowRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-6 text-center text-slate-500">
                          No cash flow data available. Ensure Part II verified
                          projects have CSG mappings, ICC data, and scanned
                          contracts.
                        </TableCell>
                      </TableRow>
                    ) : (
                      cashFlowRows.map((row) => {
                        const groupIdx = pipelineRowGroupIndex(cashFlowRows, row.month);
                        const shaded = groupIdx % 2 === 1;
                        return (
                          <TableRow key={row.month} className={shaded ? "bg-slate-50" : ""}>
                            <TableCell className="font-medium">{row.month}</TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(row.vendorFee)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(row.ccAuthCollateral)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(row.additionalCollateral)}
                            </TableCell>
                            <TableCell className="text-right font-semibold">
                              {formatCurrency(row.totalCashFlow)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatNumber(row.projectCount)}
                            </TableCell>
                            <TableCell className="text-right text-slate-400">
                              {formatCurrency(row.prevTotalCashFlow)}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
