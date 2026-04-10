/**
 * Shared constants for the Solar REC dashboard modules.
 *
 * Phase 0 seeds this file with UTILITY_PATTERNS, the single constant that
 * buildDeliveryTrackerData needs. Phase 1 will move DATASET_DEFINITIONS,
 * the pagesize constants, and the REMOTE_* keys here too.
 */

/**
 * Transferee / transferor name fragments that identify the receiving entity
 * as an Illinois utility (ComEd, Ameren Illinois, MidAmerican). A transfer
 * whose transferee matches one of these is treated as a delivery; a transfer
 * whose transferor matches one of these is treated as a return.
 *
 * Duplicated at SolarRecDashboard.tsx:4419-4420, 6908-6909, and 10120-10121.
 * Phase 1 collapses those callsites to import from here.
 */
export const UTILITY_PATTERNS = ["comed", "ameren", "midamerican"] as const;
