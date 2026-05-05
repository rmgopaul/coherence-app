import { FETCH_TIMEOUT_MS } from "../../constants";

type CachedEgressIpv4 = {
  ip: string;
  source: string;
  fetchedAt: number;
};

let cachedTeslaPowerhubEgressIpv4: CachedEgressIpv4 | null = null;

const TESLA_POWERHUB_EGRESS_IPV4_CACHE_MS = 5 * 60 * 1000;

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every(part => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function extractIpv4FromText(value: string): string | null {
  const match = value.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (!match) return null;
  return isValidIpv4(match[0]) ? match[0] : null;
}

export async function fetchTeslaPowerhubServerEgressIpv4(options?: {
  forceRefresh?: boolean;
}): Promise<{
  ip: string;
  cidr: string;
  source: string;
  fetchedAt: string;
  fromCache: boolean;
}> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    cachedTeslaPowerhubEgressIpv4 &&
    now - cachedTeslaPowerhubEgressIpv4.fetchedAt <
      TESLA_POWERHUB_EGRESS_IPV4_CACHE_MS
  ) {
    return {
      ip: cachedTeslaPowerhubEgressIpv4.ip,
      cidr: `${cachedTeslaPowerhubEgressIpv4.ip}/32`,
      source: cachedTeslaPowerhubEgressIpv4.source,
      fetchedAt: new Date(
        cachedTeslaPowerhubEgressIpv4.fetchedAt
      ).toISOString(),
      fromCache: true,
    };
  }

  const providers: Array<{
    source: string;
    url: string;
    format: "json" | "text";
    jsonKey?: string;
  }> = [
    {
      source: "api.ipify.org",
      url: "https://api.ipify.org?format=json",
      format: "json",
      jsonKey: "ip",
    },
    {
      source: "ifconfig.me",
      url: "https://ifconfig.me/ip",
      format: "text",
    },
    {
      source: "ipv4.icanhazip.com",
      url: "https://ipv4.icanhazip.com",
      format: "text",
    },
  ];

  let lastError: string | null = null;

  for (const provider of providers) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const response = await fetch(provider.url, {
        method: "GET",
        headers: {
          Accept:
            provider.format === "json" ? "application/json" : "text/plain",
          "User-Agent": "coherence-rmg/tesla-powerhub-egress-check",
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) {
        throw new Error(`${provider.source} responded ${response.status}`);
      }

      let ip: string | null = null;
      if (provider.format === "json") {
        const payload = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        ip = extractIpv4FromText(
          String(payload[provider.jsonKey ?? "ip"] ?? "")
        );
      } else {
        const text = await response.text().catch(() => "");
        ip = extractIpv4FromText(text);
      }

      if (!ip) {
        throw new Error(
          `${provider.source} response did not include a valid IPv4 address`
        );
      }

      cachedTeslaPowerhubEgressIpv4 = {
        ip,
        source: provider.source,
        fetchedAt: Date.now(),
      };

      return {
        ip,
        cidr: `${ip}/32`,
        source: provider.source,
        fetchedAt: new Date(
          cachedTeslaPowerhubEgressIpv4.fetchedAt
        ).toISOString(),
        fromCache: false,
      };
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : "Unknown network error";
    }
  }

  throw new Error(
    `Unable to detect server egress IPv4 address.${
      lastError ? ` Last error: ${lastError}` : ""
    }`
  );
}
