// ---------------------------------------------------------------------------
// Solar REC permission module registry.
//
// Canonical list of every module that participates in the Task 5.1 permission
// matrix. Each entry is a stable key used as the permission record's
// `moduleKey`, plus display metadata for the Settings "Team & Permissions"
// UI and the sidebar.
//
// Source of truth: docs/execution-plan.md Task 5.1 (module enumeration).
// Adding a module later: append to MODULE_KEYS + MODULES; existing users keep
// their rows and default to `none` on the new module until an admin grants
// access.
// ---------------------------------------------------------------------------

export const MODULE_KEYS = [
  "solar-rec-dashboard",
  "monitoring-overview",
  "meter-reads",
  "schedule-b",
  "contract-scanner",
  "contract-scrape-manager",
  "din-scrape-manager",
  "abp-invoice-settlement",
  "early-payment",
  "invoice-match",
  "address-checker",
  "zendesk-metrics",
  "deep-update-synthesizer",
  "jobs",
  "portfolio-workbench",
  "team-permissions",
  "solar-rec-settings",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export const PERMISSION_LEVELS = ["none", "read", "edit", "admin"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export interface ModuleDescriptor {
  /** Stable key used in the `solarRecUserModulePermissions` row. */
  key: ModuleKey;
  /** Title shown in the matrix column header and sidebar. */
  label: string;
  /** Short blurb shown under the label in the matrix tooltip. */
  description: string;
  /**
   * Highest permission level this module recognises. Most modules support
   * all four levels; a few read-only modules top out at `read`.
   */
  maxLevel: PermissionLevel;
}

export const MODULES: readonly ModuleDescriptor[] = [
  {
    key: "solar-rec-dashboard",
    label: "Solar REC Dashboard",
    description: "Main portfolio dashboard and all tabs.",
    maxLevel: "admin",
  },
  {
    key: "monitoring-overview",
    label: "Monitoring Overview",
    description: "Daily monitoring scheduler and run history.",
    maxLevel: "admin",
  },
  {
    key: "meter-reads",
    label: "Meter Reads",
    description: "All vendor meter-read pages.",
    maxLevel: "admin",
  },
  {
    key: "schedule-b",
    label: "Schedule B",
    description: "Schedule B import and CSG Schedule B import.",
    maxLevel: "admin",
  },
  {
    key: "contract-scanner",
    label: "Contract Scanner",
    description: "PDF upload scanner.",
    maxLevel: "admin",
  },
  {
    key: "contract-scrape-manager",
    label: "Contract Scrape Manager",
    description: "CSG portal contract scraper.",
    maxLevel: "admin",
  },
  {
    key: "din-scrape-manager",
    label: "DIN Scrape Manager",
    description: "Inverter/meter DIN photo scraper.",
    maxLevel: "admin",
  },
  {
    key: "abp-invoice-settlement",
    label: "ABP Invoice Settlement",
    description: "ABP invoice reconciliation workflow.",
    maxLevel: "admin",
  },
  {
    key: "early-payment",
    label: "Early Payment",
    description: "Early payment eligibility workbench.",
    maxLevel: "admin",
  },
  {
    key: "invoice-match",
    label: "Invoice Match",
    description: "Invoice-to-system matching dashboard.",
    maxLevel: "admin",
  },
  {
    key: "address-checker",
    label: "Address Checker",
    description: "Address normalization and dedupe tool.",
    maxLevel: "admin",
  },
  {
    key: "zendesk-metrics",
    label: "Zendesk Ticket Metrics",
    description: "Zendesk ticket metrics and resolver stats.",
    maxLevel: "admin",
  },
  {
    key: "deep-update-synthesizer",
    label: "Deep Update Synthesizer",
    description: "Aggregated update synthesis tool.",
    maxLevel: "admin",
  },
  {
    key: "jobs",
    label: "Jobs",
    description: "Unified jobs and run history page.",
    maxLevel: "admin",
  },
  {
    key: "portfolio-workbench",
    label: "Portfolio Workbench",
    description: "System detail + worksets (Phase 9).",
    maxLevel: "admin",
  },
  {
    key: "team-permissions",
    label: "Team & Permissions",
    description: "Manage team members and the permission matrix.",
    maxLevel: "admin",
  },
  {
    key: "solar-rec-settings",
    label: "Solar REC Settings",
    description: "Solar REC module settings (not personal Settings).",
    maxLevel: "admin",
  },
] as const;

const MODULE_INDEX: Record<string, ModuleDescriptor> = Object.fromEntries(
  MODULES.map((m) => [m.key, m])
);

export function isModuleKey(value: string): value is ModuleKey {
  return value in MODULE_INDEX;
}

export function getModule(key: ModuleKey): ModuleDescriptor {
  return MODULE_INDEX[key];
}

/**
 * Numeric ordering for permission comparison. A call that requires at least
 * `read` should accept `read`, `edit`, or `admin`.
 */
export const PERMISSION_ORDER: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  edit: 2,
  admin: 3,
};

export function permissionAtLeast(
  actual: PermissionLevel,
  required: PermissionLevel
): boolean {
  return PERMISSION_ORDER[actual] >= PERMISSION_ORDER[required];
}
