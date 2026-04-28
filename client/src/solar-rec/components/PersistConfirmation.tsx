import { Button } from "@/components/ui/button";
import { Loader2, Database, X } from "lucide-react";
import { toast } from "sonner";
import { solarRecTrpc as trpc } from "../solarRecTrpc";

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

  return (
    <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-md border border-emerald-200 bg-emerald-50/50 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-emerald-900">
          Ready to save {rows.length} meter read{rows.length === 1 ? "" : "s"}
        </p>
        <p className="text-xs text-emerald-700">
          Last saved to Converted Reads: {summariesQuery.isLoading ? "..." : lastSavedAt}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onDiscard} disabled={isSaving}>
          <X className="mr-2 h-4 w-4" />
          Discard
        </Button>
        <Button size="sm" onClick={() => void handleSave()} disabled={isSaving || rows.length === 0}>
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
          Save to Converted Reads
        </Button>
      </div>
    </div>
  );
}
