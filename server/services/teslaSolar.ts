export const TESLA_SOLAR_DEFAULT_BASE_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";

export type TeslaSolarApiContext = {
  accessToken: string;
  baseUrl?: string | null;
};

export type TeslaProduct = {
  id: string;
  resourceType: string | null;
  siteId: string | null;
  siteName: string | null;
  vin: string | null;
};

export type TeslaEnergySite = {
  siteId: string;
  siteName: string;
  resourceType: string | null;
};

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toIdString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return TESLA_SOLAR_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function parseIsoDate(input: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(input);
}

function buildTeslaApiUrl(
  path: string,
  context: TeslaSolarApiContext,
  query?: Record<string, string | number | null | undefined>
): string {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  return url.toString();
}

async function getTeslaJson(
  path: string,
  context: TeslaSolarApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const url = buildTeslaApiUrl(path, context, query);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${context.accessToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Tesla request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  return response.json();
}

function extractProducts(payload: unknown): TeslaProduct[] {
  const root = asRecord(payload);
  const responseRows = Array.isArray(root.response)
    ? root.response
    : Array.isArray(payload)
      ? payload
      : [];

  const products: TeslaProduct[] = [];
  for (const row of responseRows) {
    const value = asRecord(row);
    products.push({
      id: toIdString(value.id) ?? toIdString(value.energy_site_id) ?? "unknown",
      resourceType: toNullableString(value.resource_type),
      siteId: toIdString(value.energy_site_id),
      siteName: toNullableString(value.site_name),
      vin: toNullableString(value.vin),
    });
  }

  return products;
}

function toEnergySites(products: TeslaProduct[]): TeslaEnergySite[] {
  const map = new Map<string, TeslaEnergySite>();
  for (const product of products) {
    if (!product.siteId) continue;
    if (map.has(product.siteId)) continue;
    map.set(product.siteId, {
      siteId: product.siteId,
      siteName: product.siteName ?? `Energy Site ${product.siteId}`,
      resourceType: product.resourceType,
    });
  }
  return Array.from(map.values()).sort((a, b) => a.siteName.localeCompare(b.siteName));
}

export async function listTeslaProducts(
  context: TeslaSolarApiContext
): Promise<{ products: TeslaProduct[]; energySites: TeslaEnergySite[]; raw: unknown }> {
  const raw = await getTeslaJson("/api/1/products", context);
  const products = extractProducts(raw);
  return {
    products,
    energySites: toEnergySites(products),
    raw,
  };
}

export async function getTeslaEnergySiteLiveStatus(
  context: TeslaSolarApiContext,
  siteId: string
): Promise<unknown> {
  return getTeslaJson(`/api/1/energy_sites/${encodeURIComponent(siteId)}/live_status`, context);
}

export async function getTeslaEnergySiteInfo(
  context: TeslaSolarApiContext,
  siteId: string
): Promise<unknown> {
  return getTeslaJson(`/api/1/energy_sites/${encodeURIComponent(siteId)}/site_info`, context);
}

export async function getTeslaEnergySiteHistory(
  context: TeslaSolarApiContext,
  siteId: string,
  options?: {
    kind?: string | null;
    period?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  }
): Promise<unknown> {
  const startDate = options?.startDate?.trim();
  const endDate = options?.endDate?.trim();
  if (startDate && !parseIsoDate(startDate)) {
    throw new Error("Start date must be YYYY-MM-DD.");
  }
  if (endDate && !parseIsoDate(endDate)) {
    throw new Error("End date must be YYYY-MM-DD.");
  }

  return getTeslaJson(`/api/1/energy_sites/${encodeURIComponent(siteId)}/history`, context, {
    kind: options?.kind ?? "energy",
    period: options?.period ?? "day",
    start_date: startDate ?? undefined,
    end_date: endDate ?? undefined,
  });
}
