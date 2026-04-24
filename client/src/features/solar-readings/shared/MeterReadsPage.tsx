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
  BulkDataTypeId,
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

/**
 * Placeholder mutation shape for data types a vendor doesn't implement.
 * Not a React hook — just a function returning a stable object — so
 * invoking it in place of a missing hook doesn't change React's hook
 * order. Real vendor hooks that ARE provided get called in a stable
 * slot alongside this; configs are expected to be module-level consts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopMutation = (): { mutateAsync: (input: any) => Promise<unknown>; isPending: boolean } => ({
  mutateAsync: async () => ({}),
  isPending: false,
});

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

  const defaultDataType: BulkDataTypeId =
    config.bulkDataTypes?.[0]?.value ?? "production";
  const [selectedDataType, setSelectedDataType] =
    useState<BulkDataTypeId>(defaultDataType);
  const hasMultipleDataTypes =
    (config.bulkDataTypes?.length ?? 0) > 1;

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

  // Per-data-type mutation hooks. Call all three alternates
  // unconditionally every render, with a noop fallback so hook order
  // stays stable regardless of which types this vendor supports.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const metersSnapshotMutation = (
    config.useBulkSnapshotMutationByType?.meters ?? noopMutation
  )();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const invertersSnapshotMutation = (
    config.useBulkSnapshotMutationByType?.inverters ?? noopMutation
  )();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const devicesSnapshotMutation = (
    config.useBulkSnapshotMutationByType?.devices ?? noopMutation
  )();

  const mutationByDataType: Record<
    BulkDataTypeId,
    typeof productionSnapshotMutation
  > = {
    production: productionSnapshotMutation,
    meters: metersSnapshotMutation as typeof productionSnapshotMutation,
    inverters:
      invertersSnapshotMutation as typeof productionSnapshotMutation,
    devices:
      devicesSnapshotMutation as typeof productionSnapshotMutation,
  };
  const activeSnapshotMutation = mutationByDataType[selectedDataType];

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
      const operationLabel =
        config.bulkDataTypes?.find(
          (opt) => opt.value === selectedDataType
        )?.label ?? "Production Snapshot";
      void runAction(operationLabel, () =>
        activeSnapshotMutation.mutateAsync({
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
              await activeSnapshotMutation.mutateAsync(
                {
                  [config.idFieldName]: id,
                  anchorDate: bulkAnchorDate,
                  // Passed through to providers that honor it
                  // (e.g. SolarEdge fans out to "active" vs "all").
                  // Vendors that don't recognize the field have Zod
                  // `.object()` strip it by default.
                  connectionScope: bulkConnectionScope,
                }
              );
            const snapshotRow =
              raw as unknown as Record<string, unknown>;

            // Normalize the provider-specific ID field to entityId
            const row: BulkSnapshotRow = {
              entityId: id,
              dataType: selectedDataType,
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

              // Non-production columns (populated only for the
              // matching data type; all are optional on BulkSnapshotRow).
              meterCount:
                snapshotRow.meterCount as
                  | number
                  | null
                  | undefined,
              productionMeters:
                snapshotRow.productionMeters as
                  | number
                  | null
                  | undefined,
              consumptionMeters:
                snapshotRow.consumptionMeters as
                  | number
                  | null
                  | undefined,
              inverterCount:
                snapshotRow.inverterCount as
                  | number
                  | null
                  | undefined,
              invertersWithTelemetry:
                snapshotRow.invertersWithTelemetry as
                  | number
                  | null
                  | undefined,
              inverterFailures:
                snapshotRow.inverterFailures as
                  | number
                  | null
                  | undefined,
              inverterLatestPowerKw:
                snapshotRow.inverterLatestPowerKw as
                  | number
                  | null
                  | undefined,
              inverterLatestEnergyKwh:
                snapshotRow.inverterLatestEnergyKwh as
                  | number
                  | null
                  | undefined,
              deviceCount:
                snapshotRow.deviceCount as
                  | number
                  | null
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
              dataType: selectedDataType,
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

      const runLabel =
        config.bulkDataTypes?.find(
          (opt) => opt.value === selectedDataType
        )?.label ?? "production snapshots";
      if (bulkCancelRef.current) {
        toast.message(
          `Stopped ${runLabel.toLowerCase()} after ${NUMBER_FORMATTER.format(processed)} of ${NUMBER_FORMATTER.format(bulkEntityIds.length)} ${config.idFieldLabelPlural}.`
        );
      } else {
        toast.success(
          `Completed ${runLabel.toLowerCase()} for ${NUMBER_FORMATTER.format(processed)} ${config.idFieldLabelPlural}${bulkConnectionScope === "all" ? " using all saved API profiles" : ""}. Found ${NUMBER_FORMATTER.format(found)}, not found ${NUMBER_FORMATTER.format(notFound)}, errors ${NUMBER_FORMATTER.format(errored)}.`
        );

        // Auto-push to Converted Reads is production-only (only
        // production snapshots produce a lifetime-kWh reading).
        if (selectedDataType === "production") {
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
      }
    } catch (error) {
      const failLabel =
        config.bulkDataTypes?.find(
          (opt) => opt.value === selectedDataType
        )?.label ?? "production snapshots";
      toast.error(
        `Bulk ${failLabel.toLowerCase()} failed: ${toErrorMessage(error)}`
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
        case "meterCount":
          return (
            toComparableNumber(b.meterCount) -
            toComparableNumber(a.meterCount)
          );
        case "productionMeters":
          return (
            toComparableNumber(b.productionMeters) -
            toComparableNumber(a.productionMeters)
          );
        case "consumptionMeters":
          return (
            toComparableNumber(b.consumptionMeters) -
            toComparableNumber(a.consumptionMeters)
          );
        case "inverterCount":
          return (
            toComparableNumber(b.inverterCount) -
            toComparableNumber(a.inverterCount)
          );
        case "invertersWithTelemetry":
          return (
            toComparableNumber(b.invertersWithTelemetry) -
            toComparableNumber(a.invertersWithTelemetry)
          );
        case "inverterFailures":
          return (
            toComparableNumber(b.inverterFailures) -
            toComparableNumber(a.inverterFailures)
          );
        case "inverterLatestPower":
          return (
            toComparableNumber(b.inverterLatestPowerKw) -
            toComparableNumber(a.inverterLatestPowerKw)
          );
        case "inverterLatestEnergy":
          return (
            toComparableNumber(b.inverterLatestEnergyKwh) -
            toComparableNumber(a.inverterLatestEnergyKwh)
          );
        case "deviceCount":
          return (
            toComparableNumber(b.deviceCount) -
            toComparableNumber(a.deviceCount)
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
  }> = useMemo(() => {
    const commonStart: Array<{
      value: BulkSortKey;
      label: string;
    }> = [
      {
        value: "entityId",
        label: `${config.idFieldLabel} (A-Z)`,
      },
      { value: "status", label: "Status" },
    ];
    if (selectedDataType === "meters") {
      return [
        ...commonStart,
        { value: "meterCount", label: "Meter Count (High-Low)" },
        {
          value: "productionMeters",
          label: "Production Meters (High-Low)",
        },
        {
          value: "consumptionMeters",
          label: "Consumption Meters (High-Low)",
        },
      ];
    }
    if (selectedDataType === "inverters") {
      return [
        ...commonStart,
        {
          value: "inverterCount",
          label: "Inverter Count (High-Low)",
        },
        {
          value: "invertersWithTelemetry",
          label: "With Telemetry (High-Low)",
        },
        {
          value: "inverterFailures",
          label: "Failures (High-Low)",
        },
        {
          value: "inverterLatestPower",
          label: "Latest Power (High-Low)",
        },
        {
          value: "inverterLatestEnergy",
          label: "Latest Energy (High-Low)",
        },
      ];
    }
    if (selectedDataType === "devices") {
      return [
        ...commonStart,
        { value: "deviceCount", label: "Device Count (High-Low)" },
      ];
    }
    // production (default)
    return [
      ...commonStart,
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
  }, [selectedDataType, config.idFieldLabel]);

  // If the sort key isn't valid for the active data type, fall back
  // to entityId so the Select doesn't show a stale selection.
  useEffect(() => {
    const valid = bulkSortOptions.some((opt) => opt.value === bulkSort);
    if (!valid) setBulkSort("entityId");
  }, [bulkSortOptions, bulkSort]);

  /*
   * Per-data-type columns used by both the table and CSV exporter.
   * `tableLabel` shown in the table header; `csvHeader` is the
   * snake_case CSV column. Table rendering and CSV extraction share a
   * single source of truth so they can't drift.
   */
  type BulkColumn = {
    key: string;
    tableLabel: string;
    tableRender: (row: BulkSnapshotRow) => React.ReactNode;
    csvHeader: string;
    csvValue: (
      row: BulkSnapshotRow
    ) => string | number | boolean | null | undefined;
    tableOnly?: boolean;
    csvOnly?: boolean;
  };

  const bulkDataColumns: BulkColumn[] = useMemo(() => {
    if (selectedDataType === "meters") {
      return [
        {
          key: "meterCount",
          tableLabel: "Meters",
          tableRender: (row) =>
            row.meterCount == null
              ? ""
              : NUMBER_FORMATTER.format(row.meterCount),
          csvHeader: "meter_count",
          csvValue: (row) => row.meterCount,
        },
        {
          key: "productionMeters",
          tableLabel: "Production",
          tableRender: (row) =>
            row.productionMeters == null
              ? ""
              : NUMBER_FORMATTER.format(row.productionMeters),
          csvHeader: "production_meters",
          csvValue: (row) => row.productionMeters,
        },
        {
          key: "consumptionMeters",
          tableLabel: "Consumption",
          tableRender: (row) =>
            row.consumptionMeters == null
              ? ""
              : NUMBER_FORMATTER.format(row.consumptionMeters),
          csvHeader: "consumption_meters",
          csvValue: (row) => row.consumptionMeters,
        },
      ];
    }
    if (selectedDataType === "inverters") {
      return [
        {
          key: "inverterCount",
          tableLabel: "Inverters",
          tableRender: (row) =>
            row.inverterCount == null
              ? ""
              : NUMBER_FORMATTER.format(row.inverterCount),
          csvHeader: "inverter_count",
          csvValue: (row) => row.inverterCount,
        },
        {
          key: "invertersWithTelemetry",
          tableLabel: "With Telemetry",
          tableRender: (row) =>
            row.invertersWithTelemetry == null
              ? ""
              : NUMBER_FORMATTER.format(
                  row.invertersWithTelemetry
                ),
          csvHeader: "inverters_with_telemetry",
          csvValue: (row) => row.invertersWithTelemetry,
        },
        {
          key: "inverterFailures",
          tableLabel: "Failures",
          tableRender: (row) =>
            row.inverterFailures == null
              ? ""
              : NUMBER_FORMATTER.format(row.inverterFailures),
          csvHeader: "inverter_failures",
          csvValue: (row) => row.inverterFailures,
        },
        {
          key: "inverterLatestPowerKw",
          tableLabel: "Latest Power (kW)",
          tableRender: (row) =>
            row.inverterLatestPowerKw == null
              ? ""
              : row.inverterLatestPowerKw.toFixed(2),
          csvHeader: "inverter_latest_power_kw",
          csvValue: (row) => row.inverterLatestPowerKw,
        },
        {
          key: "inverterLatestEnergyKwh",
          tableLabel: "Latest Energy (kWh)",
          tableRender: (row) =>
            formatKwh(row.inverterLatestEnergyKwh),
          csvHeader: "inverter_latest_energy_kwh",
          csvValue: (row) => row.inverterLatestEnergyKwh,
        },
      ];
    }
    if (selectedDataType === "devices") {
      return [
        {
          key: "deviceCount",
          tableLabel: "Devices",
          tableRender: (row) =>
            row.deviceCount == null
              ? ""
              : NUMBER_FORMATTER.format(row.deviceCount),
          csvHeader: "device_count",
          csvValue: (row) => row.deviceCount,
        },
      ];
    }
    // production (default): richer set; a few columns are CSV-only
    // (hourly, anchor/start-date metadata) to match legacy behavior.
    return [
      {
        key: "lifetimeKwh",
        tableLabel: "Lifetime (kWh)",
        tableRender: (row) => formatKwh(row.lifetimeKwh),
        csvHeader: "lifetime_kwh",
        csvValue: (row) => row.lifetimeKwh,
      },
      {
        key: "dailyProductionKwh",
        tableLabel: "Daily (kWh)",
        tableRender: (row) => formatKwh(row.dailyProductionKwh),
        csvHeader: "daily_production_kwh",
        csvValue: (row) => row.dailyProductionKwh,
      },
      {
        key: "weeklyProductionKwh",
        tableLabel: "Weekly (kWh)",
        tableRender: (row) => formatKwh(row.weeklyProductionKwh),
        csvHeader: "weekly_production_kwh",
        csvValue: (row) => row.weeklyProductionKwh,
      },
      {
        key: "mtdProductionKwh",
        tableLabel: "MTD (kWh)",
        tableRender: (row) => formatKwh(row.mtdProductionKwh),
        csvHeader: "mtd_production_kwh",
        csvValue: (row) => row.mtdProductionKwh,
      },
      {
        key: "monthlyProductionKwh",
        tableLabel: "Monthly 30d (kWh)",
        tableRender: (row) => formatKwh(row.monthlyProductionKwh),
        csvHeader: "monthly_production_kwh",
        csvValue: (row) => row.monthlyProductionKwh,
      },
      {
        key: "previousCalendarMonthProductionKwh",
        tableLabel: "Prev Month (kWh)",
        tableRender: (row) =>
          formatKwh(row.previousCalendarMonthProductionKwh),
        csvHeader: "previous_calendar_month_production_kwh",
        csvValue: (row) => row.previousCalendarMonthProductionKwh,
      },
      {
        key: "last12MonthsProductionKwh",
        tableLabel: "Last 12M (kWh)",
        tableRender: (row) => formatKwh(row.last12MonthsProductionKwh),
        csvHeader: "last_12_months_production_kwh",
        csvValue: (row) => row.last12MonthsProductionKwh,
      },
      {
        key: "hourlyProductionKwh",
        tableLabel: "",
        tableRender: () => null,
        csvHeader: "hourly_production_kwh",
        csvValue: (row) => row.hourlyProductionKwh,
        csvOnly: true,
      },
      {
        key: "anchorDate",
        tableLabel: "",
        tableRender: () => null,
        csvHeader: "anchor_date",
        csvValue: (row) => row.anchorDate,
        csvOnly: true,
      },
      {
        key: "monthlyStartDate",
        tableLabel: "",
        tableRender: () => null,
        csvHeader: "monthly_start_date",
        csvValue: (row) => row.monthlyStartDate,
        csvOnly: true,
      },
      {
        key: "weeklyStartDate",
        tableLabel: "",
        tableRender: () => null,
        csvHeader: "weekly_start_date",
        csvValue: (row) => row.weeklyStartDate,
        csvOnly: true,
      },
      {
        key: "mtdStartDate",
        tableLabel: "",
        tableRender: () => null,
        csvHeader: "mtd_start_date",
        csvValue: (row) => row.mtdStartDate,
        csvOnly: true,
      },
      {
        key: "previousCalendarMonthStartDate",
        tableLabel: "",
        tableRender: () => null,
        csvHeader: "previous_calendar_month_start_date",
        csvValue: (row) => row.previousCalendarMonthStartDate,
        csvOnly: true,
      },
      {
        key: "previousCalendarMonthEndDate",
        tableLabel: "",
        tableRender: () => null,
        csvHeader: "previous_calendar_month_end_date",
        csvValue: (row) => row.previousCalendarMonthEndDate,
        csvOnly: true,
      },
      {
        key: "last12MonthsStartDate",
        tableLabel: "",
        tableRender: () => null,
        csvHeader: "last_12_months_start_date",
        csvValue: (row) => row.last12MonthsStartDate,
        csvOnly: true,
      },
    ];
  }, [selectedDataType]);

  const tableDataColumns = bulkDataColumns.filter(
    (col) => !col.csvOnly
  );

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

    const commonHeaders = [
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
    ];
    const dataHeaders = bulkDataColumns
      .filter((col) => !col.tableOnly)
      .map((col) => col.csvHeader);
    const headers = [...commonHeaders, ...dataHeaders];

    const csvRows = rows.map((row) => {
      const base: Record<
        string,
        string | number | boolean | null | undefined
      > = {
        [idHeader]: row.entityId,
        system_name: row.name,
        status: row.status,
        found: row.found ? "Yes" : "No",
        error: row.error,
        matched_connection_id: row.matchedConnectionId,
        matched_connection_name: row.matchedConnectionName,
        checked_connections: row.checkedConnections,
        found_in_connections: row.foundInConnections,
        profile_status_summary: row.profileStatusSummary,
      };
      for (const col of bulkDataColumns) {
        if (col.tableOnly) continue;
        base[col.csvHeader] = col.csvValue(row);
      }
      return base;
    });

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
      case "accessKeyIdMasked":
        return `Access Key ID: ${connection.accessKeyIdMasked ?? "N/A"}`;
      case "usernameMasked":
        return `Username: ${connection.usernameMasked ?? "N/A"}`;
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
      case "accessKeyIdMasked":
        return `${connection.name} (${connection.accessKeyIdMasked ?? connection.id.slice(0, 8)})`;
      case "usernameMasked":
        return `${connection.name} (${connection.usernameMasked ?? connection.id.slice(0, 8)})`;
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
              snapshots in batches.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {hasMultipleDataTypes ? (
              <div className="space-y-2 max-w-sm">
                <Label>Bulk Data Type</Label>
                <Select
                  value={selectedDataType}
                  onValueChange={(value) => {
                    setSelectedDataType(
                      value as BulkDataTypeId
                    );
                    setBulkRows([]);
                    setBulkProgress({
                      total: bulkEntityIds.length,
                      processed: 0,
                      found: 0,
                      notFound: 0,
                      errored: 0,
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {config.bulkDataTypes?.map((opt) => (
                      <SelectItem
                        key={opt.value}
                        value={opt.value}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Switches the API called per row, and the
                  result columns shown below. Rows reset
                  when you change this.
                </p>
              </div>
            ) : null}

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
                Run{" "}
                {config.bulkDataTypes?.find(
                  (opt) => opt.value === selectedDataType
                )?.label ?? "Production Snapshot"}
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
                    `${config.providerSlug}-${selectedDataType}-bulk-all`
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
                    `${config.providerSlug}-${selectedDataType}-bulk-filtered`
                  )
                }
              >
                Download Filtered CSV
              </Button>
              <Button
                variant="outline"
                disabled={
                  selectedDataType !== "production" ||
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
                  {tableDataColumns.map((col) => (
                    <TableHead key={col.key}>
                      {col.tableLabel}
                    </TableHead>
                  ))}
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
                    {tableDataColumns.map((col) => (
                      <TableCell key={col.key}>
                        {col.tableRender(row)}
                      </TableCell>
                    ))}
                    <TableCell className="text-xs text-muted-foreground">
                      {row.error ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
                {bulkPageRows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={
                        6 + tableDataColumns.length
                      }
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
