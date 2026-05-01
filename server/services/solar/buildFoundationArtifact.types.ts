/**
 * Pure-input type contract for the foundation builder.
 *
 * Split out of `buildFoundationArtifact.ts` (the file grew past
 * the CLAUDE.md ~1000-LOC threshold after Phase 2.7 + the
 * trackingRef collision fix). Kept as a sibling module so
 * tests + the builder + downstream callers share one source of
 * truth without circular concerns.
 *
 * Output types live in `shared/solarRecFoundation.ts` (the
 * artifact contract is symmetric across server + client).
 */

import type { DatasetKey } from "../../../shared/datasetUpload.helpers";

/**
 * Pre-resolved Solar Applications row used by the builder. The
 * caller (`buildFoundationArtifact`) extracts these fields from
 * the typed `srDsSolarApplications` columns + the JSON `rawRow`
 * for status fields. Tests construct fixtures directly.
 */
export type FoundationSolarApplicationInput = {
  csgId: string | null;
  applicationId: string | null;
  systemName: string | null;
  installedKwAc: number | null;
  installedKwDc: number | null;
  totalContractAmount: number | null;
  contractType: string | null;
  /**
   * Concatenated status text from the row's status fields (see
   * `client/src/solar-rec-dashboard/lib/buildSystems.ts:434-443` for
   * the source-field list). Used to detect rejected/cancelled/
   * withdrawn applications.
   */
  statusText: string | null;
  /**
   * Tracking-system ref ID — the linkage column that joins solar
   * applications to generation/transfer rows. Same value appears
   * as `gatsGenId` on `srDsAccountSolarGeneration` and `unitId` on
   * `srDsGenerationEntry` + `srDsTransferHistory`.
   */
  trackingSystemRefId: string | null;
  /** Zillow sold date (`Zillow_Sold_Date`) from the row's `rawRow` JSON. */
  zillowSoldDate: string | null;
  /** Zillow status text (`Zillow_Status` or nested `zillowData.status`). */
  zillowStatus: string | null;
};

export type FoundationAbpReportInput = {
  applicationId: string | null;
  part2AppVerificationDate: string | null;
  projectName: string | null;
};

export type FoundationAbpCsgMappingInput = {
  csgId: string | null;
  /** From the mapping table's typed `systemId` column = ABP Application_ID. */
  abpId: string | null;
};

/**
 * Account Solar Generation row. `gatsGenId` is the join column to
 * `solarApplications.trackingSystemRefId`. Both date columns are
 * canonical ISO strings (`yyyy-mm-dd`) on production data.
 */
export type FoundationAccountSolarGenerationInput = {
  gatsGenId: string | null;
  monthOfGeneration: string | null;
  lastMeterReadDate: string | null;
  lastMeterReadKwh: number | null;
};

/**
 * Generation Entry row. `unitId` is the join column to
 * `solarApplications.trackingSystemRefId`. The kWh value isn't a
 * typed column (legacy parses it from `GENERATION_BASELINE_VALUE_HEADERS`
 * in `rawRow`), so the DB-bound builder pre-extracts it before
 * passing to the pure builder.
 */
export type FoundationGenerationEntryInput = {
  unitId: string | null;
  lastMonthOfGen: string | null;
  effectiveDate: string | null;
  /** kWh value extracted from the row's rawRow (any of the 7 GENERATION_BASELINE_VALUE_HEADERS). */
  generationKwh: number | null;
};

export type FoundationTransferHistoryInput = {
  unitId: string | null;
  transferCompletionDate: string | null;
};

export type FoundationContractedDateInput = {
  csgId: string | null;
  contractedDate: string | null;
};

export type FoundationBuilderInputs = {
  scopeId: string;
  inputVersions: Record<DatasetKey, { batchId: string | null; rowCount: number }>;
  solarApplications: FoundationSolarApplicationInput[];
  abpReport: FoundationAbpReportInput[];
  abpCsgSystemMapping: FoundationAbpCsgMappingInput[];
  accountSolarGeneration: FoundationAccountSolarGenerationInput[];
  generationEntry: FoundationGenerationEntryInput[];
  transferHistory: FoundationTransferHistoryInput[];
  contractedDate: FoundationContractedDateInput[];
  /**
   * `populatedDatasets` is a function of `inputVersions`: a key is
   * populated when its `rowCount > 0`. The builder derives this; the
   * caller doesn't pass it separately.
   */
};
