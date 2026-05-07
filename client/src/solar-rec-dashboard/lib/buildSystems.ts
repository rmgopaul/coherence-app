/**
 * Pure builder for the `systems: SystemRecord[]` array.
 *
 * Extracted from `SolarRecDashboard.tsx` in Phase 19 so it can run in
 * a Web Worker off the main thread. This is the single biggest
 * computation in the entire dashboard — it walks up to 8 different
 * datasets, builds an indexed `SystemBuilder` intermediate, then
 * projects the result into `SystemRecord[]` with derived fields for
 * ownership status, reporting status, value gaps, and more.
 *
 * Downstream memos (summary, changeOwnershipRows, performanceSourceRows,
 * part2EligibleSystemsForSizeReporting, and half the tabs) all depend
 * on this output, so any time one of the input datasets changes the
 * entire cascade had to re-run on the main thread, blocking the UI
 * for ~100–200 ms on real data.
 *
 * Moving this into a worker means:
 *   - Cold hydrate doesn't freeze while 8 datasets all land and the
 *     builder rebuilds
 *   - Dataset uploads don't freeze while the affected slice of
 *     systems recomputes
 *   - Every keystroke/click in an unrelated tab stays smooth even
 *     when a dataset changes in the background
 *
 * Usage:
 *   const systems = buildSystems({
 *     part2VerifiedAbpRows,
 *     solarApplicationsRows: datasets.solarApplications?.rows ?? [],
 *     ...
 *   });
 *
 * The function is a pure reducer over its inputs — no React, no
 * closures, no browser globals — which lets it run isomorphically
 * on the server (dynamic-imported by buildSystemSnapshot.ts) and
 * in unit tests.
 */

import { clean } from "@/lib/helpers";
import {
  firstNonEmptyString,
  firstNonNull,
  isTerminatedContractType,
  isTransferredContractType,
  maxDate,
  normalizeMonitoringPlatform,
  parseDate,
  parseEnergyToWh,
  parseNumber,
  parsePart2VerificationDate,
  resolveLastMeterReadRawValue,
  resolveStateApplicationRefId,
} from "@/solar-rec-dashboard/lib/helpers";
import {
  buildTransferDeliveryLookup,
  getDeliveredLifetime,
} from "@/solar-rec-dashboard/lib/transferHistoryDeliveries";
import { GENERATION_BASELINE_VALUE_HEADERS } from "@/solar-rec-dashboard/lib/constants";
import type {
  ChangeOwnershipStatus,
  CsvRow,
  OwnershipStatus,
  SizeBucket,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Local (worker-safe) helpers
// ---------------------------------------------------------------------------

/**
 * Intermediate accumulator — every input dataset contributes to one
 * of these, keyed by (trackingSystemRefId | systemId | fallback).
 * This type stays local to the builder because nothing else reads it.
 */
type SystemBuilder = {
  key: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  primaryName: string | null;
  names: Set<string>;
  installedKwAc: number | null;
  installedKwDc: number | null;
  recPrice: number | null;
  totalContractAmount: number | null;
  annualRecs: number | null;
  recsOnContract: number | null;
  recsDeliveredQty: number | null;
  scheduleRequired: number | null;
  scheduleDelivered: number | null;
  latestGenerationDate: Date | null;
  latestGenerationReadDate: Date | null;
  latestGenerationReadWh: number | null;
  lastRecDeliveredGenerationDate: Date | null;
  contractedDate: Date | null;
  contractType: string | null;
  zillowStatus: string | null;
  zillowSoldDate: Date | null;
  transferSeen: boolean;
  statusText: string;
  monitoringType: string | null;
  monitoringPlatform: string | null;
  installerName: string | null;
  part2VerificationDate: Date | null;
};

/**
 * Classify the raw `online_monitoring_*` fields from a solarApplications
 * row into a canonical "access method" label. Previously inlined in
 * SolarRecDashboard.tsx; moved here because it's only used by the
 * systems builder.
 */
function normalizeMonitoringMethod(
  accessTypeRaw: string,
  entryMethodRaw: string,
  selfReportRaw: string,
): string {
  const accessType = clean(accessTypeRaw).toLowerCase();
  if (accessType === "granted") return "Granted Access";
  if (accessType === "pwd" || accessType === "password") return "Password";
  if (accessType === "link") return "Link";
  if (accessType === "self") return "Self-Report";
  if (accessType.includes("grant")) return "Granted Access";
  if (accessType.includes("pass")) return "Password";
  if (accessType.includes("link")) return "Link";
  if (accessType.includes("self")) return "Self-Report";

  const selfReport = clean(selfReportRaw).toLowerCase();
  if (["1", "true", "yes", "y"].includes(selfReport)) return "Self-Report";

  const entryMethod = clean(entryMethodRaw);
  if (entryMethod) return `Other - ${entryMethod}`;

  return "Unknown";
}

/**
 * Sum every `year{N}_quantity_{required|delivered}` cell on a
 * deliveryScheduleBase row. Previously inlined in
 * SolarRecDashboard.tsx; moved here because it's only used by the
 * systems builder.
 */
function sumSchedule(
  row: CsvRow,
  suffix: "_quantity_required" | "_quantity_delivered",
): number | null {
  let total = 0;
  let hasData = false;

  Object.entries(row).forEach(([header, value]) => {
    if (!header.endsWith(suffix)) return;
    const parsed = parseNumber(value);
    if (parsed === null) return;
    total += parsed;
    hasData = true;
  });

  return hasData ? total : null;
}

// ---------------------------------------------------------------------------
// Public input / builder
// ---------------------------------------------------------------------------

/**
 * Everything the builder needs to produce a SystemRecord[]. Passing
 * only the raw row arrays (not the full CsvDataset objects) keeps the
 * structured-clone cost to the worker proportional to just the data
 * and not the dataset metadata.
 */
export interface BuildSystemsInput {
  /** Pre-filtered Part II verified rows from `datasets.abpReport`. */
  part2VerifiedAbpRows: CsvRow[];
  solarApplicationsRows: CsvRow[];
  contractedDateRows: CsvRow[];
  accountSolarGenerationRows: CsvRow[];
  generationEntryRows: CsvRow[];
  transferHistoryRows: CsvRow[];
  deliveryScheduleBaseRows: CsvRow[];
}

/**
 * Build the `SystemRecord[]` array from the raw dataset rows.
 *
 * This function is pure: given the same input it produces the same
 * output, touches no shared state, and has no side effects. It runs
 * isomorphically on the Node server (from
 * `server/services/solar/buildSystemSnapshot.ts`) and in unit tests.
 */
export function buildSystems(input: BuildSystemsInput): SystemRecord[] {
  const {
    part2VerifiedAbpRows,
    solarApplicationsRows,
    contractedDateRows,
    accountSolarGenerationRows,
    generationEntryRows,
    transferHistoryRows,
    deliveryScheduleBaseRows,
  } = input;

  const abpReportRows = part2VerifiedAbpRows;
  const eligibleAbpSystemIds = new Set<string>();
  const eligibleAbpTrackingIds = new Set<string>();
  const eligibleAbpNames = new Set<string>();

  abpReportRows.forEach((row) => {
    const systemId = clean(row.Application_ID) || clean(row.system_id);
    const trackingId =
      clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
    const name = clean(row.Project_Name) || clean(row.system_name);

    if (systemId) eligibleAbpSystemIds.add(systemId);
    if (trackingId) eligibleAbpTrackingIds.add(trackingId);
    if (name) eligibleAbpNames.add(name.toLowerCase());
  });

  if (abpReportRows.length === 0) {
    return [];
  }

  const contractedBySystemId = new Map<string, Date>();
  contractedDateRows.forEach((row) => {
    const systemId = clean(row.id);
    const contractedDate = parseDate(row.contracted);
    if (!systemId || !contractedDate) return;
    contractedBySystemId.set(systemId, contractedDate);
  });

  const builders = new Map<string, SystemBuilder>();
  const keyByTracking = new Map<string, string>();
  const keyBySystemId = new Map<string, string>();

  const ensureBuilder = (
    trackingSystemRefId: string | null,
    systemId: string | null,
  ): SystemBuilder => {
    const existingKeyByTracking = trackingSystemRefId
      ? keyByTracking.get(trackingSystemRefId)
      : undefined;
    if (existingKeyByTracking) return builders.get(existingKeyByTracking)!;

    const existingKeyBySystemId = systemId ? keyBySystemId.get(systemId) : undefined;
    if (existingKeyBySystemId) {
      if (trackingSystemRefId) keyByTracking.set(trackingSystemRefId, existingKeyBySystemId);
      return builders.get(existingKeyBySystemId)!;
    }

    const key =
      trackingSystemRefId || (systemId ? `system-${systemId}` : `unknown-${builders.size + 1}`);
    const created: SystemBuilder = {
      key,
      systemId: systemId || null,
      stateApplicationRefId: null,
      trackingSystemRefId: trackingSystemRefId || null,
      primaryName: null,
      names: new Set<string>(),
      installedKwAc: null,
      installedKwDc: null,
      recPrice: null,
      totalContractAmount: null,
      annualRecs: null,
      recsOnContract: null,
      recsDeliveredQty: null,
      scheduleRequired: null,
      scheduleDelivered: null,
      latestGenerationDate: null,
      latestGenerationReadDate: null,
      latestGenerationReadWh: null,
      lastRecDeliveredGenerationDate: null,
      contractedDate: null,
      contractType: null,
      zillowStatus: null,
      zillowSoldDate: null,
      transferSeen: false,
      statusText: "",
      monitoringType: null,
      monitoringPlatform: null,
      installerName: null,
      part2VerificationDate: null,
    };

    builders.set(key, created);
    if (trackingSystemRefId) keyByTracking.set(trackingSystemRefId, key);
    if (systemId) keyBySystemId.set(systemId, key);
    return created;
  };

  const updateLatestGenerationRead = (
    builder: SystemBuilder,
    candidateDate: Date | null,
    candidateWh: number | null,
  ) => {
    if (!candidateDate || candidateWh === null) return;
    const existingTime =
      builder.latestGenerationReadDate?.getTime() ?? Number.NEGATIVE_INFINITY;
    const candidateTime = candidateDate.getTime();
    if (
      candidateTime > existingTime ||
      (candidateTime === existingTime && builder.latestGenerationReadWh === null)
    ) {
      builder.latestGenerationReadDate = candidateDate;
      builder.latestGenerationReadWh = candidateWh;
    }
  };

  // --- solarApplications → primary seeding of every builder --------
  solarApplicationsRows.forEach((row) => {
    const systemId = clean(row.system_id) || clean(row.Application_ID) || null;
    const stateApplicationRefId = resolveStateApplicationRefId(row);
    const trackingSystemRefId =
      clean(row.tracking_system_ref_id) ||
      clean(row.reporting_entity_ref_id) ||
      clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
      null;
    const builder = ensureBuilder(trackingSystemRefId, systemId);

    if (systemId) builder.systemId = systemId;
    if (stateApplicationRefId) builder.stateApplicationRefId = stateApplicationRefId;
    if (trackingSystemRefId) builder.trackingSystemRefId = trackingSystemRefId;

    const systemName = clean(row.system_name) || clean(row.Project_Name);
    if (systemName) {
      builder.names.add(systemName);
      if (!builder.primaryName) builder.primaryName = systemName;
    }

    const installed = firstNonNull(
      parseNumber(row.installed_system_size_kw_ac),
      parseNumber(row.planned_system_size_kw_ac),
      parseNumber(row["financialDetail.contract_kw_ac"]),
      parseNumber(row.Inverter_Size_kW_AC_Part_2),
      parseNumber(row.Inverter_Size_kW_AC_Part_1),
    );
    if (installed !== null) builder.installedKwAc = installed;

    const installedDc = firstNonNull(
      parseNumber(row.installed_system_size_kw_dc),
      parseNumber(row.planned_system_size_kw_dc),
      parseNumber(row["financialDetail.contract_kw_dc"]),
      parseNumber(row.Inverter_Size_kW_DC_Part_2),
      parseNumber(row.Inverter_Size_kW_DC_Part_1),
    );
    if (installedDc !== null) builder.installedKwDc = installedDc;

    const part2DateRaw =
      clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
    const part2Date = parsePart2VerificationDate(part2DateRaw);
    if (part2Date && !builder.part2VerificationDate) builder.part2VerificationDate = part2Date;

    const recPrice = parseNumber(row.rec_price);
    if (recPrice !== null) builder.recPrice = recPrice;

    const totalContractAmount = parseNumber(row.total_contract_amount);
    if (totalContractAmount !== null) builder.totalContractAmount = totalContractAmount;

    const annualRecs = parseNumber(row.annual_recs);
    if (annualRecs !== null) builder.annualRecs = annualRecs;

    const recsOnContract = parseNumber(row.recs_on_contract);
    if (recsOnContract !== null) builder.recsOnContract = recsOnContract;

    const recsDeliveredQuantity = parseNumber(row.recs_delivered_quantity);
    if (recsDeliveredQuantity !== null) builder.recsDeliveredQty = recsDeliveredQuantity;

    if (builder.recsOnContract === null) {
      builder.recsOnContract = firstNonNull(
        parseNumber(row["_15_Year_REC_Estimate_MWh_PVWatts_Part_2"]),
        parseNumber(row["_15_Year_REC_Estimate_MWh_Custom_Part_2"]),
        parseNumber(row["_15_Year_REC_Estimate_MWh_Calculated_Part_1"]),
        parseNumber(row["_20_Year_REC_Estimate_MWh_PVWatts_Part_2"]),
        parseNumber(row["_20_Year_REC_Estimate_MWh_Custom_Part_2"]),
        parseNumber(row["_20_Year_REC_Estimate_MWh_Calculated_Part_1"]),
      );
    }

    builder.lastRecDeliveredGenerationDate = maxDate(
      builder.lastRecDeliveredGenerationDate,
      parseDate(row.last_rec_delivered_generation_date),
    );

    builder.contractedDate = maxDate(
      builder.contractedDate,
      contractedBySystemId.get(systemId ?? "") ??
        parseDate(row.contract_execution_date) ??
        parseDate(row.contract_start_date) ??
        parseDate(row.Part_1_Submission_Date) ??
        parseDate(row.Part_1_Original_Submission_Date),
    );

    const contractType = clean(row.contract_type);
    if (contractType) {
      builder.contractType = contractType;
      if (isTransferredContractType(contractType)) {
        builder.transferSeen = true;
      }
    }

    const zillowStatus = clean(row["zillowData.status"]) || clean(row.Zillow_Status);
    if (zillowStatus) builder.zillowStatus = zillowStatus;

    builder.monitoringType = normalizeMonitoringMethod(
      row.online_monitoring_access_type,
      row.online_monitoring_entry_method,
      row.online_monitoring_self_report,
    );
    builder.monitoringPlatform = normalizeMonitoringPlatform(
      row.online_monitoring,
      row.online_monitoring_website_api_link,
      row.online_monitoring_notes,
    );

    const installerName = firstNonEmptyString(
      clean(row["partnerCompany.name"]),
      clean(row.installer_company_name),
      clean(row.installer_name),
      clean(row.system_installer),
      clean(row["lastInstallerUpdatedBy.name"]),
    );
    if (installerName) builder.installerName = installerName;

    builder.zillowSoldDate = maxDate(
      builder.zillowSoldDate,
      parseDate(row["zillowData.last_price_action_date"]) ??
        parseDate(row.zillow_last_price_action_date) ??
        parseDate(row["zillowData.updated_at"]),
    );

    const zillowEvent = clean(row["zillowData.last_price_action_event"]).toLowerCase();
    if (zillowEvent.includes("sold")) {
      builder.zillowStatus = builder.zillowStatus || "Sold";
    }

    const statusParts = [
      clean(row.contract_status),
      clean(row.contract_type),
      clean(row.internal_status),
      clean(row["project.status"]),
      clean(row.tracking_system_status),
      clean(row.Part_1_Status),
      clean(row.Part_2_Status),
      clean(row.Batch_Status),
    ].filter(Boolean);
    if (statusParts.length > 0) builder.statusText = statusParts.join(" | ");
  });

  // --- abpReport → fill in Part II verification dates that solar ---
  // applications didn't provide.
  abpReportRows.forEach((row) => {
    const systemId = clean(row.Application_ID) || clean(row.system_id);
    const trackingId =
      clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) || clean(row.tracking_system_ref_id);
    if (!systemId && !trackingId) return;

    const part2DateRaw =
      clean(row.Part_2_App_Verification_Date) || clean(row.part_2_app_verification_date);
    const part2Date = parsePart2VerificationDate(part2DateRaw);
    if (!part2Date) return;

    const key =
      (trackingId ? keyByTracking.get(trackingId) : undefined) ??
      (systemId ? keyBySystemId.get(systemId) : undefined);
    if (!key) return;
    const builder = builders.get(key);
    if (builder && !builder.part2VerificationDate) {
      builder.part2VerificationDate = part2Date;
    }
  });

  // --- deliveryScheduleBase + transferHistory → REC obligation + ---
  // delivered totals. Phase 1a: obligations come exclusively from
  // deliveryScheduleBase, deliveries come exclusively from
  // transferHistory (aggregated lifetime-total per tracking ID).
  const transferLookup = buildTransferDeliveryLookup(transferHistoryRows);

  deliveryScheduleBaseRows.forEach((row) => {
    const trackingSystemRefId = clean(row.tracking_system_ref_id) || null;
    if (!trackingSystemRefId) return;
    const builder = ensureBuilder(trackingSystemRefId, null);

    const systemName = clean(row.system_name);
    if (systemName) {
      builder.names.add(systemName);
      if (!builder.primaryName) builder.primaryName = systemName;
    }

    const required = sumSchedule(row, "_quantity_required");
    if (required !== null) builder.scheduleRequired = required;

    builder.scheduleDelivered = getDeliveredLifetime(transferLookup, trackingSystemRefId);
  });

  // --- accountSolarGeneration → latest month + latest meter read --
  accountSolarGenerationRows.forEach((row) => {
    const trackingSystemRefId = clean(row["GATS Gen ID"]) || null;
    if (!trackingSystemRefId) return;
    const builder = ensureBuilder(trackingSystemRefId, null);

    const systemName = clean(row["Facility Name"]);
    if (systemName) {
      builder.names.add(systemName);
      if (!builder.primaryName) builder.primaryName = systemName;
    }

    const monthOfGeneration = parseDate(row["Month of Generation"]);
    builder.latestGenerationDate = maxDate(builder.latestGenerationDate, monthOfGeneration);

    const latestMeterReadWh = parseEnergyToWh(
      resolveLastMeterReadRawValue(row),
      "Last Meter Read (kWh)",
      "kwh",
    );
    const latestMeterReadDate = parseDate(row["Last Meter Read Date"]) ?? monthOfGeneration;
    updateLatestGenerationRead(builder, latestMeterReadDate, latestMeterReadWh);
  });

  // --- generationEntry → fallback latest month + meter read -------
  generationEntryRows.forEach((row) => {
    const trackingSystemRefId = clean(row["Unit ID"]) || null;
    if (!trackingSystemRefId) return;
    const builder = ensureBuilder(trackingSystemRefId, null);

    const systemName = clean(row["Facility Name"]);
    if (systemName) {
      builder.names.add(systemName);
      if (!builder.primaryName) builder.primaryName = systemName;
    }

    const lastMonthOfGen = parseDate(row["Last Month of Gen"]);
    builder.latestGenerationDate = maxDate(builder.latestGenerationDate, lastMonthOfGen);

    let latestReadWh: number | null = null;
    for (const header of GENERATION_BASELINE_VALUE_HEADERS) {
      latestReadWh = parseEnergyToWh(row[header], header, "kwh");
      if (latestReadWh !== null) break;
    }
    const latestReadDate =
      parseDate(row["Last Meter Read Date"]) ??
      parseDate(row["Effective Date"]) ??
      parseDate(row["Month of Generation"]) ??
      lastMonthOfGen;
    updateLatestGenerationRead(builder, latestReadDate, latestReadWh);
  });

  // --- Project into SystemRecord[] with derived fields ------------
  const threshold = new Date();
  // Reporting is month-based, so use the first day of the month
  // three months back.
  threshold.setHours(0, 0, 0, 0);
  threshold.setDate(1);
  threshold.setMonth(threshold.getMonth() - 3);

  return Array.from(builders.values())
    .map((builder) => {
      const latestReportingDate = maxDate(
        builder.latestGenerationDate,
        builder.lastRecDeliveredGenerationDate,
      );
      const isReporting = latestReportingDate ? latestReportingDate >= threshold : false;

      const sizeBucket: SizeBucket =
        builder.installedKwAc === null
          ? "Unknown"
          : builder.installedKwAc <= 10
            ? "<=10 kW AC"
            : ">10 kW AC";

      const contractedRecs = firstNonNull(
        builder.scheduleRequired,
        builder.recsOnContract,
        builder.annualRecs,
      );
      const deliveredRecs = firstNonNull(builder.scheduleDelivered, builder.recsDeliveredQty);

      const contractedValue =
        builder.recPrice !== null && contractedRecs !== null
          ? builder.recPrice * contractedRecs
          : null;
      const deliveredValue =
        builder.recPrice !== null && deliveredRecs !== null
          ? builder.recPrice * deliveredRecs
          : null;
      const valueGap =
        contractedValue !== null && deliveredValue !== null
          ? contractedValue - deliveredValue
          : null;
      const latestReportingKwh =
        builder.latestGenerationReadWh !== null
          ? Math.round((builder.latestGenerationReadWh / 1_000) * 1_000) / 1_000
          : null;

      const isContractTransferred = isTransferredContractType(builder.contractType);
      const isContractTerminated = isTerminatedContractType(builder.contractType);
      const isTerminated = isContractTerminated;
      const zillowStatusNormalized = clean(builder.zillowStatus).toLowerCase();
      const isZillowSold = zillowStatusNormalized.includes("sold");
      const hasZillowConfirmedOwnershipChange =
        isZillowSold &&
        !!builder.zillowSoldDate &&
        !!builder.contractedDate &&
        builder.zillowSoldDate > builder.contractedDate;
      const hasChangedOwnership =
        isContractTransferred || isContractTerminated || hasZillowConfirmedOwnershipChange;

      let ownershipStatus: OwnershipStatus;
      if (isTerminated) {
        ownershipStatus = isReporting ? "Terminated and Reporting" : "Terminated and Not Reporting";
      } else if (builder.transferSeen || isContractTransferred) {
        ownershipStatus = isReporting
          ? "Transferred and Reporting"
          : "Transferred and Not Reporting";
      } else {
        ownershipStatus = isReporting
          ? "Not Transferred and Reporting"
          : "Not Transferred and Not Reporting";
      }

      let changeOwnershipStatus: ChangeOwnershipStatus | null = null;
      if (hasChangedOwnership) {
        if (isContractTransferred) {
          changeOwnershipStatus = isReporting
            ? "Transferred and Reporting"
            : "Transferred and Not Reporting";
        } else if (isContractTerminated) {
          changeOwnershipStatus = isReporting
            ? "Terminated and Reporting"
            : "Terminated and Not Reporting";
        } else {
          changeOwnershipStatus = isReporting
            ? "Change of Ownership - Not Transferred and Reporting"
            : "Change of Ownership - Not Transferred and Not Reporting";
        }
      }

      const fallbackName = builder.names.values().next().value;
      const systemName =
        builder.primaryName || fallbackName || builder.trackingSystemRefId || builder.key;

      return {
        key: builder.key,
        systemId: builder.systemId,
        stateApplicationRefId: builder.stateApplicationRefId,
        trackingSystemRefId: builder.trackingSystemRefId,
        systemName,
        installedKwAc: builder.installedKwAc,
        installedKwDc: builder.installedKwDc,
        sizeBucket,
        recPrice: builder.recPrice,
        totalContractAmount: builder.totalContractAmount,
        contractedRecs,
        deliveredRecs,
        contractedValue,
        deliveredValue,
        valueGap,
        latestReportingDate,
        latestReportingKwh,
        isReporting,
        isTerminated,
        isTransferred: builder.transferSeen,
        ownershipStatus,
        hasChangedOwnership,
        changeOwnershipStatus,
        contractStatusText: builder.statusText || "N/A",
        contractType: builder.contractType,
        zillowStatus: builder.zillowStatus,
        zillowSoldDate: builder.zillowSoldDate,
        contractedDate: builder.contractedDate,
        monitoringType: builder.monitoringType || "Unknown",
        monitoringPlatform: builder.monitoringPlatform || "Unknown",
        installerName: builder.installerName || "Unknown",
        part2VerificationDate: builder.part2VerificationDate,
      } satisfies SystemRecord;
    })
    .filter((system) => {
      const bySystemId = system.systemId ? eligibleAbpSystemIds.has(system.systemId) : false;
      const byTrackingId = system.trackingSystemRefId
        ? eligibleAbpTrackingIds.has(system.trackingSystemRefId)
        : false;
      const byName = eligibleAbpNames.has(system.systemName.toLowerCase());
      if (system.systemId || system.trackingSystemRefId) {
        return bySystemId || byTrackingId;
      }
      return byName;
    })
    .sort((a, b) => a.systemName.localeCompare(b.systemName));
}
