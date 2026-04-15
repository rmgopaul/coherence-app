import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { clean, formatCurrency, downloadTextFile } from "@/lib/helpers";
import { ArrowLeft, Download, Loader2, Trash2, Upload } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  // Types
  type UploadedDataset,
  type InvoiceSourceRow,
  type QuickBooksInvoice,
  type InvoiceCell,
  type PotentialMatch,
  type DashboardRow,
  type LineItemCategoryKey,
  type CsgLookupRow,
  type PersistedDashboardState,
  LINE_ITEM_CATEGORY_DEFINITIONS,
  COLLATOR,
  POTENTIAL_MATCH_LIMIT,
  PERSISTENCE_VERSION,
  // Helpers
  parseCsv,
  normalizeText,
  formatQuickBooksLineItemText,
  formatUploadedAt,
  buildCsv,
  formatNumberForCsv,
  formatCurrencyOrDash,
  normalizeInvoiceReference,
  parseCsgIdsFromText,
  parseCsgIdsFile,
  summarizeInvoiceCategoryTotals,
  detectLineItemCategories,
  getStatusClassName,
  parseInvoicesFile,
  parseQuickBooksFile,
  buildDashboardRows,
  serializeDataset,
  deserializeDataset,
  serializeInvoiceRows,
  deserializeInvoiceRows,
  serializeQuickBooksInvoices,
  deserializeQuickBooksInvoices,
  readPersistedDashboardState,
  writePersistedDashboardState,
  clearPersistedDashboardState,
} from "./invoiceMatch";

export default function InvoiceMatchDashboard() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();

  const [invoiceRows, setInvoiceRows] = useState<InvoiceSourceRow[]>([]);
  const [quickBooksByInvoice, setQuickBooksByInvoice] = useState<Map<string, QuickBooksInvoice>>(new Map());

  const [invoiceDataset, setInvoiceDataset] = useState<UploadedDataset | null>(null);
  const [quickBooksDataset, setQuickBooksDataset] = useState<UploadedDataset | null>(null);

  const [isParsingInvoices, setIsParsingInvoices] = useState(false);
  const [isParsingQuickBooks, setIsParsingQuickBooks] = useState(false);
  const [isParsingLookupCsgIds, setIsParsingLookupCsgIds] = useState(false);
  const [csgLookupInput, setCsgLookupInput] = useState("");
  const [uploadedLookupCsgIds, setUploadedLookupCsgIds] = useState<string[]>([]);
  const [lookupCsgDataset, setLookupCsgDataset] = useState<UploadedDataset | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState<"all" | "missing-invoice" | "with-potential">("all");
  const [sortBy, setSortBy] = useState<"system-asc" | "system-desc" | "invoice-qty-desc" | "potential-desc">(
    "system-asc"
  );

  const [pageSize, setPageSize] = useState("50");
  const [page, setPage] = useState(1);
  const [isRestoringPersistedState, setIsRestoringPersistedState] = useState(true);
  const hasRestoredPersistedStateRef = useRef(false);
  const hasShownPersistenceErrorRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const loadPersistedState = async () => {
      try {
        const persisted = await readPersistedDashboardState();
        if (cancelled || !persisted) return;

        setInvoiceDataset(deserializeDataset(persisted.invoiceDataset));
        setQuickBooksDataset(deserializeDataset(persisted.quickBooksDataset));
        setInvoiceRows(deserializeInvoiceRows(persisted.invoiceRows));
        setQuickBooksByInvoice(deserializeQuickBooksInvoices(persisted.quickBooksInvoices));
        setCsgLookupInput(clean(persisted.csgLookupInput));
        setUploadedLookupCsgIds(
          Array.isArray(persisted.uploadedLookupCsgIds)
            ? Array.from(
                new Set(
                  persisted.uploadedLookupCsgIds
                    .map((value) => clean(value))
                    .filter(Boolean)
                )
              )
            : []
        );
        setLookupCsgDataset(deserializeDataset(persisted.lookupCsgDataset));
      } catch (error) {
        if (!cancelled && !hasShownPersistenceErrorRef.current) {
          hasShownPersistenceErrorRef.current = true;
          const message = error instanceof Error ? error.message : "Unknown persistence error.";
          toast.error(`Saved invoice dashboard data could not be restored: ${message}`);
        }
      } finally {
        if (!cancelled) {
          hasRestoredPersistedStateRef.current = true;
          setIsRestoringPersistedState(false);
        }
      }
    };

    void loadPersistedState();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasRestoredPersistedStateRef.current) return;
    if (typeof window === "undefined") return;

    const timer = window.setTimeout(() => {
      const shouldClearPersistedState =
        !invoiceDataset &&
        !quickBooksDataset &&
        !lookupCsgDataset &&
        clean(csgLookupInput).length === 0 &&
        uploadedLookupCsgIds.length === 0 &&
        invoiceRows.length === 0 &&
        quickBooksByInvoice.size === 0;

      if (shouldClearPersistedState) {
        void clearPersistedDashboardState().catch((error) => {
          if (hasShownPersistenceErrorRef.current) return;
          hasShownPersistenceErrorRef.current = true;
          const message = error instanceof Error ? error.message : "Unknown persistence error.";
          toast.error(`Saved invoice dashboard data could not be cleared: ${message}`);
        });
        return;
      }

      const payload: PersistedDashboardState = {
        version: PERSISTENCE_VERSION,
        invoiceDataset: serializeDataset(invoiceDataset),
        quickBooksDataset: serializeDataset(quickBooksDataset),
        invoiceRows: serializeInvoiceRows(invoiceRows),
        quickBooksInvoices: serializeQuickBooksInvoices(quickBooksByInvoice),
        csgLookupInput,
        uploadedLookupCsgIds,
        lookupCsgDataset: serializeDataset(lookupCsgDataset),
      };

      void writePersistedDashboardState(payload)
        .then(() => {
          hasShownPersistenceErrorRef.current = false;
        })
        .catch((error) => {
          if (hasShownPersistenceErrorRef.current) return;
          hasShownPersistenceErrorRef.current = true;
          const message = error instanceof Error ? error.message : "Unknown persistence error.";
          toast.error(`Saved invoice dashboard data could not be updated: ${message}`);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    invoiceDataset,
    quickBooksDataset,
    lookupCsgDataset,
    csgLookupInput,
    uploadedLookupCsgIds,
    invoiceRows,
    quickBooksByInvoice,
  ]);

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, setLocation, user]);

  const rows = useMemo(
    () => buildDashboardRows(invoiceRows, quickBooksByInvoice),
    [invoiceRows, quickBooksByInvoice]
  );

  const lookupCsgIds = useMemo(
    () => Array.from(new Set([...parseCsgIdsFromText(csgLookupInput), ...uploadedLookupCsgIds])),
    [csgLookupInput, uploadedLookupCsgIds]
  );

  const csgLookupRows = useMemo(() => {
    if (!lookupCsgIds.length) return [] as CsgLookupRow[];

    const bySystemId = new Map<string, InvoiceSourceRow[]>();
    invoiceRows.forEach((row) => {
      const systemId = clean(row.systemId);
      if (!systemId) return;
      const existing = bySystemId.get(systemId) ?? [];
      existing.push(row);
      bySystemId.set(systemId, existing);
    });

    const result: CsgLookupRow[] = [];

    const toGeneralStatus = (invoice: QuickBooksInvoice | undefined, sourceRowsForInvoice: InvoiceSourceRow[]): string => {
      if (invoice) {
        if (normalizeText(invoice.voided) === "yes") return "Voided";
        const amount = invoice.amount;
        const cash = invoice.cashReceived;
        if (amount !== null && cash !== null && Number.isFinite(amount) && Number.isFinite(cash)) {
          if (cash >= amount - 0.01) return "Paid";
          if (cash > 0) return "Partially Paid";
          return "Not Paid";
        }
        const paymentStatus = normalizeText(invoice.paymentStatus);
        if (paymentStatus === "paid") return "Paid";
        if (paymentStatus.includes("unpaid")) return "Not Paid";
      }

      const sourceStatus = sourceRowsForInvoice
        .map((row) => normalizeText(row.status))
        .find((status) => status.length > 0) ?? "";
      if (sourceStatus === "paid") return "Paid";
      if (sourceStatus.includes("unpaid") || sourceStatus.includes("not paid")) return "Not Paid";
      if (sourceStatus.includes("void")) return "Voided";
      return invoice ? clean(invoice.paymentStatus) || "Unknown" : "Not Paid";
    };

    lookupCsgIds.forEach((csgId) => {
      const rowsForCsg = bySystemId.get(csgId) ?? [];
      if (!rowsForCsg.length) {
        result.push({
          csgId,
          invoiceNumber: "",
          applicationFeePaid: null,
          collateral5PercentPaid: null,
          ccFeePaid: null,
          totalAmountPaid: null,
          generalStatus: "No Invoice Found",
        });
        return;
      }

      const byInvoiceNumber = new Map<string, InvoiceSourceRow[]>();
      rowsForCsg.forEach((row) => {
        const invoiceNumber = clean(row.invoiceNumber);
        if (!invoiceNumber) return;
        const existing = byInvoiceNumber.get(invoiceNumber) ?? [];
        existing.push(row);
        byInvoiceNumber.set(invoiceNumber, existing);
      });

      if (byInvoiceNumber.size === 0) {
        result.push({
          csgId,
          invoiceNumber: "",
          applicationFeePaid: null,
          collateral5PercentPaid: null,
          ccFeePaid: null,
          totalAmountPaid: null,
          generalStatus: "Invoice Number Missing",
        });
        return;
      }

      byInvoiceNumber.forEach((sourceRowsForInvoice, invoiceNumber) => {
        const quickBooksInvoice = quickBooksByInvoice.get(invoiceNumber);
        const invoiceAmount = quickBooksInvoice?.amount ?? null;
        const invoiceCashReceived = quickBooksInvoice?.cashReceived ?? null;
        const paymentRatio =
          invoiceAmount !== null &&
          invoiceCashReceived !== null &&
          Number.isFinite(invoiceAmount) &&
          Number.isFinite(invoiceCashReceived) &&
          invoiceAmount > 0
            ? Math.max(0, Math.min(1, invoiceCashReceived / invoiceAmount))
            : normalizeText(quickBooksInvoice?.paymentStatus ?? "") === "paid" &&
                invoiceAmount !== null &&
                Number.isFinite(invoiceAmount) &&
                invoiceAmount > 0
              ? 1
              : 0;

        let applicationFeePaid = 0;
        let collateral5PercentPaid = 0;
        let ccFeePaid = 0;

        const applyCategoryAmount = (category: LineItemCategoryKey, amount: number | null) => {
          if (amount === null || !Number.isFinite(amount)) return;
          const paidAmount = amount * paymentRatio;
          if (category === "abpApplicationFee") applicationFeePaid += paidAmount;
          if (category === "utilityHeldCollateral5Percent") collateral5PercentPaid += paidAmount;
          if (category === "ccFee") ccFeePaid += Math.abs(paidAmount);
        };

        if (quickBooksInvoice?.lineItems.length) {
          quickBooksInvoice.lineItems.forEach((lineItem) => {
            const categories = detectLineItemCategories(lineItem.description);
            if (categories.length !== 1) return;
            applyCategoryAmount(categories[0], lineItem.amount);
          });
        } else {
          sourceRowsForInvoice.forEach((sourceRow) => {
            const fallbackCategories = detectLineItemCategories(sourceRow.type);
            if (fallbackCategories.length !== 1) return;
            applyCategoryAmount(fallbackCategories[0], sourceRow.amount);
          });
        }

        result.push({
          csgId,
          invoiceNumber,
          applicationFeePaid: applicationFeePaid > 0 ? Math.round(applicationFeePaid * 100) / 100 : null,
          collateral5PercentPaid: collateral5PercentPaid > 0 ? Math.round(collateral5PercentPaid * 100) / 100 : null,
          ccFeePaid: ccFeePaid > 0 ? Math.round(ccFeePaid * 100) / 100 : null,
          totalAmountPaid:
            invoiceCashReceived !== null && Number.isFinite(invoiceCashReceived)
              ? Math.round(invoiceCashReceived * 100) / 100
              : null,
          generalStatus: toGeneralStatus(quickBooksInvoice, sourceRowsForInvoice),
        });
      });
    });

    return result.sort((left, right) => {
      const csgCompare = COLLATOR.compare(left.csgId, right.csgId);
      if (csgCompare !== 0) return csgCompare;
      return COLLATOR.compare(left.invoiceNumber, right.invoiceNumber);
    });
  }, [invoiceRows, lookupCsgIds, quickBooksByInvoice]);

  const availableStatuses = useMemo(() => {
    const statusMap = new Map<string, string>();
    rows.forEach((row) => {
      row.statuses.forEach((status) => {
        const token = normalizeText(status);
        if (!token) return;
        if (!statusMap.has(token)) {
          statusMap.set(token, status);
        }
      });
    });

    return Array.from(statusMap.entries())
      .sort((left, right) => COLLATOR.compare(left[1], right[1]))
      .map(([token, label]) => ({ token, label }));
  }, [rows]);

  const sortedRows = useMemo(() => {
    const sorted = [...rows];

    sorted.sort((left, right) => {
      if (sortBy === "system-asc") {
        return COLLATOR.compare(left.systemId, right.systemId);
      }

      if (sortBy === "system-desc") {
        return COLLATOR.compare(right.systemId, left.systemId);
      }

      if (sortBy === "invoice-qty-desc") {
        if (right.invoiceCount !== left.invoiceCount) return right.invoiceCount - left.invoiceCount;
        return COLLATOR.compare(left.systemId, right.systemId);
      }

      const leftScore = left.potentialMatches[0]?.score ?? Number.NEGATIVE_INFINITY;
      const rightScore = right.potentialMatches[0]?.score ?? Number.NEGATIVE_INFINITY;
      if (rightScore !== leftScore) return rightScore - leftScore;
      return COLLATOR.compare(left.systemId, right.systemId);
    });

    return sorted;
  }, [rows, sortBy]);

  const filteredRows = useMemo(() => {
    const searchToken = normalizeText(searchTerm);

    return sortedRows.filter((row) => {
      if (statusFilter !== "all" && !row.statusTokens.includes(statusFilter)) {
        return false;
      }

      if (scopeFilter === "missing-invoice" && !row.hasMissingInvoiceNumber) {
        return false;
      }

      if (scopeFilter === "with-potential" && row.potentialMatches.length === 0) {
        return false;
      }

      if (!searchToken) return true;
      return row.searchIndex.includes(searchToken);
    });
  }, [searchTerm, sortedRows, statusFilter, scopeFilter]);

  useEffect(() => {
    setPage(1);
  }, [searchTerm, statusFilter, scopeFilter, sortBy, pageSize]);

  const numericPageSize = Math.max(1, Number(pageSize) || 50);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / numericPageSize));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    if (safePage !== page) {
      setPage(safePage);
    }
  }, [page, safePage]);

  const pageRows = useMemo(() => {
    const start = (safePage - 1) * numericPageSize;
    return filteredRows.slice(start, start + numericPageSize);
  }, [filteredRows, numericPageSize, safePage]);

  const maxInvoiceSlots = useMemo(() => {
    if (!filteredRows.length) return 1;
    return Math.max(1, ...filteredRows.map((row) => row.invoiceCount));
  }, [filteredRows]);

  const maxLineItemSlotsPerInvoice = useMemo(() => {
    if (!filteredRows.length) {
      return Array.from({ length: maxInvoiceSlots }, () => 1);
    }

    return Array.from({ length: maxInvoiceSlots }, (_, invoiceIndex) => {
      return Math.max(
        1,
        ...filteredRows.map((row) => {
          const invoice = row.invoices[invoiceIndex];
          if (!invoice) return 0;
          return Math.max(1, invoice.quickBooksLineItems.length);
        })
      );
    });
  }, [filteredRows, maxInvoiceSlots]);

  const systemsWithPotentialMatches = useMemo(
    () => rows.filter((row) => row.potentialMatches.length > 0).length,
    [rows]
  );

  const systemsWithMissingInvoiceNumber = useMemo(
    () => rows.filter((row) => row.hasMissingInvoiceNumber).length,
    [rows]
  );

  const handleExportFilteredRows = () => {
    if (!filteredRows.length) {
      toast.error("No rows available to export.");
      return;
    }

    const baseHeaders = [
      "System ID",
      "Invoice Quantity",
      "Cash Received Total",
    ];

    const invoiceDetailHeaders = Array.from({ length: maxInvoiceSlots }).flatMap((_, invoiceIndex) => {
      const lineItemHeaders = Array.from({
        length: maxLineItemSlotsPerInvoice[invoiceIndex] ?? 1,
      }).flatMap((__, lineItemIndex) => [
        `Invoice #${invoiceIndex + 1} - Line Item #${lineItemIndex + 1}`,
        `Invoice #${invoiceIndex + 1} - Line Item #${lineItemIndex + 1} - Amount #${lineItemIndex + 1}`,
      ]);

      return [
        `Invoice #${invoiceIndex + 1}`,
        `Invoice #${invoiceIndex + 1} Status (QuickBooks)`,
        `Invoice #${invoiceIndex + 1} Amount`,
        `Invoice #${invoiceIndex + 1} Cash Received`,
        `Invoice #${invoiceIndex + 1} Quantity of Line Items`,
        `Invoice #${invoiceIndex + 1} Application Fee Amount`,
        `Invoice #${invoiceIndex + 1} 5% Collateral Amount`,
        `Invoice #${invoiceIndex + 1} CC Fee Amount`,
        ...lineItemHeaders,
      ];
    });

    const lineItemAmountHeaders = LINE_ITEM_CATEGORY_DEFINITIONS.map(
      (category) => `${category.label} Amount`
    );
    const lineItemInvoiceHeaders = LINE_ITEM_CATEGORY_DEFINITIONS.map(
      (category) => `${category.label} Invoices`
    );

    const potentialHeaders = Array.from({ length: POTENTIAL_MATCH_LIMIT }).flatMap((_, index) => [
      `Potential Match ${index + 1} Invoice`,
      `Potential Match ${index + 1} Score`,
      `Potential Match ${index + 1} Cash`,
      `Potential Match ${index + 1} Why`,
    ]);

    const headers = [
      ...baseHeaders,
      ...invoiceDetailHeaders,
      ...lineItemAmountHeaders,
      ...lineItemInvoiceHeaders,
      "Other Line Item Notes",
      ...potentialHeaders,
    ];

    const rowsForCsv = filteredRows.map((row) => {
      const record: Record<string, string | number | null> = {};
      const cashReceivedTotal = row.invoices.reduce((sum, invoice) => {
        if (invoice.cashReceived === null || !Number.isFinite(invoice.cashReceived)) return sum;
        return sum + invoice.cashReceived;
      }, 0);

      record["System ID"] = row.systemId;
      record["Invoice Quantity"] = row.invoiceCount;
      record["Cash Received Total"] = cashReceivedTotal.toFixed(2);

      Array.from({ length: maxInvoiceSlots }).forEach((_, index) => {
        const invoice = row.invoices[index];
        const lineItems =
          invoice && invoice.quickBooksLineItems.length === 0 && clean(invoice.lineItem)
            ? [{ description: clean(invoice.lineItem), amount: invoice.amount }]
            : invoice?.quickBooksLineItems ?? [];
        const maxLineItemsForInvoice = maxLineItemSlotsPerInvoice[index] ?? 1;
        const categoryTotals = summarizeInvoiceCategoryTotals(invoice);

        record[`Invoice #${index + 1}`] = invoice?.invoiceNumber ?? "";
        record[`Invoice #${index + 1} Status (QuickBooks)`] = clean(invoice?.status);
        record[`Invoice #${index + 1} Amount`] = formatNumberForCsv(invoice?.amount ?? null);
        record[`Invoice #${index + 1} Cash Received`] = formatNumberForCsv(invoice?.cashReceived ?? null);
        record[`Invoice #${index + 1} Quantity of Line Items`] = invoice ? lineItems.length : "";
        record[`Invoice #${index + 1} Application Fee Amount`] = formatNumberForCsv(
          categoryTotals.abpApplicationFee > 0 ? categoryTotals.abpApplicationFee : null
        );
        record[`Invoice #${index + 1} 5% Collateral Amount`] = formatNumberForCsv(
          categoryTotals.utilityHeldCollateral5Percent > 0
            ? categoryTotals.utilityHeldCollateral5Percent
            : null
        );
        record[`Invoice #${index + 1} CC Fee Amount`] = formatNumberForCsv(
          categoryTotals.ccFee > 0 ? categoryTotals.ccFee : null
        );

        Array.from({ length: maxLineItemsForInvoice }).forEach((__, lineItemIndex) => {
          const lineItem = lineItems[lineItemIndex];
          record[`Invoice #${index + 1} - Line Item #${lineItemIndex + 1}`] =
            lineItem?.description ?? "";
          record[`Invoice #${index + 1} - Line Item #${lineItemIndex + 1} - Amount #${lineItemIndex + 1}`] = formatNumberForCsv(
            lineItem?.amount ?? null
          );
        });
      });

      LINE_ITEM_CATEGORY_DEFINITIONS.forEach((category) => {
        const amount = row.lineItemSummary.totals[category.key];
        const invoices = row.lineItemSummary.invoices[category.key];
        record[`${category.label} Amount`] = amount > 0 ? amount.toFixed(2) : "";
        record[`${category.label} Invoices`] = invoices.join(" | ");
      });

      record["Other Line Item Notes"] = row.lineItemSummary.otherNotes.join(" || ");

      Array.from({ length: POTENTIAL_MATCH_LIMIT }).forEach((_, index) => {
        const potential = row.potentialMatches[index];
        record[`Potential Match ${index + 1} Invoice`] = potential?.invoiceNumber ?? "";
        record[`Potential Match ${index + 1} Score`] = potential?.score ?? "";
        record[`Potential Match ${index + 1} Cash`] = formatNumberForCsv(potential?.cashReceived ?? null);
        record[`Potential Match ${index + 1} Why`] = potential?.reason ?? "";
      });

      return record;
    });

    const csv = buildCsv(headers, rowsForCsv);
    const fileName = `invoice-match-dashboard-export-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(fileName, csv, "text/csv;charset=utf-8");
    toast.success(`Exported ${filteredRows.length.toLocaleString("en-US")} rows.`);
  };

  const handleExportLookupRows = () => {
    if (!csgLookupRows.length) {
      toast.error("No CSG lookup rows to export.");
      return;
    }

    const headers = [
      "CSG ID",
      "Invoice Number",
      "Amount of 5% Paid",
      "Amount of Application Fee Paid",
      "Amount of CC Fee Paid",
      "Total Amount Paid",
      "General Status",
    ];

    const csvRows = csgLookupRows.map((row) => ({
      "CSG ID": row.csgId,
      "Invoice Number": row.invoiceNumber,
      "Amount of 5% Paid": formatNumberForCsv(row.collateral5PercentPaid),
      "Amount of Application Fee Paid": formatNumberForCsv(row.applicationFeePaid),
      "Amount of CC Fee Paid": formatNumberForCsv(row.ccFeePaid),
      "Total Amount Paid": formatNumberForCsv(row.totalAmountPaid),
      "General Status": row.generalStatus,
    }));

    const csv = buildCsv(headers, csvRows);
    const fileName = `invoice-match-csg-lookup-${new Date().toISOString().slice(0, 10)}.csv`;
    downloadTextFile(fileName, csv, "text/csv;charset=utf-8");
    toast.success(`Exported ${csgLookupRows.length.toLocaleString("en-US")} lookup rows.`);
  };

  const handleInvoicesUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please upload a CSV file for the invoices report.");
      return;
    }

    setIsParsingInvoices(true);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      const nextInvoiceRows = parseInvoicesFile(parsed);

      setInvoiceRows(nextInvoiceRows);
      setInvoiceDataset({
        fileName: file.name,
        uploadedAt: new Date(),
        rowCount: nextInvoiceRows.length,
      });

      toast.success(`Invoices report loaded: ${nextInvoiceRows.length.toLocaleString("en-US")} rows.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse invoices report.";
      toast.error(message);
    } finally {
      setIsParsingInvoices(false);
    }
  };

  const handleQuickBooksUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please upload a CSV file for the QuickBooks report.");
      return;
    }

    setIsParsingQuickBooks(true);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      const nextQuickBooksByInvoice = parseQuickBooksFile(parsed);

      setQuickBooksByInvoice(nextQuickBooksByInvoice);
      setQuickBooksDataset({
        fileName: file.name,
        uploadedAt: new Date(),
        rowCount: nextQuickBooksByInvoice.size,
      });

      toast.success(
        `QuickBooks report loaded: ${nextQuickBooksByInvoice.size.toLocaleString("en-US")} invoice numbers.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse QuickBooks report.";
      toast.error(message);
    } finally {
      setIsParsingQuickBooks(false);
    }
  };

  const handleLookupCsgUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please upload a CSV file with CSG IDs.");
      return;
    }

    setIsParsingLookupCsgIds(true);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      const ids = parseCsgIdsFile(parsed);

      if (!ids.length) {
        throw new Error(
          "No CSG IDs were found in this file. Include a CSG ID/System ID column or put IDs in the first column."
        );
      }

      setUploadedLookupCsgIds(ids);
      setLookupCsgDataset({
        fileName: file.name,
        uploadedAt: new Date(),
        rowCount: ids.length,
      });

      toast.success(`Loaded ${ids.length.toLocaleString("en-US")} CSG IDs from ${file.name}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse CSG IDs file.";
      toast.error(message);
    } finally {
      setIsParsingLookupCsgIds(false);
    }
  };

  const clearInvoices = () => {
    setInvoiceRows([]);
    setInvoiceDataset(null);
    setSearchTerm("");
    setStatusFilter("all");
    setScopeFilter("all");
    toast.success("Invoices report removed.");
  };

  const clearQuickBooks = () => {
    setQuickBooksByInvoice(new Map());
    setQuickBooksDataset(null);
    toast.success("QuickBooks report removed.");
  };

  const clearLookupCsgIds = () => {
    setCsgLookupInput("");
    setUploadedLookupCsgIds([]);
    setLookupCsgDataset(null);
    toast.success("CSG ID lookup input cleared.");
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) return null;

  if (isRestoringPersistedState) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-2 text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin" />
          Restoring saved invoice dashboard...
        </div>
      </div>
    );
  }

  const startIndex = filteredRows.length === 0 ? 0 : (safePage - 1) * numericPageSize + 1;
  const endIndex = Math.min(filteredRows.length, safePage * numericPageSize);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">Invoice Match Dashboard</h1>
          <p className="text-sm text-slate-600 mt-1">
            Upload the invoices export plus the QuickBooks report, then search and filter by System ID.
            Potential matches only use QuickBooks invoices that are not already tied to another System ID.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Upload Reports</CardTitle>
            <CardDescription>
              You can replace either report at any time. The dashboard recalculates automatically after each upload.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-2">
            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">Invoices Report (System ID Source)</p>
                <p className="text-xs text-slate-600">Example: Invoices-YYYY-MM-DD.csv</p>
              </div>

              <Label htmlFor="invoice-report-upload" className="text-xs uppercase tracking-wide text-slate-500">
                Upload CSV
              </Label>
              <Input
                id="invoice-report-upload"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  void handleInvoicesUpload(event.target.files);
                  event.currentTarget.value = "";
                }}
                disabled={isParsingInvoices}
              />

              {isParsingInvoices && (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Parsing invoices report...
                </div>
              )}

              {invoiceDataset ? (
                <div className="space-y-1 text-sm text-slate-700">
                  <p className="font-medium">{invoiceDataset.fileName}</p>
                  <p>{invoiceDataset.rowCount.toLocaleString("en-US")} system-linked invoice rows</p>
                  <p>Uploaded: {formatUploadedAt(invoiceDataset.uploadedAt)}</p>
                </div>
              ) : (
                <p className="text-sm text-slate-500">No invoices report uploaded yet.</p>
              )}

              <Button variant="outline" size="sm" onClick={clearInvoices} disabled={!invoiceDataset || isParsingInvoices}>
                <Trash2 className="h-4 w-4 mr-2" />
                Remove Invoices Report
              </Button>
            </div>

            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">QuickBooks Invoice Report (Cash + Potential Matches)</p>
                <p className="text-xs text-slate-600">Example: CARBON SOLUTIONS GROUP... Invoice Report.csv</p>
              </div>

              <Label htmlFor="quickbooks-report-upload" className="text-xs uppercase tracking-wide text-slate-500">
                Upload CSV
              </Label>
              <Input
                id="quickbooks-report-upload"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  void handleQuickBooksUpload(event.target.files);
                  event.currentTarget.value = "";
                }}
                disabled={isParsingQuickBooks}
              />

              {isParsingQuickBooks && (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Parsing QuickBooks report...
                </div>
              )}

              {quickBooksDataset ? (
                <div className="space-y-1 text-sm text-slate-700">
                  <p className="font-medium">{quickBooksDataset.fileName}</p>
                  <p>{quickBooksDataset.rowCount.toLocaleString("en-US")} invoice numbers</p>
                  <p>Uploaded: {formatUploadedAt(quickBooksDataset.uploadedAt)}</p>
                </div>
              ) : (
                <p className="text-sm text-slate-500">No QuickBooks report uploaded yet.</p>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={clearQuickBooks}
                disabled={!quickBooksDataset || isParsingQuickBooks}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Remove QuickBooks Report
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>2) CSG ID Lookup (Paste or Upload)</CardTitle>
              <CardDescription>
                Provide CSG IDs and get invoice-level paid amounts for 5% collateral, application fee, CC fee, total paid, and paid status.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              onClick={handleExportLookupRows}
              disabled={!csgLookupRows.length}
              className="md:self-center"
            >
              <Download className="h-4 w-4 mr-2" />
              Export Lookup CSV
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="csg-id-paste">Paste CSG IDs</Label>
                <Textarea
                  id="csg-id-paste"
                  value={csgLookupInput}
                  onChange={(event) => setCsgLookupInput(event.target.value)}
                  placeholder={"Example:\n177418\n1689\n7754"}
                  className="min-h-[130px]"
                />
                <p className="text-xs text-slate-600">
                  Accepts line breaks, commas, spaces, or semicolons.
                </p>
              </div>

              <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Upload CSG IDs CSV</p>
                  <p className="text-xs text-slate-600">Use a column like CSG ID, System ID, ID, or first column IDs.</p>
                </div>
                <Input
                  id="lookup-csg-upload"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    void handleLookupCsgUpload(event.target.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={isParsingLookupCsgIds}
                />
                {isParsingLookupCsgIds ? (
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Parsing CSG IDs...
                  </div>
                ) : null}
                {lookupCsgDataset ? (
                  <div className="space-y-1 text-sm text-slate-700">
                    <p className="font-medium">{lookupCsgDataset.fileName}</p>
                    <p>{lookupCsgDataset.rowCount.toLocaleString("en-US")} CSG IDs loaded</p>
                    <p>Uploaded: {formatUploadedAt(lookupCsgDataset.uploadedAt)}</p>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No CSG ID CSV uploaded yet.</p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                <Badge className="bg-blue-100 text-blue-900 border-blue-200">
                  {lookupCsgIds.length.toLocaleString("en-US")} CSG IDs
                </Badge>
                <Badge className="bg-emerald-100 text-emerald-900 border-emerald-200">
                  {csgLookupRows.length.toLocaleString("en-US")} Invoice Rows
                </Badge>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={clearLookupCsgIds}
                disabled={!lookupCsgIds.length && !lookupCsgDataset && clean(csgLookupInput).length === 0}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear CSG Lookup Input
              </Button>
            </div>

            {!lookupCsgIds.length ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600">
                Paste CSG IDs or upload a CSG ID CSV to generate lookup rows.
              </div>
            ) : csgLookupRows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600">
                No lookup rows yet. Upload the invoices and QuickBooks reports, then provide CSG IDs.
              </div>
            ) : (
              <div className="overflow-auto rounded-lg border border-slate-200 max-h-[45vh]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[120px]">CSG ID</TableHead>
                      <TableHead className="min-w-[140px]">Invoice Number</TableHead>
                      <TableHead className="min-w-[170px]">Amount of 5% Paid</TableHead>
                      <TableHead className="min-w-[190px]">Amount of Application Fee Paid</TableHead>
                      <TableHead className="min-w-[170px]">Amount of CC Fee Paid</TableHead>
                      <TableHead className="min-w-[150px]">Total Amount Paid</TableHead>
                      <TableHead className="min-w-[140px]">General Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {csgLookupRows.map((row, index) => (
                      <TableRow key={`${row.csgId}-${row.invoiceNumber || "no-invoice"}-${index}`}>
                        <TableCell className="font-semibold text-slate-900">{row.csgId}</TableCell>
                        <TableCell>{row.invoiceNumber || "-"}</TableCell>
                        <TableCell>{formatCurrencyOrDash(row.collateral5PercentPaid)}</TableCell>
                        <TableCell>{formatCurrencyOrDash(row.applicationFeePaid)}</TableCell>
                        <TableCell>{formatCurrencyOrDash(row.ccFeePaid)}</TableCell>
                        <TableCell>{formatCurrencyOrDash(row.totalAmountPaid)}</TableCell>
                        <TableCell>
                          <Badge className={getStatusClassName(row.generalStatus)}>{row.generalStatus}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total System IDs</CardDescription>
              <CardTitle>{rows.length.toLocaleString("en-US")}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Filtered Results</CardDescription>
              <CardTitle>{filteredRows.length.toLocaleString("en-US")}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>With Potential Matches</CardDescription>
              <CardTitle>{systemsWithPotentialMatches.toLocaleString("en-US")}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Missing Invoice Number</CardDescription>
              <CardTitle>{systemsWithMissingInvoiceNumber.toLocaleString("en-US")}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>3) Search, Filter, and Export</CardTitle>
              <CardDescription>
                Search by System ID, project, company, recipient, invoice number, or potential match invoice.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              onClick={handleExportFilteredRows}
              disabled={!filteredRows.length}
              className="md:self-center"
            >
              <Download className="h-4 w-4 mr-2" />
              Export Filtered CSV
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="search-invoices">Search</Label>
              <Input
                id="search-invoices"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Type a System ID, invoice number, customer, or line item"
              />
            </div>

            <div className="space-y-2">
              <Label>Status Filter</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {availableStatuses.map((status) => (
                    <SelectItem key={status.token} value={status.token}>
                      {status.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Scope</Label>
              <Select
                value={scopeFilter}
                onValueChange={(value: "all" | "missing-invoice" | "with-potential") => setScopeFilter(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All rows</SelectItem>
                  <SelectItem value="missing-invoice">Missing invoice number</SelectItem>
                  <SelectItem value="with-potential">Has potential matches</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Sort</Label>
              <Select
                value={sortBy}
                onValueChange={(value: "system-asc" | "system-desc" | "invoice-qty-desc" | "potential-desc") =>
                  setSortBy(value)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system-asc">System ID (A to Z)</SelectItem>
                  <SelectItem value="system-desc">System ID (Z to A)</SelectItem>
                  <SelectItem value="invoice-qty-desc">Invoice quantity (high to low)</SelectItem>
                  <SelectItem value="potential-desc">Potential score (high to low)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Rows Per Page</Label>
              <Select value={pageSize} onValueChange={setPageSize}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                  <SelectItem value="250">250</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4) System ID Invoice Dashboard</CardTitle>
            <CardDescription>
              Each System ID row includes invoice details from the invoices report and optional QuickBooks potential
              matches.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!invoiceDataset ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
                Upload the invoices report first to populate System IDs.
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
                No rows match the current filters.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="overflow-auto rounded-lg border border-slate-200 max-h-[65vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[140px]">System ID</TableHead>
                        <TableHead className="min-w-[120px]">Invoice Qty</TableHead>
                        {Array.from({ length: maxInvoiceSlots }).map((_, index) => (
                          <Fragment key={`invoice-columns-${index}`}>
                            <TableHead className="min-w-[140px]">Invoice #{index + 1}</TableHead>
                            <TableHead className="min-w-[140px]">Amount #{index + 1}</TableHead>
                            <TableHead className="min-w-[150px]">Status #{index + 1}</TableHead>
                            <TableHead className="min-w-[170px]">Cash Received #{index + 1}</TableHead>
                            {Array.from({ length: maxLineItemSlotsPerInvoice[index] ?? 1 }).map(
                              (__, lineItemIndex) => (
                                <TableHead
                                  key={`invoice-${index}-line-item-${lineItemIndex}`}
                                  className="min-w-[260px]"
                                >
                                  Invoice #{index + 1} - Line Item #{lineItemIndex + 1}
                                </TableHead>
                              )
                            )}
                          </Fragment>
                        ))}
                        {LINE_ITEM_CATEGORY_DEFINITIONS.map((category) => (
                          <TableHead key={category.key} className="min-w-[230px]">
                            {category.label}
                          </TableHead>
                        ))}
                        {Array.from({ length: POTENTIAL_MATCH_LIMIT }).map((_, index) => (
                          <Fragment key={`potential-columns-${index}`}>
                            <TableHead className="min-w-[170px]">Potential #{index + 1} Invoice</TableHead>
                            <TableHead className="min-w-[130px]">Potential #{index + 1} Score</TableHead>
                            <TableHead className="min-w-[170px]">Potential #{index + 1} Cash</TableHead>
                            <TableHead className="min-w-[280px]">Potential #{index + 1} Why</TableHead>
                          </Fragment>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageRows.map((row) => (
                        <TableRow key={row.systemId}>
                          <TableCell className="font-semibold text-slate-900">{row.systemId}</TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <span>{row.invoiceCount}</span>
                              {row.hasMissingInvoiceNumber && (
                                <Badge className="w-fit bg-amber-100 text-amber-900 border-amber-200">
                                  Missing invoice #
                                </Badge>
                              )}
                            </div>
                          </TableCell>

                          {Array.from({ length: maxInvoiceSlots }).map((_, index) => {
                            const invoice = row.invoices[index];
                            const lineItems =
                              invoice && invoice.quickBooksLineItems.length === 0
                                ? [{ description: invoice.lineItem || "-", amount: invoice.amount }]
                                : invoice?.quickBooksLineItems ?? [];
                            const maxLineItemsForInvoice = maxLineItemSlotsPerInvoice[index] ?? 1;
                            return (
                              <Fragment key={`${row.systemId}-invoice-${index}`}>
                                <TableCell className="font-medium text-slate-900">
                                  {invoice?.invoiceNumber || "-"}
                                </TableCell>
                                <TableCell>{invoice ? formatCurrency(invoice.amount) : "-"}</TableCell>
                                <TableCell>
                                  {invoice?.status ? (
                                    <Badge className={getStatusClassName(invoice.status)}>{invoice.status}</Badge>
                                  ) : (
                                    "-"
                                  )}
                                </TableCell>
                                <TableCell>{invoice ? formatCurrency(invoice.cashReceived) : "-"}</TableCell>
                                {Array.from({ length: maxLineItemsForInvoice }).map((__, lineItemIndex) => {
                                  const lineItem = lineItems[lineItemIndex];
                                  return (
                                    <TableCell
                                      key={`${row.systemId}-invoice-${index}-line-item-${lineItemIndex}`}
                                      className="max-w-[260px] align-top"
                                    >
                                      {lineItem ? (
                                        <p className="whitespace-pre-wrap break-words text-xs text-slate-700">
                                          {lineItem.description}
                                          {lineItem.amount !== null && Number.isFinite(lineItem.amount)
                                            ? ` (${formatCurrency(lineItem.amount)})`
                                            : ""}
                                        </p>
                                      ) : (
                                        "-"
                                      )}
                                    </TableCell>
                                  );
                                })}
                              </Fragment>
                            );
                          })}

                          {LINE_ITEM_CATEGORY_DEFINITIONS.map((category) => {
                            const amount = row.lineItemSummary.totals[category.key];
                            const invoiceReferences = row.lineItemSummary.invoices[category.key];
                            return (
                              <TableCell key={`${row.systemId}-${category.key}`} className="max-w-[230px] align-top">
                                {amount > 0 || invoiceReferences.length > 0 ? (
                                  <div className="space-y-1">
                                    <p className="text-sm font-medium text-slate-900">
                                      {amount > 0 ? formatCurrency(amount) : "-"}
                                    </p>
                                    {invoiceReferences.length > 0 ? (
                                      <p className="text-xs text-slate-600 whitespace-pre-wrap break-words">
                                        {invoiceReferences.join(", ")}
                                      </p>
                                    ) : null}
                                  </div>
                                ) : (
                                  "-"
                                )}
                              </TableCell>
                            );
                          })}

                          {Array.from({ length: POTENTIAL_MATCH_LIMIT }).map((_, index) => {
                            const match = row.potentialMatches[index];
                            return (
                              <Fragment key={`${row.systemId}-potential-${index}`}>
                                <TableCell>
                                  {match ? (
                                    <div className="space-y-1">
                                      <p className="font-medium text-slate-900">{match.invoiceNumber}</p>
                                      <p className="text-xs text-slate-600 whitespace-pre-wrap break-words">
                                        {match.customerLabel}
                                      </p>
                                    </div>
                                  ) : (
                                    "-"
                                  )}
                                </TableCell>
                                <TableCell>
                                  {match ? (
                                    <Badge
                                      className={
                                        match.score >= 70
                                          ? "bg-emerald-100 text-emerald-900 border-emerald-200"
                                          : match.score >= 45
                                            ? "bg-amber-100 text-amber-900 border-amber-200"
                                            : "bg-slate-100 text-slate-800 border-slate-200"
                                      }
                                    >
                                      {match.score}
                                    </Badge>
                                  ) : (
                                    "-"
                                  )}
                                </TableCell>
                                <TableCell>{match ? formatCurrency(match.cashReceived) : "-"}</TableCell>
                                <TableCell className="max-w-[280px] whitespace-pre-wrap break-words text-xs text-slate-600">
                                  {match ? match.reason : "-"}
                                </TableCell>
                              </Fragment>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-slate-600">
                    Showing {startIndex.toLocaleString("en-US")}-{endIndex.toLocaleString("en-US")} of{" "}
                    {filteredRows.length.toLocaleString("en-US")} systems
                  </p>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                      disabled={safePage <= 1}
                    >
                      Previous
                    </Button>
                    <p className="text-sm text-slate-700">
                      Page {safePage.toLocaleString("en-US")} of {totalPages.toLocaleString("en-US")}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                      disabled={safePage >= totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How Matching Works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <p>
              `System ID` rows only come from the invoices CSV. That file is the source of truth for existing
              associations.
            </p>
            <p>
              `Invoice Status` and `Cash Received` come only from the QuickBooks report. Cash received is estimated as
              `Amount - Open Balance` for the same invoice number.
            </p>
            <p>
              `Potential Match` columns only use QuickBooks invoice numbers that are not already tied to a different
              System ID in the invoices CSV.
            </p>
            <p>
              If a System ID has a missing invoice number, the matching score starts higher so those rows surface
              likely candidates first.
            </p>
            <p>
              Line items are normalized under fixed headers: Application Fee, 5% Collateral (including 5% bond),
              and CC Fee.
            </p>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Upload className="h-4 w-4" />
          Re-upload either CSV anytime to refresh this dashboard with newer rows, System IDs, and invoice numbers.
        </div>
      </main>
    </div>
  );
}
