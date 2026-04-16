/**
 * Migration banner for transitioning from IndexedDB to server-side storage.
 *
 * Shows when:
 * 1. IndexedDB has datasets (hasLocalData)
 * 2. Server-side storage is not yet enabled
 *
 * Offers a one-click migration button that uploads all IndexedDB datasets
 * to the server, then enables the server-side flag.
 */

import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CloudUpload, Check, Loader2, X, Database } from "lucide-react";
import { useServerSideStorage } from "../hooks/useServerSideStorage";

export default memo(function ServerMigrationBanner() {
  const {
    needsMigration,
    startMigration,
    migrationProgress,
  } = useServerSideStorage();

  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !needsMigration) return null;

  const isRunning = migrationProgress?.status === "uploading" || migrationProgress?.status === "reading";
  const isDone = migrationProgress?.status === "done";
  const hasErrors = (migrationProgress?.errors.length ?? 0) > 0;

  return (
    <div className="mx-4 mb-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-blue-900">
          <Database className="h-4 w-4 shrink-0" />
          <div>
            {isDone && !hasErrors ? (
              <span className="font-medium text-emerald-800">
                <Check className="mr-1 inline h-4 w-4" />
                Migration complete — server-side storage is now active.
              </span>
            ) : isDone && hasErrors ? (
              <span className="font-medium text-amber-800">
                Migration completed with {migrationProgress!.errors.length} error(s).
                Some datasets may need to be re-uploaded.
              </span>
            ) : isRunning ? (
              <span>
                <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                Migrating {migrationProgress!.currentDataset ?? "datasets"}...
                ({migrationProgress!.completedDatasets}/{migrationProgress!.totalDatasets})
              </span>
            ) : (
              <span>
                <strong>Server-side storage available.</strong>{" "}
                Migrate your datasets to the server for faster loading and no more browser crashes.
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!isDone && !isRunning && (
            <Button
              size="sm"
              variant="default"
              className="h-7 gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs"
              onClick={startMigration}
            >
              <CloudUpload className="h-3.5 w-3.5" />
              Migrate Now
            </Button>
          )}
          {!isRunning && (
            <button
              onClick={() => setDismissed(true)}
              className="text-blue-400 hover:text-blue-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
