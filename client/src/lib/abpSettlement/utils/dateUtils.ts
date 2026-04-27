export function buildUpcomingTuesdayLabel(date = new Date()): string {
  const local = new Date(date);
  const day = local.getDay();
  const daysUntilTuesday = (2 - day + 7) % 7 || 7;
  local.setDate(local.getDate() + daysUntilTuesday);
  return local.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function buildMonthKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * True only for fully-typed `YYYY-MM` strings (e.g. "2026-04"). False
 * for incomplete or invalid input ("2026", "2026-", "2026-0",
 * "2026-13", garbage). Used by `AbpInvoiceSettlement.tsx` to suppress
 * localStorage writes during mid-typing input keystrokes — without
 * this guard, persisting per-keystroke writes manual-override state
 * to orphan keys (`abp-overrides:2026-0` etc.) and contaminates the
 * destination month's overrides during a month change. See Task 2.3.
 */
export function isCompleteMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value.trim());
}
