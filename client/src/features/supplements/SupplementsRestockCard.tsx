/**
 * Restock forecast for the Protocol tab. Shows how many days of each
 * locked supplement remain, with an "Add event" quick-form to log a
 * purchase, open, or finished bottle.
 *
 * Dose balance is computed server-side from supplementRestockEvents;
 * this component is purely presentational + form state.
 */

import { useState } from "react";
import { Plus, ShoppingCart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toErrorMessage } from "@/lib/helpers";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import type { SupplementDefinition } from "@/features/dashboard/types";

export interface SupplementsRestockCardProps {
  definitions: readonly SupplementDefinition[];
}

type EventType = "purchased" | "opened" | "finished";

interface DraftState {
  definitionId: string;
  eventType: EventType;
  quantityDelta: string;
  unitPrice: string;
}

function defaultDraft(definitions: readonly SupplementDefinition[]): DraftState {
  return {
    definitionId: definitions[0]?.id ?? "",
    eventType: "purchased",
    quantityDelta: "",
    unitPrice: "",
  };
}

export function SupplementsRestockCard({
  definitions,
}: SupplementsRestockCardProps) {
  const [draft, setDraft] = useState<DraftState>(defaultDraft(definitions));
  const utils = trpc.useUtils();

  const { data: forecast = [] } = trpc.supplements.getRestockForecast.useQuery(
    undefined,
    { retry: false }
  );
  const addEvent = trpc.supplements.addRestockEvent.useMutation();

  async function submit() {
    const qtyRaw = Number(draft.quantityDelta.trim());
    if (!draft.definitionId || !Number.isFinite(qtyRaw) || qtyRaw <= 0) {
      toast.error("Pick a supplement and enter a positive quantity.");
      return;
    }
    // Sign convention: purchased adds doses, opened/finished subtract.
    const signedQty = draft.eventType === "purchased" ? qtyRaw : -qtyRaw;
    const priceRaw = draft.unitPrice.trim();
    const unitPrice = priceRaw === "" ? undefined : Number(priceRaw);
    if (priceRaw !== "" && (!Number.isFinite(unitPrice) || unitPrice! < 0)) {
      toast.error("Unit price must be a non-negative number.");
      return;
    }

    try {
      await addEvent.mutateAsync({
        definitionId: draft.definitionId,
        eventType: draft.eventType,
        quantityDelta: signedQty,
        unitPrice,
      });
      toast.success("Event logged.");
      setDraft(defaultDraft(definitions));
      void utils.supplements.getRestockForecast.invalidate();
      void utils.supplements.listRestockEvents.invalidate();
    } catch (err) {
      toast.error(toErrorMessage(err));
    }
  }

  if (definitions.length === 0) return null;

  const lowStock = forecast.filter(
    (f) => f.daysRemaining !== null && f.daysRemaining < 7
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 pb-2">
        <ShoppingCart className="h-4 w-4 text-amber-600" />
        <CardTitle className="text-sm">Restock forecast</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {forecast.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No locked supplements yet. Lock items on the Protocol tab to
            track inventory.
          </p>
        ) : (
          <ul className="space-y-1">
            {forecast.map((row) => {
              const tone =
                row.daysRemaining === null
                  ? "text-muted-foreground"
                  : row.daysRemaining < 7
                    ? "text-red-600"
                    : row.daysRemaining < 14
                      ? "text-amber-600"
                      : "text-emerald-700";
              return (
                <li
                  key={row.definitionId}
                  className="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1.5 text-xs"
                >
                  <span className="min-w-0 truncate font-medium">{row.name}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {row.balance.toFixed(0)} doses
                    </span>
                    <span className={cn("font-semibold", tone)}>
                      {row.daysRemaining === null
                        ? "—"
                        : `${row.daysRemaining}d left`}
                    </span>
                    {row.runsOutOn && row.daysRemaining !== null && row.daysRemaining < 30 ? (
                      <Badge variant="outline" className="text-[10px]">
                        out {row.runsOutOn}
                      </Badge>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {lowStock.length > 0 ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
            {lowStock.length} supplement{lowStock.length === 1 ? "" : "s"} running
            low — log a purchase below to keep the forecast accurate.
          </div>
        ) : null}

        <div className="grid grid-cols-[1fr_110px_100px_110px_auto] gap-2">
          <Select
            value={draft.definitionId}
            onValueChange={(v) => setDraft({ ...draft, definitionId: v })}
          >
            <SelectTrigger className="h-8">
              <SelectValue placeholder="Supplement" />
            </SelectTrigger>
            <SelectContent>
              {definitions.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={draft.eventType}
            onValueChange={(v) => setDraft({ ...draft, eventType: v as EventType })}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="purchased">Purchased</SelectItem>
              <SelectItem value="opened">Opened</SelectItem>
              <SelectItem value="finished">Finished</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="h-8"
            type="number"
            min="0"
            step="1"
            placeholder="doses"
            value={draft.quantityDelta}
            onChange={(e) => setDraft({ ...draft, quantityDelta: e.target.value })}
          />
          <Input
            className="h-8"
            type="number"
            min="0"
            step="0.01"
            placeholder="$ (opt)"
            value={draft.unitPrice}
            onChange={(e) => setDraft({ ...draft, unitPrice: e.target.value })}
          />
          <Button size="sm" className="h-8" onClick={submit} disabled={addEvent.isPending}>
            <Plus className="mr-1 h-3 w-3" />
            Log
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
