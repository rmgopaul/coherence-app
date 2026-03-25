/**
 * Google Address Validation API integration.
 *
 * Validates US mailing addresses using Google's USPS CASS-certified service.
 * Returns deliverability verdict, corrected address, and granular component data.
 *
 * Pricing: $17/1,000 requests (first $200/month free = ~11,760 free requests).
 * For ~580 addresses/month, this is well within the free tier.
 *
 * @see https://developers.google.com/maps/documentation/address-validation/overview
 */

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type AddressVerificationInput = {
  key: string; // CSG ID or unique row identifier
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
};

export type AddressVerificationResult = {
  key: string;
  /** Overall verdict: CONFIRMED, UNCONFIRMED, or ERROR. */
  verdict: "CONFIRMED" | "UNCONFIRMED" | "ERROR";
  /** Google's granular verdict on the address. */
  validationGranularity: string;
  /** Whether the address is deliverable according to USPS. */
  deliverable: boolean;
  /** Whether Google corrected any components. */
  hasCorrections: boolean;
  /** The corrected/standardized address components. */
  corrected: {
    address1: string;
    address2: string;
    city: string;
    state: string;
    zip: string;
    zipPlus4: string;
  };
  /** USPS data (only when enableUspsCass is true). */
  usps: {
    deliveryPointCode: string;
    carrierRoute: string;
    dpvConfirmation: string;
    dpvFootnote: string;
  } | null;
  /** Human-readable summary of issues. */
  issues: string[];
  /** Raw error message if the API call failed. */
  error: string | null;
};

/* ------------------------------------------------------------------ */
/*  API call                                                            */
/* ------------------------------------------------------------------ */

const GOOGLE_ADDRESS_VALIDATION_URL = "https://addressvalidation.googleapis.com/v1:validateAddress";

async function validateSingleAddress(
  apiKey: string,
  input: AddressVerificationInput,
): Promise<AddressVerificationResult> {
  const addressLines: string[] = [];
  if (input.address1) addressLines.push(input.address1);
  if (input.address2) addressLines.push(input.address2);

  const requestBody = {
    address: {
      regionCode: "US",
      addressLines,
      locality: input.city,
      administrativeArea: input.state,
      postalCode: input.zip,
    },
    enableUspsCass: true,
  };

  try {
    const response = await fetch(`${GOOGLE_ADDRESS_VALIDATION_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      let message = `Google API error (${response.status})`;
      try {
        const parsed = JSON.parse(errorText);
        message = parsed?.error?.message || message;
      } catch { /* use default */ }
      return {
        key: input.key,
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

    const data = await response.json() as GoogleValidationResponse;
    return parseValidationResponse(input.key, data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return {
      key: input.key,
      verdict: "ERROR",
      validationGranularity: "",
      deliverable: false,
      hasCorrections: false,
      corrected: { address1: "", address2: "", city: "", state: "", zip: "", zipPlus4: "" },
      usps: null,
      issues: [msg],
      error: msg,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Response parsing                                                    */
/* ------------------------------------------------------------------ */

type GoogleValidationResponse = {
  result?: {
    verdict?: {
      inputGranularity?: string;
      validationGranularity?: string;
      geocodeGranularity?: string;
      addressComplete?: boolean;
      hasUnconfirmedComponents?: boolean;
      hasInferredComponents?: boolean;
      hasReplacedComponents?: boolean;
    };
    address?: {
      formattedAddress?: string;
      postalAddress?: {
        regionCode?: string;
        postalCode?: string;
        administrativeArea?: string;
        locality?: string;
        addressLines?: string[];
      };
      addressComponents?: Array<{
        componentName?: { text?: string };
        componentType?: string;
        confirmationLevel?: string;
        inferred?: boolean;
        replaced?: boolean;
      }>;
    };
    uspsData?: {
      standardizedAddress?: {
        firstAddressLine?: string;
        secondAddressLine?: string;
        city?: string;
        state?: string;
        zipCode?: string;
        zipCodeExtension?: string;
      };
      deliveryPointCode?: string;
      carrierRoute?: string;
      dpvConfirmation?: string;
      dpvFootnote?: string;
    };
  };
};

function parseValidationResponse(key: string, data: GoogleValidationResponse): AddressVerificationResult {
  const verdict = data.result?.verdict;
  const address = data.result?.address;
  const uspsData = data.result?.uspsData;
  const issues: string[] = [];

  // Determine deliverability from USPS DPV confirmation
  const dpv = uspsData?.dpvConfirmation ?? "";
  const deliverable = dpv === "Y" || dpv === "S" || dpv === "D";

  if (!deliverable && dpv) {
    if (dpv === "N") issues.push("Address not deliverable (USPS DPV: not confirmed)");
    if (dpv === "D") issues.push("Primary address confirmed but secondary (apt/suite) missing");
  }

  if (verdict?.hasUnconfirmedComponents) {
    const unconfirmed = (address?.addressComponents ?? [])
      .filter((c) => c.confirmationLevel === "UNCONFIRMED_BUT_PLAUSIBLE" || c.confirmationLevel === "UNCONFIRMED_AND_SUSPICIOUS")
      .map((c) => `${c.componentType}: "${c.componentName?.text ?? ""}"`)
      .join(", ");
    if (unconfirmed) issues.push(`Unconfirmed: ${unconfirmed}`);
  }

  if (verdict?.hasReplacedComponents) {
    issues.push("Google replaced one or more address components");
  }

  if (verdict?.hasInferredComponents) {
    issues.push("Google inferred missing components (e.g. ZIP from city/state)");
  }

  // Extract corrected address from USPS standardized data (preferred) or Google postal address
  const std = uspsData?.standardizedAddress;
  const postal = address?.postalAddress;

  const corrected = {
    address1: std?.firstAddressLine ?? postal?.addressLines?.[0] ?? "",
    address2: std?.secondAddressLine ?? postal?.addressLines?.[1] ?? "",
    city: std?.city ?? postal?.locality ?? "",
    state: std?.state ?? postal?.administrativeArea ?? "",
    zip: std?.zipCode ?? postal?.postalCode ?? "",
    zipPlus4: std?.zipCodeExtension ? `${std.zipCode}-${std.zipCodeExtension}` : "",
  };

  const hasCorrections = verdict?.hasReplacedComponents === true || verdict?.hasInferredComponents === true;

  const overallVerdict: "CONFIRMED" | "UNCONFIRMED" =
    deliverable && !verdict?.hasUnconfirmedComponents ? "CONFIRMED" : "UNCONFIRMED";

  return {
    key,
    verdict: overallVerdict,
    validationGranularity: verdict?.validationGranularity ?? "",
    deliverable,
    hasCorrections,
    corrected,
    usps: uspsData
      ? {
          deliveryPointCode: uspsData.deliveryPointCode ?? "",
          carrierRoute: uspsData.carrierRoute ?? "",
          dpvConfirmation: uspsData.dpvConfirmation ?? "",
          dpvFootnote: uspsData.dpvFootnote ?? "",
        }
      : null,
    issues,
    error: null,
  };
}

/* ------------------------------------------------------------------ */
/*  Batch verification                                                  */
/* ------------------------------------------------------------------ */

/** Rate-limit delay between API calls (200ms = 5 requests/sec). */
const RATE_LIMIT_DELAY_MS = 200;

/**
 * Verify a batch of addresses using the Google Address Validation API.
 * Processes sequentially with rate limiting to stay within Google's quotas.
 */
export async function verifyAddressBatch(
  apiKey: string,
  addresses: AddressVerificationInput[],
  onProgress?: (completed: number, total: number) => void,
): Promise<AddressVerificationResult[]> {
  const results: AddressVerificationResult[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const result = await validateSingleAddress(apiKey, addresses[i]);
    results.push(result);
    onProgress?.(i + 1, addresses.length);

    // Rate limit: wait between requests (skip delay on last item)
    if (i < addresses.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
    }
  }

  return results;
}
