import { Button } from "@/components/ui/button";
import { Loader2, Database, X } from "lucide-react";
import { toast } from "sonner";
import { solarRecTrpc as trpc } from "../solarRecTrpc";

// Runtime-safe readers for vendor meter-read snapshot objects.
// Each of the 14 vendor pages narrows their tRPC result with these
// before building PersistConfirmation rows, instead of casting to
// `any`. The vendor return shapes are tRPC unions whose "Found"
// branch carries `status`, `name`, and `lifetimeKwh`; these
// helpers walk through `unknown` and bail to null otherwise.
export function readMeterStatus(result: unknown): string | null {
  if (result && typeof result === "object" && "status" in result) {
    const value = (result as { status: unknown }).status;
    if (typeof value === "string") return value;
  }
  return null;
}

export function readMeterName(result: unknown): string | null {
  if (result && typeof result === "object") {
    const obj = result as { name?: unknown; systemName?: unknown };
    if (typeof obj.name === "string" && obj.name.trim()) return obj.name;
    if (typeof obj.systemName === "string" && obj.systemName.trim()) return obj.systemName;
  }
  return null;
}

export function readMeterLifetimeKwh(result: unknown): number | null {
  if (result && typeof result === "object" && "lifetimeKwh" in result) {
    const value = (result as { lifetimeKwh: unknown }).lifetimeKwh;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

interface PersistConfirmationProps {
  providerKey: string;
  providerLabel: string;
  rows: Record<string, string>[];
  onDiscard: () => void;
  onSuccess?: () => void;
}

export function PersistConfirmation({
  providerKey,
  providerLabel,
  rows,
  onDiscard,
  onSuccess,
}: PersistConfirmationProps) {
  const pushMutation = trpc.solarRecDashboard.pushConvertedReadsSource.useMutation();
  // Poll for dataset summaries to get lastSavedAt
  const summariesQuery = trpc.solarRecDashboard.getDatasetSummariesAll.useQuery(undefined, {
    refetchInterval: 10000,
  });

  const handleSave = async () => {
    try {
      await pushMutation.mutateAsync({
        providerKey,
        providerLabel,
        rows,
      });
      toast.success(`Saved ${rows.length} rows to Converted Reads`);
      onSuccess?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to save: ${msg}`);
    }
  };

  const isSaving = pushMutation.isPending;

  const convertedReadsSummary = summariesQuery.data?.summaries.find(s => s.datasetKey === "convertedReads");
  const lastSavedAt = convertedReadsSummary?.lastUpdated 
    ? new Date(convertedReadsSummary.lastUpdated).toLocaleString() 
    : "Never";

  // When the read returned no usable rows (vendor reported "Not
  // Found" / empty), show the strip in amber as a "nothing to save"
  // notice so the user still sees the persistence boundary instead
  // of confusing the inline display with a durable record.
  const hasRows = rows.length > 0;
  const tone = hasRows
    ? {
        wrapper: "border-emerald-200 bg-emerald-50/50",
        title: "text-emerald-900",
        meta: "text-emerald-700",
      }
    : {
        wrapper: "border-amber-200 bg-amber-50/60",
        title: "text-amber-900",
        meta: "text-amber-800",
      };

  return (
    <div className={`mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-md border p-4 ${tone.wrapper}`}>
      <div className="space-y-1">
        <p className={`text-sm font-medium ${tone.title}`}>
          {hasRows
            ? `This read is not saved. Save ${rows.length} row${rows.length === 1 ? "" : "s"} to Converted Reads?`
            : "Read returned no usable data — nothing to save."}
        </p>
        <p className={`text-xs ${tone.meta}`}>
          Last saved to Converted Reads: {summariesQuery.isLoading ? "..." : lastSavedAt}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onDiscard} disabled={isSaving}>
          <X className="mr-2 h-4 w-4" />
          Discard
        </Button>
        <Button size="sm" onClick={() => void handleSave()} disabled={isSaving || !hasRows}>
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
          Save to Converted Reads
        </Button>
      </div>
    </div>
  );
}
