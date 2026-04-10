/**
 * Shared runtime types for the Solar REC dashboard.
 *
 * Phase 1 seeds this module with the two types that ScheduleBImport,
 * csvIo, and the mergeScheduleRows / buildDeliveryTrackerData pipeline
 * all need in common. Additional dataset + remote-sync types will move
 * here in Phase 1 session 2 when useDashboardPersistence is extracted.
 */

/**
 * A single row from any uploaded CSV. Keys are header names, values
 * are raw cell strings (not parsed / not typed).
 */
export type CsvRow = Record<string, string>;
