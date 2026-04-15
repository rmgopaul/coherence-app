/**
 * Monitoring-platform normalization + credential-resolution helpers.
 * Used by the Offline Monitoring tab, Performance Ratio tab, and the
 * master systems builder.
 */

import { clean } from "@/lib/helpers";
import type {
  MonitoringDetailsRecord,
  OfflineMonitoringAccessFields,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";
import {
  AUTO_MONITORING_PLATFORM_COMPLIANT_SOURCE_BY_KEY,
  TEN_KW_COMPLIANT_SOURCE,
} from "@/solar-rec-dashboard/lib/constants";
import { firstNonEmptyString } from "./misc";

export function normalizeMonitoringMatch(
  value: string | null | undefined,
): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeSystemIdMatch(
  value: string | null | undefined,
): string {
  const compact = clean(value).replaceAll(",", "").replace(/\s+/g, "");
  if (!compact) return "";
  if (/^-?\d+(?:\.\d+)?$/.test(compact)) {
    const parsed = Number(compact);
    if (Number.isFinite(parsed)) return String(Math.trunc(parsed));
  }
  return compact.toUpperCase();
}

export function normalizeSystemNameMatch(
  value: string | null | undefined,
): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a freeform monitoring platform string (from portal, URL, or
 * notes) to one of a known set of canonical platform names. Falls back
 * to the raw string if non-URL, or "Unknown" otherwise.
 */
export function normalizeMonitoringPlatform(
  platformRaw: string,
  websiteRaw: string,
  notesRaw: string,
): string {
  const candidates = [clean(platformRaw), clean(websiteRaw), clean(notesRaw)]
    .filter(Boolean)
    .map((value) => value.toLowerCase());

  const inferFromText = (text: string): string | null => {
    if (text.includes("solaredge") || text.includes("solar edge")) return "SolarEdge";
    if (text.includes("enphase")) return "Enphase";
    if (text.includes("hoymiles") || text.includes("s-miles")) return "Hoymiles S-Miles Cloud";
    if (text.includes("fronius") || text.includes("solar.web") || text.includes("solarweb.com")) return "Fronius Solar.web";
    if (text.includes("apsystems")) return "APSystems";
    if (text.includes("ennexos")) return "ennexOS";
    if (text.includes("tesla")) return "Tesla";
    if (text.includes("egauge") || text.includes("eguage")) return "eGauge";
    if (text.includes("sunpower")) return "SUNPOWER";
    if (text.includes("sdsi") || text.includes("arraymeter")) return "SDSI ArrayMeter";
    if (text.includes("generac") || text.includes("pwrfleet") || text.includes("pwrcell")) return "Generac PWRfleet";
    if (text.includes("chilicon")) return "Chilicon Power";
    if (text.includes("solis")) return "Solis";
    if (text.includes("encompass") || text.includes("ekm")) return "EKM Encompass.io";
    if (text.includes("duracell")) return "DURACELL Power Center";
    if (text.includes("solar-log") || text.includes("solarlog")) return "Solar-Log";
    if (text.includes("sensergm")) return "SenseRGM";
    if (text.includes("sems") || text.includes("goodwe")) return "GoodWe SEMS Portal";
    if (text.includes("alsoenergy")) return "AlsoEnergy";
    if (text.includes("locus")) return "Locus Energy";
    if (text.includes("sol-ark")) return "Sol-Ark PowerView Inteless";
    if (text.includes("mysolark")) return "MySolArk";
    if (text.includes("chint")) return "Chint Power Systems";
    if (text.includes("growatt")) return "Growatt";
    if (text.includes("sunnyportal")) return "SunnyPortal";
    if (text.includes("eg4")) return "EG4Electronics";
    if (text.includes("tigo")) return "Tigo";
    if (text.includes("vision metering")) return "Vision Metering";
    if (text.includes("solectria") || text.includes("solrenview")) return "Solectria SolrenView";
    if (text.includes("sigenergy") || text.includes("sigencloud")) return "Sigenergy";
    if (text.includes("savant")) return "Savant Power Storage";
    if (text.includes("aurora vision")) return "Aurora Vision";
    if (text.includes("franklin")) return "FranklinWH";
    if (text.includes("outback optics")) return "Outback Optics RE";
    if (text.includes("elkor")) return "ELKOR Cloud";
    if (text.includes("emporia")) return "Emporia Energy";
    if (text.includes("wattch")) return "Wattch.io";
    if (text.includes("aptos")) return "Aptos Solar";
    if (text.includes("insight cloud")) return "Insight Cloud";
    if (text.includes("third part")) return "Third Party Reporting";
    return null;
  };

  for (const candidate of candidates) {
    const inferred = inferFromText(candidate);
    if (inferred) return inferred;
  }

  const primary = clean(platformRaw);
  if (primary && !primary.toLowerCase().startsWith("http")) return primary;
  return "Unknown";
}

/**
 * Look up a system's monitoring details (online monitoring URL, credentials,
 * etc.) from the monitoringDetailsBySystemKey map, trying systemId →
 * trackingSystemRefId → systemName lowercase in order.
 */
export function getMonitoringDetailsForSystem(
  system: SystemRecord,
  monitoringDetailsBySystemKey: Map<string, MonitoringDetailsRecord>,
): MonitoringDetailsRecord | undefined {
  const keyById = system.systemId ? `id:${system.systemId}` : "";
  const keyByTracking = system.trackingSystemRefId
    ? `tracking:${system.trackingSystemRefId}`
    : "";
  const keyByName = `name:${system.systemName.toLowerCase()}`;

  return (
    (keyById ? monitoringDetailsBySystemKey.get(keyById) : undefined) ??
    (keyByTracking ? monitoringDetailsBySystemKey.get(keyByTracking) : undefined) ??
    monitoringDetailsBySystemKey.get(keyByName)
  );
}

/**
 * Classify a monitoring access-type string into one of four categories
 * the Offline Monitoring tab uses to decide which credential columns
 * to show in its detail table.
 */
export function classifyMonitoringAccessType(
  accessTypeRaw: string,
): "granted" | "link" | "login" | "other" {
  const normalized = clean(accessTypeRaw).toLowerCase();
  if (!normalized) return "other";
  if (normalized.includes("grant")) return "granted";
  if (normalized.includes("link")) return "link";
  if (
    normalized.includes("password") ||
    normalized.includes("pass") ||
    normalized.includes("pwd") ||
    normalized.includes("login")
  ) {
    return "login";
  }
  return "other";
}

/**
 * Resolve the six credential fields shown in the Offline Monitoring
 * detail table. Values blank or populate depending on the access
 * category — e.g. "granted" access hides link/username/password even
 * if present, to avoid leaking the wrong credential for that
 * workflow.
 */
export function resolveOfflineMonitoringAccessFields(
  system: SystemRecord,
  monitoringDetailsBySystemKey: Map<string, MonitoringDetailsRecord>,
): OfflineMonitoringAccessFields {
  const details = getMonitoringDetailsForSystem(
    system,
    monitoringDetailsBySystemKey,
  );
  const accessType =
    clean(details?.online_monitoring_access_type) || clean(system.monitoringType);
  const category = classifyMonitoringAccessType(accessType);
  const monitoringSiteId = clean(details?.online_monitoring_system_id);
  const monitoringSiteName = clean(details?.online_monitoring_system_name);
  const monitoringLink = clean(details?.online_monitoring_website_api_link);
  const monitoringUsername =
    firstNonEmptyString(
      clean(details?.online_monitoring_username),
      clean(details?.online_monitoring_granted_username),
    ) ?? "";
  const monitoringPassword = clean(details?.online_monitoring_password);

  if (category === "granted") {
    return {
      accessType,
      monitoringSiteId,
      monitoringSiteName,
      monitoringLink: "",
      monitoringUsername: "",
      monitoringPassword: "",
    };
  }

  if (category === "link") {
    return {
      accessType,
      monitoringSiteId: "",
      monitoringSiteName: "",
      monitoringLink,
      monitoringUsername: "",
      monitoringPassword: "",
    };
  }

  if (category === "login") {
    return {
      accessType,
      monitoringSiteId: "",
      monitoringSiteName,
      monitoringLink: "",
      monitoringUsername,
      monitoringPassword,
    };
  }

  return {
    accessType,
    monitoringSiteId,
    monitoringSiteName,
    monitoringLink,
    monitoringUsername,
    monitoringPassword,
  };
}

export function resolveMonitoringPlatformCompliantSource(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeMonitoringMatch(value);
  if (!normalized) return null;
  return AUTO_MONITORING_PLATFORM_COMPLIANT_SOURCE_BY_KEY[normalized] ?? null;
}

export function getAutoCompliantSourcePriority(value: string): number {
  return value === TEN_KW_COMPLIANT_SOURCE ? 1 : 2;
}

export function isTenKwAcOrLess(
  portalAcSizeKw: number | null,
  abpAcSizeKw: number | null,
): boolean {
  const hasAnySize = portalAcSizeKw !== null || abpAcSizeKw !== null;
  if (!hasAnySize) return false;
  const portalOk = portalAcSizeKw === null || portalAcSizeKw <= 10;
  const abpOk = abpAcSizeKw === null || abpAcSizeKw <= 10;
  return portalOk && abpOk;
}
