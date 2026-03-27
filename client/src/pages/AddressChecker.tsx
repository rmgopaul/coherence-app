import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseTabularFile } from "@/lib/csvParsing";
import { clean, downloadTextFile, toErrorMessage } from "@/lib/helpers";
import { trpc } from "@/lib/trpc";
import { CheckCircle, Download, FileUp, Loader2, MapPin, Sparkles } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AddressRow = {
  /** Stable row key (index-based) */
  key: string;
  /** Original values from the uploaded file */
  original: {
    name: string;
    address1: string;
    address2: string;
    city: string;
    state: string;
    zip: string;
  };
  /** Values after AI cleaning (null = not yet cleaned) */
  cleaned: {
    name: string;
    address1: string;
    address2: string;
    city: string;
    state: string;
    zip: string;
  } | null;
  /** USPS verification result (null = not yet verified) */
  verification: {
    verdict: string;
    deliverable: boolean;
    issues: string[];
    corrected: {
      address1: string;
      city: string;
      state: string;
      zip: string;
      zipPlus4: string;
    };
  } | null;
};

type ColumnRole = "name" | "address1" | "address2" | "city" | "state" | "zip" | "ignore";

const COLUMN_ROLES: { value: ColumnRole; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "address1", label: "Address 1" },
  { value: "address2", label: "Address 2" },
  { value: "city", label: "City" },
  { value: "state", label: "State" },
  { value: "zip", label: "Zip" },
  { value: "ignore", label: "— Ignore —" },
];

const KNOWN_HEADER_NAMES: Record<string, ColumnRole> = {
  name: "name",
  payee: "name",
  payeename: "name",
  recipient: "name",
  fullname: "name",
  address: "address1",
  address1: "address1",
  addressline1: "address1",
  streetaddress: "address1",
  mailingaddress: "address1",
  mailingaddress1: "address1",
  street: "address1",
  addr1: "address1",
  address2: "address2",
  addressline2: "address2",
  apt: "address2",
  suite: "address2",
  unit: "address2",
  addr2: "address2",
  mailingaddress2: "address2",
  secondary: "address2",
  city: "city",
  town: "city",
  state: "state",
  st: "state",
  province: "state",
  zip: "zip",
  zipcode: "zip",
  postalcode: "zip",
  postal: "zip",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeForHeaderMatch(value: string): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const US_STATE_ABBREVIATIONS = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR","VI","GU","AS","MP",
]);

/** Heuristic: does the first row of data look like headers or actual data? */
function firstRowLooksLikeHeaders(row: string[]): boolean {
  // If any cell is a known header name, it's probably a header row
  const normalized = row.map(normalizeForHeaderMatch);
  const knownMatches = normalized.filter((v) => v in KNOWN_HEADER_NAMES).length;
  if (knownMatches >= 2) return true;

  // If any cell looks like a state abbreviation or zip code, it's probably data
  const hasState = row.some((v) => US_STATE_ABBREVIATIONS.has(clean(v).toUpperCase()));
  const hasZip = row.some((v) => /^\d{5}(-\d{4})?$/.test(clean(v)));
  if (hasState || hasZip) return false;

  return false;
}

/** Detect column roles from header names */
function detectColumnRoles(headers: string[]): ColumnRole[] {
  const roles: ColumnRole[] = headers.map(() => "ignore");
  const usedRoles = new Set<ColumnRole>();

  // First pass: try to match known header names
  headers.forEach((header, index) => {
    const normalized = normalizeForHeaderMatch(header);
    const role = KNOWN_HEADER_NAMES[normalized];
    if (role && !usedRoles.has(role)) {
      roles[index] = role;
      usedRoles.add(role);
    }
  });

  return roles;
}

/** Assign positional column roles for headerless files */
function positionalColumnRoles(columnCount: number): ColumnRole[] {
  const positional: ColumnRole[] = ["name", "address1", "address2", "city", "state", "zip"];
  return Array.from({ length: columnCount }, (_, i) => positional[i] ?? "ignore");
}

function csvEscape(value: string): string {
  const safe = clean(value);
  if (!safe) return "";
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AddressChecker() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [columnRoles, setColumnRoles] = useState<ColumnRole[]>([]);
  const [rows, setRows] = useState<AddressRow[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verdictFilter, setVerdictFilter] = useState<string>("all");

  const cleanMutation = trpc.abpSettlement.cleanMailingData.useMutation();
  const verifyMutation = trpc.abpSettlement.verifyAddresses.useMutation();

  // Store raw matrix for re-derivation on column role change
  const [rawMatrix, setRawMatrix] = useState<string[][]>([]);

  // Enhanced upload that stores raw matrix
  const handleFileUploadFull = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    setIsUploading(true);
    try {
      const parsed = await parseTabularFile(file);
      if (parsed.matrix.length === 0) {
        toast.error("File is empty.");
        return;
      }

      const isHeadered = firstRowLooksLikeHeaders(parsed.matrix[0]);
      let headers: string[];
      let dataRows: string[][];

      if (isHeadered) {
        headers = parsed.matrix[0].map((v, i) => clean(v) || `Column ${i + 1}`);
        dataRows = parsed.matrix.slice(1);
      } else {
        const colCount = parsed.matrix[0].length;
        const defaultNames = ["Name", "Address 1", "Address 2", "City", "State", "Zip"];
        headers = Array.from({ length: colCount }, (_, i) => defaultNames[i] ?? `Column ${i + 1}`);
        dataRows = parsed.matrix;
      }

      const roles = isHeadered
        ? detectColumnRoles(headers)
        : positionalColumnRoles(headers.length);

      const addressRows = buildRowsFromMatrix(dataRows, roles);

      setRawHeaders(headers);
      setColumnRoles(roles);
      setRawMatrix(dataRows);
      setRows(addressRows);
      setFileName(file.name);
      setVerdictFilter("all");
      toast.success(`Loaded ${addressRows.length.toLocaleString("en-US")} address row(s) from ${file.name}.`);
    } catch (error) {
      toast.error(`Failed to parse file: ${toErrorMessage(error)}`);
    } finally {
      setIsUploading(false);
    }
  }, []);

  function buildRowsFromMatrix(dataRows: string[][], roles: ColumnRole[]): AddressRow[] {
    return dataRows
      .filter((row) => row.some((cell) => clean(cell) !== ""))
      .map((row, index) => {
        const getValue = (role: ColumnRole): string => {
          const colIndex = roles.indexOf(role);
          return colIndex >= 0 && colIndex < row.length ? clean(row[colIndex]) : "";
        };
        return {
          key: String(index),
          original: {
            name: getValue("name"),
            address1: getValue("address1"),
            address2: getValue("address2"),
            city: getValue("city"),
            state: getValue("state"),
            zip: getValue("zip"),
          },
          cleaned: null,
          verification: null,
        };
      });
  }

  // Re-derive rows when column roles change
  const handleRoleChange = useCallback(
    (colIndex: number, newRole: ColumnRole) => {
      setColumnRoles((prev) => {
        const updated = [...prev];
        updated[colIndex] = newRole;
        // Rebuild rows with new roles
        const newRows = buildRowsFromMatrix(rawMatrix, updated);
        setRows(newRows);
        return updated;
      });
    },
    [rawMatrix]
  );

  // -----------------------------------------------------------------------
  // AI Clean
  // -----------------------------------------------------------------------

  const handleAiClean = useCallback(async () => {
    if (rows.length === 0) {
      toast.error("Upload a file first.");
      return;
    }
    setIsCleaning(true);
    try {
      const BATCH_SIZE = 150;
      const updatedRows = [...rows];

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        toast.info(`Cleaning addresses ${i + 1}–${Math.min(i + BATCH_SIZE, rows.length)} of ${rows.length}...`);

        const input = batch.map((row) => ({
          key: row.key,
          payeeName: row.original.name,
          mailingAddress1: row.original.address1,
          mailingAddress2: row.original.address2,
          city: row.original.city,
          state: row.original.state,
          zip: row.original.zip,
        }));

        const response = await cleanMutation.mutateAsync({ rows: input });

        for (const cleaned of response.rows) {
          const rowIndex = updatedRows.findIndex((r) => r.key === cleaned.key);
          if (rowIndex >= 0) {
            updatedRows[rowIndex] = {
              ...updatedRows[rowIndex],
              cleaned: {
                name: cleaned.payeeName ?? updatedRows[rowIndex].original.name,
                address1: cleaned.mailingAddress1 ?? updatedRows[rowIndex].original.address1,
                address2: cleaned.mailingAddress2 ?? "",
                city: cleaned.city ?? updatedRows[rowIndex].original.city,
                state: cleaned.state ?? updatedRows[rowIndex].original.state,
                zip: cleaned.zip ?? updatedRows[rowIndex].original.zip,
              },
              // Reset verification since address may have changed
              verification: null,
            };
          }
        }
      }

      setRows(updatedRows);
      const changedCount = updatedRows.filter((r) => {
        if (!r.cleaned) return false;
        return (
          r.cleaned.name !== r.original.name ||
          r.cleaned.address1 !== r.original.address1 ||
          r.cleaned.address2 !== r.original.address2 ||
          r.cleaned.city !== r.original.city ||
          r.cleaned.state !== r.original.state ||
          r.cleaned.zip !== r.original.zip
        );
      }).length;
      toast.success(`AI cleaning complete. ${changedCount} row(s) modified.`);
    } catch (error) {
      toast.error(`AI cleaning failed: ${toErrorMessage(error)}`);
    } finally {
      setIsCleaning(false);
    }
  }, [rows, cleanMutation]);

  // -----------------------------------------------------------------------
  // USPS Verify
  // -----------------------------------------------------------------------

  const handleVerify = useCallback(async () => {
    if (rows.length === 0) {
      toast.error("Upload a file first.");
      return;
    }
    setIsVerifying(true);
    try {
      const BATCH_SIZE = 100;
      const updatedRows = [...rows];

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        toast.info(`Verifying addresses ${i + 1}–${Math.min(i + BATCH_SIZE, rows.length)} of ${rows.length}...`);

        const input = batch.map((row) => {
          // Use cleaned values if available, otherwise original
          const src = row.cleaned ?? row.original;
          return {
            key: row.key,
            address1: src.address1,
            address2: src.address2,
            city: src.city,
            state: src.state,
            zip: src.zip,
          };
        });

        const response = await verifyMutation.mutateAsync({ addresses: input });

        for (const result of response.results) {
          const rowIndex = updatedRows.findIndex((r) => r.key === result.key);
          if (rowIndex >= 0) {
            updatedRows[rowIndex] = {
              ...updatedRows[rowIndex],
              verification: {
                verdict: result.verdict,
                deliverable: result.deliverable,
                issues: result.issues,
                corrected: result.corrected,
              },
            };
          }
        }
      }

      setRows(updatedRows);
      const confirmed = updatedRows.filter((r) => r.verification?.verdict === "CONFIRMED").length;
      const unconfirmed = updatedRows.filter((r) => r.verification?.verdict === "UNCONFIRMED").length;
      const errors = updatedRows.filter((r) => r.verification?.verdict === "ERROR").length;
      toast.success(`USPS verification complete: ${confirmed} confirmed, ${unconfirmed} unconfirmed, ${errors} errors.`);
    } catch (error) {
      toast.error(`USPS verification failed: ${toErrorMessage(error)}`);
    } finally {
      setIsVerifying(false);
    }
  }, [rows, verifyMutation]);

  // -----------------------------------------------------------------------
  // Clean + Verify combo
  // -----------------------------------------------------------------------

  const handleCleanThenVerify = useCallback(async () => {
    setIsCleaning(true);
    try {
      // Run clean first
      const BATCH_SIZE = 150;
      const updatedRows = [...rows];

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        toast.info(`Cleaning addresses ${i + 1}–${Math.min(i + BATCH_SIZE, rows.length)} of ${rows.length}...`);
        const input = batch.map((row) => ({
          key: row.key,
          payeeName: row.original.name,
          mailingAddress1: row.original.address1,
          mailingAddress2: row.original.address2,
          city: row.original.city,
          state: row.original.state,
          zip: row.original.zip,
        }));
        const response = await cleanMutation.mutateAsync({ rows: input });
        for (const cleaned of response.rows) {
          const rowIndex = updatedRows.findIndex((r) => r.key === cleaned.key);
          if (rowIndex >= 0) {
            updatedRows[rowIndex] = {
              ...updatedRows[rowIndex],
              cleaned: {
                name: cleaned.payeeName ?? updatedRows[rowIndex].original.name,
                address1: cleaned.mailingAddress1 ?? updatedRows[rowIndex].original.address1,
                address2: cleaned.mailingAddress2 ?? "",
                city: cleaned.city ?? updatedRows[rowIndex].original.city,
                state: cleaned.state ?? updatedRows[rowIndex].original.state,
                zip: cleaned.zip ?? updatedRows[rowIndex].original.zip,
              },
              verification: null,
            };
          }
        }
      }

      setRows(updatedRows);
      setIsCleaning(false);
      toast.success("AI cleaning complete. Starting USPS verification...");

      // Now verify with the cleaned data
      setIsVerifying(true);
      const VERIFY_BATCH = 100;
      for (let i = 0; i < updatedRows.length; i += VERIFY_BATCH) {
        const batch = updatedRows.slice(i, i + VERIFY_BATCH);
        toast.info(`Verifying addresses ${i + 1}–${Math.min(i + VERIFY_BATCH, updatedRows.length)} of ${updatedRows.length}...`);
        const input = batch.map((row) => {
          const src = row.cleaned ?? row.original;
          return {
            key: row.key,
            address1: src.address1,
            address2: src.address2,
            city: src.city,
            state: src.state,
            zip: src.zip,
          };
        });
        const response = await verifyMutation.mutateAsync({ addresses: input });
        for (const result of response.results) {
          const rowIndex = updatedRows.findIndex((r) => r.key === result.key);
          if (rowIndex >= 0) {
            updatedRows[rowIndex] = {
              ...updatedRows[rowIndex],
              verification: {
                verdict: result.verdict,
                deliverable: result.deliverable,
                issues: result.issues,
                corrected: result.corrected,
              },
            };
          }
        }
      }

      setRows([...updatedRows]);
      const confirmed = updatedRows.filter((r) => r.verification?.verdict === "CONFIRMED").length;
      const unconfirmed = updatedRows.filter((r) => r.verification?.verdict === "UNCONFIRMED").length;
      const errors = updatedRows.filter((r) => r.verification?.verdict === "ERROR").length;
      toast.success(`Done! ${confirmed} confirmed, ${unconfirmed} unconfirmed, ${errors} errors.`);
    } catch (error) {
      toast.error(`Clean + Verify failed: ${toErrorMessage(error)}`);
    } finally {
      setIsCleaning(false);
      setIsVerifying(false);
    }
  }, [rows, cleanMutation, verifyMutation]);

  // -----------------------------------------------------------------------
  // Export CSV
  // -----------------------------------------------------------------------

  const handleExportCsv = useCallback(() => {
    if (rows.length === 0) {
      toast.error("No rows to export.");
      return;
    }

    const headers = [
      "Name (Original)",
      "Address 1 (Original)",
      "Address 2 (Original)",
      "City (Original)",
      "State (Original)",
      "Zip (Original)",
      "Name (Cleaned)",
      "Address 1 (Cleaned)",
      "Address 2 (Cleaned)",
      "City (Cleaned)",
      "State (Cleaned)",
      "Zip (Cleaned)",
      "USPS Verdict",
      "Deliverable",
      "USPS Issues",
      "USPS Corrected Address 1",
      "USPS Corrected City",
      "USPS Corrected State",
      "USPS Corrected Zip",
      "USPS Corrected Zip+4",
    ];

    const lines = [headers.map(csvEscape).join(",")];

    for (const row of rows) {
      const c = row.cleaned;
      const v = row.verification;
      const record = [
        row.original.name,
        row.original.address1,
        row.original.address2,
        row.original.city,
        row.original.state,
        row.original.zip,
        c?.name ?? "",
        c?.address1 ?? "",
        c?.address2 ?? "",
        c?.city ?? "",
        c?.state ?? "",
        c?.zip ?? "",
        v?.verdict ?? "",
        v ? (v.deliverable ? "Yes" : "No") : "",
        v?.issues.join("; ") ?? "",
        v?.corrected.address1 ?? "",
        v?.corrected.city ?? "",
        v?.corrected.state ?? "",
        v?.corrected.zip ?? "",
        v?.corrected.zipPlus4 ?? "",
      ];
      lines.push(record.map(csvEscape).join(","));
    }

    const csv = lines.join("\n");
    const safeName = clean(fileName ?? "addresses").replace(/\.[^.]+$/, "");
    downloadTextFile(`${safeName}-checked.csv`, csv, "text/csv;charset=utf-8");
    toast.success("CSV exported.");
  }, [rows, fileName]);

  // -----------------------------------------------------------------------
  // Filtered rows + summary
  // -----------------------------------------------------------------------

  const filteredRows = useMemo(() => {
    if (verdictFilter === "all") return rows;
    return rows.filter((r) => r.verification?.verdict === verdictFilter);
  }, [rows, verdictFilter]);

  const summary = useMemo(() => {
    const total = rows.length;
    const cleaned = rows.filter((r) => r.cleaned !== null).length;
    const verified = rows.filter((r) => r.verification !== null).length;
    const confirmed = rows.filter((r) => r.verification?.verdict === "CONFIRMED").length;
    const unconfirmed = rows.filter((r) => r.verification?.verdict === "UNCONFIRMED").length;
    const errors = rows.filter((r) => r.verification?.verdict === "ERROR").length;
    return { total, cleaned, verified, confirmed, unconfirmed, errors };
  }, [rows]);

  const isBusy = isCleaning || isVerifying || isUploading;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MapPin className="h-6 w-6" />
          Address Checker
        </h1>
        <p className="text-muted-foreground mt-1">
          Upload addresses, AI-clean to USPS spec, and verify with USPS CASS.
        </p>
      </div>

      {/* Upload + Column Mapping */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Upload Addresses</CardTitle>
          <CardDescription>
            Upload a CSV or Excel file with name and address columns. Headerless files are auto-detected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Label htmlFor="address-file-upload" className="sr-only">
              Address file
            </Label>
            <input
              id="address-file-upload"
              type="file"
              accept=".csv,.xlsx,.xls,.xlsm,.xlsb,text/csv"
              className="text-sm file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer"
              onChange={(e) => void handleFileUploadFull(e.currentTarget.files)}
              disabled={isBusy}
            />
            {fileName && (
              <span className="text-sm text-muted-foreground">{fileName} — {rows.length.toLocaleString("en-US")} rows</span>
            )}
          </div>

          {/* Column Mapping */}
          {rawHeaders.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Column Mapping</Label>
              <div className="flex flex-wrap gap-3">
                {rawHeaders.map((header, colIndex) => (
                  <div key={colIndex} className="flex flex-col gap-1 min-w-[140px]">
                    <span className="text-xs text-muted-foreground truncate" title={header}>
                      {header}
                    </span>
                    <Select
                      value={columnRoles[colIndex] ?? "ignore"}
                      onValueChange={(value) => handleRoleChange(colIndex, value as ColumnRole)}
                      disabled={isBusy}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COLUMN_ROLES.map((role) => (
                          <SelectItem key={role.value} value={role.value}>
                            {role.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <Button onClick={handleAiClean} disabled={isBusy} variant="outline">
                {isCleaning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                AI Clean Addresses
              </Button>
              <Button onClick={handleVerify} disabled={isBusy} variant="outline">
                {isVerifying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-2" />}
                Verify with USPS
              </Button>
              <Button onClick={handleCleanThenVerify} disabled={isBusy}>
                {isBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                Clean + Verify
              </Button>
              <div className="flex-1" />
              <Button onClick={handleExportCsv} disabled={rows.length === 0} variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary Bar */}
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-3 items-center">
          <Badge variant="secondary">{summary.total} total</Badge>
          {summary.cleaned > 0 && (
            <Badge variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
              {summary.cleaned} cleaned
            </Badge>
          )}
          {summary.verified > 0 && (
            <>
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 cursor-pointer"
                onClick={() => setVerdictFilter(verdictFilter === "CONFIRMED" ? "all" : "CONFIRMED")}
              >
                {summary.confirmed} confirmed
              </Badge>
              <Badge
                variant="secondary"
                className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 cursor-pointer"
                onClick={() => setVerdictFilter(verdictFilter === "UNCONFIRMED" ? "all" : "UNCONFIRMED")}
              >
                {summary.unconfirmed} unconfirmed
              </Badge>
              <Badge
                variant="secondary"
                className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 cursor-pointer"
                onClick={() => setVerdictFilter(verdictFilter === "ERROR" ? "all" : "ERROR")}
              >
                {summary.errors} errors
              </Badge>
              {verdictFilter !== "all" && (
                <Button variant="ghost" size="sm" onClick={() => setVerdictFilter("all")} className="text-xs h-6">
                  Clear filter
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {/* Results Table */}
      {filteredRows.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-auto max-h-[70vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-background z-10 min-w-[40px]">#</TableHead>
                    <TableHead className="min-w-[160px]">Name</TableHead>
                    <TableHead className="min-w-[200px]">Address 1</TableHead>
                    <TableHead className="min-w-[120px]">Address 2</TableHead>
                    <TableHead className="min-w-[120px]">City</TableHead>
                    <TableHead className="min-w-[60px]">State</TableHead>
                    <TableHead className="min-w-[70px]">Zip</TableHead>
                    <TableHead className="min-w-[100px]">Verdict</TableHead>
                    <TableHead className="min-w-[200px]">Issues</TableHead>
                    <TableHead className="min-w-[200px]">USPS Corrected Address</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((row) => {
                    const display = row.cleaned ?? row.original;
                    const wasCleaned = row.cleaned !== null;
                    const v = row.verification;

                    const diffClass = (original: string, current: string) =>
                      wasCleaned && original !== current ? "bg-blue-50 dark:bg-blue-950" : "";

                    return (
                      <TableRow key={row.key}>
                        <TableCell className="sticky left-0 bg-background z-10 text-muted-foreground text-xs">
                          {Number(row.key) + 1}
                        </TableCell>
                        <TableCell className={diffClass(row.original.name, display.name)}>
                          <span className="text-sm">{display.name}</span>
                          {wasCleaned && row.original.name !== display.name && (
                            <div className="text-xs text-muted-foreground line-through">{row.original.name}</div>
                          )}
                        </TableCell>
                        <TableCell className={diffClass(row.original.address1, display.address1)}>
                          <span className="text-sm">{display.address1}</span>
                          {wasCleaned && row.original.address1 !== display.address1 && (
                            <div className="text-xs text-muted-foreground line-through">{row.original.address1}</div>
                          )}
                        </TableCell>
                        <TableCell className={diffClass(row.original.address2, display.address2)}>
                          <span className="text-sm">{display.address2}</span>
                        </TableCell>
                        <TableCell className={diffClass(row.original.city, display.city)}>
                          <span className="text-sm">{display.city}</span>
                          {wasCleaned && row.original.city !== display.city && (
                            <div className="text-xs text-muted-foreground line-through">{row.original.city}</div>
                          )}
                        </TableCell>
                        <TableCell className={diffClass(row.original.state, display.state)}>
                          <span className="text-sm">{display.state}</span>
                        </TableCell>
                        <TableCell className={diffClass(row.original.zip, display.zip)}>
                          <span className="text-sm">{display.zip}</span>
                        </TableCell>
                        <TableCell>
                          {v ? (
                            <Badge
                              variant="secondary"
                              className={
                                v.verdict === "CONFIRMED"
                                  ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                                  : v.verdict === "UNCONFIRMED"
                                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                                    : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                              }
                            >
                              {v.verdict}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {v && v.issues.length > 0 ? (
                            <span className="text-xs text-amber-700 dark:text-amber-400">{v.issues.join("; ")}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {v ? (
                            <div className="text-xs space-y-0.5">
                              <div>{v.corrected.address1}</div>
                              <div>
                                {v.corrected.city}, {v.corrected.state} {v.corrected.zip}
                                {v.corrected.zipPlus4 ? `-${v.corrected.zipPlus4}` : ""}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {rows.length === 0 && (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <FileUp className="h-12 w-12 mx-auto mb-4 opacity-40" />
            <p className="text-lg font-medium">Upload a CSV or Excel file to get started</p>
            <p className="text-sm mt-1">
              Supports headerless files (Name, Address 1, Address 2, City, State, Zip) or files with headers.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
