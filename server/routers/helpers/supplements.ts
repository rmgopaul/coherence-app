import { nanoid } from "nanoid";
import { toNonEmptyString } from "../../services/core/addressCleaning";
import { IntegrationNotConnectedError } from "../../errors";
import {
  getIntegrationByProvider,
  getSupplementDefinitionById,
  listSupplementDefinitions,
  createSupplementDefinition,
  updateSupplementDefinition,
  addSupplementPriceLog,
} from "../../db";
import { storagePut } from "../../storage";
import {
  checkSupplementPrice,
  extractSupplementsFromBottleImage,
  findExistingSupplementMatch,
  sourceDomainFromUrl,
} from "../../services/integrations/supplements";
import { parseJsonMetadata } from "./utils";

// ---------------------------------------------------------------------------
// Supplement bottle scan helper
// ---------------------------------------------------------------------------

type SupplementBottleScanInput = {
  base64Data: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  timing?: "am" | "pm";
  autoLogPrice?: boolean;
};

type SupplementDefinitionRow = NonNullable<
  Awaited<ReturnType<typeof import("../../db").getSupplementDefinitionById>>
>;
type SupplementExtraction = Awaited<
  ReturnType<
    typeof import("../../services/integrations/supplements").extractSupplementsFromBottleImage
  >
>[number];
type SupplementPriceCheck = Awaited<
  ReturnType<typeof import("../../services/integrations/supplements").checkSupplementPrice>
>;

type SupplementBottleScanResultItem = {
  existed: boolean;
  definitionId: string;
  definition: SupplementDefinitionRow | null;
  extracted: SupplementExtraction;
  priceCheck: SupplementPriceCheck | null;
  priceCheckError: string | null;
  priceLogCreated: boolean;
};

type SupplementBottleScanResult = {
  success: boolean;
  imageUrl: string;
  results: SupplementBottleScanResultItem[];
  // Legacy top-level fields mirror `results[0]` for mobile clients
  // that were built before multi-extraction landed. Remove once every
  // mobile build is on the new shape.
  existed: boolean;
  definitionId: string;
  definition: SupplementDefinitionRow | null;
  extracted: SupplementExtraction;
  priceCheck: SupplementPriceCheck | null;
  priceCheckError: string | null;
  priceLogCreated: boolean;
};

/**
 * Ensure a matched-or-created supplement definition exists for a
 * single extracted record, returning the ID plus the freshly-loaded
 * row. Does NOT run a price check — that happens in a second pass so
 * price checks can be parallelized.
 */
async function resolveSupplementForExtraction(
  userId: number,
  extracted: SupplementExtraction,
  existingDefinitions: SupplementDefinitionRow[],
  fallbackTiming: "am" | "pm" | undefined
): Promise<{
  definitionId: string;
  existed: boolean;
  definitionRow: SupplementDefinitionRow;
}> {
  const matchedDefinition = findExistingSupplementMatch(
    existingDefinitions,
    extracted.name ?? "",
    extracted.brand
  );

  const defaultDose = toNonEmptyString(extracted.dose) ?? "1";
  const defaultDoseUnit = extracted.doseUnit ?? "capsule";
  const defaultTiming = extracted.timing ?? fallbackTiming ?? "am";

  let definitionId: string;
  const existed = Boolean(matchedDefinition);

  if (matchedDefinition) {
    definitionId = matchedDefinition.id;
    await updateSupplementDefinition(userId, matchedDefinition.id, {
      brand:
        toNonEmptyString(matchedDefinition.brand) ??
        toNonEmptyString(extracted.brand) ??
        null,
      dose: toNonEmptyString(matchedDefinition.dose) ?? defaultDose,
      doseUnit: matchedDefinition.doseUnit ?? defaultDoseUnit,
      dosePerUnit:
        toNonEmptyString(matchedDefinition.dosePerUnit) ??
        toNonEmptyString(extracted.dosePerUnit) ??
        null,
      quantityPerBottle:
        matchedDefinition.quantityPerBottle ?? extracted.quantityPerBottle ?? null,
      timing: matchedDefinition.timing ?? defaultTiming,
    });
  } else {
    const nextSortOrder =
      existingDefinitions.length > 0
        ? Math.max(
            ...existingDefinitions.map((definition) => definition.sortOrder ?? 0)
          ) + 1
        : 0;
    definitionId = nanoid();
    await createSupplementDefinition({
      id: definitionId,
      userId,
      name: extracted.name ?? "Unnamed supplement",
      brand: toNonEmptyString(extracted.brand) ?? null,
      dose: defaultDose,
      doseUnit: defaultDoseUnit,
      dosePerUnit: toNonEmptyString(extracted.dosePerUnit) ?? null,
      productUrl: null,
      pricePerBottle: null,
      quantityPerBottle: extracted.quantityPerBottle ?? null,
      timing: defaultTiming,
      isLocked: false,
      isActive: true,
      sortOrder: nextSortOrder,
    });
  }

  const reloaded = await getSupplementDefinitionById(userId, definitionId);
  const definitionRow = reloaded ?? matchedDefinition;
  if (!definitionRow) {
    throw new Error("Supplement was created but could not be reloaded.");
  }
  return { definitionId, existed, definitionRow };
}

export async function performSupplementBottleScanForUser(
  userId: number,
  input: SupplementBottleScanInput
): Promise<SupplementBottleScanResult> {
  const anthropicIntegration = await getIntegrationByProvider(userId, "anthropic");
  const apiKey = toNonEmptyString(anthropicIntegration?.accessToken);
  if (!apiKey) {
    throw new IntegrationNotConnectedError("Claude");
  }

  const anthropicMeta = parseJsonMetadata(anthropicIntegration?.metadata);
  const model =
    typeof anthropicMeta.model === "string" && anthropicMeta.model.trim().length > 0
      ? anthropicMeta.model.trim()
      : "claude-sonnet-4-20250514";

  const extMap: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const ext = extMap[input.contentType] ?? "jpg";
  const imageKey = `supplements/${userId}/bottles/${nanoid()}.${ext}`;
  const imageBuffer = Buffer.from(input.base64Data, "base64");
  const { url: imageUrl } = await storagePut(imageKey, imageBuffer, input.contentType);

  const extractedList = await extractSupplementsFromBottleImage({
    credentials: { apiKey, model },
    base64Image: input.base64Data,
    mimeType: input.contentType,
  });

  if (extractedList.length === 0) {
    throw new Error(
      "Could not read any supplement labels from the photo. Try a clearer image with the front labels visible."
    );
  }

  // Phase 1 — reconcile each extracted item against the DB. Serialized
  // so that if the same image shows two bottles of the same product
  // (unlikely but possible), the second pass sees the first one's
  // insert and merges instead of creating a duplicate.
  const existingDefinitions = (await listSupplementDefinitions(
    userId
  )) as SupplementDefinitionRow[];
  const workingDefinitions: SupplementDefinitionRow[] = [...existingDefinitions];

  const resolved: Array<{
    extracted: SupplementExtraction;
    definitionId: string;
    existed: boolean;
    definitionRow: SupplementDefinitionRow;
  }> = [];

  for (const extracted of extractedList) {
    const outcome = await resolveSupplementForExtraction(
      userId,
      extracted,
      workingDefinitions,
      input.timing
    );
    resolved.push({ extracted, ...outcome });
    // Fold the newly-created/updated row into the working set so the
    // next iteration's match check can see it.
    const idx = workingDefinitions.findIndex(
      (row) => row.id === outcome.definitionRow.id
    );
    if (idx >= 0) {
      workingDefinitions[idx] = outcome.definitionRow;
    } else {
      workingDefinitions.push(outcome.definitionRow);
    }
  }

  // Phase 2 — run price checks in parallel. Claude price lookups hit
  // the web and are the slowest part of the pipeline; serializing them
  // would turn a 10-supplement photo into a minute-long stall.
  const priceCheckOutcomes = await Promise.all(
    resolved.map(async (item) => {
      try {
        const priceCheck = await checkSupplementPrice({
          credentials: { apiKey, model },
          supplementName: item.definitionRow.name,
          brand: toNonEmptyString(item.definitionRow.brand),
          dosePerUnit: toNonEmptyString(item.definitionRow.dosePerUnit),
        });
        return { priceCheck, priceCheckError: null as string | null };
      } catch (error) {
        return {
          priceCheck: null as SupplementPriceCheck | null,
          priceCheckError:
            error instanceof Error ? error.message : "Claude price lookup failed.",
        };
      }
    })
  );

  // Phase 3 — persist price updates + logs. Sequential because each
  // write targets a distinct definition ID and the overhead of a few
  // awaits is nothing next to the Claude round-trips that already ran.
  const results: SupplementBottleScanResultItem[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const item = resolved[i];
    const { priceCheck, priceCheckError } = priceCheckOutcomes[i];
    let priceLogCreated = false;

    if (priceCheck && priceCheck.pricePerBottle !== null) {
      await updateSupplementDefinition(userId, item.definitionId, {
        pricePerBottle: priceCheck.pricePerBottle,
        productUrl: priceCheck.sourceUrl ?? item.definitionRow.productUrl ?? null,
      });

      if (input.autoLogPrice ?? true) {
        await addSupplementPriceLog({
          id: nanoid(),
          userId,
          definitionId: item.definitionId,
          supplementName: item.definitionRow.name,
          brand: item.definitionRow.brand ?? null,
          pricePerBottle: priceCheck.pricePerBottle,
          currency: priceCheck.currency ?? "USD",
          sourceName: priceCheck.sourceName ?? null,
          sourceUrl: priceCheck.sourceUrl ?? null,
          sourceDomain: sourceDomainFromUrl(priceCheck.sourceUrl),
          confidence: priceCheck.confidence,
          imageUrl,
          capturedAt: new Date(),
        });
        priceLogCreated = true;
      }
    }

    const finalDefinition = await getSupplementDefinitionById(
      userId,
      item.definitionId
    );
    results.push({
      existed: item.existed,
      definitionId: item.definitionId,
      definition: finalDefinition,
      extracted: item.extracted,
      priceCheck,
      priceCheckError,
      priceLogCreated,
    });
  }

  const primary = results[0];
  return {
    success: true,
    imageUrl,
    results,
    // Legacy fields — see type definition.
    existed: primary.existed,
    definitionId: primary.definitionId,
    definition: primary.definition,
    extracted: primary.extracted,
    priceCheck: primary.priceCheck,
    priceCheckError: primary.priceCheckError,
    priceLogCreated: primary.priceLogCreated,
  };
}
