/**
 * Re-export of the `Standing` derivation helper from
 * `@shared/solarRecStanding` so legacy client imports (which use
 * the `@/solar-rec-dashboard/lib/deriveStanding` path) continue to
 * resolve. Hoisted in PR B2 — same body, just one source of truth
 * shared between the client worker and the server aggregators.
 *
 * Prefer importing directly from `@shared/solarRecStanding` in new
 * code.
 */
export { deriveStanding } from "@shared/solarRecStanding";
