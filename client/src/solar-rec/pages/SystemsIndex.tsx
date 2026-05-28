/**
 * `/solar-rec/systems` — browseable directory of every system in the
 * portfolio.
 *
 * Reads `solarRecDashboardSystemFacts` via `getDashboardSystemsPage`
 * (paginated, bounded ≤1 MB per page). Click a column header to
 * sort; click the filter icon next to any header to filter on that
 * column. Row click navigates to the existing
 * `/solar-rec/system/:csgId` detail page.
 *
 * Permission: gates on `solar-rec-dashboard` (same as the parent
 * dashboard).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
import { solarRecTrpc as trpc } from "../solarRecTrpc";
import { PermissionGate } from "../components/PermissionGate";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Filter,
  RefreshCcw,
  Search,
  X,
} from "lucide-react";

const PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortDir = "asc" | "desc";
type FilterKind = "text" | "boolean" | "none";

// Spec shape mirrors the server's FilterSpec union (see
// `server/db/dashboardSystemFacts.ts`).
type ServerFilter =
  | { kind: "contains"; value: string }
  | { kind: "equals"; value: string }
  | { kind: "in"; values: string[] }
  | { kind: "boolean"; value: boolean };

type ClientFilter =
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean };

type FilterMap = Record<string, ClientFilter>;

interface ColumnDef {
  key: string; // server SORTABLE_COLUMN_NAMES allowlist entry
  label: string;
  filter: FilterKind;
  align?: "right";
  className?: string;
  cell: (row: SystemRow) => ReactNode;
}

interface SystemRow {
  systemKey: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  systemName: string;
  installedKwAc: string | null;
  recPrice: string | null;
  contractedRecs: string | null;
  deliveredRecs: string | null;
  terminationCost: string | null;
  additionalCollateralPercent: string | null;
  totalTransferredMwh: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  county: string | null;
  utilityTerritory: string | null;
  contractIdNumber: string | null;
  deliveryStartDate: Date | string | null;
  deliveryEndDate: Date | string | null;
  lastMeterReadDate: Date | string | null;
  projectStatus: string | null;
  internalStatus: string | null;
  part1Status: string | null;
  part2Status: string | null;
  // PR A: parallel coexistence — risk-tier "Standing" derived from
  // `contractType` + `transferSeen` + `isReporting`. See
  // `deriveStanding` in client/src/solar-rec-dashboard/lib for the
  // taxonomy. Nullable on the wire because older fact rows written
  // by pre-PR-A runners hadn't populated it yet.
  standing: string | null;
}

// ---------------------------------------------------------------------------
// Column config — declarative so adding columns is one line.
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
  {
    key: "systemName",
    label: "System",
    filter: "text",
    className: "w-[260px] sticky left-0 bg-background z-10 font-medium",
    cell: (row) => row.systemName || "—",
  },
  {
    key: "systemId",
    label: "CSG ID",
    filter: "text",
    className: "font-mono text-xs",
    cell: (row) => row.systemId ?? "—",
  },
  {
    key: "stateApplicationRefId",
    label: "ABP ID",
    filter: "text",
    className: "font-mono text-xs",
    cell: (row) => row.stateApplicationRefId ?? "—",
  },
  {
    key: "trackingSystemRefId",
    label: "GATS Gen ID",
    filter: "text",
    className: "font-mono text-xs",
    cell: (row) => row.trackingSystemRefId ?? "—",
  },
  {
    key: "addressCity",
    label: "City / State",
    filter: "text",
    cell: (row) =>
      formatCityState(row.addressCity, row.addressState, row.addressZip),
  },
  {
    key: "county",
    label: "County",
    filter: "text",
    cell: (row) => row.county ?? "—",
  },
  {
    key: "utilityTerritory",
    label: "Interconnecting Utility",
    filter: "text",
    cell: (row) => row.utilityTerritory ?? "—",
  },
  {
    key: "installedKwAc",
    label: "Size (kW AC)",
    filter: "none",
    align: "right",
    cell: (row) => formatDecimal(row.installedKwAc, 2),
  },
  {
    key: "standing",
    label: "Standing",
    filter: "text",
    cell: (row) => <StandingBadge standing={row.standing} />,
  },
  {
    key: "projectStatus",
    label: "Project Status",
    filter: "text",
    cell: (row) => row.projectStatus ?? "—",
  },
  {
    key: "internalStatus",
    label: "Internal Status",
    filter: "text",
    cell: (row) => row.internalStatus ?? "—",
  },
  {
    key: "part1Status",
    label: "ABP Part I",
    filter: "text",
    cell: (row) => row.part1Status ?? "—",
  },
  {
    key: "part2Status",
    label: "ABP Part II",
    filter: "text",
    cell: (row) => row.part2Status ?? "—",
  },
  {
    key: "contractIdNumber",
    label: "Contract ID",
    filter: "text",
    cell: (row) => row.contractIdNumber ?? "—",
  },
  {
    key: "recPrice",
    label: "REC Price",
    filter: "none",
    align: "right",
    cell: (row) => formatCurrency(row.recPrice, 2),
  },
  {
    key: "contractedRecs",
    label: "Contracted RECs",
    filter: "none",
    align: "right",
    cell: (row) => formatDecimal(row.contractedRecs, 0),
  },
  {
    key: "deliveredRecs",
    label: "Delivered RECs",
    filter: "none",
    align: "right",
    cell: (row) => formatDecimal(row.deliveredRecs, 0),
  },
  {
    key: "terminationCost",
    label: "Termination Cost",
    filter: "none",
    align: "right",
    cell: (row) => formatCurrency(row.terminationCost, 2),
  },
  {
    key: "additionalCollateralPercent",
    label: "Add'l Collateral",
    filter: "none",
    align: "right",
    cell: (row) => formatPercent(row.additionalCollateralPercent),
  },
  {
    key: "deliveryStartDate",
    label: "Delivery Start",
    filter: "none",
    cell: (row) => formatDate(row.deliveryStartDate),
  },
  {
    key: "deliveryEndDate",
    label: "Delivery End",
    filter: "none",
    cell: (row) => formatDate(row.deliveryEndDate),
  },
  {
    key: "totalTransferredMwh",
    label: "Transferred (MWh)",
    filter: "none",
    align: "right",
    cell: (row) => formatDecimal(row.totalTransferredMwh, 1),
  },
  {
    key: "lastMeterReadDate",
    label: "Last Meter Read",
    filter: "none",
    cell: (row) => formatDate(row.lastMeterReadDate),
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SystemsIndex() {
  return (
    <PermissionGate moduleKey="solar-rec-dashboard">
      <SystemsIndexImpl />
    </PermissionGate>
  );
}

function SystemsIndexImpl() {
  const [, setLocation] = useLocation();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filters, setFilters] = useState<FilterMap>({});

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const serverFilters = useMemo(() => clientToServerFilters(filters), [
    filters,
  ]);

  const pagesQuery =
    trpc.solarRecDashboard.getDashboardSystemsPage.useInfiniteQuery(
      {
        limit: PAGE_SIZE,
        textSearch: debouncedSearch ? debouncedSearch : null,
        sortBy: sortBy ?? null,
        sortDir,
        filters: Object.keys(serverFilters).length > 0 ? serverFilters : null,
      },
      {
        getNextPageParam: (last) =>
          last.hasMore ? last.nextCursor : undefined,
        initialCursor: null,
      }
    );

  const rows = useMemo(() => {
    const pages = pagesQuery.data?.pages ?? [];
    return pages.flatMap((p) => p.rows as unknown as SystemRow[]);
  }, [pagesQuery.data]);

  const totalLoaded = rows.length;
  const isLoading = pagesQuery.isLoading || pagesQuery.isRefetching;
  const isFetchingMore = pagesQuery.isFetchingNextPage;
  const hasMore = pagesQuery.hasNextPage ?? false;

  const handleSort = useCallback(
    (columnKey: string) => {
      if (sortBy === columnKey) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortBy(columnKey);
        setSortDir("asc");
      }
    },
    [sortBy]
  );

  const handleFilterChange = useCallback(
    (columnKey: string, next: ClientFilter | null) => {
      setFilters((prev) => {
        const out = { ...prev };
        if (next === null) delete out[columnKey];
        else out[columnKey] = next;
        return out;
      });
    },
    []
  );

  const activeFilterCount = Object.keys(filters).length;

  function rowProps(systemId: string | null): {
    className: string;
    onClick?: () => void;
  } {
    if (!systemId) return { className: "" };
    return {
      className: "cursor-pointer hover:bg-muted/50",
      onClick: () =>
        setLocation(`/solar-rec/system/${encodeURIComponent(systemId)}`),
    };
  }

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Systems</h1>
          <p className="text-sm text-muted-foreground">
            Every system in the portfolio with its address, contract
            terms, delivery window, and reporting status. Click a column
            header to sort; the filter icon next to any header narrows
            on that column.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeFilterCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFilters({})}
              className="text-xs"
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Clear {activeFilterCount} filter
              {activeFilterCount === 1 ? "" : "s"}
            </Button>
          )}
          <Badge variant="outline" className="text-xs">
            {totalLoaded.toLocaleString()} loaded
            {hasMore ? "+" : ""}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => pagesQuery.refetch()}
            disabled={isLoading}
          >
            <RefreshCcw
              className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
            />
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by CSG ID or system name…"
          className="pl-9"
          data-testid="systems-search-input"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {debouncedSearch
              ? `Results for "${debouncedSearch}"`
              : "All systems"}
          </CardTitle>
          <CardDescription>
            Source:{" "}
            <code className="text-xs">solarRecDashboardSystemFacts</code>
            {" — populated by the dashboard build runner."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {COLUMNS.map((col) => (
                    <TableHead
                      key={col.key}
                      className={col.className ?? ""}
                    >
                      <ColumnHeader
                        col={col}
                        sortBy={sortBy}
                        sortDir={sortDir}
                        filter={filters[col.key] ?? null}
                        onSort={() => handleSort(col.key)}
                        onFilterChange={(next) =>
                          handleFilterChange(col.key, next)
                        }
                      />
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && totalLoaded === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={COLUMNS.length}
                      className="text-center text-sm text-muted-foreground py-8"
                    >
                      Loading systems…
                    </TableCell>
                  </TableRow>
                ) : totalLoaded === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={COLUMNS.length}
                      className="text-center text-sm text-muted-foreground py-8"
                    >
                      {debouncedSearch || activeFilterCount > 0
                        ? "No systems match the current search / filters."
                        : "No systems yet. Upload solarApplications to populate."}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.systemKey} {...rowProps(row.systemId)}>
                      {COLUMNS.map((col) => (
                        <TableCell
                          key={col.key}
                          className={`${col.className ?? ""} ${
                            col.align === "right" ? "text-right" : ""
                          }`}
                        >
                          {col.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {hasMore && (
            <div className="flex justify-center py-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => pagesQuery.fetchNextPage()}
                disabled={isFetchingMore}
              >
                {isFetchingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column header — sort + filter UI
// ---------------------------------------------------------------------------

function ColumnHeader({
  col,
  sortBy,
  sortDir,
  filter,
  onSort,
  onFilterChange,
}: {
  col: ColumnDef;
  sortBy: string | null;
  sortDir: SortDir;
  filter: ClientFilter | null;
  onSort: () => void;
  onFilterChange: (next: ClientFilter | null) => void;
}) {
  const isActive = sortBy === col.key;
  const SortIcon = isActive
    ? sortDir === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown;
  return (
    <div
      className={`flex items-center gap-1 ${
        col.align === "right" ? "justify-end" : ""
      }`}
    >
      <button
        type="button"
        onClick={onSort}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        <span>{col.label}</span>
        <SortIcon
          className={`h-3 w-3 ${
            isActive ? "text-foreground" : "text-muted-foreground/50"
          }`}
        />
      </button>
      {col.filter !== "none" && (
        <FilterPopover
          column={col}
          filter={filter}
          onChange={onFilterChange}
        />
      )}
    </div>
  );
}

function FilterPopover({
  column,
  filter,
  onChange,
}: {
  column: ColumnDef;
  filter: ClientFilter | null;
  onChange: (next: ClientFilter | null) => void;
}) {
  const isActive = filter !== null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex h-5 w-5 items-center justify-center rounded transition-colors ${
            isActive
              ? "text-primary"
              : "text-muted-foreground/40 hover:text-muted-foreground"
          }`}
          aria-label={`Filter ${column.label}`}
        >
          <Filter className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        {column.filter === "text" ? (
          <TextFilterInput
            column={column}
            filter={filter}
            onChange={onChange}
          />
        ) : column.filter === "boolean" ? (
          <BooleanFilterInput filter={filter} onChange={onChange} />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function TextFilterInput({
  column,
  filter,
  onChange,
}: {
  column: ColumnDef;
  filter: ClientFilter | null;
  onChange: (next: ClientFilter | null) => void;
}) {
  const initial =
    filter && filter.kind === "text" ? filter.value : "";
  const [value, setValue] = useState(initial);
  useEffect(() => {
    setValue(initial);
  }, [initial]);
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        Filter {column.label} (contains)
      </div>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Type to filter…"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const trimmed = value.trim();
            onChange(trimmed ? { kind: "text", value: trimmed } : null);
          }
        }}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="default"
          className="flex-1"
          onClick={() => {
            const trimmed = value.trim();
            onChange(trimmed ? { kind: "text", value: trimmed } : null);
          }}
        >
          Apply
        </Button>
        {filter && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setValue("");
              onChange(null);
            }}
          >
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

function BooleanFilterInput({
  filter,
  onChange,
}: {
  filter: ClientFilter | null;
  onChange: (next: ClientFilter | null) => void;
}) {
  const current =
    filter && filter.kind === "boolean" ? filter.value : null;
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        Filter
      </div>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant={current === true ? "default" : "outline"}
          className="flex-1"
          onClick={() => onChange({ kind: "boolean", value: true })}
        >
          Yes
        </Button>
        <Button
          size="sm"
          variant={current === false ? "default" : "outline"}
          className="flex-1"
          onClick={() => onChange({ kind: "boolean", value: false })}
        >
          No
        </Button>
        <Button
          size="sm"
          variant={current === null ? "default" : "outline"}
          className="flex-1"
          onClick={() => onChange(null)}
        >
          Any
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversion: client filter shape → server filter spec.
// ---------------------------------------------------------------------------

function clientToServerFilters(
  filters: FilterMap
): Record<string, ServerFilter> {
  const out: Record<string, ServerFilter> = {};
  for (const [key, f] of Object.entries(filters)) {
    if (f.kind === "text") {
      const trimmed = f.value.trim();
      if (trimmed) out[key] = { kind: "contains", value: trimmed };
    } else if (f.kind === "boolean") {
      out[key] = { kind: "boolean", value: f.value };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCityState(
  city: string | null,
  state: string | null,
  zip: string | null
): string {
  const parts: string[] = [];
  if (city) parts.push(city);
  if (state) parts.push(state);
  const base = parts.join(", ");
  if (zip) return base ? `${base} ${zip}` : zip;
  return base || "—";
}

function formatDecimal(value: string | null, fractionDigits: number): string {
  if (value === null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatCurrency(value: string | null, fractionDigits: number): string {
  if (value === null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatPercent(value: string | null): string {
  if (value === null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function formatDate(value: Date | string | null): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// PR B1 (2026-05-28): retired `OwnershipStatusBadge` + `STATUS_VARIANT`
// alongside the column drop. The `ownershipStatus` field is still on
// the wire row payload + filterable via the generic `filters` map for
// future consumers, but this page no longer renders or filters by it.

// PR A: Standing taxonomy badge. Variants:
//   - "default" (green-ish) → Active / Good Standing / Closed-good-standing
//   - "secondary" (muted) → At Risk
//   - "destructive" (red) → Jeopardy / Closed-Default
//   - "outline" (neutral) → Unknown
const STANDING_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  "Active — Good Standing": "default",
  "Active — Good Standing (Assigned)": "default",
  "Closed — RECs Repaid (Good Standing)": "default",
  "At Risk — Unassigned Transfer": "secondary",
  "At Risk — Reporting Lapse": "secondary",
  "At Risk — Reporting Lapse (Assigned)": "secondary",
  "Jeopardy / Default-Track": "destructive",
  "Closed — Default": "destructive",
  Unknown: "outline",
};

function StandingBadge({ standing }: { standing: string | null }) {
  if (!standing) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge
      variant={STANDING_VARIANT[standing] ?? "outline"}
      className="text-xs whitespace-nowrap"
    >
      {standing}
    </Badge>
  );
}
