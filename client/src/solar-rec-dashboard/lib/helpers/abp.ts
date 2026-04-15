/**
 * IL ABP (Adjustable Block Program) contract-type + Part 2
 * verification helpers. Encodes the normalized contract-type
 * strings and the Part-2 row predicate.
 */

import { clean } from "@/lib/helpers";
import type { CsvRow } from "@/solar-rec-dashboard/state/types";
import {
  IL_ABP_TERMINATED_CONTRACT_TYPE,
  IL_ABP_TRANSFERRED_CONTRACT_TYPE,
} from "@/solar-rec-dashboard/lib/constants";
import { parsePart2VerificationDate } from "./parsing";

export function isPart2VerifiedAbpRow(row: CsvRow): boolean {
  const part2VerifiedDateRaw =
    clean(row.Part_2_App_Verification_Date) ||
    clean(row.part_2_app_verification_date);
  return parsePart2VerificationDate(part2VerifiedDateRaw) !== null;
}

export function normalizeContractType(
  value: string | null | undefined,
): string {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

export function isTransferredContractType(
  value: string | null | undefined,
): boolean {
  return normalizeContractType(value) === IL_ABP_TRANSFERRED_CONTRACT_TYPE;
}

export function isTerminatedContractType(
  value: string | null | undefined,
): boolean {
  return normalizeContractType(value) === IL_ABP_TERMINATED_CONTRACT_TYPE;
}

export function isValidCompliantSourceText(value: string): boolean {
  if (!value || value.length > 100) return false;
  if (!/[A-Za-z0-9]/.test(value)) return false;
  return /^[A-Za-z0-9 _,-]+$/.test(value);
}
