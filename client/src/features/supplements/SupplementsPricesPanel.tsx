/**
 * Price-watch controls + price-log history for the standalone page.
 *
 * Two halves:
 *  1. A "Run price watch now" button that calls `runPriceWatchNow`,
 *     surfaces the result (attempted / updated / skipped / errors),
 *     and invalidates the price-log query so the table below refreshes.
 *  2. A table of recent entries from `supplementPriceLogs` — every
 *     successful price check (manual or scheduled) appends a row.
 */

import { useMemo, useState } from "react";
import { AlertCircle, Play, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { formatCurrency, toErrorMessage } from "@/lib/helpers";
import type {
  SupplementDefinition,
  SupplementPriceWatchResult,
} from "@/features/dashboard/types";
import { formatConfidencePct, formatSourceLabel } from "./supplements.helpers";

export interface SupplementsPricesPanelProps {
  definitions: readonly SupplementDefinition[];
}

const PAGE_LIMITS = [50, 100, 250] as const;

export function SupplementsPricesPanel({
  definitions,
}: SupplementsPricesPanelProps) {
  const utils = trpc.useUtils();
  const [filterDefId, setFilterDefId] = useState<string>("");
  const [limit, setLimit] = useState<number>(100);
  const [lastRun, setLastRun] = useState<SupplementPriceWatchResult | null>(null);

  const {
    data: priceLogs = [],
    isFetching,
    error: priceLogsError,
    refetch: refetchPriceLogs,
  } = trpc.supplements.listPriceLogs.useQuery(
    {
      definitionId: filterDefId || undefined,
      limit,
    },
    { retry: false }
  );

  const runPriceWatch = trpc.supplements.runPriceWatchNow.useMutation();

  async function runNow() {
    try {
      const result = await runPriceWatch.mutateAsync();
      setLastRun(result);
      if (result.missingCredentials) {
        toast.error("Anthropic credentials missing — connect in Settings first.");
      } else if (result.alreadyRunning) {
        toast.message("A price watch is already running for you.");
      } else {
        toast.success(
          `Price watch done: ${result.updated} updated, ${result.skipped} skipped, ${result.errors} error${result.errors === 1 ? "" : "s"}.`
        );
      }
      void utils.supplements.listPriceLogs.invalidate();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  const defNameById = useMemo(
    () => new Map(definitions.map((d) => [d.id, d.name])),
    [definitions]
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">Price watcher</CardTitle>
          <Button
            size="sm"
            onClick={runNow}
            disabled={runPriceWatch.isPending}
          >
            {runPriceWatch.isPending ? (
              <>
                <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Play className="mr-1 h-3 w-3" />
                Run now
              </>
            )}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Re-checks the current price of every active supplement via your
            Anthropic integration, then records the result below. Safe to run
            repeatedly — concurrent runs for the same user no-op.
          </p>
          {lastRun ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline">
                attempted {lastRun.attempted}
              </Badge>
              <Badge variant="default">updated {lastRun.updated}</Badge>
              <Badge variant="secondary">skipped {lastRun.skipped}</Badge>
              <Badge
                variant={lastRun.errors > 0 ? "destructive" : "outline"}
              >
                errors {lastRun.errors}
              </Badge>
              <span className="text-muted-foreground">
                · finished {new Date(lastRun.completedAt).toLocaleTimeString()}
              </span>
              {lastRun.missingCredentials ? (
                <Badge variant="destructive">missing credentials</Badge>
              ) : null}
              {lastRun.alreadyRunning ? (
                <Badge variant="outline">already running</Badge>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Price log</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Filter</span>
            <Select
              value={filterDefId || "__all"}
              onValueChange={(v) => setFilterDefId(v === "__all" ? "" : v)}
            >
              <SelectTrigger className="h-8 w-56">
                <SelectValue placeholder="All supplements" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All supplements</SelectItem>
                {definitions.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(limit)}
              onValueChange={(v) => setLimit(Number(v))}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_LIMITS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    last {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isFetching ? (
              <span className="text-muted-foreground">loading…</span>
            ) : (
              <span className="text-muted-foreground">
                {priceLogs.length} entr{priceLogs.length === 1 ? "y" : "ies"}
              </span>
            )}
          </div>

          {priceLogsError ? (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Couldn't load the price log.</p>
                <p className="text-red-700">{toErrorMessage(priceLogsError)}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => refetchPriceLogs()}
              >
                Retry
              </Button>
            </div>
          ) : priceLogs.length === 0 ? (
            <div className="rounded-md border bg-muted/40 p-6 text-center text-xs text-muted-foreground">
              No price snapshots yet. Click "Run now" above to capture the
              current prices.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Captured</TableHead>
                    <TableHead>Supplement</TableHead>
                    <TableHead>Brand</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Confidence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {priceLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(log.capturedAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </TableCell>
                      <TableCell className="font-medium">
                        {defNameById.get(log.definitionId) ?? log.supplementName}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {log.brand ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {formatCurrency(log.pricePerBottle)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {log.sourceUrl ? (
                          <a
                            href={log.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-700 hover:underline"
                          >
                            {formatSourceLabel(log, "link")}
                          </a>
                        ) : (
                          formatSourceLabel(log)
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {formatConfidencePct(log.confidence)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
