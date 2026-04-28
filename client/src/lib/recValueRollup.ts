/**
 * Task 9.5 PR-4 (2026-04-28) — pure REC value rollup for the system
 * detail page.
 *
 * Composes a single financial picture from the four sections the
 * detail page already loads (registry, contract scan, Schedule B,
 * invoice status). No new DB I/O — this is a presentation-layer
 * compute that the new RecValueSection consumes.
 *
 * Source priority for each field is documented inline. The general
 * rule: **prefer the most authoritative source for each value**,
 * and surface which source we picked so the UI can render
 * provenance ("from ICC report" / "from contract scan"). When no
 * authoritative source is available, compute from the next-best
 * inputs (e.g. derive total value from qty × price). When nothing
 * is available, return `null` — the section UI shows "—".
 *
 * `registry.annualRecs` is intentionally NOT used as a fallback
 * for `contractedRecs` because it represents annual production
 * estimate, not lifetime contracted quantity. Mixing them would
 * produce a 20× inflated outstanding value on a 20-year contract.
 */

/** Provenance label so the UI can show "from ICC report" etc. */
export type RecValueSource =
  | "icc-report"
  | "schedule-b"
  | "contract-scan"
  | "registry"
  | "computed"
  | null;

/** A scalar value paired with its source. `value: null` means
 *  none of the inputs had a usable value for this field. */
export interface SourcedValue {
  value: number | null;
  source: RecValueSource;
}

export interface DeliveryYear {
  year: number;
  quantity: number | null;
}

export interface RecValueRollup {
  /** Lifetime contracted REC quantity. */
  contractedRecs: SourcedValue;
  /** Per-REC contract price ($). */
  contractedRecPrice: SourcedValue;
  /** Lifetime contracted contract value ($) — qty × price OR an
   *  explicit field. */
  contractedTotalValue: SourcedValue;
  /** Total RECs invoiced to date — sum across all utility invoices.
   *  Null when no utility invoice rows exist. */
  paidRecs: number | null;
  /** Total $ invoiced to date. */
  paidTotalValue: number | null;
  /** Contracted total minus paid total. Null when either is null
   *  OR when paid > contracted (which is data-quality suspicious;
   *  we surface the components instead of pretending we know the
   *  answer). */
  outstandingValue: number | null;
  /** % of contracted RECs that have been invoiced. Null when
   *  contractedRecs <= 0 or paidRecs is null. */
  pctDelivered: number | null;
  /** Per-year delivery schedule from Schedule B. Empty when
   *  deliveryYearsJson is missing or unparseable. */
  deliveryYears: DeliveryYear[];
}

interface RegistryInput {
  totalContractAmount: number | null;
  recPrice: number | null;
  /** Annual production estimate — NOT used as a lifetime fallback;
   *  documented here for callers who want to surface it separately. */
  annualRecs: number | null;
}

interface ContractScanInput {
  recQuantity: number | null;
  recPrice: number | null;
}

interface ScheduleBInput {
  maxRecQuantity: number | null;
  contractPrice: number | null;
  /** Raw JSON text from `scheduleBImportResults.deliveryYearsJson`. */
  deliveryYearsJson: string | null;
}

interface IccReportInput {
  contractedRecs: number | null;
  recPrice: number | null;
  grossContractValue: number | null;
}

interface UtilityInvoicesInput {
  totalRecs: number | null;
  totalInvoiceAmount: number | null;
}

export interface RecValueRollupInput {
  registry: RegistryInput | null;
  contractScan: ContractScanInput | null;
  scheduleB: ScheduleBInput | null;
  iccReport: IccReportInput | null;
  utilityInvoices: UtilityInvoicesInput | null;
}

const EMPTY_ROLLUP: RecValueRollup = {
  contractedRecs: { value: null, source: null },
  contractedRecPrice: { value: null, source: null },
  contractedTotalValue: { value: null, source: null },
  paidRecs: null,
  paidTotalValue: null,
  outstandingValue: null,
  pctDelivered: null,
  deliveryYears: [],
};

/** Pick the first non-null candidate; preserves the source label
 *  attached to each candidate. Used by every contracted-* field. */
function pickFirstNonNull(
  candidates: ReadonlyArray<{
    value: number | null | undefined;
    source: RecValueSource;
  }>
): SourcedValue {
  for (const c of candidates) {
    if (c.value !== null && c.value !== undefined && Number.isFinite(c.value)) {
      return { value: c.value, source: c.source };
    }
  }
  return { value: null, source: null };
}

function parseDeliveryYears(rawJson: string | null): DeliveryYear[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): DeliveryYear | null => {
        if (typeof entry !== "object" || entry === null) return null;
        const r = entry as Record<string, unknown>;
        if (typeof r.year !== "number" || !Number.isFinite(r.year)) return null;
        return {
          year: r.year,
          quantity:
            typeof r.quantity === "number" && Number.isFinite(r.quantity)
              ? r.quantity
              : null,
        };
      })
      .filter((v): v is DeliveryYear => v !== null)
      .sort((a, b) => a.year - b.year);
  } catch {
    return [];
  }
}

/** Compose the rec-value rollup from all four upstream sections.
 *  Pure. Exposed for testability + reuse if the same data shape
 *  ever needs to be rendered elsewhere. */
export function buildRecValueRollup(
  input: RecValueRollupInput
): RecValueRollup {
  const allEmpty =
    !input.registry &&
    !input.contractScan &&
    !input.scheduleB &&
    !input.iccReport &&
    !input.utilityInvoices;
  if (allEmpty) return EMPTY_ROLLUP;

  // Contracted REC quantity — ICC report is canonical (the
  // contractually-owed quantity); Schedule B's maxRecQuantity is
  // the second-best (extracted from the actual contract PDF);
  // contract scan recQuantity is third (also from the PDF but a
  // different parser path). registry.annualRecs is intentionally
  // skipped — see file header.
  const contractedRecs = pickFirstNonNull([
    { value: input.iccReport?.contractedRecs, source: "icc-report" },
    { value: input.scheduleB?.maxRecQuantity, source: "schedule-b" },
    { value: input.contractScan?.recQuantity, source: "contract-scan" },
  ]);

  // Contracted REC price — prefer the ICC report; fall back through
  // contract scan, registry, then Schedule B's contractPrice.
  const contractedRecPrice = pickFirstNonNull([
    { value: input.iccReport?.recPrice, source: "icc-report" },
    { value: input.contractScan?.recPrice, source: "contract-scan" },
    { value: input.registry?.recPrice, source: "registry" },
    { value: input.scheduleB?.contractPrice, source: "schedule-b" },
  ]);

  // Contracted total value — prefer the ICC report's GCV; fall
  // back to registry.totalContractAmount; otherwise compute from
  // qty × price (when both available).
  let contractedTotalValue: SourcedValue = pickFirstNonNull([
    { value: input.iccReport?.grossContractValue, source: "icc-report" },
    { value: input.registry?.totalContractAmount, source: "registry" },
  ]);
  if (
    contractedTotalValue.value === null &&
    contractedRecs.value !== null &&
    contractedRecPrice.value !== null
  ) {
    contractedTotalValue = {
      value: contractedRecs.value * contractedRecPrice.value,
      source: "computed",
    };
  }

  // Paid amounts: directly from utility invoices.
  const paidRecs = input.utilityInvoices?.totalRecs ?? null;
  const paidTotalValue = input.utilityInvoices?.totalInvoiceAmount ?? null;

  // Outstanding value: only when we have both numbers AND paid <=
  // contracted (otherwise it's a data-quality issue, not negative
  // outstanding).
  let outstandingValue: number | null = null;
  if (
    contractedTotalValue.value !== null &&
    paidTotalValue !== null &&
    paidTotalValue <= contractedTotalValue.value
  ) {
    outstandingValue = contractedTotalValue.value - paidTotalValue;
  }

  // % delivered: paidRecs / contractedRecs, capped at sensible
  // bounds. Returns null when either is null OR contractedRecs is 0.
  let pctDelivered: number | null = null;
  if (
    contractedRecs.value !== null &&
    contractedRecs.value > 0 &&
    paidRecs !== null
  ) {
    pctDelivered = (paidRecs / contractedRecs.value) * 100;
  }

  return {
    contractedRecs,
    contractedRecPrice,
    contractedTotalValue,
    paidRecs,
    paidTotalValue,
    outstandingValue,
    pctDelivered,
    deliveryYears: parseDeliveryYears(input.scheduleB?.deliveryYearsJson ?? null),
  };
}

/** Human-readable label for a source code. Exposed so the UI
 *  doesn't need to maintain a parallel switch. */
export function recValueSourceLabel(source: RecValueSource): string {
  switch (source) {
    case "icc-report":
      return "ICC Report";
    case "schedule-b":
      return "Schedule B";
    case "contract-scan":
      return "Contract scan";
    case "registry":
      return "Solar Apps";
    case "computed":
      return "Computed";
    default:
      return "—";
  }
}
