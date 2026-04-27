/**
 * Test fixtures shared by the Task 5.13 aggregator test suites
 * (`build*.test.ts` next to this file). Used only from tests, but
 * the file deliberately is NOT named `*.test.ts` so vitest doesn't
 * try to run its top level as a test suite.
 */

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
