export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';
export const TWO_FACTOR_REQUIRED_MSG = '2FA_REQUIRED';
export const SOLAR_REC_SESSION_COOKIE = "solar_rec_session";

export const SUPPLEMENT_UNITS = ["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"] as const;
export type SupplementUnit = (typeof SUPPLEMENT_UNITS)[number];

/**
 * Canonical monitoring-platform names used in the Solar REC "Converted Reads"
 * dataset. These strings are the single source of truth — every meter reads
 * page (client) and the monitoring batch bridge (server) must pass the same
 * value when building a ConvertedReadRow, otherwise the same site gets stored
 * under multiple dedup keys and you end up with duplicate rows.
 *
 * The canonical values here match what `normalizeMonitoringPlatform()` in
 * client/src/solar-rec-dashboard/lib/helpers/monitoring.ts returns — that
 * function is what the Performance Ratio tab's match index builds around,
 * so these are also the names the system database uses.
 */
export const MONITORING_CANONICAL_NAMES = {
  solarEdge: "SolarEdge",
  enphase: "Enphase",
  fronius: "Fronius Solar.web",
  generac: "Generac PWRfleet",
  hoymiles: "Hoymiles S-Miles Cloud",
  goodwe: "GoodWe SEMS Portal",
  solis: "Solis",
  locus: "Locus Energy",
  apsystems: "APSystems",
  solarLog: "Solar-Log",
  growatt: "Growatt",
  egauge: "eGauge",
  teslaPowerhub: "Tesla Powerhub",
  ennexos: "ennexOS",
  ekm: "EKM Encompass.io",
} as const;

export type MonitoringCanonicalName =
  (typeof MONITORING_CANONICAL_NAMES)[keyof typeof MONITORING_CANONICAL_NAMES];
