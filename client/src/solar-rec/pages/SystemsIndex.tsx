/**
 * `/solar-rec/systems` — browseable directory of every system in the
 * portfolio.
 *
 * Reads the `solarRecDashboardSystemFacts` table via
 * `getDashboardSystemsPage` (paginated, bounded ≤1 MB per page).
 * Row click navigates to the existing `/solar-rec/system/:csgId`
 * detail page. Text search is debounced and re-issued as the
 * cursor's first page; pagination is via `useInfiniteQuery`.
 *
 * Permission: gates on `solar-rec-dashboard` (same as the parent
 * dashboard). The fact table is the canonical browse surface; the
 * dashboard tabs are tab-specific slices.
 */
import { useEffect, useMemo, useState } from "react";
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
import { RefreshCcw, Search } from "lucide-react";

const PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 250;

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

  // Debounce search input → server filter. Keeps the input snappy
  // while avoiding a request on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const pagesQuery = trpc.solarRecDashboard.getDashboardSystemsPage.useInfiniteQuery(
    {
      limit: PAGE_SIZE,
      textSearch: debouncedSearch ? debouncedSearch : null,
    },
    {
      getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
      initialCursor: null,
    }
  );

  const rows = useMemo(() => {
    const pages = pagesQuery.data?.pages ?? [];
    return pages.flatMap((p) => p.rows);
  }, [pagesQuery.data]);

  const totalLoaded = rows.length;
  const isLoading = pagesQuery.isLoading || pagesQuery.isRefetching;
  const isFetchingMore = pagesQuery.isFetchingNextPage;
  const hasMore = pagesQuery.hasNextPage ?? false;

  function handleRowClick(systemId: string | null) {
    if (!systemId) return;
    setLocation(`/solar-rec/system/${encodeURIComponent(systemId)}`);
  }

  // A row is only navigable when it has a CSG ID (== systemId); SystemDetail
  // keys off it. Rows without one render as inert (no pointer / no hover).
  function rowProps(systemId: string | null): {
    className: string;
    onClick?: () => void;
  } {
    if (!systemId) {
      return { className: "" };
    }
    return {
      className: "cursor-pointer hover:bg-muted/50",
      onClick: () => handleRowClick(systemId),
    };
  }

  return (
    <div className="container mx-auto p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Systems</h1>
          <p className="text-sm text-muted-foreground">
            Every system in the portfolio with its address, contract
            terms, delivery window, and reporting status. Click a row
            for the system detail page.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            {" — populated by the dashboard build runner. New columns "}
            land null until the next build runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[260px] sticky left-0 bg-background z-10">
                    System
                  </TableHead>
                  <TableHead>CSG ID</TableHead>
                  <TableHead>ABP ID</TableHead>
                  <TableHead>GATS Gen ID</TableHead>
                  <TableHead>City / State</TableHead>
                  <TableHead>County</TableHead>
                  <TableHead>Utility</TableHead>
                  <TableHead className="text-right">Size (kW AC)</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Contract ID</TableHead>
                  <TableHead className="text-right">REC Price</TableHead>
                  <TableHead className="text-right">Contracted RECs</TableHead>
                  <TableHead className="text-right">Delivered RECs</TableHead>
                  <TableHead className="text-right">
                    Termination Cost
                  </TableHead>
                  <TableHead className="text-right">
                    Add'l Collateral
                  </TableHead>
                  <TableHead>Delivery Start</TableHead>
                  <TableHead>Delivery End</TableHead>
                  <TableHead className="text-right">
                    Transferred (MWh)
                  </TableHead>
                  <TableHead>Last Meter Read</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && totalLoaded === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={19}
                      className="text-center text-sm text-muted-foreground py-8"
                    >
                      Loading systems…
                    </TableCell>
                  </TableRow>
                ) : totalLoaded === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={19}
                      className="text-center text-sm text-muted-foreground py-8"
                    >
                      {debouncedSearch
                        ? `No systems match "${debouncedSearch}".`
                        : "No systems yet. Upload solarApplications to populate."}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.systemKey} {...rowProps(row.systemId)}>
                      <TableCell className="font-medium sticky left-0 bg-background">
                        {row.systemName || "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.systemId ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.stateApplicationRefId ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.trackingSystemRefId ?? "—"}
                      </TableCell>
                      <TableCell>
                        {formatCityState(
                          row.addressCity,
                          row.addressState,
                          row.addressZip
                        )}
                      </TableCell>
                      <TableCell>{row.county ?? "—"}</TableCell>
                      <TableCell>{row.utilityTerritory ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {formatDecimal(row.installedKwAc, 2)}
                      </TableCell>
                      <TableCell>
                        <OwnershipStatusBadge status={row.ownershipStatus} />
                      </TableCell>
                      <TableCell>{row.contractIdNumber ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(row.recPrice, 4)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatDecimal(row.contractedRecs, 0)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatDecimal(row.deliveredRecs, 0)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(row.terminationCost, 0)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatPercent(row.additionalCollateralPercent)}
                      </TableCell>
                      <TableCell>
                        {formatDate(row.deliveryStartDate)}
                      </TableCell>
                      <TableCell>
                        {formatDate(row.deliveryEndDate)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatDecimal(row.totalTransferredMwh, 1)}
                      </TableCell>
                      <TableCell>
                        {formatDate(row.lastMeterReadDate)}
                      </TableCell>
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

/**
 * Drizzle returns decimal columns as string-encoded numbers. Parse +
 * format with the given fraction digits; null / non-finite → em-dash.
 */
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

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  "Not Transferred and Reporting": "default",
  "Transferred and Reporting": "default",
  "Not Transferred and Not Reporting": "secondary",
  "Transferred and Not Reporting": "secondary",
  "Terminated and Reporting": "destructive",
  "Terminated and Not Reporting": "destructive",
};

function OwnershipStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "outline"} className="text-xs">
      {status}
    </Badge>
  );
}
