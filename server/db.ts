/**
 * Barrel file — re-exports all database operations from the domain modules
 * under `./db/`.
 *
 * Previously a 4,305-line god file; now split into 18 domain-focused modules.
 * Consumers continue to `import { ... } from "./db"` or `from "../db"` —
 * no callsite changes were required.
 *
 * The singleton `_db` connection lives in `./db/_core` and all sub-modules
 * share it via module identity.
 */

export * from "./db/_core";
export * from "./db/users";
export * from "./db/integrations";
export * from "./db/preferences";
export * from "./db/oauth";
export * from "./db/conversations";
export * from "./db/notes";
export * from "./db/metrics";
export * from "./db/supplements";
export * from "./db/habits";
export * from "./db/engagement";
export * from "./db/feedback";
export * from "./db/totp";
export * from "./db/productionReadings";
export * from "./db/solarRec";
export * from "./db/monitoring";
export * from "./db/contractScans";
export * from "./db/scheduleB";
export * from "./db/solarRecDatasets";
export * from "./db/kingOfDay";
