/**
 * CSV row identity + field-lookup helpers.
 *
 * Pure functions that normalize CSV rows into the identity tuples +
 * raw string values that the rest of the helpers modules rely on.
 * No React, no state, no browser globals.
 */

import { clean } from "@/lib/helpers";
import type { CsvRow } from "@/solar-rec-dashboard/state/types";

export function resolvePart2ProjectIdentity(row: CsvRow, index: number) {
  const applicationId =
    clean(row.Application_ID) || clean(row.application_id);
  const portalSystemId = clean(row.system_id);
  const trackingId =
    clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
    clean(row.tracking_system_ref_id);
  const projectName = clean(row.Project_Name) || clean(row.system_name);
  const projectNameKey = projectName.toLowerCase();
  const dedupeKey = portalSystemId
    ? `system:${portalSystemId}`
    : trackingId
      ? `tracking:${trackingId}`
      : applicationId
        ? `application:${applicationId}`
        : projectName
          ? `name:${projectNameKey}`
          : `row:${index}`;

  return {
    applicationId,
    portalSystemId,
    trackingId,
    projectName,
    projectNameKey,
    dedupeKey,
  };
}

export function getCsvValueByHeader(
  row: CsvRow,
  headerName: string,
): string {
  const target = clean(headerName).toLowerCase();
  for (const [header, value] of Object.entries(row)) {
    if (clean(header).toLowerCase() === target) return clean(value);
  }
  return "";
}

export function resolveLastMeterReadRawValue(row: CsvRow): string {
  const direct =
    clean(row["Last Meter Read (kWh)"]) ||
    clean(row["Last Meter Read (kW)"]) ||
    clean(row["Last Meter Read"]);
  if (direct) return direct;

  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = clean(key).toLowerCase();
    if (
      normalizedKey.includes("last meter read") &&
      !normalizedKey.includes("date")
    ) {
      const candidate = clean(value);
      if (candidate) return candidate;
    }
  }

  return "";
}

export function resolveStateApplicationRefId(
  row: CsvRow,
): string | null {
  const exact = clean(row.state_certification_number);
  return exact || null;
}
