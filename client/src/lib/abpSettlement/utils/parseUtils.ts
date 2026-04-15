import { clean } from "@/lib/helpers";

export function parseCsgIds(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,;\n\t]+/g)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

export function parseNumberInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function splitCityStateZip(rawValue: string | null | undefined): {
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const raw = clean(rawValue);
  if (!raw) return { city: null, state: null, zip: null };

  const normalized = raw.replace(/\s+/g, " ");
  const match = normalized.match(/^(.+?)[,\s]+([A-Za-z]{2,})\s+(\d{5}(?:-\d{4})?)$/);
  if (!match) return { city: normalized || null, state: null, zip: null };

  return {
    city: clean(match[1]) || null,
    state: clean(match[2]).toUpperCase() || null,
    zip: clean(match[3]) || null,
  };
}

export function normalizeAlias(value: string): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function getRowValueByAliases(row: Record<string, string>, aliases: string[]): string {
  if (!row || typeof row !== "object") return "";
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const target = normalizeAlias(alias);
    const found = entries.find(([key]) => normalizeAlias(key) === target);
    if (!found) continue;
    const value = clean(found[1]);
    if (value) return value;
  }
  return "";
}
