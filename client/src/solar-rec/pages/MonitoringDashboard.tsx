import { useEffect, useMemo, useRef, useState } from "react";
import { solarRecTrpc as trpc } from "../solarRecTrpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Activity,
  Play,
  Search,
  Download,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Minus,
  Loader2,
  Upload,
  Bug,
} from "lucide-react";
import { useSolarRecAuth } from "../hooks/useSolarRecAuth";
import { parseCsv } from "@/solar-rec-dashboard/lib/csvIo";

// ---------------------------------------------------------------------------
// Site IDs CSV upload dialog
// ---------------------------------------------------------------------------

type ParsedSite = { siteId: string; name: string | null };

function parseSiteIdsCsv(csvText: string): ParsedSite[] {
  const { headers, rows } = parseCsv(csvText);
  if (rows.length === 0) return [];

  // Auto-detect column names (case-insensitive)
  const lowerHeaders = headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const idCol = headers[lowerHeaders.findIndex((h) =>
    ["siteid", "site_id", "id", "meternumber", "meter_number", "systemid", "system_id"].includes(h)
  )] ?? headers[0]; // fall back to first column
  const nameCol = headers[lowerHeaders.findIndex((h) =>
    ["name", "sitename", "site_name", "system_name", "label"].includes(h)
  )] ?? null;

  const sites: ParsedSite[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const siteId = (row[idCol] ?? "").trim();
    if (!siteId || seen.has(siteId)) continue;
    seen.add(siteId);
    sites.push({
      siteId,
      name: nameCol ? (row[nameCol] ?? "").trim() || null : null,
    });
  }
  return sites;
}

function SiteIdsUploadDialog({
  credentialId,
  credentialLabel,
  open,
  onOpenChange,
}: {
  credentialId: string;
  credentialLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedSite[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existingQuery = trpc.credentials.getSiteIds.useQuery(
    { credentialId },
    { enabled: open }
  );
  const [savedCount, setSavedCount] = useState<number | null>(null);

  // Reset transient state when dialog opens
  useEffect(() => {
    if (open) {
      setSavedCount(null);
      setParsed(null);
      setFileName(null);
      setError(null);
    }
  }, [open]);
  const saveMutation = trpc.credentials.setSiteIds.useMutation({
    onSuccess: (data) => {
      existingQuery.refetch();
      setSavedCount(data.count);
      setParsed(null);
      setFileName(null);
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const sites = parseSiteIdsCsv(reader.result as string);
        if (sites.length === 0) {
          setError("No valid site IDs found in the CSV. Ensure the file has a column named 'siteId', 'id', or similar.");
          setParsed(null);
        } else {
          setParsed(sites);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to parse CSV.");
        setParsed(null);
      }
    };
    reader.readAsText(file);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  };

  const handleSave = () => {
    if (!parsed) return;
    saveMutation.mutate({
      credentialId,
      siteIds: parsed.map((s) => ({ siteId: s.siteId, name: s.name ?? undefined })),
    });
  };

  const existingCount = existingQuery.data?.siteIds.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload Site IDs — {credentialLabel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-1">
          {savedCount != null && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
              <span><span className="font-medium">{savedCount}</span> site IDs saved. They will be used on the next "Run All".</span>
            </div>
          )}
          {savedCount == null && existingCount > 0 && (
            <div className="rounded-md border bg-muted/40 p-2.5 text-xs">
              <span className="font-medium">{existingCount}</span> site IDs currently stored.
              Uploading a new CSV will replace them.
            </div>
          )}

          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            {fileName ? fileName : "Choose CSV file"}
          </Button>

          <p className="text-[11px] text-muted-foreground">
            CSV should have a column named <code className="bg-muted px-1 rounded">siteId</code> (or <code className="bg-muted px-1 rounded">id</code>). An optional <code className="bg-muted px-1 rounded">name</code> column adds labels.
          </p>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          {parsed && (
            <div className="rounded-md border p-2.5 space-y-1.5">
              <p className="text-xs font-medium">
                {parsed.length} site{parsed.length === 1 ? "" : "s"} found
              </p>
              <div className="max-h-40 overflow-y-auto space-y-0.5">
                {parsed.slice(0, 50).map((s) => (
                  <div key={s.siteId} className="text-[11px] text-muted-foreground flex gap-2">
                    <span className="font-mono">{s.siteId}</span>
                    {s.name && <span className="truncate">{s.name}</span>}
                  </div>
                ))}
                {parsed.length > 50 && (
                  <p className="text-[11px] text-muted-foreground">
                    ...and {parsed.length - 50} more
                  </p>
                )}
              </div>
            </div>
          )}

          {savedCount != null ? (
            <Button
              onClick={() => {
                setSavedCount(null);
                onOpenChange(false);
              }}
              className="w-full"
            >
              Done
            </Button>
          ) : (
            <Button
              onClick={handleSave}
              disabled={!parsed || saveMutation.isPending}
              className="w-full"
            >
              {saveMutation.isPending ? "Saving..." : `Save ${parsed?.length ?? 0} Site IDs`}
            </Button>
          )}

          {saveMutation.error && (
            <p className="text-xs text-destructive">{saveMutation.error.message}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Wipe the `dataset:convertedReads` entry from the SolarRec Dashboard's
 * IndexedDB cache. Kept in sync with the constants and database schema
 * in client/src/solar-rec-dashboard/lib/constants.ts and
 * client/src/features/solar-rec/SolarRecDashboard.tsx.
 */
async function clearLocalConvertedReadsFromIndexedDb(): Promise<void> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return;
  const DB_NAME = "solarRecDashboardDb";
  const DB_VERSION = 2;
  const STORE = "datasets";
  const KEY = "dataset:convertedReads";

  await new Promise<void>((resolve, reject) => {
    const openReq = window.indexedDB.open(DB_NAME, DB_VERSION);
    openReq.onerror = () => reject(openReq.error ?? new Error("Failed to open IndexedDB."));
    openReq.onsuccess = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.delete(KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error("IndexedDB transaction failed."));
      };
    };
  });
}

/**
 * Debug dialog — shows the raw state of `dataset:convertedReads` on the server.
 * Use this to confirm whether the monitoring batch bridge actually wrote
 * anything, and if so, what dates/rows are stored.
 */
function DebugConvertedReadsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = trpc.monitoring.debugConvertedReadsState.useQuery(undefined, {
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const [clearStatus, setClearStatus] = useState<string | null>(null);
  const clearMutation = trpc.monitoring.clearConvertedReads.useMutation({
    onSuccess: async () => {
      // Also wipe the client-side IndexedDB copy so the dashboard doesn't
      // re-push stale data on its next auto-sync cycle.
      try {
        await clearLocalConvertedReadsFromIndexedDb();
        setClearStatus("Server + local IndexedDB cleared. Safe to re-run.");
      } catch (err) {
        setClearStatus(
          `Server cleared. Local IndexedDB clear failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      query.refetch();
    },
    onError: (err) => {
      setClearStatus(`Clear failed: ${err.message}`);
    },
  });

  const markFailedMutation = trpc.monitoring.markBatchFailed.useMutation({
    onSuccess: (data) => {
      setClearStatus(
        data.ok
          ? "Latest batch marked as failed."
          : `Batch not marked failed: ${data.message}`
      );
      query.refetch();
    },
    onError: (err) => {
      setClearStatus(`Mark failed error: ${err.message}`);
    },
  });

  const handleClear = () => {
    const confirmed = window.confirm(
      "This will wipe the converted reads dataset on the server AND your local browser cache. You'll need to re-run meter reads to repopulate. Continue?"
    );
    if (!confirmed) return;
    setClearStatus(null);
    clearMutation.mutate();
  };

  const handleMarkFailed = (batchId: string) => {
    const confirmed = window.confirm(
      "Mark this batch as failed? Use this when a batch has been 'running' for a long time without progress (e.g. the server process died). This does NOT cancel any still-running process — it only updates the DB row so the UI unsticks."
    );
    if (!confirmed) return;
    setClearStatus(null);
    markFailedMutation.mutate({ batchId });
  };

  const data = query.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Converted Reads — Raw Server State</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {query.isLoading && <p className="text-muted-foreground">Loading…</p>}
          {query.error && <p className="text-destructive">{query.error.message}</p>}
          {data && (
            <>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <p className="text-muted-foreground">Owner userId</p>
                  <p className="font-mono">{data.ownerUserId}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Today (CT, ISO)</p>
                  <p className="font-mono">{data.todayIso}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Today (CT, M/D/YYYY)</p>
                  <p className="font-mono">{data.todayLocal}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Dataset exists</p>
                  <p className="font-mono">{data.exists ? "yes" : "no"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">uploadedAt</p>
                  <p className="font-mono text-[11px]">{data.uploadedAt ?? "n/a"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Total rows stored</p>
                  <p className="font-mono">{data.totalRows}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Rows matching today</p>
                  <p className="font-mono">{data.todayRowCount}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Payload bytes</p>
                  <p className="font-mono">{data.rawPayloadBytes.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Chunked?</p>
                  <p className="font-mono">
                    {data.chunked ? `yes (${data.chunkKeys.length} chunks)` : "no"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Format</p>
                  <p className="font-mono">
                    {data.isSourceManifest
                      ? `source-manifest (${data.manifestSourceCount})`
                      : "plain"}
                  </p>
                </div>
              </div>

              {data.latestBatch && (
                <div className="rounded border bg-muted/30 p-2 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Latest batch run
                  </p>
                  <div className="text-[11px] font-mono space-y-0.5">
                    <div>id: {data.latestBatch.id}</div>
                    <div>
                      status: <span className={data.latestBatch.status === "running" ? "text-amber-600" : data.latestBatch.status === "failed" ? "text-destructive" : "text-emerald-700"}>{data.latestBatch.status}</span>
                      {" · "}
                      age: {data.latestBatch.ageSeconds != null ? `${data.latestBatch.ageSeconds}s` : "n/a"}
                    </div>
                    <div>
                      providers: {data.latestBatch.providersCompleted}/{data.latestBatch.providersTotal}
                      {" · "}
                      sites: {data.latestBatch.totalSites}
                      {" ("}
                      {data.latestBatch.successCount}✓ {data.latestBatch.errorCount}✗ {data.latestBatch.noDataCount}○{")"}
                    </div>
                    <div>current: {data.latestBatch.currentProvider ?? "none"} {data.latestBatch.currentCredentialName ? `(${data.latestBatch.currentCredentialName})` : ""}</div>
                    <div>started: {data.latestBatch.startedAt?.slice(0, 19) ?? "n/a"}</div>
                    <div>completed: {data.latestBatch.completedAt?.slice(0, 19) ?? "n/a"}</div>
                  </div>
                  {data.latestBatch.status === "running" &&
                    data.latestBatch.ageSeconds != null &&
                    data.latestBatch.ageSeconds > 300 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full mt-1 h-7 text-xs text-destructive hover:bg-destructive/10"
                        disabled={markFailedMutation.isPending}
                        onClick={() => handleMarkFailed(data.latestBatch!.id)}
                      >
                        {markFailedMutation.isPending
                          ? "Marking failed…"
                          : `Force-fail stalled batch (${data.latestBatch.ageSeconds}s old)`}
                      </Button>
                    )}
                </div>
              )}

              {data.sources && data.sources.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Sources (last 5)
                  </p>
                  <div className="space-y-0.5">
                    {data.sources.slice(-5).map((s, i) => (
                      <div key={i} className="text-[11px] font-mono text-muted-foreground">
                        {s.uploadedAt.slice(0, 19)} — {s.fileName} ({s.rowCount})
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {data.sampleRows && data.sampleRows.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Today's rows (first 10)
                  </p>
                  <div className="rounded border bg-muted/30 p-2 max-h-40 overflow-y-auto">
                    {data.sampleRows.map((r, i) => (
                      <div key={i} className="text-[11px] font-mono">
                        {r.monitoring} | {r.monitoring_system_id} |{" "}
                        {r.monitoring_system_name?.slice(0, 20)} | {r.lifetime_meter_read_wh} Wh |{" "}
                        {r.read_date}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {data.totalRows === 0 && data.rawPayloadBytes > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Payload preview (first 400 chars) — diagnostic for mystery payloads
                  </p>
                  <div className="rounded border bg-muted/30 p-2 max-h-32 overflow-y-auto">
                    <div className="text-[10px] font-mono whitespace-pre-wrap break-all">
                      {data.rawPayloadPreview ?? "(empty)"}
                    </div>
                  </div>
                  {data.topLevelKeys && data.topLevelKeys.length > 0 && (
                    <p className="text-[11px] font-mono text-muted-foreground mt-1">
                      Top-level keys: {data.topLevelKeys.join(", ")}
                    </p>
                  )}
                </div>
              )}

              {data.lastRows && data.lastRows.length > 0 && data.todayRowCount === 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Last 5 rows in dataset (no today rows found)
                  </p>
                  <div className="rounded border bg-muted/30 p-2 max-h-40 overflow-y-auto">
                    {data.lastRows.map((r: Record<string, string>, i: number) => (
                      <div key={i} className="text-[11px] font-mono">
                        {r.monitoring} | {r.monitoring_system_id} |{" "}
                        {r.monitoring_system_name?.slice(0, 20)} | {r.lifetime_meter_read_wh} Wh |{" "}
                        {r.read_date}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {clearStatus && (
            <div className="rounded border bg-muted/40 p-2 text-xs">
              {clearStatus}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => query.refetch()}
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={clearMutation.isPending}
            >
              Refresh
            </Button>
            <Button
              onClick={handleClear}
              variant="destructive"
              size="sm"
              className="flex-1"
              disabled={clearMutation.isPending}
            >
              {clearMutation.isPending ? "Clearing…" : "Clear Dataset"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Tiny badge showing stored site count for a credential. */
function StoredSitesBadge({ credentialId }: { credentialId: string }) {
  const query = trpc.credentials.getSiteIds.useQuery({ credentialId });
  const count = query.data?.siteIds.length ?? 0;
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center rounded bg-blue-100 text-blue-700 px-1 py-0 text-[10px] font-medium leading-4">
      {count} sites
    </span>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ApiRun = {
  id: string;
  provider: string;
  siteId: string;
  siteName: string | null;
  dateKey: string;
  status: "success" | "error" | "no_data" | "skipped";
  readingsCount: number;
  lifetimeKwh: number | null;
  errorMessage: string | null;
  durationMs: number | null;
};

type HealthSummary = {
  provider: string;
  totalRuns: number;
  successCount: number;
  errorCount: number;
  noDataCount: number;
  uniqueSites: number;
  lastSuccess: string | null;
};

type GridRow = {
  provider: string;
  siteId: string;
  siteName: string;
  runs: Map<string, ApiRun>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return today's date (YYYY-MM-DD) in the project's local timezone (America/Chicago). */
function todayProjectDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getDateRange(daysBack: number) {
  const endKey = todayProjectDate();
  // Parse back to a Date, subtract days, format again in project TZ.
  // Using UTC-midnight math here is fine because we only care about day offsets.
  const endDate = new Date(`${endKey}T00:00:00`);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - daysBack);
  const startKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(startDate);
  return {
    startDate: startKey,
    endDate: endKey,
  };
}

function getDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (current <= endDate) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates.reverse(); // newest first
}

function formatDate(dateKey: string): string {
  const d = new Date(dateKey + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}

function buildGridRows(data: ApiRun[], search: string): GridRow[] {
  const rowMap = new Map<string, GridRow>();

  for (const run of data) {
    const key = `${run.provider}::${run.siteId}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, {
        provider: run.provider,
        siteId: run.siteId,
        siteName: run.siteName ?? run.siteId,
        runs: new Map(),
      });
    }
    rowMap.get(key)!.runs.set(run.dateKey, run);
  }

  let rows = Array.from(rowMap.values());

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(
      (row) =>
        row.provider.toLowerCase().includes(q) ||
        row.siteId.toLowerCase().includes(q) ||
        row.siteName.toLowerCase().includes(q)
    );
  }

  rows.sort((a, b) =>
    a.provider === b.provider
      ? a.siteName.localeCompare(b.siteName)
      : a.provider.localeCompare(b.provider)
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Status cell component
// ---------------------------------------------------------------------------

function StatusCell({
  run,
  onClick,
}: {
  run: ApiRun | undefined;
  onClick: () => void;
}) {
  if (!run) {
    return (
      <td className="px-1 py-1 text-center">
        <div className="w-8 h-6 rounded bg-muted flex items-center justify-center mx-auto">
          <Minus className="h-3 w-3 text-muted-foreground/40" />
        </div>
      </td>
    );
  }

  const colors = {
    success: "bg-emerald-100 text-emerald-700 hover:bg-emerald-200",
    error: "bg-red-100 text-red-700 hover:bg-red-200",
    no_data: "bg-amber-100 text-amber-700 hover:bg-amber-200",
    skipped: "bg-muted text-muted-foreground",
  };

  return (
    <td className="px-1 py-1 text-center">
      <button
        onClick={onClick}
        className={`w-8 h-6 rounded text-[10px] font-medium ${colors[run.status]} cursor-pointer transition-colors flex items-center justify-center mx-auto`}
        title={`${run.status}: ${run.readingsCount} readings`}
      >
        {run.status === "success"
          ? run.readingsCount
          : run.status === "error"
            ? "!"
            : run.status === "no_data"
              ? "0"
              : "-"}
      </button>
    </td>
  );
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

function SummaryCards({
  health,
  gridData,
  today,
}: {
  health: HealthSummary[];
  gridData: ApiRun[];
  today: string;
}) {
  const totalSites = health.reduce((acc, h) => acc + h.uniqueSites, 0);
  const todayRuns = gridData.filter((r) => r.dateKey === today);
  const todaySuccess = todayRuns.filter((r) => r.status === "success").length;
  const todayErrors = todayRuns.filter((r) => r.status === "error").length;

  const healthyProviders = health.filter(
    (h) => h.errorCount === 0 && h.successCount > 0
  ).length;
  const totalProviders = health.length;

  // Sites missing 3+ consecutive days
  const sitesWithGaps = useMemo(() => {
    const siteLastSuccess = new Map<string, string>();
    for (const run of gridData) {
      if (run.status === "success") {
        const key = `${run.provider}:${run.siteId}`;
        const existing = siteLastSuccess.get(key);
        if (!existing || run.dateKey > existing) {
          siteLastSuccess.set(key, run.dateKey);
        }
      }
    }
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const threshold = threeDaysAgo.toISOString().slice(0, 10);
    let count = 0;
    siteLastSuccess.forEach((lastDate) => {
      if (lastDate < threshold) count++;
    });
    return count;
  }, [gridData]);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <p className="text-xs text-muted-foreground">Total Sites</p>
          <p className="text-2xl font-bold">{totalSites}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <p className="text-xs text-muted-foreground">Reporting Today</p>
          <p className="text-2xl font-bold">
            {todaySuccess}
            <span className="text-sm font-normal text-muted-foreground ml-1">
              / {todaySuccess + todayErrors || totalSites}
            </span>
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <p className="text-xs text-muted-foreground">API Health</p>
          <p className="text-2xl font-bold">
            {healthyProviders}
            <span className="text-sm font-normal text-muted-foreground ml-1">
              / {totalProviders}
            </span>
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3 px-4">
          <p className="text-xs text-muted-foreground">Alerts</p>
          <p className="text-2xl font-bold">
            {sitesWithGaps}
            {sitesWithGaps > 0 && (
              <AlertTriangle className="inline h-4 w-4 ml-1 text-amber-500" />
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type BatchStatus = {
  id: string;
  status: "running" | "completed" | "failed";
  currentProvider: string | null;
  currentCredentialName: string | null;
  providersTotal: number;
  providersCompleted: number;
  totalSites: number;
  successCount: number;
  errorCount: number;
  noDataCount: number;
};

type ConfiguredCredential = {
  id: string;
  provider: string;
  connectionName: string | null;
  label: string;
};

const GRID_PAGE_SIZE = 50;

export default function MonitoringDashboard() {
  const [daysBack] = useState(30);
  const { startDate, endDate } = useMemo(() => getDateRange(daysBack), [daysBack]);
  const today = todayProjectDate();
  const [search, setSearch] = useState("");
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<string[]>([]);
  const [selectedRun, setSelectedRun] = useState<ApiRun | null>(null);
  const [uploadCredentialId, setUploadCredentialId] = useState<string | null>(null);
  const [uploadCredentialLabel, setUploadCredentialLabel] = useState("");
  const [debugOpen, setDebugOpen] = useState(false);
  const { isOperator } = useSolarRecAuth();
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [showSystemPerformance, setShowSystemPerformance] = useState(false);
  const [visibleGridRowCount, setVisibleGridRowCount] = useState(GRID_PAGE_SIZE);

  const gridQuery = trpc.monitoring.getGrid.useQuery({ startDate, endDate });
  const healthQuery = trpc.monitoring.getHealthSummary.useQuery();
  const providersQuery = trpc.monitoring.getConfiguredProviders.useQuery();
  const credentialsQuery = trpc.monitoring.getConfiguredCredentials.useQuery(undefined, {
    enabled: isOperator,
  });
  const batchStatusQuery = trpc.monitoring.getBatchStatus.useQuery(
    { batchId: activeBatchId! },
    { enabled: !!activeBatchId, refetchInterval: 2000 }
  );

  // Track batch progress via polling
  useEffect(() => {
    if (!batchStatusQuery.data) return;
    const data = batchStatusQuery.data as BatchStatus;
    setBatchStatus(data);
    if (data.status === "completed" || data.status === "failed") {
      // Batch finished - stop polling, refresh grid
      setActiveBatchId(null);
      gridQuery.refetch();
      healthQuery.refetch();
    }
  }, [batchStatusQuery.data]);

  const runAllMutation = trpc.monitoring.runAll.useMutation({
    onSuccess: (data) => {
      setActiveBatchId(data.batchId);
      setBatchStatus({
        id: data.batchId,
        status: "running",
        currentProvider: null,
        currentCredentialName: null,
        providersTotal: 0,
        providersCompleted: 0,
        totalSites: 0,
        successCount: 0,
        errorCount: 0,
        noDataCount: 0,
      });
    },
  });

  const isRunning = !!activeBatchId || runAllMutation.isPending;

  const dates = useMemo(() => getDatesInRange(startDate, endDate), [startDate, endDate]);
  const providerOptions = useMemo(() => {
    const fromConfigured = providersQuery.data ?? [];
    const fromHealth = (healthQuery.data ?? []).map((item) => item.provider);
    const fromGrid = (gridQuery.data ?? []).map((item) => item.provider);
    return Array.from(new Set([...fromConfigured, ...fromHealth, ...fromGrid]))
      .filter((provider) => provider.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
  }, [providersQuery.data, healthQuery.data, gridQuery.data]);

  useEffect(() => {
    setSelectedProviders((prev) => prev.filter((provider) => providerOptions.includes(provider)));
  }, [providerOptions]);

  const credentialsInSelectedProviders = useMemo(() => {
    const credentials = (credentialsQuery.data ?? []) as ConfiguredCredential[];
    if (selectedProviders.length === 0) return [] as ConfiguredCredential[];
    return credentials.filter((credential) => selectedProviders.includes(credential.provider));
  }, [credentialsQuery.data, selectedProviders]);

  useEffect(() => {
    const visibleCredentialIds = new Set(credentialsInSelectedProviders.map((credential) => credential.id));
    setSelectedCredentialIds((prev) => prev.filter((credentialId) => visibleCredentialIds.has(credentialId)));
  }, [credentialsInSelectedProviders]);

  const gridRows = useMemo(() => {
    if (!showSystemPerformance) return [];
    return buildGridRows(gridQuery.data ?? [], search);
  }, [gridQuery.data, search, showSystemPerformance]);

  const visibleGridRows = useMemo(
    () => gridRows.slice(0, visibleGridRowCount),
    [gridRows, visibleGridRowCount]
  );

  useEffect(() => {
    setVisibleGridRowCount(GRID_PAGE_SIZE);
  }, [search, showSystemPerformance]);

  const handleRunAll = () => {
    runAllMutation.mutate({ providers: [] });
  };

  const handleRunSelected = () => {
    if (selectedProviders.length === 0) return;
    runAllMutation.mutate({
      providers: selectedProviders,
      credentialIds: selectedCredentialIds,
    });
  };

  const toggleProvider = (provider: string, checked: boolean) => {
    setSelectedProviders((prev) => {
      if (checked) {
        if (prev.includes(provider)) return prev;
        return [...prev, provider].sort((a, b) => a.localeCompare(b));
      }
      return prev.filter((entry) => entry !== provider);
    });
  };

  const toggleCredential = (credentialId: string, checked: boolean) => {
    setSelectedCredentialIds((prev) => {
      if (checked) {
        if (prev.includes(credentialId)) return prev;
        return [...prev, credentialId];
      }
      return prev.filter((id) => id !== credentialId);
    });
  };

  const handleExportCsv = () => {
    const exportRows = buildGridRows(gridQuery.data ?? [], "");
    const headers = ["Provider", "Site ID", "Site Name", ...dates.map(formatDate)];
    const csvRows = exportRows.map((row) => [
      row.provider,
      row.siteId,
      row.siteName,
      ...dates.map((d) => {
        const run = row.runs.get(d);
        if (!run) return "";
        if (run.status === "success") return String(run.readingsCount);
        if (run.status === "error") return "ERROR";
        return "NO_DATA";
      }),
    ]);

    const csv = [headers, ...csvRows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `monitoring-${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Monitoring Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">
            Track API calls and meter readings across all monitoring systems.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={(gridQuery.data?.length ?? 0) === 0}
          >
            <Download className="h-3.5 w-3.5 mr-1" />
            Export CSG CSV
          </Button>
          {isOperator && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDebugOpen(true)}
              title="Show raw converted reads state"
            >
              <Bug className="h-3.5 w-3.5 mr-1" />
              Debug
            </Button>
          )}
          {isOperator && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRunSelected}
                disabled={isRunning || selectedProviders.length === 0}
              >
                {isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1" />
                )}
                {isRunning ? "Running..." : `Run Selected (${selectedProviders.length})`}
              </Button>
              <Button
                size="sm"
                onClick={handleRunAll}
                disabled={isRunning}
              >
                {isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1" />
                )}
                {isRunning ? "Running..." : "Run All"}
              </Button>
            </>
          )}
        </div>
      </div>

      {isOperator && providerOptions.length > 0 && (
        <Card className="border-dashed">
          <CardContent className="py-3 px-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Select one or more monitoring modules, then click <span className="font-medium text-foreground">Run Selected</span>.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={isRunning || selectedProviders.length === providerOptions.length}
                  onClick={() => setSelectedProviders(providerOptions)}
                >
                  Select All
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={isRunning || selectedProviders.length === 0}
                  onClick={() => setSelectedProviders([])}
                >
                  Clear
                </Button>
                <Badge variant="outline" className="text-[11px]">
                  {selectedProviders.length} selected
                </Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {providerOptions.map((provider) => {
                const checked = selectedProviders.includes(provider);
                return (
                  <label
                    key={provider}
                    className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs cursor-pointer ${
                      checked ? "border-blue-300 bg-blue-50 text-blue-900" : "border-border bg-background"
                    } ${isRunning ? "opacity-60 cursor-not-allowed" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isRunning}
                      onChange={(event) => toggleProvider(provider, event.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    <span>{provider}</span>
                  </label>
                );
              })}
            </div>
            {selectedProviders.length > 0 && (
              <div className="space-y-2 border-t pt-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Optional: choose specific logins. If none are selected, all logins for selected modules will run.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={isRunning || credentialsInSelectedProviders.length === 0}
                      onClick={() =>
                        setSelectedCredentialIds(
                          credentialsInSelectedProviders.map((credential) => credential.id)
                        )
                      }
                    >
                      Select All Logins
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={isRunning || selectedCredentialIds.length === 0}
                      onClick={() => setSelectedCredentialIds([])}
                    >
                      Clear Logins
                    </Button>
                    <Badge variant="outline" className="text-[11px]">
                      {selectedCredentialIds.length === 0
                        ? "All logins"
                        : `${selectedCredentialIds.length} login${selectedCredentialIds.length === 1 ? "" : "s"}`}
                    </Badge>
                  </div>
                </div>
                {credentialsInSelectedProviders.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No saved logins found for the selected modules.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {credentialsInSelectedProviders.map((credential) => {
                      const checked = selectedCredentialIds.includes(credential.id);
                      return (
                        <label
                          key={credential.id}
                          className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs cursor-pointer ${
                            checked ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-border bg-background"
                          } ${isRunning ? "opacity-60 cursor-not-allowed" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isRunning}
                            onChange={(event) => toggleCredential(credential.id, event.target.checked)}
                            className="h-3.5 w-3.5"
                          />
                          <span>{credential.provider} • {credential.label}</span>
                          <StoredSitesBadge credentialId={credential.id} />
                          <button
                            type="button"
                            className="ml-1 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                            title="Upload site IDs CSV"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setUploadCredentialId(credential.id);
                              setUploadCredentialLabel(`${credential.provider} • ${credential.label}`);
                            }}
                          >
                            <Upload className="h-3 w-3" />
                          </button>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Progress panel */}
      {isRunning && batchStatus && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3 mb-2">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
              <span className="text-sm font-medium text-blue-900">
                Running monitoring batch...
              </span>
            </div>

            {/* Progress bar */}
            {batchStatus.providersTotal > 0 && (
              <div className="mb-2">
                <div className="flex justify-between text-xs text-blue-700 mb-1">
                  <span>
                    Provider {batchStatus.providersCompleted + (batchStatus.currentProvider ? 1 : 0)} of {batchStatus.providersTotal}
                  </span>
                  <span>
                    {Math.round((batchStatus.providersCompleted / batchStatus.providersTotal) * 100)}%
                  </span>
                </div>
                <div className="h-2 bg-blue-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 rounded-full transition-all duration-500"
                    style={{
                      width: `${(batchStatus.providersCompleted / batchStatus.providersTotal) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Current provider */}
            {batchStatus.currentProvider && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-blue-600 font-medium">
                  Now: {batchStatus.currentProvider}
                </span>
                {batchStatus.currentCredentialName && (
                  <span className="text-blue-500">
                    ({batchStatus.currentCredentialName})
                  </span>
                )}
              </div>
            )}

            {/* Running totals */}
            <div className="flex items-center gap-4 mt-2 text-xs text-blue-700">
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                {batchStatus.successCount} success
              </span>
              <span className="flex items-center gap-1">
                <XCircle className="h-3 w-3 text-red-500" />
                {batchStatus.errorCount} errors
              </span>
              <span>
                {batchStatus.totalSites} total sites
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Batch completed notification */}
      {!isRunning && batchStatus && batchStatus.status !== "running" && (
        <Card className={batchStatus.status === "completed" ? "border-emerald-200 bg-emerald-50/50" : "border-red-200 bg-red-50/50"}>
          <CardContent className="py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                {batchStatus.status === "completed" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-600" />
                )}
                <span className="font-medium">
                  Batch {batchStatus.status}
                </span>
                <span className="text-muted-foreground">
                  {batchStatus.successCount} success, {batchStatus.errorCount} errors, {batchStatus.totalSites} total sites
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => setBatchStatus(null)}
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      <SummaryCards
        health={healthQuery.data ?? []}
        gridData={gridQuery.data ?? []}
        today={today}
      />

      {/* System-level performance */}
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">System-Level Performance</CardTitle>
              <p className="text-sm text-muted-foreground">
                Hidden by default to keep this page fast. Load 50 rows at a time,
                or export the full CSG dataset if you need everything.
              </p>
            </div>
            <Button
              variant={showSystemPerformance ? "outline" : "default"}
              size="sm"
              onClick={() => setShowSystemPerformance((prev) => !prev)}
              disabled={gridQuery.isLoading && !showSystemPerformance}
            >
              {showSystemPerformance ? "Hide System-Level Performance" : "Show System-Level Performance"}
            </Button>
          </div>
          {showSystemPerformance && (
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Filter by provider or site..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-9 text-sm"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Showing {Math.min(visibleGridRows.length, gridRows.length)} of {gridRows.length} sites
              </p>
            </div>
          )}
        </CardHeader>
        <CardContent className={showSystemPerformance ? "p-0 overflow-x-auto" : "pt-0"}>
          {!showSystemPerformance ? (
            <div className="px-6 pb-6">
              <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
                Click <span className="font-medium text-foreground">Show System-Level Performance</span> to load the detailed site table. The export button above downloads the full CSG monitoring dataset without rendering every site in the page.
              </div>
            </div>
          ) : gridQuery.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : gridRows.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm text-muted-foreground">
                No monitoring data yet. Connect API credentials in Settings, then click "Run All" or "Run Selected".
              </p>
            </div>
          ) : (
            <div className="space-y-0">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-3 py-2 font-medium sticky left-0 bg-muted/30 z-10 min-w-[100px]">
                      Provider
                    </th>
                    <th className="text-left px-2 py-2 font-medium min-w-[80px]">
                      Site ID
                    </th>
                    <th className="text-left px-2 py-2 font-medium min-w-[120px]">
                      Site Name
                    </th>
                    {dates.slice(0, 30).map((d) => (
                      <th
                        key={d}
                        className="px-1 py-2 font-medium text-center min-w-[36px]"
                      >
                        {formatDate(d)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleGridRows.map((row) => (
                    <tr
                      key={`${row.provider}::${row.siteId}`}
                      className="border-b hover:bg-muted/20"
                    >
                      <td className="px-3 py-1 sticky left-0 bg-background z-10">
                        <span className="font-medium">{row.provider}</span>
                      </td>
                      <td className="px-2 py-1 text-muted-foreground truncate max-w-[100px]">
                        {row.siteId}
                      </td>
                      <td className="px-2 py-1 truncate max-w-[150px]">
                        {row.siteName}
                      </td>
                      {dates.slice(0, 30).map((d) => (
                        <StatusCell
                          key={d}
                          run={row.runs.get(d)}
                          onClick={() => {
                            const run = row.runs.get(d);
                            if (run) setSelectedRun(run);
                          }}
                        />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {visibleGridRowCount < gridRows.length && (
                <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    Load more if you want to inspect additional systems here. For the full set, use Export CSG CSV.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setVisibleGridRowCount((prev) =>
                        Math.min(prev + GRID_PAGE_SIZE, gridRows.length)
                      )
                    }
                  >
                    Load 50 More
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-emerald-100" />
          Success
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-red-100" />
          Error
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-amber-100" />
          No Data
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-muted" />
          Not Run
        </div>
      </div>

      {/* Site IDs upload dialog */}
      {uploadCredentialId && (
        <SiteIdsUploadDialog
          credentialId={uploadCredentialId}
          credentialLabel={uploadCredentialLabel}
          open={!!uploadCredentialId}
          onOpenChange={(open) => {
            if (!open) setUploadCredentialId(null);
          }}
        />
      )}

      {/* Debug: raw converted reads state dialog */}
      <DebugConvertedReadsDialog open={debugOpen} onOpenChange={setDebugOpen} />

      {/* Run detail dialog */}
      <Dialog
        open={selectedRun !== null}
        onOpenChange={(open) => !open && setSelectedRun(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run Details</DialogTitle>
          </DialogHeader>
          {selectedRun && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">Provider</p>
                  <p className="font-medium">{selectedRun.provider}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Date</p>
                  <p className="font-medium">{selectedRun.dateKey}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Site ID</p>
                  <p className="font-medium">{selectedRun.siteId}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Site Name</p>
                  <p className="font-medium">
                    {selectedRun.siteName ?? "N/A"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <Badge
                    variant={
                      selectedRun.status === "success"
                        ? "default"
                        : selectedRun.status === "error"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {selectedRun.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Readings</p>
                  <p className="font-medium">{selectedRun.readingsCount}</p>
                </div>
                {selectedRun.lifetimeKwh != null && (
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Lifetime kWh
                    </p>
                    <p className="font-medium">
                      {selectedRun.lifetimeKwh.toLocaleString()}
                    </p>
                  </div>
                )}
                {selectedRun.durationMs != null && (
                  <div>
                    <p className="text-xs text-muted-foreground">Duration</p>
                    <p className="font-medium">{selectedRun.durationMs}ms</p>
                  </div>
                )}
              </div>
              {selectedRun.errorMessage && (
                <div className="rounded border border-destructive/20 bg-destructive/5 p-3">
                  <p className="text-xs text-destructive font-mono whitespace-pre-wrap">
                    {selectedRun.errorMessage}
                  </p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
