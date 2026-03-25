/**
 * Generic file upload hook for CSV/XLSX parsing workflows.
 *
 * Encapsulates the repeating pattern: guard → set loading → parse → domain transform → set state → toast.
 * Used by AbpInvoiceSettlement (8 uploads), InvoiceMatchDashboard, SolarEdgeMeterReads, etc.
 */

import { toErrorMessage } from "@/lib/helpers";
import { parseTabularFile, type ParsedTabularData } from "@/lib/csvParsing";
import { useCallback, useState } from "react";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type FileUploadConfig<TResult> = {
  /** Unique key for this upload slot (used for loading state tracking). */
  key: string;
  /** Human-readable label for toast messages (e.g. "QuickBooks report"). */
  label: string;
  /** Transform parsed tabular data into domain rows. Receives the parsed file and the original File object. */
  transform: (parsed: ParsedTabularData, file: File) => TResult | Promise<TResult>;
  /** Called with the transformed result to update state. */
  onResult: (result: TResult, fileName: string) => void;
  /** Format a success message. Receives the result for counting. Default: "Loaded {label}." */
  successMessage?: (result: TResult, fileName: string) => string;
  /** If true, accept multiple files and merge results via transform called per-file. Default: false. */
  multi?: boolean;
};

export type FileUploadMultiConfig<TRow> = {
  key: string;
  label: string;
  /** Parse a single file into rows. Called once per file. */
  parseFile: (file: File) => TRow[] | Promise<TRow[]>;
  /** Called with all merged rows from all files. */
  onResult: (rows: TRow[], fileNames: string[]) => void;
  successMessage?: (rows: TRow[], fileNames: string[]) => string;
};

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export function useFileUpload() {
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(() => new Set());

  const startLoading = useCallback(
    (key: string) => setLoadingKeys((s) => new Set(s).add(key)),
    []
  );
  const stopLoading = useCallback(
    (key: string) =>
      setLoadingKeys((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      }),
    []
  );

  const isLoading = useCallback((key: string) => loadingKeys.has(key), [loadingKeys]);

  /**
   * Create an upload handler for a single-file upload that uses parseTabularFile.
   * Returns `(fileList: FileList | null) => Promise<void>`.
   */
  function createHandler<TResult>(config: FileUploadConfig<TResult>) {
    return async (fileList: FileList | null) => {
      const file = fileList?.[0];
      if (!file) return;
      startLoading(config.key);
      try {
        const parsed = await parseTabularFile(file);
        const result = await config.transform(parsed, file);
        config.onResult(result, file.name);
        const msg = config.successMessage
          ? config.successMessage(result, file.name)
          : `Loaded ${config.label}.`;
        toast.success(msg);
      } catch (error) {
        toast.error(`Failed to parse ${config.label}: ${toErrorMessage(error)}`);
      } finally {
        stopLoading(config.key);
      }
    };
  }

  /**
   * Create an upload handler for multi-file uploads with per-file parsing + merge.
   * Returns `(fileList: FileList | null) => Promise<void>`.
   */
  function createMultiHandler<TRow>(config: FileUploadMultiConfig<TRow>) {
    return async (fileList: FileList | null) => {
      if (!fileList?.length) return;
      startLoading(config.key);
      try {
        const files = Array.from(fileList);
        const mergedRows: TRow[] = [];
        for (const file of files) {
          const rows = await config.parseFile(file);
          mergedRows.push(...rows);
        }
        const fileNames = files.map((f) => f.name);
        config.onResult(mergedRows, fileNames);
        const msg = config.successMessage
          ? config.successMessage(mergedRows, fileNames)
          : `Loaded ${mergedRows.length.toLocaleString("en-US")} rows from ${files.length} file(s).`;
        toast.success(msg);
      } catch (error) {
        toast.error(`Failed to parse ${config.label}: ${toErrorMessage(error)}`);
      } finally {
        stopLoading(config.key);
      }
    };
  }

  return { isLoading, createHandler, createMultiHandler };
}
