/**
 * Shared types for the Settings page.
 *
 * Extracted from Settings.tsx during refactoring.
 */

import { SUPPLEMENT_UNITS } from "@shared/const";

export type SupplementEditorState = {
  name: string;
  brand: string;
  dose: string;
  doseUnit: (typeof SUPPLEMENT_UNITS)[number];
  dosePerUnit: string;
  timing: "am" | "pm";
  productUrl: string;
  pricePerBottle: string;
  quantityPerBottle: string;
  isLocked: boolean;
};

export type SupplementBottleScanSummary = {
  definitionId: string;
  definitionName: string;
  existed: boolean;
  pricePerBottle: number | null;
  sourceUrl: string | null;
  priceLogCreated: boolean;
  priceCheckError: string | null;
};

export type SupplementBottleScanBatch = {
  imageUrl: string | null;
  items: SupplementBottleScanSummary[];
};
