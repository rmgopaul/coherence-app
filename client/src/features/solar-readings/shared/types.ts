/**
 * Shared types for the generic MeterReadsPage component.
 *
 * BulkSnapshotRow uses a generic `entityId` field instead of
 * provider-specific names (meterNumber, plantId, stationId, etc.).
 *
 * Bulk data types (Task 4.7 migration scaffold)
 * ---------------------------------------------
 * Most vendors only produce "production" snapshots. A few expose
 * additional data kinds that the hand-rolled pages currently render
 * as toggles: SolarEdge has "meters" and "inverters"; Fronius has
 * "devices". A vendor config lists the data types it supports via
 * `MeterReadsProviderConfig.bulkDataTypes`; the shared page renders
 * a segmented control when more than one is listed and omits it
 * otherwise. Rows carry optional per-type columns below so
 * production-only vendors don't pay any shape cost.
 */

export type BulkStatusFilter =
  | "All"
  | "Found"
  | "Not Found"
  | "Error";

export type BulkSortKey =
  | "entityId"
  | "status"
  | "lifetime"
  | "hourly"
  | "monthly"
  | "mtd"
  | "previousMonth"
  | "last12Months"
  | "weekly"
  | "daily"
  | "meterCount"
  | "productionMeters"
  | "consumptionMeters"
  | "inverterCount"
  | "invertersWithTelemetry"
  | "inverterFailures"
  | "inverterLatestPower"
  | "inverterLatestEnergy"
  | "deviceCount";

export type BulkConnectionScope = "active" | "all";

/**
 * Canonical bulk data type identifier. Vendors extend the union via
 * their config; consumers of `BulkSnapshotRow` should treat
 * `dataType` as an opaque string past this list.
 */
export type BulkDataTypeId =
  | "production"
  | "meters"
  | "inverters"
  | "devices";

export type BulkDataTypeOption = {
  value: BulkDataTypeId;
  label: string;
};

export type BulkSnapshotRow = {
  entityId: string;
  name?: string | null;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  /**
   * Which data type this row represents. Optional for
   * backward-compat; production-only vendors can omit it and the
   * shared page treats the row as production.
   */
  dataType?: BulkDataTypeId;

  // -- production columns (legacy default) --
  lifetimeKwh?: number | null;
  hourlyProductionKwh?: number | null;
  monthlyProductionKwh?: number | null;
  mtdProductionKwh?: number | null;
  previousCalendarMonthProductionKwh?: number | null;
  last12MonthsProductionKwh?: number | null;
  weeklyProductionKwh?: number | null;
  dailyProductionKwh?: number | null;
  anchorDate?: string;
  monthlyStartDate?: string;
  weeklyStartDate?: string;
  mtdStartDate?: string;
  previousCalendarMonthStartDate?: string;
  previousCalendarMonthEndDate?: string;
  last12MonthsStartDate?: string;

  // -- meters columns (SolarEdge) --
  meterCount?: number | null;
  productionMeters?: number | null;
  consumptionMeters?: number | null;

  // -- inverters columns (SolarEdge) --
  inverterCount?: number | null;
  invertersWithTelemetry?: number | null;
  inverterFailures?: number | null;
  inverterLatestPowerKw?: number | null;
  inverterLatestEnergyKwh?: number | null;

  // -- devices columns (Fronius) --
  deviceCount?: number | null;

  error?: string | null;
  matchedConnectionId?: string | null;
  matchedConnectionName?: string | null;
  checkedConnections?: number;
  foundInConnections?: number;
  profileStatusSummary?: string;
};

/* ---------- Credential field config ---------- */

export type CredentialField = {
  /** Internal key used for state & connect mutation payload */
  name: string;
  /** UI label shown above the input */
  label: string;
  /** HTML input type (defaults to "text") */
  type?: "text" | "password";
  /** Placeholder text */
  placeholder: string;
  /** If true, this field is optional for the connect call */
  optional?: boolean;
  /** Optional helper text below the input */
  helperText?: string;
};

/* ---------- Single-operation dropdown items ---------- */

export type SingleOperationOption = {
  value: string;
  label: string;
};

/* ---------- Connection display config ---------- */

export type ConnectionDisplayField =
  | "apiKeyMasked"
  | "accountMasked"
  | "accessKeyIdMasked"
  | "usernameMasked"
  | "baseUrl"
  | "idSlice";

/* ---------- tRPC hooks passed as config ---------- */

type StatusQueryResult = {
  connected: boolean;
  activeConnectionId?: string | null;
  connections: Array<{
    id: string;
    name: string;
    isActive: boolean;
    updatedAt: string;
    apiKeyMasked?: string;
    accountMasked?: string;
    accessKeyIdMasked?: string;
    usernameMasked?: string;
    baseUrl?: string;
  }>;
};

type ListItemsResult = {
  [key: string]: Array<{ [key: string]: string }>;
};

type ConnectResult = {
  activeConnectionId: string;
  totalConnections: number;
};

type RemoveResult = {
  connected: boolean;
  activeConnectionId?: string | null;
  totalConnections: number;
};

export type MeterReadsProviderConfig = {
  /* ---------- display ---------- */
  providerName: string;
  /** Short slug for file names, e.g. "ekm", "growatt" */
  providerSlug: string;
  /** Name used in buildConvertedReadRow, e.g. "EKM", "Growatt" */
  convertedReadsMonitoring: string;
  /** Alternate monitoring name for CSV (e.g. "EKM Encompass.io") */
  convertedReadsCsvMonitoring?: string;
  /** Page title, e.g. "EKM Metering API" */
  pageTitle: string;
  /** Page subtitle/description */
  pageDescription: string;
  /** Description for the connect card */
  connectDescription: string;

  /* ---------- ID field ---------- */
  /** Internal field name: "meterNumber", "plantId", etc. */
  idFieldName: string;
  /** UI label: "Meter Number", "Plant ID", etc. */
  idFieldLabel: string;
  /** Plural form for bulk messages: "Meter Numbers", "Plant IDs" */
  idFieldLabelPlural: string;

  /* ---------- CSV ---------- */
  /** Preferred CSV column headers for ID extraction */
  csvIdHeaders: string[];

  /* ---------- credentials ---------- */
  credentialFields: CredentialField[];

  /* ---------- connection display ---------- */
  /** How to display the connection in the selector dropdown */
  connectionDisplayField: ConnectionDisplayField;
  /** Label for saved profiles section (e.g. "Saved API Profiles") */
  savedProfilesLabel?: string;
  /** What to show in the connection card detail line */
  connectionCardDetail?: (connection: {
    id: string;
    apiKeyMasked?: string;
    accountMasked?: string;
    accessKeyIdMasked?: string;
    usernameMasked?: string;
    baseUrl?: string;
  }) => string;

  /* ---------- single operations ---------- */
  singleOperations: SingleOperationOption[];

  /* ---------- tRPC hooks ---------- */
  useStatusQuery: (
    enabled: boolean
  ) => {
    data: StatusQueryResult | undefined;
    error: unknown;
    refetch: () => Promise<unknown>;
  };

  useListItemsQuery?: (
    enabled: boolean
  ) => {
    data: ListItemsResult | undefined;
    error: unknown;
    refetch: () => Promise<{
      data: ListItemsResult | undefined;
    }>;
  };

  /** The property key in listItems response, e.g. "plants", "sites" */
  listItemsKey?: string;

  /* eslint-disable @typescript-eslint/no-explicit-any --
     tRPC mutations have provider-specific input shapes
     (e.g. { meterNumber: string } vs { plantId: string });
     the generic component builds the input object dynamically,
     so we accept `any` here to avoid impossible intersection types. */
  useConnectMutation: () => {
    mutateAsync: (input: any) => Promise<ConnectResult>;
    isPending: boolean;
  };

  useSetActiveConnectionMutation: () => {
    mutateAsync: (input: {
      connectionId: string;
    }) => Promise<unknown>;
    isPending: boolean;
  };

  useRemoveConnectionMutation: () => {
    mutateAsync: (input: {
      connectionId: string;
    }) => Promise<RemoveResult>;
    isPending: boolean;
  };

  useDisconnectMutation: () => {
    mutateAsync: () => Promise<unknown>;
    isPending: boolean;
  };

  useProductionSnapshotMutation: () => {
    mutateAsync: (input: any) => Promise<unknown>;
    isPending: boolean;
  };

  /**
   * Vendors that expose more than one bulk data type list them here
   * (e.g. SolarEdge: production/meters/inverters; Fronius:
   * production/devices). Omit or leave empty/single-entry for the
   * production-only default — the shared page hides the data-type
   * selector in that case. The first entry is the default selection.
   */
  bulkDataTypes?: BulkDataTypeOption[];

  /**
   * Per-data-type bulk snapshot mutations. Only consulted when
   * `bulkDataTypes` has more than one entry; the shared page picks
   * the mutation for the currently-selected data type. For the
   * production-only default, `useProductionSnapshotMutation` above
   * is still the source of truth.
   */
  useBulkSnapshotMutationByType?: Partial<
    Record<
      BulkDataTypeId,
      () => {
        mutateAsync: (input: any) => Promise<unknown>;
        isPending: boolean;
      }
    >
  >;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /**
   * Called after connect/disconnect/remove to invalidate queries.
   * Receives the trpcUtils so the provider can invalidate its own
   * router namespace.
   */
  invalidateQueries: (trpcUtils: unknown) => Promise<void>;

  /**
   * Reset the selectedEntityId (e.g. plants selector).
   * Only relevant for providers that have a listItems query.
   */
  hasListItems: boolean;
};
