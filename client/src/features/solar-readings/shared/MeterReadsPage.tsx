import { useAuth } from "@/_core/hooks/useAuth";
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
import { Progress } from "@/components/ui/progress";
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
import { trpc } from "@/lib/trpc";
import {
  buildConvertedReadRow,
  pushConvertedReadsToRecDashboard,
} from "@/lib/convertedReads";
import {
  toErrorMessage,
  formatKwh,
  downloadTextFile,
} from "@/lib/helpers";
import {
  ArrowLeft,
  Download,
  Loader2,
  PlugZap,
  RefreshCw,
  Unplug,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import {
  buildCsv,
  chunkArray,
  extractIdsFromCsv,
  formatDateInput,
  toComparableNumber,
  waitForNextFrame,
} from "./csvUtils";

import type {
  BulkConnectionScope,
  BulkSnapshotRow,
  BulkSortKey,
  BulkStatusFilter,
  MeterReadsProviderConfig,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const BULK_BATCH_SIZE_ACTIVE = 200;
const BULK_BATCH_SIZE_ALL_PROFILES = 25;
const BULK_ROWS_RENDER_INTERVAL_ACTIVE = 1;
const BULK_ROWS_RENDER_INTERVAL_ALL_PROFILES = 4;
const BULK_PAGE_SIZE = 25;

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function MeterReadsPage({
  config,
}: {
  config: MeterReadsProviderConfig;
}) {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const today = useMemo(() => formatDateInput(new Date()), []);

  /* --- credential inputs (dynamic, one per credentialField) --- */
  const [credentialValues, setCredentialValues] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      config.credentialFields.map((f) => [f.name, ""])
    )
  );
  const setCredential = (name: string, value: string) =>
    setCredentialValues((prev) => ({ ...prev, [name]: value }));

  const [connectionNameInput, setConnectionNameInput] =
    useState("");
  const [selectedConnectionId, setSelectedConnectionId] =
    useState("");
  const [selectedEntityId, setSelectedEntityId] = useState("");
  const [selectedOperation, setSelectedOperation] = useState(
    config.singleOperations[0]?.value ?? "getProductionSnapshot"
  );
  const [resultTitle, setResultTitle] = useState(
    "No request run yet"
  );
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const [bulkAnchorDate, setBulkAnchorDate] = useState(today);
  const [bulkEntityIds, setBulkEntityIds] = useState<string[]>([]);
  const [bulkSourceFileName, setBulkSourceFileName] = useState<
    string | null
  >(null);
  const [bulkImportError, setBulkImportError] = useState<
    string | null
  >(null);
  const [bulkRows, setBulkRows] = useState<BulkSnapshotRow[]>([]);
  const [bulkIsRunning, setBulkIsRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({
    total: 0,
    processed: 0,
    found: 0,
    notFound: 0,
    errored: 0,
  });
  const [bulkStatusFilter, setBulkStatusFilter] =
    useState<BulkStatusFilter>("All");
  const [bulkSearch, setBulkSearch] = useState("");
  const [bulkSort, setBulkSort] =
    useState<BulkSortKey>("entityId");
  const [bulkConnectionScope, setBulkConnectionScope] =
    useState<BulkConnectionScope>("active");
  const [bulkPage, setBulkPage] = useState(1);
  const bulkCancelRef = useRef(false);

  /* --- tRPC hooks (from config) --- */
  const statusQuery = config.useStatusQuery(!!user);

  const listItemsQuery = config.useListItemsQuery?.(
    !!user && !!statusQuery.data?.connected
  );

  const connectMutation = config.useConnectMutation();
  const setActiveConnectionMutation =
    config.useSetActiveConnectionMutation();
  const removeConnectionMutation =
    config.useRemoveConnectionMutation();
  const disconnectMutation = config.useDisconnectMutation();
  const productionSnapshotMutation =
    config.useProductionSnapshotMutation();
  const pushConvertedReadsSource =
    trpc.solarRecDashboard.pushConvertedReadsSource.useMutation();

  /* --- effects --- */

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;

    const availableIds = new Set(
      statusQuery.data.connections.map((connection) => connection.id)
    );
    if (availableIds.size === 0) {
      setSelectedConnectionId("");
      return;
    }

    setSelectedConnectionId((current) => {
      if (current && availableIds.has(current)) return current;
      return (
        statusQuery.data?.activeConnectionId ??
        statusQuery.data?.connections[0]?.id ??
        ""
      );
    });
  }, [statusQuery.data]);

  // Auto-select first list item when provider has a list query
  useEffect(() => {
    if (!config.hasListItems || !listItemsQuery?.data) return;
    const key = config.listItemsKey;
    if (!key) return;
    const items = (listItemsQuery.data as Record<string, unknown[]>)[
      key
    ] as Array<Record<string, string>> | undefined;
    const firstItem = items?.[0];
    if (!firstItem) return;
    if (!selectedEntityId) {
      setSelectedEntityId(
        firstItem[config.idFieldName] ?? ""
      );
    }
  }, [
    listItemsQuery?.data,
    selectedEntityId,
    config.hasListItems,
    config.listItemsKey,
    config.idFieldName,
  ]);

  useEffect(() => {
    setBulkPage(1);
  }, [bulkRows.length, bulkSearch, bulkSort, bulkStatusFilter]);

  useEffect(() => {
    setBulkRows([]);
    setBulkProgress({
      total: bulkEntityIds.length,
      processed: 0,
      found: 0,
      notFound: 0,
      errored: 0,
    });
  }, [bulkEntityIds.length]);

  /* --- handlers --- */

  const handleConnect = async () => {
    // Validate required credential fields
    const requiredFields = config.credentialFields.filter(
      (f) => !f.optional
    );
    const missingFields = requiredFields.filter(
      (f) => !credentialValues[f.name]?.trim()
    );
    if (missingFields.length > 0) {
      toast.error(
        `Enter ${missingFields.map((f) => f.label).join(", ")}.`
      );
      return;
    }

    try {
      const input: Record<string, string | undefined> = {};
      for (const field of config.credentialFields) {
        const val = credentialValues[field.name]?.trim();
        if (field.optional) {
          input[field.name] = val || undefined;
        } else {
          input[field.name] = val;
        }
      }
      input.connectionName =
        connectionNameInput.trim() || undefined;

      const response = await connectMutation.mutateAsync(input);
      await config.invalidateQueries(trpcUtils);
      setSelectedConnectionId(response.activeConnectionId);
      // Reset credential inputs
      setCredentialValues(
        Object.fromEntries(
          config.credentialFields.map((f) => [f.name, ""])
        )
      );
      setConnectionNameInput("");
      toast.success(
        `${config.providerName} profile saved. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) stored.`
      );
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleSetActiveConnection = async () => {
    const connectionId = selectedConnectionId.trim();
    if (!connectionId) {
      toast.error("Select an API profile first.");
      return;
    }

    try {
      await setActiveConnectionMutation.mutateAsync({
        connectionId,
      });
      await config.invalidateQueries(trpcUtils);
      if (config.hasListItems) setSelectedEntityId("");
      toast.success(
        `Active ${config.providerName} API profile updated.`
      );
    } catch (error) {
      toast.error(
        `Failed to switch profile: ${toErrorMessage(error)}`
      );
    }
  };

  const handleRemoveConnection = async () => {
    const connectionId = selectedConnectionId.trim();
    if (!connectionId) {
      toast.error("Select an API profile first.");
      return;
    }

    try {
      const response =
        await removeConnectionMutation.mutateAsync({
          connectionId,
        });
      await config.invalidateQueries(trpcUtils);
      if (config.hasListItems) setSelectedEntityId("");
      setSelectedConnectionId(
        response.activeConnectionId ?? ""
      );
      toast.success(
        response.connected
          ? `Removed profile. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) remain.`
          : `Removed final profile. ${config.providerName} is now disconnected.`
      );
    } catch (error) {
      toast.error(
        `Failed to remove profile: ${toErrorMessage(error)}`
      );
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await config.invalidateQueries(trpcUtils);
      if (config.hasListItems) setSelectedEntityId("");
      setSelectedConnectionId("");
      toast.success(`${config.providerName} disconnected.`);
    } catch (error) {
      toast.error(
        `Failed to disconnect: ${toErrorMessage(error)}`
      );
    }
  };

  const runAction = async (
    title: string,
    action: () => Promise<unknown>
  ) => {
    setIsRunningAction(true);
    try {
      const payload = await action();
      setResultTitle(title);
      setResultText(JSON.stringify(payload, null, 2));
      toast.success(`${title} loaded.`);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setIsRunningAction(false);
    }
  };

  const handleRunSingleOperation = () => {
    if (selectedOperation === "getProductionSnapshot") {
      if (!selectedEntityId) {
        toast.error(
          `Enter a ${config.idFieldLabel} first.`
        );
        return;
      }
      void runAction("Production Snapshot", () =>
        productionSnapshotMutation.mutateAsync({
          [config.idFieldName]: selectedEntityId,
          anchorDate: bulkAnchorDate || undefined,
        })
      );
    } else if (
      config.hasListItems &&
      listItemsQuery
    ) {
      // listPlants / listSites / listStations etc.
      const listLabel =
        config.singleOperations.find(
          (o) => o.value === selectedOperation
        )?.label ?? selectedOperation;
      void runAction(listLabel, () =>
        listItemsQuery
          .refetch()
          .then(
            (result: { data: unknown }) => result.data
          )
      );
    }
  };

  const handleBulkFileUpload = async (
    file: File | null
  ) => {
    if (!file) return;
    setBulkImportError(null);

    try {
      const raw = await file.text();
      const ids = extractIdsFromCsv(
        raw,
        config.csvIdHeaders
      );
      if (ids.length === 0) {
        setBulkImportError(
          `No valid ${config.idFieldLabelPlural} found in CSV.`
        );
        setBulkEntityIds([]);
        setBulkSourceFileName(file.name);
        return;
      }

      setBulkSourceFileName(file.name);
      setBulkEntityIds(ids);
      setBulkRows([]);
      setBulkProgress({
        total: ids.length,
        processed: 0,
        found: 0,
        notFound: 0,
        errored: 0,
      });
      toast.success(
        `Imported ${NUMBER_FORMATTER.format(ids.length)} ${config.idFieldLabelPlural}.`
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to parse CSV.";
      setBulkImportError(message);
      setBulkEntityIds([]);
    }
  };

  const handlePullAllItems = async () => {
    if (!isConnected) {
      toast.error(
        `Connect ${config.providerName} before pulling ${config.listItemsKey ?? "items"}.`
      );
      return;
    }
    if (!listItemsQuery || !config.listItemsKey) return;
    try {
      const result = await listItemsQuery.refetch();
      const items =
        (
          result.data as Record<string, unknown[]> | undefined
        )?.[config.listItemsKey] ?? [];
      if (items.length === 0) {
        toast.error(
          `No ${config.listItemsKey} found for this API profile.`
        );
        return;
      }
      const ids = (
        items as Array<Record<string, string>>
      ).map(
        (item) =>
          item[config.idFieldName] ?? ""
      );
      setBulkEntityIds(ids);
      setBulkSourceFileName(
        `API \u2014 ${ids.length} ${config.listItemsKey}`
      );
      setBulkRows([]);
      setBulkImportError(null);
      setBulkProgress({
        total: ids.length,
        processed: 0,
        found: 0,
        notFound: 0,
        errored: 0,
      });
      toast.success(
        `Loaded ${NUMBER_FORMATTER.format(ids.length)} ${config.idFieldLabelPlural}. Next step: click "Run Production Snapshot" to fetch row data.`
      );
    } catch (error) {
      toast.error(
        `Failed to list ${config.listItemsKey}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  const runBulkSnapshot = async () => {
    if (!statusQuery.data?.connected) {
      toast.error(
        `Connect ${config.providerName} before running bulk processing.`
      );
      return;
    }
    if (bulkEntityIds.length === 0) {
      toast.error(
        `Upload a CSV with ${config.idFieldLabelPlural} first.`
      );
      return;
    }

    setBulkIsRunning(true);
    bulkCancelRef.current = false;
    setBulkRows([]);
    const effectiveBatchSize =
      bulkConnectionScope === "all"
        ? BULK_BATCH_SIZE_ALL_PROFILES
        : BULK_BATCH_SIZE_ACTIVE;
    const rowRenderInterval =
      bulkConnectionScope === "all"
        ? BULK_ROWS_RENDER_INTERVAL_ALL_PROFILES
        : BULK_ROWS_RENDER_INTERVAL_ACTIVE;
    const chunks = chunkArray(
      bulkEntityIds,
      effectiveBatchSize
    );
    let processed = 0;
    let found = 0;
    let notFound = 0;
    let errored = 0;
    const collectedRows: BulkSnapshotRow[] = [];
    setBulkProgress({
      total: bulkEntityIds.length,
      processed: 0,
      found: 0,
      notFound: 0,
      errored: 0,
    });

    try {
      for (
        let chunkIndex = 0;
        chunkIndex < chunks.length;
        chunkIndex += 1
      ) {
        const chunk = chunks[chunkIndex];
        if (bulkCancelRef.current) break;

        for (const id of chunk) {
          if (bulkCancelRef.current) break;
          try {
            const raw =
              await productionSnapshotMutation.mutateAsync(
                {
                  [config.idFieldName]: id,
                  anchorDate: bulkAnchorDate,
                }
              );
            const snapshotRow =
              raw as unknown as Record<string, unknown>;

            // Normalize the provider-specific ID field to entityId
            const row: BulkSnapshotRow = {
              entityId: id,
              name:
                (snapshotRow.name as string | null) ??
                null,
              status: snapshotRow.found
                ? "Found"
                : "Not Found",
              found: Boolean(snapshotRow.found),
              lifetimeKwh:
                snapshotRow.lifetimeKwh as
                  | number
                  | null
                  | undefined,
              hourlyProductionKwh:
                snapshotRow.hourlyProductionKwh as
                  | number
                  | null
                  | undefined,
              monthlyProductionKwh:
                snapshotRow.monthlyProductionKwh as
                  | number
                  | null
                  | undefined,
              mtdProductionKwh:
                snapshotRow.mtdProductionKwh as
                  | number
                  | null
                  | undefined,
              previousCalendarMonthProductionKwh:
                snapshotRow.previousCalendarMonthProductionKwh as
                  | number
                  | null
                  | undefined,
              last12MonthsProductionKwh:
                snapshotRow.last12MonthsProductionKwh as
                  | number
                  | null
                  | undefined,
              weeklyProductionKwh:
                snapshotRow.weeklyProductionKwh as
                  | number
                  | null
                  | undefined,
              dailyProductionKwh:
                snapshotRow.dailyProductionKwh as
                  | number
                  | null
                  | undefined,
              anchorDate:
                snapshotRow.anchorDate as
                  | string
                  | undefined,
              monthlyStartDate:
                snapshotRow.monthlyStartDate as
                  | string
                  | undefined,
              weeklyStartDate:
                snapshotRow.weeklyStartDate as
                  | string
                  | undefined,
              mtdStartDate:
                snapshotRow.mtdStartDate as
                  | string
                  | undefined,
              previousCalendarMonthStartDate:
                snapshotRow.previousCalendarMonthStartDate as
                  | string
                  | undefined,
              previousCalendarMonthEndDate:
                snapshotRow.previousCalendarMonthEndDate as
                  | string
                  | undefined,
              last12MonthsStartDate:
                snapshotRow.last12MonthsStartDate as
                  | string
                  | undefined,
              matchedConnectionId:
                (snapshotRow.matchedConnectionId as
                  | string
                  | null) ?? null,
              matchedConnectionName:
                (snapshotRow.matchedConnectionName as
                  | string
                  | null) ?? null,
              checkedConnections:
                (snapshotRow.checkedConnections as number) ??
                1,
              foundInConnections:
                (snapshotRow.foundInConnections as number) ??
                (snapshotRow.found ? 1 : 0),
              profileStatusSummary:
                (snapshotRow.profileStatusSummary as string) ??
                "",
              error:
                (snapshotRow.error as string | null) ??
                null,
            };

            // Use status from server if present
            if (snapshotRow.status === "Found") {
              row.status = "Found";
              row.found = true;
            } else if (
              snapshotRow.status === "Not Found"
            ) {
              row.status = "Not Found";
              row.found = false;
            } else if (
              snapshotRow.status === "Error"
            ) {
              row.status = "Error";
              row.found = false;
            }

            collectedRows.push(row);
            if (row.found) found++;
            else if (row.status === "Not Found")
              notFound++;
            else errored++;
          } catch (idError) {
            const errorMessage =
              toErrorMessage(idError);
            const isNotFound =
              errorMessage
                .toLowerCase()
                .includes("not found") ||
              errorMessage
                .toLowerCase()
                .includes("404");
            collectedRows.push({
              entityId: id,
              name: null,
              status: isNotFound
                ? "Not Found"
                : "Error",
              found: false,
              error: errorMessage,
              matchedConnectionId: null,
              matchedConnectionName: null,
              checkedConnections:
                bulkConnectionScope === "all"
                  ? (statusQuery.data?.connections
                      .length ?? 0)
                  : 1,
              foundInConnections: 0,
              profileStatusSummary: "",
            });
            if (isNotFound) notFound++;
            else errored++;
          }
          processed++;
          setBulkProgress({
            total: bulkEntityIds.length,
            processed,
            found,
            notFound,
            errored,
          });
        }

        const shouldRenderRows =
          chunkIndex % rowRenderInterval === 0 ||
          chunkIndex === chunks.length - 1 ||
          bulkCancelRef.current;
        if (shouldRenderRows) {
          setBulkRows([...collectedRows]);
        }

        await waitForNextFrame();
      }

      if (bulkCancelRef.current) {
        toast.message(
          `Stopped production snapshots after ${NUMBER_FORMATTER.format(processed)} of ${NUMBER_FORMATTER.format(bulkEntityIds.length)} ${config.idFieldLabelPlural}.`
        );
      } else {
        toast.success(
          `Completed production snapshots for ${NUMBER_FORMATTER.format(processed)} ${config.idFieldLabelPlural}${bulkConnectionScope === "all" ? " using all saved API profiles" : ""}. Found ${NUMBER_FORMATTER.format(found)}, not found ${NUMBER_FORMATTER.format(notFound)}, errors ${NUMBER_FORMATTER.format(errored)}.`
        );

        try {
          const readRows = collectedRows
            .filter(
              (row) =>
                row.found &&
                row.lifetimeKwh != null &&
                row.anchorDate
            )
            .map((row) =>
              buildConvertedReadRow(
                config.convertedReadsMonitoring,
                row.entityId,
                row.name ?? "",
                row.lifetimeKwh!,
                row.anchorDate!
              )
            );
          if (readRows.length === 0) {
            toast.message(
              `No ${config.providerName} rows to push to Converted Reads — ${NUMBER_FORMATTER.format(found)} sites returned but none had a lifetime kWh reading.`
            );
          } else {
            const result =
              await pushConvertedReadsToRecDashboard(
                (input) =>
                  pushConvertedReadsSource.mutateAsync(input),
                readRows,
                config.convertedReadsMonitoring
              );
            if (result.pushed > 0) {
              toast.success(
                `Pushed ${NUMBER_FORMATTER.format(result.pushed)} ${config.providerName} rows to Solar REC Dashboard Converted Reads.${result.skipped > 0 ? ` ${NUMBER_FORMATTER.format(result.skipped)} duplicates skipped.` : ""}`
              );
            } else if (result.skipped > 0) {
              toast.message(
                `All ${NUMBER_FORMATTER.format(result.skipped)} ${config.providerName} Converted Reads rows already exist. No new rows pushed.`
              );
            } else {
              toast.message(
                `${config.providerName} Converted Reads push returned 0 rows.`
              );
            }
          }
        } catch (pushError) {
          toast.error(
            `Failed to push Converted Reads: ${toErrorMessage(pushError)}`
          );
        }
      }
    } catch (error) {
      toast.error(
        `Bulk production snapshots failed: ${toErrorMessage(error)}`
      );
    } finally {
      setBulkIsRunning(false);
    }
  };

  /* --- derived data --- */

  const filteredBulkRows = useMemo(() => {
    const normalizedSearch = bulkSearch
      .trim()
      .toLowerCase();
    const filtered = bulkRows.filter((row) => {
      const matchesStatus =
        bulkStatusFilter === "All"
          ? true
          : row.status === bulkStatusFilter;
      if (!matchesStatus) return false;
      if (!normalizedSearch) return true;
      const haystack =
        `${row.entityId} ${row.name ?? ""} ${row.status} ${row.error ?? ""}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    });

    filtered.sort((a, b) => {
      switch (bulkSort) {
        case "status":
          return a.status.localeCompare(b.status);
        case "lifetime":
          return (
            toComparableNumber(b.lifetimeKwh) -
            toComparableNumber(a.lifetimeKwh)
          );
        case "hourly":
          return (
            toComparableNumber(
              b.hourlyProductionKwh
            ) -
            toComparableNumber(
              a.hourlyProductionKwh
            )
          );
        case "monthly":
          return (
            toComparableNumber(
              b.monthlyProductionKwh
            ) -
            toComparableNumber(
              a.monthlyProductionKwh
            )
          );
        case "mtd":
          return (
            toComparableNumber(
              b.mtdProductionKwh
            ) -
            toComparableNumber(
              a.mtdProductionKwh
            )
          );
        case "previousMonth":
          return (
            toComparableNumber(
              b.previousCalendarMonthProductionKwh
            ) -
            toComparableNumber(
              a.previousCalendarMonthProductionKwh
            )
          );
        case "last12Months":
          return (
            toComparableNumber(
              b.last12MonthsProductionKwh
            ) -
            toComparableNumber(
              a.last12MonthsProductionKwh
            )
          );
        case "weekly":
          return (
            toComparableNumber(
              b.weeklyProductionKwh
            ) -
            toComparableNumber(
              a.weeklyProductionKwh
            )
          );
        case "daily":
          return (
            toComparableNumber(
              b.dailyProductionKwh
            ) -
            toComparableNumber(
              a.dailyProductionKwh
            )
          );
        case "entityId":
        default:
          return a.entityId.localeCompare(
            b.entityId,
            undefined,
            { numeric: true, sensitivity: "base" }
          );
      }
    });

    return filtered;
  }, [bulkRows, bulkSearch, bulkSort, bulkStatusFilter]);

  const bulkTotalPages = Math.max(
    1,
    Math.ceil(filteredBulkRows.length / BULK_PAGE_SIZE)
  );
  const bulkCurrentPage = Math.min(
    bulkPage,
    bulkTotalPages
  );
  const bulkPageStartIndex =
    (bulkCurrentPage - 1) * BULK_PAGE_SIZE;
  const bulkPageRows = filteredBulkRows.slice(
    bulkPageStartIndex,
    bulkPageStartIndex + BULK_PAGE_SIZE
  );
  const bulkProgressPercent =
    bulkProgress.total > 0
      ? Math.min(
          100,
          (bulkProgress.processed /
            bulkProgress.total) *
            100
        )
      : 0;

  const bulkSortOptions: Array<{
    value: BulkSortKey;
    label: string;
  }> = [
    {
      value: "entityId",
      label: `${config.idFieldLabel} (A-Z)`,
    },
    { value: "status", label: "Status" },
    { value: "lifetime", label: "Lifetime (High-Low)" },
    { value: "hourly", label: "Hourly (High-Low)" },
    { value: "monthly", label: "Monthly (High-Low)" },
    { value: "mtd", label: "MTD (High-Low)" },
    {
      value: "previousMonth",
      label: "Previous Month (High-Low)",
    },
    {
      value: "last12Months",
      label: "Last 12 Months (High-Low)",
    },
    { value: "weekly", label: "Weekly (High-Low)" },
    { value: "daily", label: "Daily (High-Low)" },
  ];

  /* --- CSV export helpers --- */

  const downloadBulkCsv = (
    rows: BulkSnapshotRow[],
    fileNamePrefix: string
  ) => {
    if (rows.length === 0) {
      toast.error("No rows available to export.");
      return;
    }

    const idHeader = config.idFieldName
      .replace(/([A-Z])/g, "_$1")
      .toLowerCase()
      .replace(/^_/, "");

    const headers = [
      idHeader,
      "system_name",
      "status",
      "found",
      "error",
      "matched_connection_id",
      "matched_connection_name",
      "checked_connections",
      "found_in_connections",
      "profile_status_summary",
      "lifetime_kwh",
      "hourly_production_kwh",
      "monthly_production_kwh",
      "mtd_production_kwh",
      "previous_calendar_month_production_kwh",
      "last_12_months_production_kwh",
      "weekly_production_kwh",
      "daily_production_kwh",
      "anchor_date",
      "monthly_start_date",
      "weekly_start_date",
      "mtd_start_date",
      "previous_calendar_month_start_date",
      "previous_calendar_month_end_date",
      "last_12_months_start_date",
    ];

    const csvRows = rows.map((row) => ({
      [idHeader]: row.entityId,
      system_name: row.name,
      status: row.status,
      found: row.found ? "Yes" : "No",
      error: row.error,
      matched_connection_id: row.matchedConnectionId,
      matched_connection_name:
        row.matchedConnectionName,
      checked_connections: row.checkedConnections,
      found_in_connections: row.foundInConnections,
      profile_status_summary:
        row.profileStatusSummary,
      lifetime_kwh: row.lifetimeKwh,
      hourly_production_kwh:
        row.hourlyProductionKwh,
      monthly_production_kwh:
        row.monthlyProductionKwh,
      mtd_production_kwh: row.mtdProductionKwh,
      previous_calendar_month_production_kwh:
        row.previousCalendarMonthProductionKwh,
      last_12_months_production_kwh:
        row.last12MonthsProductionKwh,
      weekly_production_kwh:
        row.weeklyProductionKwh,
      daily_production_kwh:
        row.dailyProductionKwh,
      anchor_date: row.anchorDate,
      monthly_start_date: row.monthlyStartDate,
      weekly_start_date: row.weeklyStartDate,
      mtd_start_date: row.mtdStartDate,
      previous_calendar_month_start_date:
        row.previousCalendarMonthStartDate,
      previous_calendar_month_end_date:
        row.previousCalendarMonthEndDate,
      last_12_months_start_date:
        row.last12MonthsStartDate,
    }));

    const csvText = buildCsv(headers, csvRows);
    const fileName = `${fileNamePrefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(
      fileName,
      csvText,
      "text/csv;charset=utf-8"
    );
  };

  const downloadConvertedReadsCsv = (
    rows: BulkSnapshotRow[]
  ) => {
    const readRows = rows.filter(
      (row) =>
        row.found &&
        row.lifetimeKwh != null &&
        row.anchorDate
    );
    if (readRows.length === 0) {
      toast.error(
        "No rows with lifetime kWh available for Converted Reads export."
      );
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
    const csvRows: Array<
      Record<
        string,
        string | number | boolean | null | undefined
      >
    > = [];
    const csvMonitoringName =
      config.convertedReadsCsvMonitoring ??
      config.convertedReadsMonitoring;
    for (const row of readRows) {
      const base = buildConvertedReadRow(
        csvMonitoringName,
        row.entityId,
        row.name ?? "",
        row.lifetimeKwh!,
        row.anchorDate!
      );
      // Row 1: system name only (ID blank) -- matches by name
      csvRows.push({
        monitoring: base.monitoring,
        monitoring_system_id: "",
        monitoring_system_name:
          base.monitoring_system_name,
        lifetime_meter_read_wh:
          base.lifetime_meter_read_wh,
        read_date: base.read_date,
        status: base.status,
        alert_severity: base.alert_severity,
      });
      // Row 2: system ID only (name blank) -- matches by ID
      csvRows.push({
        monitoring: base.monitoring,
        monitoring_system_id:
          base.monitoring_system_id,
        monitoring_system_name: "",
        lifetime_meter_read_wh:
          base.lifetime_meter_read_wh,
        read_date: base.read_date,
        status: base.status,
        alert_severity: base.alert_severity,
      });
    }
    const csvText = buildCsv(headers, csvRows);
    const fileName = `${config.providerSlug}-converted-reads-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(
      fileName,
      csvText,
      "text/csv;charset=utf-8"
    );
    toast.success(
      `Downloaded ${csvRows.length} Converted Reads rows (${readRows.length} systems \u00d7 2 match rows each).`
    );
  };

  /* --- connection display helpers --- */

  const getConnectionDisplayText = (
    connection: (typeof connections)[number]
  ): string => {
    if (config.connectionCardDetail) {
      return config.connectionCardDetail(connection);
    }
    switch (config.connectionDisplayField) {
      case "apiKeyMasked":
        return `Key: ${connection.apiKeyMasked ?? "N/A"}`;
      case "accountMasked":
        return `Account: ${connection.accountMasked ?? "N/A"}`;
      case "baseUrl":
        return `URL: ${connection.baseUrl ?? "N/A"}`;
      case "idSlice":
      default:
        return `ID: ${connection.id.slice(0, 12)}...`;
    }
  };

  const getConnectionSelectorText = (
    connection: (typeof connections)[number]
  ): string => {
    switch (config.connectionDisplayField) {
      case "apiKeyMasked":
        return `${connection.name} (${connection.apiKeyMasked ?? connection.id.slice(0, 8)})`;
      case "accountMasked":
        return `${connection.name} (${connection.accountMasked ?? connection.id.slice(0, 8)})`;
      case "baseUrl":
        return `${connection.name} (${connection.baseUrl ?? connection.id.slice(0, 8)})`;
      case "idSlice":
      default:
        return `${connection.name} (${connection.id.slice(0, 8)}...)`;
    }
  };

  /* --- loading / auth guards --- */

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) return null;

  const isConnected = Boolean(
    statusQuery.data?.connected
  );
  const connections =
    statusQuery.data?.connections ?? [];
  const activeConnection = connections.find(
    (connection) => connection.isActive
  );
  const statusError = statusQuery.error
    ? toErrorMessage(statusQuery.error)
    : null;
  const listItemsError =
    listItemsQuery && listItemsQuery.error
      ? toErrorMessage(listItemsQuery.error)
      : null;

  const savedProfilesLabel =
    config.savedProfilesLabel ?? "Saved API Profiles";

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-accent/20">
      <header className="border-b bg-card/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button
            variant="ghost"
            onClick={() => setLocation("/dashboard")}
            className="mb-2"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-foreground">
            {config.pageTitle}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {config.pageDescription}
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        {/* Section 1: Connection Management */}
        <Card>
          <CardHeader>
            <CardTitle>
              1) Connect {config.providerName}
            </CardTitle>
            <CardDescription>
              {config.connectDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className={`grid grid-cols-1 md:grid-cols-${Math.min(config.credentialFields.length + 1, 4)} gap-4`}
            >
              <div className="space-y-2">
                <Label
                  htmlFor={`${config.providerSlug}-connection-name`}
                >
                  Profile Name (optional)
                </Label>
                <Input
                  id={`${config.providerSlug}-connection-name`}
                  value={connectionNameInput}
                  onChange={(e) =>
                    setConnectionNameInput(
                      e.target.value
                    )
                  }
                  placeholder={`Example: ${config.providerName} API 1`}
                />
              </div>
              {config.credentialFields.map((field) => (
                <div
                  key={field.name}
                  className="space-y-2"
                >
                  <Label
                    htmlFor={`${config.providerSlug}-${field.name}`}
                  >
                    {field.label}
                    {field.optional
                      ? " (optional)"
                      : ""}
                  </Label>
                  <Input
                    id={`${config.providerSlug}-${field.name}`}
                    type={field.type ?? "text"}
                    value={
                      credentialValues[
                        field.name
                      ] ?? ""
                    }
                    onChange={(e) =>
                      setCredential(
                        field.name,
                        e.target.value
                      )
                    }
                    placeholder={field.placeholder}
                  />
                  {field.helperText ? (
                    <p className="text-xs text-muted-foreground">
                      {field.helperText}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>

            {connections.length > 0 ? (
              <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div className="space-y-2 md:col-span-2">
                    <Label>
                      {savedProfilesLabel}
                    </Label>
                    <Select
                      value={selectedConnectionId}
                      onValueChange={
                        setSelectedConnectionId
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select saved profile" />
                      </SelectTrigger>
                      <SelectContent>
                        {connections.map(
                          (connection) => (
                            <SelectItem
                              key={connection.id}
                              value={connection.id}
                            >
                              {getConnectionSelectorText(
                                connection
                              )}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={
                        handleSetActiveConnection
                      }
                      disabled={
                        !selectedConnectionId ||
                        setActiveConnectionMutation.isPending
                      }
                    >
                      {setActiveConnectionMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : null}
                      Set Active
                    </Button>
                    <Button
                      variant="outline"
                      onClick={
                        handleRemoveConnection
                      }
                      disabled={
                        !selectedConnectionId ||
                        removeConnectionMutation.isPending
                      }
                    >
                      {removeConnectionMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : null}
                      Remove Profile
                    </Button>
                  </div>
                </div>

                <div className="text-xs text-muted-foreground">
                  {NUMBER_FORMATTER.format(
                    connections.length
                  )}{" "}
                  profile(s) saved. Active profile:{" "}
                  <span className="font-medium text-foreground">
                    {activeConnection?.name ?? "N/A"}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {connections.map((connection) => (
                    <div
                      key={connection.id}
                      className={`rounded-md border px-3 py-2 text-xs ${
                        connection.isActive
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "border-border bg-card text-muted-foreground"
                      }`}
                    >
                      <p className="font-medium">
                        {connection.name}
                      </p>
                      <p>
                        {getConnectionDisplayText(
                          connection
                        )}
                      </p>
                      <p>
                        Updated:{" "}
                        {new Date(
                          connection.updatedAt
                        ).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {statusError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Status error: {statusError}
              </div>
            )}

            {listItemsError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                List error: {listItemsError}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={handleConnect}
                disabled={connectMutation.isPending}
              >
                {connectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <PlugZap className="h-4 w-4 mr-2" />
                )}
                Connect
              </Button>
              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={
                  disconnectMutation.isPending ||
                  !isConnected
                }
              >
                {disconnectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Unplug className="h-4 w-4 mr-2" />
                )}
                Disconnect
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  statusQuery.refetch();
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-muted-foreground">
                Status:{" "}
                {isConnected
                  ? `Connected (${connections.length} profile${connections.length === 1 ? "" : "s"})`
                  : "Not connected"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Single API Tester */}
        <Card>
          <CardHeader>
            <CardTitle>
              2) Single {config.idFieldLabel} API
              Tester
            </CardTitle>
            <CardDescription>
              Enter a {config.idFieldLabel} manually,
              then fetch production snapshot.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label
                  htmlFor={`manual-${config.providerSlug}-id`}
                >
                  {config.idFieldLabel}
                </Label>
                <Input
                  id={`manual-${config.providerSlug}-id`}
                  value={selectedEntityId}
                  onChange={(e) =>
                    setSelectedEntityId(
                      e.target.value.trim()
                    )
                  }
                  placeholder={`Enter ${config.providerName} ${config.idFieldLabel}`}
                />
              </div>

              <div className="space-y-2">
                <Label>Operation</Label>
                <Select
                  value={selectedOperation}
                  onValueChange={setSelectedOperation}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {config.singleOperations.map(
                      (op) => (
                        <SelectItem
                          key={op.value}
                          value={op.value}
                        >
                          {op.label}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="single-anchor-date">
                  Anchor Date (optional)
                </Label>
                <Input
                  id="single-anchor-date"
                  type="date"
                  value={bulkAnchorDate}
                  onChange={(e) =>
                    setBulkAnchorDate(e.target.value)
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Defaults to today if left empty. Used
                  to anchor production windows.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  isRunningAction || !isConnected
                }
                onClick={handleRunSingleOperation}
              >
                {isRunningAction ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Run Operation
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Bulk CSV Processing */}
        <Card>
          <CardHeader>
            <CardTitle>
              3) Bulk CSV Processing
            </CardTitle>
            <CardDescription>
              Upload a CSV of{" "}
              {config.idFieldLabelPlural} and process
              production snapshots in batches.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="bulk-anchor-date">
                  Anchor Date
                </Label>
                <Input
                  id="bulk-anchor-date"
                  type="date"
                  value={bulkAnchorDate}
                  onChange={(e) =>
                    setBulkAnchorDate(e.target.value)
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Used for production snapshots.
                  Production windows: Monthly = last 30
                  days, MTD = first of current month
                  through anchor day, Previous Month =
                  prior calendar month, Last 12 Months
                  = trailing 12 months ending on anchor
                  day.
                </p>
              </div>
              <div className="space-y-2">
                <Label>API Scope</Label>
                <Select
                  value={bulkConnectionScope}
                  onValueChange={(value) =>
                    setBulkConnectionScope(
                      value as BulkConnectionScope
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">
                      Active API Profile Only
                    </SelectItem>
                    <SelectItem value="all">
                      All Saved API Profiles
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Use{" "}
                  <span className="font-medium">
                    All Saved API Profiles
                  </span>{" "}
                  to check each{" "}
                  {config.idFieldLabel} against every
                  connected API.
                </p>
              </div>
              <div className="space-y-2">
                <Label>
                  {config.idFieldLabelPlural}
                </Label>
                <div className="flex items-center gap-2">
                  <label className="cursor-pointer">
                    <Input
                      id="bulk-csv-upload"
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(event) => {
                        void handleBulkFileUpload(
                          event.target.files?.[0] ??
                            null
                        );
                        event.currentTarget.value =
                          "";
                      }}
                    />
                    <span className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground cursor-pointer">
                      <Upload className="h-4 w-4 mr-2" />
                      Upload CSV
                    </span>
                  </label>
                  {config.hasListItems ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!isConnected}
                      onClick={handlePullAllItems}
                    >
                      Pull All from API
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      bulkEntityIds.length === 0
                    }
                    onClick={() => {
                      setBulkEntityIds([]);
                      setBulkRows([]);
                      setBulkSourceFileName(null);
                      setBulkImportError(null);
                      setBulkProgress({
                        total: 0,
                        processed: 0,
                        found: 0,
                        notFound: 0,
                        errored: 0,
                      });
                    }}
                  >
                    Clear
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Source:{" "}
                  {bulkSourceFileName ?? "None"}
                  {bulkEntityIds.length > 0
                    ? ` \u2014 ${NUMBER_FORMATTER.format(bulkEntityIds.length)} IDs`
                    : ""}
                </p>
                {bulkImportError ? (
                  <p className="text-xs text-destructive">
                    {bulkImportError}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={runBulkSnapshot}
                disabled={
                  bulkIsRunning ||
                  bulkEntityIds.length === 0 ||
                  !isConnected
                }
              >
                {bulkIsRunning ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Run Production Snapshot
              </Button>
              <Button
                variant="outline"
                disabled={!bulkIsRunning}
                onClick={() => {
                  bulkCancelRef.current = true;
                }}
              >
                Stop
              </Button>
              <Button
                variant="outline"
                disabled={bulkRows.length === 0}
                onClick={() =>
                  downloadBulkCsv(
                    bulkRows,
                    `${config.providerSlug}-production-bulk-all`
                  )
                }
              >
                Download All CSV
              </Button>
              <Button
                variant="outline"
                disabled={
                  filteredBulkRows.length === 0
                }
                onClick={() =>
                  downloadBulkCsv(
                    filteredBulkRows,
                    `${config.providerSlug}-production-bulk-filtered`
                  )
                }
              >
                Download Filtered CSV
              </Button>
              <Button
                variant="outline"
                disabled={
                  bulkRows.filter(
                    (r) =>
                      r.found &&
                      r.lifetimeKwh != null
                  ).length === 0
                }
                onClick={() =>
                  downloadConvertedReadsCsv(bulkRows)
                }
              >
                <Download className="h-4 w-4 mr-2" />
                Download Converted Reads CSV
              </Button>
            </div>

            <div className="rounded-lg border bg-card p-3 space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Progress:{" "}
                  {NUMBER_FORMATTER.format(
                    bulkProgress.processed
                  )}{" "}
                  /{" "}
                  {NUMBER_FORMATTER.format(
                    bulkProgress.total
                  )}{" "}
                  {config.idFieldLabelPlural}
                </span>
                <span>
                  {bulkProgressPercent.toFixed(1)}%
                </span>
              </div>
              <Progress value={bulkProgressPercent} />
            </div>

            <div className="grid gap-3 md:grid-cols-5">
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">
                  Imported{" "}
                  {config.idFieldLabelPlural}
                </p>
                <p className="text-xl font-semibold text-foreground">
                  {NUMBER_FORMATTER.format(
                    bulkEntityIds.length
                  )}
                </p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">
                  Processed
                </p>
                <p className="text-xl font-semibold text-foreground">
                  {NUMBER_FORMATTER.format(
                    bulkProgress.processed
                  )}
                </p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">
                  Found
                </p>
                <p className="text-xl font-semibold text-emerald-700 dark:text-emerald-400">
                  {NUMBER_FORMATTER.format(
                    bulkProgress.found
                  )}
                </p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">
                  Not Found
                </p>
                <p className="text-xl font-semibold text-amber-700 dark:text-amber-400">
                  {NUMBER_FORMATTER.format(
                    bulkProgress.notFound
                  )}
                </p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">
                  Errors
                </p>
                <p className="text-xl font-semibold text-rose-700 dark:text-rose-400">
                  {NUMBER_FORMATTER.format(
                    bulkProgress.errored
                  )}
                </p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="bulk-search">
                  Search
                </Label>
                <Input
                  id="bulk-search"
                  value={bulkSearch}
                  onChange={(event) =>
                    setBulkSearch(event.target.value)
                  }
                  placeholder={`Filter by ${config.idFieldLabel} or error`}
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={bulkStatusFilter}
                  onValueChange={(value) =>
                    setBulkStatusFilter(
                      value as BulkStatusFilter
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All">
                      All
                    </SelectItem>
                    <SelectItem value="Found">
                      Found
                    </SelectItem>
                    <SelectItem value="Not Found">
                      Not Found
                    </SelectItem>
                    <SelectItem value="Error">
                      Error
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Sort</Label>
                <Select
                  value={bulkSort}
                  onValueChange={(value) =>
                    setBulkSort(
                      value as BulkSortKey
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {bulkSortOptions.map(
                      (option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                        >
                          {option.label}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Showing{" "}
                {NUMBER_FORMATTER.format(
                  bulkPageRows.length
                )}{" "}
                of{" "}
                {NUMBER_FORMATTER.format(
                  filteredBulkRows.length
                )}{" "}
                rows
              </span>
              <span>
                Page{" "}
                {NUMBER_FORMATTER.format(
                  bulkCurrentPage
                )}{" "}
                of{" "}
                {NUMBER_FORMATTER.format(
                  bulkTotalPages
                )}
              </span>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {config.idFieldLabel}
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    Matched API Profile
                  </TableHead>
                  <TableHead>
                    Found In APIs
                  </TableHead>
                  <TableHead>
                    Lifetime (kWh)
                  </TableHead>
                  <TableHead>
                    Daily (kWh)
                  </TableHead>
                  <TableHead>
                    Weekly (kWh)
                  </TableHead>
                  <TableHead>MTD (kWh)</TableHead>
                  <TableHead>
                    Monthly 30d (kWh)
                  </TableHead>
                  <TableHead>
                    Prev Month (kWh)
                  </TableHead>
                  <TableHead>
                    Last 12M (kWh)
                  </TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bulkPageRows.map((row) => (
                  <TableRow key={row.entityId}>
                    <TableCell className="font-medium font-mono text-xs">
                      {row.entityId}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.name ?? ""}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          row.status === "Found"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300"
                            : row.status ===
                                "Not Found"
                              ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300"
                              : "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-300"
                        }`}
                      >
                        {row.status}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.matchedConnectionName ??
                        "N/A"}
                    </TableCell>
                    <TableCell>
                      {NUMBER_FORMATTER.format(
                        row.foundInConnections ?? 0
                      )}{" "}
                      /{" "}
                      {NUMBER_FORMATTER.format(
                        row.checkedConnections ?? 0
                      )}
                    </TableCell>
                    <TableCell>
                      {formatKwh(row.lifetimeKwh)}
                    </TableCell>
                    <TableCell>
                      {formatKwh(
                        row.dailyProductionKwh
                      )}
                    </TableCell>
                    <TableCell>
                      {formatKwh(
                        row.weeklyProductionKwh
                      )}
                    </TableCell>
                    <TableCell>
                      {formatKwh(
                        row.mtdProductionKwh
                      )}
                    </TableCell>
                    <TableCell>
                      {formatKwh(
                        row.monthlyProductionKwh
                      )}
                    </TableCell>
                    <TableCell>
                      {formatKwh(
                        row.previousCalendarMonthProductionKwh
                      )}
                    </TableCell>
                    <TableCell>
                      {formatKwh(
                        row.last12MonthsProductionKwh
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.error ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
                {bulkPageRows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={13}
                      className="py-6 text-center text-muted-foreground"
                    >
                      No bulk rows to display.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setBulkPage((page) =>
                    Math.max(1, page - 1)
                  )
                }
                disabled={bulkCurrentPage <= 1}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setBulkPage((page) =>
                    Math.min(
                      bulkTotalPages,
                      page + 1
                    )
                  )
                }
                disabled={
                  bulkCurrentPage >= bulkTotalPages
                }
              >
                Next
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Section 4: Raw API Response */}
        <Card>
          <CardHeader>
            <CardTitle>
              4) Raw API Response
            </CardTitle>
            <CardDescription>
              {resultTitle}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-foreground/5 text-foreground rounded-md p-4 overflow-auto max-h-[480px] border">
              {resultText}
            </pre>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
