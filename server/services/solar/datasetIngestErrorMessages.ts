/**
 * Shared formatting helpers for dataset-ingest "empty batch"
 * failure messages.
 *
 * **Why not a full `formatEmptyBatchErrorMessage` helper.** The
 * v1 (`ingestDataset` — auto-heal / saveDataset path) and v2
 * (`datasetUploadJobRunner` — direct upload path) 0-row guards
 * detect DIFFERENT failure modes:
 *
 *   - **v1**: `parseCsvText` produced 0 data rows from the CSV
 *     blob. The file itself was header-only (or the parser
 *     gave up before any row). Diagnostic emphasis: byte count
 *     + headers ("the file you uploaded has no data rows").
 *
 *   - **v2**: the stream-parser yielded N rows, every row's
 *     `parseRow` returned null (typically because a required
 *     field's alias was missing from every row's headers).
 *     Diagnostic emphasis: row count + observed headers + the
 *     parser-returned-null-vs-threw branch ("the parser
 *     couldn't extract any rows from your CSV").
 *
 * Forcing both through a single message template would obscure
 * the diagnostic — each call site needs to tell its own story.
 * What IS genuinely shared is the 200-char client-truncation
 * limit, the header-list truncation, and the remediation suffix.
 * Extract those; leave the prose distinct.
 */

/**
 * Hard cap on the length of a sync-issues banner message rendered
 * by `SolarRecDashboard.tsx`. The banner uses
 * `info.message.slice(0, 200)`, so any message longer than this
 * gets visually truncated mid-instruction — which historically
 * cut the user's remediation hint in half. Each call site that
 * surfaces an error to the banner should fit under this cap; the
 * test rails in `datasetIngestion.test.ts` + the existing 200-
 * char ceiling assert pin it.
 *
 * Raising the cap requires also raising the client-side slice in
 * `SolarRecDashboard.tsx`; otherwise the longer message just gets
 * truncated again.
 */
export const MAX_SYNC_NOTICE_LENGTH = 200;

/**
 * Format an observed CSV header list as a comma-separated string
 * truncated to `maxCount` items with an ellipsis when the source
 * list is longer. Used by both empty-batch guards to surface the
 * actual columns present in the user's file when the parser
 * rejects them or the dataset-specific parser drops all rows.
 *
 * `maxCount` differs per call site: v1 uses 6 (because the
 * message includes byte-count framing that consumes some of the
 * 200-char budget); v2 uses 12 (the message has more breathing
 * room because it doesn't include byte-count framing).
 */
export function formatTruncatedHeaderList(
  headers: ReadonlyArray<string>,
  maxCount: number
): string {
  const shown = headers.slice(0, maxCount).join(", ");
  return headers.length > maxCount ? `${shown}, …` : shown;
}
