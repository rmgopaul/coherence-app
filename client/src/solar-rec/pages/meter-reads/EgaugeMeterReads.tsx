import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Database,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import { solarRecTrpc as trpc } from "../../solarRecTrpc";
import { useSolarRecPermission } from "../../hooks/useSolarRecPermission";
import { downloadTextFile, toErrorMessage } from "@/lib/helpers";
import {
  buildConvertedReadRow,
  pushConvertedReadsToRecDashboard,
  type ConvertedReadRow,
} from "@/lib/convertedReads";

type EgaugeAccessType =
  | "public"
  | "user_login"
  | "site_login"
  | "portfolio_login";

type EgaugeProfile = {
  id: string;
  credentialId?: string;
  name: string | null;
  baseUrl: string;
  accessType: EgaugeAccessType;
  username: string | null;
  hasPassword: boolean;
  defaultMeterId: string | null;
  isPortfolio?: boolean;
};

type BulkSnapshotRow = {
  meterId: string;
  meterName: string | null;
  siteName: string | null;
  group: string | null;
  portfolioAccount: string | null;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  lifetimeKwh: number | null;
  dailyProductionKwh: number | null;
  weeklyProductionKwh: number | null;
  monthlyProductionKwh: number | null;
  yearlyProductionKwh: number | null;
  mtdProductionKwh: number | null;
  previousCalendarMonthProductionKwh: number | null;
  last12MonthsProductionKwh: number | null;
  anchorDate: string;
  error: string | null;
};

type PushStatus = {
  state: "idle" | "pushing" | "ok" | "error";
  pushed?: number;
  skipped?: number;
  message?: string;
};

type PortfolioFetchSummary = {
  connectionId: string;
  connectionName: string;
  total: number;
  fetchedAt: string;
  filter: string | null;
  groupId: string | null;
};

const ACCESS_TYPE_LABELS: Record<EgaugeAccessType, string> = {
  public: "Public Link",
  user_login: "Credentialed Login",
  site_login: "Credentialed Login",
  portfolio_login: "Portfolio Login",
};

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeBulkRow(raw: unknown): BulkSnapshotRow {
  const row = readRecord(raw);
  const meterId = readString(row.meterId) ?? readString(row.siteId) ?? "";
  const statusRaw = readString(row.status);
  const status =
    statusRaw === "Not Found" || statusRaw === "Error" ? statusRaw : "Found";
  const anchorDate = readString(row.anchorDate) ?? todayIso();
  return {
    meterId,
    meterName: readString(row.meterName) ?? readString(row.name),
    siteName: readString(row.siteName),
    group: readString(row.group),
    portfolioAccount: readString(row.portfolioAccount),
    status,
    found: row.found === false ? false : status === "Found",
    lifetimeKwh: readNumber(row.lifetimeKwh),
    dailyProductionKwh: readNumber(row.dailyProductionKwh),
    weeklyProductionKwh: readNumber(row.weeklyProductionKwh),
    monthlyProductionKwh: readNumber(row.monthlyProductionKwh),
    yearlyProductionKwh: readNumber(row.yearlyProductionKwh),
    mtdProductionKwh: readNumber(row.mtdProductionKwh),
    previousCalendarMonthProductionKwh: readNumber(
      row.previousCalendarMonthProductionKwh
    ),
    last12MonthsProductionKwh: readNumber(row.last12MonthsProductionKwh),
    anchorDate,
    error: readString(row.error),
  };
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function buildSnapshotCsv(rows: BulkSnapshotRow[]): string {
  const headers = [
    "meter_id",
    "meter_name",
    "site_name",
    "group",
    "portfolio_account",
    "status",
    "lifetime_kwh",
    "daily_production_kwh",
    "weekly_production_kwh",
    "monthly_production_kwh",
    "mtd_production_kwh",
    "previous_month_production_kwh",
    "yearly_production_kwh",
    "last_12_months_production_kwh",
    "anchor_date",
    "error",
  ];
  const body = rows.map(row =>
    [
      row.meterId,
      row.meterName,
      row.siteName,
      row.group,
      row.portfolioAccount,
      row.status,
      row.lifetimeKwh,
      row.dailyProductionKwh,
      row.weeklyProductionKwh,
      row.monthlyProductionKwh,
      row.mtdProductionKwh,
      row.previousCalendarMonthProductionKwh,
      row.yearlyProductionKwh,
      row.last12MonthsProductionKwh,
      row.anchorDate,
      row.error,
    ]
      .map(csvEscape)
      .join(",")
  );
  return `${headers.join(",")}\n${body.join("\n")}\n`;
}

function parseMeterIds(value: string): string[] {
  const byKey = new Map<string, string>();
  value
    .split(/[\n,]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(meterId => {
      const key = meterId.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, meterId);
    });
  return Array.from(byKey.values());
}

function rowsToConvertedReads(rows: BulkSnapshotRow[]): ConvertedReadRow[] {
  return rows
    .filter(row => row.found && row.lifetimeKwh !== null && row.meterId)
    .map(row =>
      buildConvertedReadRow(
        MONITORING_CANONICAL_NAMES.egauge,
        row.meterId,
        row.meterName ?? row.siteName ?? "",
        row.lifetimeKwh as number,
        row.anchorDate
      )
    );
}

function formatKwh(value: number | null): string {
  return value === null
    ? ""
    : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export default function EgaugeMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.egauge.getStatus.useQuery(undefined, {
    retry: false,
  });
  const pushConvertedReads =
    trpc.solarRecDashboard.pushConvertedReadsSource.useMutation();

  const getSystemInfoMutation = trpc.egauge.getSystemInfo.useMutation();
  const getLocalDataMutation = trpc.egauge.getLocalData.useMutation();
  const getRegisterLatestMutation = trpc.egauge.getRegisterLatest.useMutation();
  const getRegisterHistoryMutation =
    trpc.egauge.getRegisterHistory.useMutation();
  const getPortfolioSystemsMutation =
    trpc.egauge.getPortfolioSystems.useMutation();
  const getProductionSnapshotMutation =
    trpc.egauge.getProductionSnapshot.useMutation();
  const getProductionSnapshotsMutation =
    trpc.egauge.getProductionSnapshots.useMutation();
  const getAllPortfolioSnapshotsMutation =
    trpc.egauge.getAllPortfolioSnapshots.useMutation();

  const profiles = (statusQuery.data?.profiles ?? []) as EgaugeProfile[];
  const portfolioProfileCount = profiles.filter(
    profile => profile.accessType === "portfolio_login"
  ).length;

  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [portfolioFilter, setPortfolioFilter] = useState("");
  const [portfolioGroupId, setPortfolioGroupId] = useState("");
  const [registerInput, setRegisterInput] = useState("");
  const [includeRate, setIncludeRate] = useState(false);
  const [historyStart, setHistoryStart] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    return date.toISOString().slice(0, 10);
  });
  const [historyEnd, setHistoryEnd] = useState(todayIso);
  const [intervalMinutes, setIntervalMinutes] = useState("15");
  const [singleMeterId, setSingleMeterId] = useState("");
  const [singleAnchorDate, setSingleAnchorDate] = useState(todayIso);
  const [bulkMeterIds, setBulkMeterIds] = useState("");
  const [bulkAnchorDate, setBulkAnchorDate] = useState(todayIso);
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);
  const [bulkRows, setBulkRows] = useState<BulkSnapshotRow[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [portfolioFetchSummary, setPortfolioFetchSummary] =
    useState<PortfolioFetchSummary | null>(null);
  const [pushStatus, setPushStatus] = useState<PushStatus>({ state: "idle" });

  useEffect(() => {
    if (!selectedConnectionId && profiles.length > 0) {
      setSelectedConnectionId(profiles[0].id);
    }
  }, [profiles, selectedConnectionId]);

  const selectedProfile =
    profiles.find(profile => profile.id === selectedConnectionId) ??
    profiles[0] ??
    null;
  const selectedIsPortfolio = selectedProfile?.accessType === "portfolio_login";
  const selectedProfileFetchSummary =
    portfolioFetchSummary?.connectionId === selectedProfile?.id
      ? portfolioFetchSummary
      : null;

  const effectiveSingleMeterId =
    singleMeterId.trim() || selectedProfile?.defaultMeterId || "";

  const bulkSummary = useMemo(() => {
    return {
      total: bulkRows.length,
      found: bulkRows.filter(row => row.status === "Found").length,
      notFound: bulkRows.filter(row => row.status === "Not Found").length,
      errored: bulkRows.filter(row => row.status === "Error").length,
      eligible: rowsToConvertedReads(bulkRows).length,
    };
  }, [bulkRows]);

  const runAction = async (title: string, action: () => Promise<unknown>) => {
    setIsRunningAction(true);
    try {
      const payload = await action();
      setResultTitle(title);
      setResultText(JSON.stringify(payload, null, 2));
      toast.success(`${title} loaded.`);
      return payload;
    } catch (error) {
      toast.error(toErrorMessage(error));
      throw error;
    } finally {
      setIsRunningAction(false);
    }
  };

  const fetchPortfolioSystems = async () => {
    if (!selectedProfile) {
      throw new Error("Select an eGauge profile first.");
    }
    const result = await getPortfolioSystemsMutation.mutateAsync({
      connectionId: selectedProfile.id,
      filter: portfolioFilter.trim() || undefined,
      groupId: portfolioGroupId.trim() || undefined,
      anchorDate: bulkAnchorDate || undefined,
    });
    const total =
      typeof result.total === "number"
        ? result.total
        : Array.isArray(result.rows)
          ? result.rows.length
          : 0;
    setPortfolioFetchSummary({
      connectionId: result.connectionId ?? selectedProfile.id,
      connectionName:
        result.connectionName ?? selectedProfile.name ?? "Profile",
      total,
      fetchedAt: new Date().toISOString(),
      filter: portfolioFilter.trim() || null,
      groupId: portfolioGroupId.trim() || null,
    });
    return result;
  };

  const handleFetchPortfolioSystems = async () => {
    await runAction("Portfolio Systems", fetchPortfolioSystems).catch(() => {});
  };

  const handlePullPortfolioIds = async () => {
    if (!selectedIsPortfolio) {
      toast.error("Select a Portfolio Login profile first.");
      return;
    }
    setBulkRunning(true);
    try {
      const result = await fetchPortfolioSystems();
      const ids = ((result.rows ?? []) as unknown[])
        .map(row => normalizeBulkRow(row).meterId)
        .filter(Boolean);
      const uniqueIds = parseMeterIds(ids.join("\n"));
      setBulkMeterIds(uniqueIds.join("\n"));
      setResultTitle("Portfolio Systems");
      setResultText(JSON.stringify(result, null, 2));
      toast.success(
        `Fetched ${NUMBER_FORMATTER.format(uniqueIds.length)} eGauge IDs.`
      );
    } catch (error) {
      toast.error(`Failed to fetch portfolio IDs: ${toErrorMessage(error)}`);
    } finally {
      setBulkRunning(false);
    }
  };

  const handleSingleSnapshot = async () => {
    if (!selectedProfile) {
      toast.error("Select an eGauge profile first.");
      return;
    }
    if (!effectiveSingleMeterId) {
      toast.error("Enter a meter ID or set a default meter ID on the profile.");
      return;
    }
    try {
      const result = await getProductionSnapshotMutation.mutateAsync({
        connectionId: selectedProfile.id,
        meterId: effectiveSingleMeterId,
        anchorDate: singleAnchorDate || undefined,
        filter: portfolioFilter.trim() || undefined,
        groupId: portfolioGroupId.trim() || undefined,
      });
      const normalized = normalizeBulkRow(result);
      setBulkRows([normalized]);
      setResultTitle("Production Snapshot");
      setResultText(JSON.stringify(result, null, 2));
      setPushStatus({ state: "idle" });
      toast.success(`Loaded snapshot for ${normalized.meterId}.`);
    } catch (error) {
      toast.error(`Snapshot failed: ${toErrorMessage(error)}`);
    }
  };

  const handleRunBulkSnapshots = async () => {
    if (!selectedProfile) {
      toast.error("Select an eGauge profile first.");
      return;
    }
    const ids = parseMeterIds(bulkMeterIds);
    const autoFetchPortfolioIds = selectedIsPortfolio && ids.length === 0;
    if (!autoFetchPortfolioIds && ids.length === 0) {
      toast.error(
        selectedIsPortfolio
          ? "Fetch portfolio IDs first, or leave the ID box empty to auto-fetch."
          : "Enter at least one meter ID."
      );
      return;
    }

    setBulkRunning(true);
    setBulkRows([]);
    setPushStatus({ state: "idle" });
    try {
      const result = await getProductionSnapshotsMutation.mutateAsync({
        connectionId: selectedProfile.id,
        meterIds: ids.length > 0 ? ids : undefined,
        autoFetchPortfolioIds,
        filter: portfolioFilter.trim() || undefined,
        groupId: portfolioGroupId.trim() || undefined,
        anchorDate: bulkAnchorDate || undefined,
      });
      const rows = ((result.rows ?? []) as unknown[]).map(normalizeBulkRow);
      setBulkRows(rows);
      setResultTitle("Bulk Production Snapshots");
      setResultText(JSON.stringify(result, null, 2));
      if (rows.length > 0) {
        setBulkMeterIds(
          rows
            .map(row => row.meterId)
            .filter(Boolean)
            .join("\n")
        );
      }
      toast.success(
        `Completed eGauge bulk snapshots: ${result.found} found, ${result.notFound} not found, ${result.errored} errors.`
      );
      await pushRowsToConvertedReads(rows);
    } catch (error) {
      toast.error(`Bulk snapshots failed: ${toErrorMessage(error)}`);
    } finally {
      setBulkRunning(false);
    }
  };

  const handleRunAllPortfolios = async () => {
    if (portfolioProfileCount === 0) {
      toast.error("No Portfolio Login profiles are configured.");
      return;
    }
    setBulkRunning(true);
    setBulkRows([]);
    setPushStatus({ state: "idle" });
    try {
      const result = await getAllPortfolioSnapshotsMutation.mutateAsync({
        filter: portfolioFilter.trim() || undefined,
        groupId: portfolioGroupId.trim() || undefined,
        anchorDate: bulkAnchorDate || undefined,
      });
      const rows = ((result.rows ?? []) as unknown[]).map(normalizeBulkRow);
      setBulkRows(rows);
      setResultTitle("All Portfolio Snapshots");
      setResultText(JSON.stringify(result, null, 2));
      if (rows.length > 0) {
        setBulkMeterIds(
          rows
            .map(row => row.meterId)
            .filter(Boolean)
            .join("\n")
        );
      }
      toast.success(
        `All portfolios: ${NUMBER_FORMATTER.format(result.total)} systems loaded.`
      );
      await pushRowsToConvertedReads(rows);
    } catch (error) {
      toast.error(`All portfolios fetch failed: ${toErrorMessage(error)}`);
    } finally {
      setBulkRunning(false);
    }
  };

  const pushRowsToConvertedReads = async (rows: BulkSnapshotRow[]) => {
    const convertedRows = rowsToConvertedReads(rows);
    if (convertedRows.length === 0) {
      setPushStatus({
        state: "ok",
        pushed: 0,
        skipped: 0,
        message: "No Found rows with lifetime kWh to push.",
      });
      return;
    }
    setPushStatus({ state: "pushing" });
    try {
      const result = await pushConvertedReadsToRecDashboard(
        input => pushConvertedReads.mutateAsync(input),
        convertedRows,
        MONITORING_CANONICAL_NAMES.egauge
      );
      setPushStatus({
        state: "ok",
        pushed: result.pushed,
        skipped: result.skipped,
      });
      toast.success(
        `Pushed ${NUMBER_FORMATTER.format(result.pushed)} eGauge row${
          result.pushed === 1 ? "" : "s"
        } to Converted Reads.`
      );
    } catch (error) {
      setPushStatus({ state: "error", message: toErrorMessage(error) });
      toast.error(`Converted Reads push failed: ${toErrorMessage(error)}`);
    }
  };

  const handleDownloadSnapshots = () => {
    if (bulkRows.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile(
      `egauge-snapshots-${stamp}.csv`,
      buildSnapshotCsv(bulkRows)
    );
  };

  const handleDownloadConvertedReads = () => {
    const rows = rowsToConvertedReads(bulkRows);
    if (rows.length === 0) {
      toast.error("No Converted Reads rows are available to download.");
      return;
    }
    const headers = [
      "monitoring",
      "monitoring_system_id",
      "monitoring_system_name",
      "lifetime_meter_read_wh",
      "status",
      "alert_severity",
      "read_date",
    ];
    const csv = [
      headers.join(","),
      ...rows.map(row =>
        headers.map(header => csvEscape(row[header])).join(",")
      ),
    ].join("\n");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile(`egauge-converted-reads-${stamp}.csv`, `${csv}\n`);
  };

  const canRunReadActions = Boolean(selectedProfile);
  const canRunEditActions = canEdit && Boolean(selectedProfile);
  const runningAnyAction =
    isRunningAction ||
    getPortfolioSystemsMutation.isPending ||
    getSystemInfoMutation.isPending ||
    getLocalDataMutation.isPending ||
    getRegisterLatestMutation.isPending ||
    getRegisterHistoryMutation.isPending;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">eGauge</h1>
          <p className="text-sm text-muted-foreground">
            Run direct meter reads or account-level portfolio snapshots from
            Solar REC team credentials.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void statusQuery.refetch()}
          disabled={statusQuery.isFetching}
        >
          {statusQuery.isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Saved Profiles</span>
            {statusQuery.data?.connected ? (
              <Badge>{statusQuery.data.connectionCount} profiles</Badge>
            ) : (
              <Badge variant="outline">No profiles</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Profiles are managed in Solar REC Settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {statusQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No eGauge profiles configured.
            </p>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-[minmax(220px,360px)_1fr]">
                <div className="space-y-1">
                  <Label htmlFor="egauge-profile">Action Profile</Label>
                  <Select
                    value={selectedConnectionId}
                    onValueChange={setSelectedConnectionId}
                  >
                    <SelectTrigger id="egauge-profile">
                      <SelectValue placeholder="Select profile" />
                    </SelectTrigger>
                    <SelectContent>
                      {profiles.map(profile => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.name ?? profile.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap items-end gap-2 text-xs text-muted-foreground">
                  <span className="rounded border px-2 py-1">
                    Mode:{" "}
                    {selectedProfile
                      ? ACCESS_TYPE_LABELS[selectedProfile.accessType]
                      : "N/A"}
                  </span>
                  <span className="rounded border px-2 py-1">
                    Last verified count:{" "}
                    {selectedProfileFetchSummary
                      ? `${NUMBER_FORMATTER.format(
                          selectedProfileFetchSummary.total
                        )} systems`
                      : "not fetched yet"}
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Base URL</TableHead>
                      <TableHead>Access</TableHead>
                      <TableHead>Username</TableHead>
                      <TableHead>Default meter</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {profiles.map(profile => (
                      <TableRow key={profile.id}>
                        <TableCell className="font-medium">
                          {profile.name}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {profile.baseUrl}
                        </TableCell>
                        <TableCell className="text-xs">
                          {ACCESS_TYPE_LABELS[profile.accessType]}
                        </TableCell>
                        <TableCell className="text-xs">
                          {profile.username ?? ""}
                          {profile.accessType !== "public" &&
                          !profile.hasPassword ? (
                            <span className="ml-1 text-amber-700">
                              missing password
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {profile.defaultMeterId ?? ""}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Data Actions</CardTitle>
          <CardDescription>
            {selectedIsPortfolio
              ? "Fetch systems from the selected eGauge portfolio login."
              : "Fetch meter-level diagnostics from the selected eGauge profile."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {selectedIsPortfolio ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="egauge-filter">Portfolio filter</Label>
                <Input
                  id="egauge-filter"
                  value={portfolioFilter}
                  onChange={event => setPortfolioFilter(event.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="egauge-group">Group ID</Label>
                <Input
                  id="egauge-group"
                  value={portfolioGroupId}
                  onChange={event => setPortfolioGroupId(event.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="egauge-register">Register</Label>
                <Input
                  id="egauge-register"
                  value={registerInput}
                  onChange={event => setRegisterInput(event.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="egauge-history-start">History start</Label>
                <Input
                  id="egauge-history-start"
                  type="date"
                  value={historyStart}
                  onChange={event => setHistoryStart(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="egauge-history-end">History end</Label>
                <Input
                  id="egauge-history-end"
                  type="date"
                  value={historyEnd}
                  onChange={event => setHistoryEnd(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="egauge-interval">Interval minutes</Label>
                <Input
                  id="egauge-interval"
                  type="number"
                  min={1}
                  max={1440}
                  value={intervalMinutes}
                  onChange={event => setIntervalMinutes(event.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={includeRate}
                  onChange={event => setIncludeRate(event.target.checked)}
                />
                Include rates
              </label>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {selectedIsPortfolio ? (
              <Button
                variant="outline"
                onClick={handleFetchPortfolioSystems}
                disabled={!canRunReadActions || runningAnyAction}
              >
                {getPortfolioSystemsMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                Fetch Portfolio Systems
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={!canRunReadActions || runningAnyAction}
                  onClick={() =>
                    void runAction("System Info", () =>
                      getSystemInfoMutation.mutateAsync({
                        connectionId: selectedProfile?.id,
                      })
                    ).catch(() => {})
                  }
                >
                  Fetch System Info
                </Button>
                <Button
                  variant="outline"
                  disabled={!canRunReadActions || runningAnyAction}
                  onClick={() =>
                    void runAction("Local Data", () =>
                      getLocalDataMutation.mutateAsync({
                        connectionId: selectedProfile?.id,
                      })
                    ).catch(() => {})
                  }
                >
                  Fetch Local Data
                </Button>
                <Button
                  variant="outline"
                  disabled={!canRunReadActions || runningAnyAction}
                  onClick={() =>
                    void runAction("Register Latest", () =>
                      getRegisterLatestMutation.mutateAsync({
                        connectionId: selectedProfile?.id,
                        register: registerInput.trim() || undefined,
                        includeRate,
                      })
                    ).catch(() => {})
                  }
                >
                  Fetch Register Latest
                </Button>
                <Button
                  variant="outline"
                  disabled={!canRunReadActions || runningAnyAction}
                  onClick={() =>
                    void runAction("Register History", () =>
                      getRegisterHistoryMutation.mutateAsync({
                        connectionId: selectedProfile?.id,
                        startDate: historyStart,
                        endDate: historyEnd,
                        intervalMinutes:
                          Number(intervalMinutes) > 0
                            ? Number(intervalMinutes)
                            : 15,
                        register: registerInput.trim() || undefined,
                        includeRate,
                      })
                    ).catch(() => {})
                  }
                >
                  Fetch Register History
                </Button>
              </>
            )}
          </div>

          <div className="rounded-md border bg-slate-950 p-3 text-xs text-slate-100">
            <div className="mb-2 text-slate-300">{resultTitle}</div>
            <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap">
              {resultText}
            </pre>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Production Snapshot</CardTitle>
          <CardDescription>
            One-meter read using the selected profile.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="egauge-single-meter">Meter ID</Label>
              <Input
                id="egauge-single-meter"
                value={singleMeterId}
                onChange={event => setSingleMeterId(event.target.value)}
                placeholder={selectedProfile?.defaultMeterId ?? "egauge12345"}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="egauge-single-anchor">Anchor date</Label>
              <Input
                id="egauge-single-anchor"
                type="date"
                value={singleAnchorDate}
                onChange={event => setSingleAnchorDate(event.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleSingleSnapshot}
              disabled={
                !canRunEditActions ||
                !effectiveSingleMeterId ||
                getProductionSnapshotMutation.isPending
              }
            >
              {getProductionSnapshotMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Run Snapshot
            </Button>
            <Button
              variant="outline"
              disabled={
                bulkSummary.eligible === 0 || pushConvertedReads.isPending
              }
              onClick={() => void pushRowsToConvertedReads(bulkRows)}
            >
              {pushConvertedReads.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Database className="mr-2 h-4 w-4" />
              )}
              Save Current Rows
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bulk Production Snapshots</CardTitle>
          <CardDescription>
            Portfolio profiles can auto-fetch IDs; meter profiles use saved
            meter IDs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_220px]">
            <div className="space-y-1">
              <Label htmlFor="egauge-bulk-ids">Meter IDs</Label>
              <Textarea
                id="egauge-bulk-ids"
                className="min-h-[120px] font-mono text-xs"
                value={bulkMeterIds}
                onChange={event => setBulkMeterIds(event.target.value)}
                placeholder={
                  selectedIsPortfolio
                    ? "Leave blank to fetch all portfolio IDs"
                    : "egauge12345\negauge67890"
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="egauge-bulk-anchor">Anchor date</Label>
              <Input
                id="egauge-bulk-anchor"
                type="date"
                value={bulkAnchorDate}
                onChange={event => setBulkAnchorDate(event.target.value)}
              />
              <div className="pt-3 text-xs text-muted-foreground">
                {bulkSummary.total > 0
                  ? `${NUMBER_FORMATTER.format(bulkSummary.found)} found, ${NUMBER_FORMATTER.format(bulkSummary.notFound)} not found, ${NUMBER_FORMATTER.format(bulkSummary.errored)} errors`
                  : "No bulk rows loaded"}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {selectedIsPortfolio ? (
              <Button
                variant="outline"
                onClick={handlePullPortfolioIds}
                disabled={!canRunReadActions || bulkRunning}
              >
                {bulkRunning && getPortfolioSystemsMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Fetch All Portfolio IDs
              </Button>
            ) : null}
            <Button
              onClick={handleRunBulkSnapshots}
              disabled={!canRunEditActions || bulkRunning}
            >
              {bulkRunning ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Run Bulk Snapshots
            </Button>
            {portfolioProfileCount > 1 ? (
              <Button
                variant="outline"
                onClick={handleRunAllPortfolios}
                disabled={!canEdit || bulkRunning}
              >
                Run All Portfolios ({portfolioProfileCount})
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={bulkRows.length === 0}
              onClick={handleDownloadSnapshots}
            >
              <Download className="mr-2 h-4 w-4" />
              Download CSV
            </Button>
            <Button
              variant="outline"
              disabled={bulkSummary.eligible === 0}
              onClick={handleDownloadConvertedReads}
            >
              <Download className="mr-2 h-4 w-4" />
              Download Converted Reads
            </Button>
          </div>

          {pushStatus.state !== "idle" ? (
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                pushStatus.state === "error"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
            >
              {pushStatus.state === "pushing"
                ? "Pushing Converted Reads..."
                : (pushStatus.message ??
                  `Converted Reads: ${NUMBER_FORMATTER.format(
                    pushStatus.pushed ?? 0
                  )} pushed, ${NUMBER_FORMATTER.format(
                    pushStatus.skipped ?? 0
                  )} skipped.`)}
            </div>
          ) : null}

          {bulkRows.length > 0 ? (
            <div className="overflow-auto max-h-[440px]">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>Meter ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Group</TableHead>
                    {bulkRows.some(row => row.portfolioAccount) ? (
                      <TableHead>Account</TableHead>
                    ) : null}
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Lifetime</TableHead>
                    <TableHead className="text-right">Daily</TableHead>
                    <TableHead className="text-right">Weekly</TableHead>
                    <TableHead className="text-right">Monthly</TableHead>
                    <TableHead className="text-right">Yearly</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bulkRows.map(row => (
                    <TableRow
                      key={`${row.portfolioAccount ?? ""}-${row.meterId}`}
                    >
                      <TableCell className="font-mono text-xs">
                        {row.meterId}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.meterName ?? row.siteName ?? ""}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.group ?? ""}
                      </TableCell>
                      {bulkRows.some(item => item.portfolioAccount) ? (
                        <TableCell className="text-xs">
                          {row.portfolioAccount ?? ""}
                        </TableCell>
                      ) : null}
                      <TableCell>
                        <Badge
                          variant={
                            row.status === "Found"
                              ? "default"
                              : row.status === "Error"
                                ? "destructive"
                                : "outline"
                          }
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatKwh(row.lifetimeKwh)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatKwh(row.dailyProductionKwh)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatKwh(row.weeklyProductionKwh)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatKwh(row.monthlyProductionKwh)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatKwh(row.yearlyProductionKwh)}
                      </TableCell>
                      <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                        {row.error ?? ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {!canEdit ? (
            <p className="text-sm text-amber-700">
              Running snapshots and saving Converted Reads requires edit access
              to meter reads.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
