import { clean } from "@/lib/helpers";

export function parseCurrencyToNumber(value: string | null | undefined): number {
  if (!value) return 0;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

export function toYammCsv(
  rows: Array<Record<string, string>>,
  headers: ReadonlyArray<string>
): string {
  const escape = (value: string): string => {
    if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
    return value;
  };
  const lines = [
    headers.map((header) => escape(header)).join(","),
    ...rows.map((row) =>
      headers.map((header) => escape(clean(row[header]))).join(",")
    ),
  ];
  return lines.join("\n");
}

export function toNumericCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const normalized = clean(value);
  return normalized;
}

export function parseNumericCell(value: unknown): number | null {
  const normalized = clean(value).replace(/,/g, "").replace(/[$%]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseBooleanText(value: unknown): boolean | null {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "1" ||
    normalized.includes("reimburs") ||
    normalized.includes("returned")
  ) {
    return true;
  }
  if (normalized === "false" || normalized === "no" || normalized === "n" || normalized === "0") {
    return false;
  }
  return null;
}
