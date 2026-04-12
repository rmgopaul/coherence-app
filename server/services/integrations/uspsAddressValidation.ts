/**
 * USPS Address API v3 integration.
 *
 * Validates US mailing addresses using the official USPS REST API.
 * Uses OAuth 2.0 client credentials for authentication with automatic
 * token caching and refresh.
 *
 * Free tier: no per-request cost for address validation.
 *
 * @see https://developers.usps.com/addressesv3
 * @see https://github.com/USPS/api-examples
 */

import type { AddressVerificationInput, AddressVerificationResult } from "./googleAddressValidation";

// Re-export the shared types so callers can import from either module
export type { AddressVerificationInput, AddressVerificationResult };

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const USPS_TOKEN_URL = "https://apis.usps.com/oauth2/v3/token";
const USPS_ADDRESS_URL = "https://apis.usps.com/addresses/v3/address";

/** Rate-limit delay between API calls (100ms = 10 requests/sec). */
const RATE_LIMIT_DELAY_MS = 100;

/* ------------------------------------------------------------------ */
/*  OAuth token cache                                                   */
/* ------------------------------------------------------------------ */

type CachedToken = {
  accessToken: string;
  expiresAt: number; // epoch ms
};

const tokenCache = new Map<string, CachedToken>();

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cacheKey = `${clientId}:${clientSecret}`;
  const cached = tokenCache.get(cacheKey);

  // Return cached token if still valid (with 60s safety margin)
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const response = await fetch(USPS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `USPS OAuth failed (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
  };

  const token: CachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  tokenCache.set(cacheKey, token);

  return token.accessToken;
}

/* ------------------------------------------------------------------ */
/*  USPS API response types                                             */
/* ------------------------------------------------------------------ */

type UspsAddressResponse = {
  firm?: string | null;
  address?: {
    streetAddress?: string;
    secondaryAddress?: string | null;
    city?: string;
    state?: string;
    ZIPCode?: string;
    ZIPPlus4?: string;
  };
  additionalInfo?: {
    deliveryPoint?: string;
    carrierRoute?: string;
    DPVConfirmation?: string;
    DPVCMRA?: string;
    business?: string;
    centralDeliveryPoint?: string;
    vacant?: string;
  };
  corrections?: Array<{
    code?: string;
    text?: string;
  }>;
  matches?: Array<{
    code?: string;
    text?: string;
  }>;
  error?: {
    source?: string;
    message?: string;
    code?: string;
  };
};

/* ------------------------------------------------------------------ */
/*  Single address validation                                           */
/* ------------------------------------------------------------------ */

async function validateSingleAddress(
  accessToken: string,
  input: AddressVerificationInput,
): Promise<AddressVerificationResult> {
  try {
    const params = new URLSearchParams();
    if (input.address1) params.set("streetAddress", input.address1);
    if (input.address2) params.set("secondaryAddress", input.address2);
    if (input.city) params.set("city", input.city);
    if (input.state) params.set("state", input.state);
    if (input.zip) params.set("ZIPCode", input.zip);

    const url = `${USPS_ADDRESS_URL}?${params.toString()}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      let message = `USPS API error (${response.status})`;
      try {
        const parsed = JSON.parse(errorText);
        message = parsed?.error?.message || parsed?.message || message;
      } catch { /* use default */ }
      return makeErrorResult(input.key, message);
    }

    const data = (await response.json()) as UspsAddressResponse;

    // Check for API-level error in the response body
    if (data.error?.message) {
      return makeErrorResult(input.key, data.error.message);
    }

    return parseUspsResponse(input.key, input, data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return makeErrorResult(input.key, msg);
  }
}

/* ------------------------------------------------------------------ */
/*  Response parsing                                                    */
/* ------------------------------------------------------------------ */

function parseUspsResponse(
  key: string,
  input: AddressVerificationInput,
  data: UspsAddressResponse,
): AddressVerificationResult {
  const addr = data.address;
  const info = data.additionalInfo;
  const issues: string[] = [];

  // DPV confirmation: Y=confirmed, S=confirmed secondary, D=missing secondary, N=not confirmed
  const dpv = info?.DPVConfirmation ?? "";
  const deliverable = dpv === "Y" || dpv === "S";

  if (dpv === "D") {
    issues.push("Primary address confirmed but secondary (apt/suite) missing or invalid");
  } else if (dpv === "N") {
    issues.push("Address not deliverable (USPS DPV: not confirmed)");
  } else if (!dpv) {
    issues.push("No DPV confirmation available");
  }

  // Check if USPS flagged it as vacant
  if (info?.vacant === "Y") {
    issues.push("Address flagged as vacant by USPS");
  }

  // Check for corrections
  const corrections = data.corrections ?? [];
  const hasCorrections = corrections.length > 0;
  for (const correction of corrections) {
    if (correction.text) {
      issues.push(`Correction: ${correction.text}`);
    }
  }

  // Check match quality
  const matches = data.matches ?? [];
  for (const match of matches) {
    // Codes like "31" = exact match, other codes indicate fuzzy matches
    if (match.code && match.code !== "31" && match.text) {
      issues.push(`Match: ${match.text}`);
    }
  }

  // Build corrected address from USPS response
  const corrected = {
    address1: addr?.streetAddress ?? "",
    address2: addr?.secondaryAddress ?? "",
    city: addr?.city ?? "",
    state: addr?.state ?? "",
    zip: addr?.ZIPCode ?? "",
    zipPlus4: addr?.ZIPPlus4 ? `${addr.ZIPCode}-${addr.ZIPPlus4}` : "",
  };

  // Determine overall verdict
  const verdict: "CONFIRMED" | "UNCONFIRMED" = deliverable ? "CONFIRMED" : "UNCONFIRMED";

  return {
    key,
    verdict,
    validationGranularity: dpv ? `DPV_${dpv}` : "NONE",
    deliverable,
    hasCorrections,
    corrected,
    usps: {
      deliveryPointCode: info?.deliveryPoint ?? "",
      carrierRoute: info?.carrierRoute ?? "",
      dpvConfirmation: dpv,
      dpvFootnote: corrections.map((c) => c.code ?? "").filter(Boolean).join(","),
    },
    issues,
    error: null,
  };
}

function makeErrorResult(key: string, message: string): AddressVerificationResult {
  return {
    key,
    verdict: "ERROR",
    validationGranularity: "",
    deliverable: false,
    hasCorrections: false,
    corrected: { address1: "", address2: "", city: "", state: "", zip: "", zipPlus4: "" },
    usps: null,
    issues: [message],
    error: message,
  };
}

/* ------------------------------------------------------------------ */
/*  Batch verification                                                  */
/* ------------------------------------------------------------------ */

/**
 * Verify a batch of addresses using the USPS Address API v3.
 * Obtains an OAuth token, then processes addresses sequentially with rate limiting.
 */
export async function verifyAddressBatch(
  clientId: string,
  clientSecret: string,
  addresses: AddressVerificationInput[],
  onProgress?: (completed: number, total: number) => void,
): Promise<AddressVerificationResult[]> {
  // Get (or refresh) the OAuth access token
  const accessToken = await getAccessToken(clientId, clientSecret);

  const results: AddressVerificationResult[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const result = await validateSingleAddress(accessToken, addresses[i]);
    results.push(result);
    onProgress?.(i + 1, addresses.length);

    // Rate limit: wait between requests (skip delay on last item)
    if (i < addresses.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
    }
  }

  return results;
}
