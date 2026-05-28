/**
 * IL ABP (Adjustable Block Program) contract-type + Part 2
 * verification helpers. Encodes the normalized contract-type
 * strings and the Part-2 row predicate.
 */

import { clean } from "@/lib/helpers";
import type { CsvRow } from "@/solar-rec-dashboard/state/types";
import { parsePart2VerificationDate } from "./parsing";

// PR B2: the four contract-type predicates moved to
// `@shared/solarRecStanding` so server aggregators + the client
// worker share one normalization rule. Re-exported below so legacy
// imports (`@/solar-rec-dashboard/lib/helpers` / `.../helpers/abp`)
// keep resolving. Prefer importing from `@shared/solarRecStanding`
// in new code.
export {
  isDefaultedContractType,
  isTerminatedContractType,
  isTransferredContractType,
  normalizeContractType,
} from "@shared/solarRecStanding";

export function isPart2VerifiedAbpRow(row: CsvRow): boolean {
  const part2VerifiedDateRaw =
    clean(row.Part_2_App_Verification_Date) ||
    clean(row.part_2_app_verification_date);
  return parsePart2VerificationDate(part2VerifiedDateRaw) !== null;
}

export function isValidCompliantSourceText(value: string): boolean {
  if (!value || value.length > 100) return false;
  if (!/[A-Za-z0-9]/.test(value)) return false;
  return /^[A-Za-z0-9 _,-]+$/.test(value);
}
