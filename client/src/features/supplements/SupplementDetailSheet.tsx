/**
 * Per-supplement drawer for the standalone page. Shows:
 *  - Edit form (name, brand, dose, price, quantity)
 *  - Price history from supplements.listPriceLogs
 *  - Recent logs filtered to this definition
 *  - Lock toggle + archive button
 *
 * Follows the repo's detail-sheet convention (see
 * `client/src/solar-rec-dashboard/components/SystemDetailSheet.tsx`).
 */

import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { SUPPLEMENT_UNITS, type SupplementUnit } from "@shared/const";
import { formatCurrency, toErrorMessage } from "@/lib/helpers";
import type { SupplementDefinition, SupplementLog } from "@/features/dashboard/types";
import { formatCostPerDose, formatSourceLabel } from "./supplements.helpers";
import { SupplementsCostTrendChart } from "./SupplementsCostTrendChart";

export interface SupplementDetailSheetProps {
  /** The definition being shown, or null when the sheet is closed. */
  definition: SupplementDefinition | null;
  /** Logs for the user (any window); we filter to this definitionId here. */
  logs: readonly SupplementLog[];
  onClose: () => void;
  /** Called after a successful edit/archive so the parent can refetch. */
  onMutated: () => void;
}

interface EditorState {
  name: string;
  brand: string;
  dose: string;
  doseUnit: SupplementUnit;
  timing: "am" | "pm";
  productUrl: string;
  pricePerBottle: string;
  quantityPerBottle: string;
}

function buildEditorState(def: SupplementDefinition): EditorState {
  return {
    name: def.name,
    brand: def.brand ?? "",
    dose: def.dose,
    doseUnit: def.doseUnit as SupplementUnit,
    timing: (def.timing as "am" | "pm") ?? "am",
    productUrl: def.productUrl ?? "",
    pricePerBottle: def.pricePerBottle != null ? String(def.pricePerBottle) : "",
    quantityPerBottle:
      def.quantityPerBottle != null ? String(def.quantityPerBottle) : "",
  };
}

function parseOptionalNonNegativeNumber(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function SupplementDetailSheet({
  definition,
  logs,
  onClose,
  onMutated,
}: SupplementDetailSheetProps) {
  const [editor, setEditor] = useState<EditorState | null>(null);

  useEffect(() => {
    setEditor(definition ? buildEditorState(definition) : null);
  }, [definition]);

  const { data: priceLogs } = trpc.supplements.listPriceLogs.useQuery(
    { definitionId: definition?.id ?? "", limit: 50 },
    { enabled: !!definition, retry: false }
  );

  const updateDefinition = trpc.supplements.updateDefinition.useMutation();
  const deleteDefinition = trpc.supplements.deleteDefinition.useMutation();
  const setLock = trpc.supplements.setDefinitionLock.useMutation();

  const definitionLogs = useMemo(() => {
    if (!definition) return [];
    return logs.filter((l) => l.definitionId === definition.id).slice(0, 20);
  }, [definition, logs]);

  const isOpen = definition !== null;

  async function handleSave() {
    if (!definition || !editor) return;
    const price = parseOptionalNonNegativeNumber(editor.pricePerBottle);
    const qty = parseOptionalNonNegativeNumber(editor.quantityPerBottle);
    if (price === undefined) {
      toast.error("Price must be a non-negative number.");
      return;
    }
    if (qty === undefined) {
      toast.error("Quantity must be a non-negative number.");
      return;
    }
    try {
      await updateDefinition.mutateAsync({
        definitionId: definition.id,
        name: editor.name.trim(),
        brand: editor.brand.trim() || undefined,
        dose: editor.dose.trim(),
        doseUnit: editor.doseUnit,
        timing: editor.timing,
        productUrl: editor.productUrl.trim() || undefined,
        pricePerBottle: price ?? undefined,
        quantityPerBottle: qty ?? undefined,
      });
      toast.success("Supplement updated.");
      onMutated();
      onClose();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }

  async function handleArchive() {
    if (!definition) return;
    if (!window.confirm(`Archive ${definition.name}? Logs remain but auto-logging stops.`)) {
      return;
    }
    try {
      await deleteDefinition.mutateAsync({ definitionId: definition.id });
      toast.success("Supplement archived.");
      onMutated();
      onClose();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }

  async function handleToggleLock() {
    if (!definition) return;
    try {
      await setLock.mutateAsync({
        definitionId: definition.id,
        isLocked: !definition.isLocked,
      });
      onMutated();
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  }

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">{definition?.name ?? "Supplement"}</SheetTitle>
          <SheetDescription>
            {definition ? formatCostPerDose(definition) : null}
          </SheetDescription>
        </SheetHeader>

        {definition && editor ? (
          <div className="space-y-6 pt-4">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Details</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 space-y-1">
                  <Label htmlFor="sd-name">Name</Label>
                  <Input
                    id="sd-name"
                    value={editor.name}
                    onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label htmlFor="sd-brand">Brand</Label>
                  <Input
                    id="sd-brand"
                    value={editor.brand}
                    onChange={(e) => setEditor({ ...editor, brand: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sd-dose">Dose</Label>
                  <Input
                    id="sd-dose"
                    value={editor.dose}
                    onChange={(e) => setEditor({ ...editor, dose: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Unit</Label>
                  <Select
                    value={editor.doseUnit}
                    onValueChange={(v) =>
                      setEditor({ ...editor, doseUnit: v as SupplementUnit })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPLEMENT_UNITS.map((u) => (
                        <SelectItem key={u} value={u}>
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Timing</Label>
                  <Select
                    value={editor.timing}
                    onValueChange={(v) =>
                      setEditor({ ...editor, timing: v as "am" | "pm" })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="am">am</SelectItem>
                      <SelectItem value="pm">pm</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 space-y-1">
                  <Label htmlFor="sd-url">Product URL</Label>
                  <Input
                    id="sd-url"
                    value={editor.productUrl}
                    onChange={(e) => setEditor({ ...editor, productUrl: e.target.value })}
                    placeholder="https://..."
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sd-price">$/bottle</Label>
                  <Input
                    id="sd-price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={editor.pricePerBottle}
                    onChange={(e) =>
                      setEditor({ ...editor, pricePerBottle: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sd-qty">Doses/bottle</Label>
                  <Input
                    id="sd-qty"
                    type="number"
                    min="0"
                    step="1"
                    value={editor.quantityPerBottle}
                    onChange={(e) =>
                      setEditor({ ...editor, quantityPerBottle: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={handleSave} disabled={updateDefinition.isPending}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant={definition.isLocked ? "default" : "outline"}
                  onClick={handleToggleLock}
                  disabled={setLock.isPending}
                >
                  {definition.isLocked ? "Locked" : "Lock"}
                </Button>
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={handleArchive}
                  disabled={deleteDefinition.isPending}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Archive
                </Button>
              </div>
            </section>

            <Separator />

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Price history</h3>
              {priceLogs && priceLogs.length > 0 ? (
                <>
                  <SupplementsCostTrendChart points={priceLogs} />
                  <ul className="space-y-1">
                    {priceLogs.slice(0, 6).map((log) => (
                      <li
                        key={log.id}
                        className="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1.5 text-xs"
                      >
                        <span className="font-medium">{formatCurrency(log.pricePerBottle)}</span>
                        <span className="text-muted-foreground">
                          {formatSourceLabel(log, "manual")} ·{" "}
                          {new Date(log.capturedAt).toLocaleDateString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">No price snapshots yet.</p>
              )}
            </section>

            <Separator />

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Recent logs</h3>
              {definitionLogs.length > 0 ? (
                <ul className="space-y-1">
                  {definitionLogs.map((log) => (
                    <li
                      key={log.id}
                      className="flex items-center justify-between rounded-md border bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900"
                    >
                      <span>
                        {log.dose} {log.doseUnit} · {log.timing}
                        {log.autoLogged ? " · auto" : ""}
                      </span>
                      <span className="text-emerald-700">
                        {new Date(log.takenAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No logs yet.</p>
              )}
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
