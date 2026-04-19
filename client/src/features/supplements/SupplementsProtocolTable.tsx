/**
 * Protocol table for the standalone page. One row per active definition.
 *
 * Row click opens the parent-controlled detail sheet.
 */

import { ExternalLink, Pill } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/helpers";
import type { SupplementProtocolRow } from "./supplements.types";
import { formatAdherencePct } from "./supplements.helpers";

export interface SupplementsProtocolTableProps {
  rows: readonly SupplementProtocolRow[];
  adherenceWindowDays: number;
  onRowSelect: (definitionId: string) => void;
}

export function SupplementsProtocolTable({
  rows,
  adherenceWindowDays,
  onRowSelect,
}: SupplementsProtocolTableProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        <Pill className="mx-auto mb-2 h-5 w-5" />
        No supplements yet. Add one from the dashboard card or via bottle scan.
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Dose</TableHead>
            <TableHead>Timing</TableHead>
            <TableHead className="text-right">$/bottle</TableHead>
            <TableHead className="text-right">Doses</TableHead>
            <TableHead className="text-right">$/dose</TableHead>
            <TableHead className="text-right">Monthly</TableHead>
            <TableHead className="text-right">{adherenceWindowDays}d adherence</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const d = row.definition;
            return (
              <TableRow
                key={d.id}
                className="cursor-pointer hover:bg-muted/60"
                onClick={() => onRowSelect(d.id)}
              >
                <TableCell className="font-medium">
                  <div className="flex flex-col">
                    <span>{d.name}</span>
                    {d.brand ? (
                      <span className="text-xs text-muted-foreground">{d.brand}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  {d.dose} {d.doseUnit}
                </TableCell>
                <TableCell className="uppercase text-xs text-muted-foreground">
                  {d.timing}
                </TableCell>
                <TableCell className="text-right">
                  {d.pricePerBottle != null ? formatCurrency(d.pricePerBottle) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {d.quantityPerBottle ?? "—"}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-semibold",
                    row.costPerDose === null && "text-muted-foreground"
                  )}
                >
                  {row.costPerDose === null ? "—" : formatCurrency(row.costPerDose)}
                </TableCell>
                <TableCell className="text-right">
                  {row.monthlyCost === null ? "—" : formatCurrency(row.monthlyCost)}
                </TableCell>
                <TableCell className="text-right">
                  {formatAdherencePct(row.adherenceTaken, row.adherenceExpected)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({row.adherenceTaken}/{row.adherenceExpected})
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {d.isLocked ? (
                      <Badge variant="default" className="text-[10px]">
                        locked
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        optional
                      </Badge>
                    )}
                    {d.productUrl ? (
                      <a
                        href={d.productUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
