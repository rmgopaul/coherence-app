/**
 * Test fixtures shared by the Task 5.13 aggregator test suites
 * (`build*.test.ts` next to this file). Used only from tests, but
 * the file deliberately is NOT named `*.test.ts` so vitest doesn't
 * try to run its top level as a test suite.
 */

import type { FoundationCanonicalSystem } from "../../../shared/solarRecFoundation";
import type { TransferDeliveryLookupPayload } from "./buildTransferDeliveryLookup";

/**
 * Builds a `TransferDeliveryLookupPayload` from a flat
 * `{trackingId: {energyYear: kwh}}` shape. Saves every aggregator
 * test from re-typing the surrounding metadata fields.
 */
export function buildTransferDeliveryLookupFixture(
  byTrackingId: Record<string, Record<string, number>> = {}
): TransferDeliveryLookupPayload {
  return {
    byTrackingId,
    inputVersionHash: "test-hash",
    transferHistoryBatchId: "test-batch",
  };
}

/**
 * Builds a `FoundationCanonicalSystem` with sensible defaults.
 * Tests override only the fields they care about. Avoids retyping
 * the 22-field shape in every overlay / aggregator-helper test.
 *
 * Default state is "active, reporting, Part II Verified" so most
 * negative tests just flip a single field.
 */
export function makeFoundationSystem(
  overrides: Partial<FoundationCanonicalSystem> = {}
): FoundationCanonicalSystem {
  return {
    csgId: "CSG-1",
    abpIds: [],
    sizeKwAc: 9.5,
    sizeKwDc: 10,
    contractValueUsd: 1000,
    isTerminated: false,
    isPart2Verified: true,
    isReporting: true,
    anchorMonthIso: "2024-04-01",
    contractType: null,
    ownershipStatus: "active",
    monitoringPlatform: null,
    gatsId: null,
    lastMeterReadDateIso: "2024-04-15",
    lastMeterReadKwh: 1500,
    abpStatus: null,
    part2VerificationDateIso: "2024-06-01",
    contractedDateIso: null,
    energyYear: null,
    integrityWarningCodes: [],
    ...overrides,
  };
}
