/**
 * Price-watcher: re-checks prices for every active supplement definition,
 * writes a new `supplementPriceLogs` row when a fresh price is found.
 *
 * Reuses the existing `checkSupplementPrice` integration so we don't
 * duplicate scraping logic. That function needs Anthropic credentials
 * resolved from the user's integration row.
 *
 * Designed to be called:
 *  - manually via the `supplements.runPriceWatchNow` tRPC mutation
 *  - on a schedule via `startSupplementPriceWatchScheduler`
 *
 * Concurrency-safe per-user via an in-memory `activeUsers` set (mirrors
 * the contractScanJobRunner pattern). No persistent job rows — a missed
 * run is just a gap in the price log.
 */

import { nanoid } from "nanoid";
import {
  addSupplementPriceLog,
  getIntegrationByProvider,
  listSupplementDefinitions,
} from "../../db";
import {
  checkSupplementPrice,
  sourceDomainFromUrl,
} from "../integrations/supplements";
import {
  IntegrationNotConnectedError,
  parseJsonMetadata,
} from "../../routers/helpers";
import { toNonEmptyString } from "../core/addressCleaning";

const activeUsers = new Set<number>();

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

export interface PriceWatchResult {
  userId: number;
  attempted: number;
  updated: number;
  skipped: number;
  errors: number;
  startedAt: string;
  completedAt: string;
  alreadyRunning?: boolean;
  missingCredentials?: boolean;
}

export async function runPriceWatchForUser(
  userId: number
): Promise<PriceWatchResult> {
  const startedAt = new Date();

  if (activeUsers.has(userId)) {
    return {
      userId,
      attempted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      startedAt: startedAt.toISOString(),
      completedAt: startedAt.toISOString(),
      alreadyRunning: true,
    };
  }
  activeUsers.add(userId);

  let attempted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const anthropicIntegration = await getIntegrationByProvider(userId, "anthropic");
    const apiKey = toNonEmptyString(anthropicIntegration?.accessToken);
    if (!apiKey) {
      return {
        userId,
        attempted: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        missingCredentials: true,
      };
    }
    const anthropicMeta = parseJsonMetadata(anthropicIntegration?.metadata);
    const model =
      typeof anthropicMeta.model === "string" && anthropicMeta.model.trim().length > 0
        ? anthropicMeta.model.trim()
        : DEFAULT_MODEL;
    const credentials = { apiKey, model };

    const definitions = await listSupplementDefinitions(userId);
    for (const def of definitions) {
      if (!def.isActive) {
        skipped += 1;
        continue;
      }
      attempted += 1;
      try {
        const priceCheck = await checkSupplementPrice({
          credentials,
          supplementName: def.name,
          brand: def.brand ?? null,
          dosePerUnit: def.dosePerUnit ?? null,
        });
        if (
          priceCheck.pricePerBottle !== null &&
          Number.isFinite(priceCheck.pricePerBottle)
        ) {
          await addSupplementPriceLog({
            id: nanoid(),
            userId,
            definitionId: def.id,
            supplementName: def.name,
            brand: def.brand ?? null,
            pricePerBottle: priceCheck.pricePerBottle,
            currency: priceCheck.currency ?? "USD",
            sourceName: priceCheck.sourceName ?? null,
            sourceUrl: priceCheck.sourceUrl ?? null,
            sourceDomain: sourceDomainFromUrl(priceCheck.sourceUrl),
            confidence: priceCheck.confidence ?? null,
            imageUrl: null,
            capturedAt: new Date(),
          });
          updated += 1;
        } else {
          skipped += 1;
        }
      } catch (err) {
        errors += 1;
        console.error(
          `[PriceWatcher] user=${userId} def=${def.id} error:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  } catch (err) {
    errors += 1;
    if (err instanceof IntegrationNotConnectedError) {
      return {
        userId,
        attempted,
        updated,
        skipped,
        errors,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        missingCredentials: true,
      };
    }
    console.error(
      `[PriceWatcher] user=${userId} top-level error:`,
      err instanceof Error ? err.message : err
    );
  } finally {
    activeUsers.delete(userId);
  }

  return {
    userId,
    attempted,
    updated,
    skipped,
    errors,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
  };
}
