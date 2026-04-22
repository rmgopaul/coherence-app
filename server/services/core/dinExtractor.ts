/**
 * Extract DIN (Device Identification Number) values from photos of
 * inverter and meter labels, plus from PDF documents.
 *
 * Primary extractor: Claude Vision via the user's Anthropic API key.
 * Fallback extractor: tesseract.js OCR (runs locally, no network).
 *
 * PDFs are first attempted via pdfjs-dist text extraction; if no DINs
 * are found in the embedded text, we fall back to treating the PDF as
 * an opaque image and sending the first page to Claude.
 *
 * DIN label format observed on Tesla/Generac-branded inverters:
 *   DIN:1538000-45-A---GF2230670002NB
 * We accept variable whitespace around the colon and variable dash
 * counts between the segments so scuffed labels and OCR noise still
 * land on the right regex.
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
// Sonnet 4.6 balances quality (scuffed field photos) and cost; users can
// override via the integration row's metadata.model.
const DEFAULT_VISION_MODEL = "claude-sonnet-4-6";

// Anthropic vision only accepts these raster types; TIFF/BMP/HEIC-raw
// return HTTP 400. HEIC is converted to JPEG upstream, so it's not in
// this set — anything not here goes straight to tesseract.
const CLAUDE_SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isClaudeCompatible(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  if (lower.includes("pdf")) return true;
  if (lower.includes("heic") || lower.includes("heif")) return true; // converted upstream
  return CLAUDE_SUPPORTED_IMAGE_MIMES.has(lower);
}

// 1538000-45-A---GF2230670002NB  (allow space or dash as separators)
const DIN_REGEX =
  /\b([0-9]{4,}[- ]+[0-9]{1,3}[- ]+[A-Z][- ]+[A-Z0-9]{6,})\b/gi;

export type DinMatch = {
  dinValue: string;
  rawMatch: string;
  extractedBy: "claude" | "tesseract" | "pdfjs";
};

export type DinExtractorCredentials = {
  anthropicApiKey: string | null;
  anthropicModel: string | null;
};

function normalizeDin(raw: string): string {
  // Collapse any run of whitespace or dashes between the mandatory
  // segments into a single dash. Keeps the canonical printed form
  // from the sticker (digits-digits-letter-alphanum).
  const trimmed = raw.trim().replace(/\s+/g, "-");
  return trimmed.replace(/-+/g, "-").toUpperCase();
}

function collectDinsFromText(
  text: string,
  extractedBy: DinMatch["extractedBy"]
): DinMatch[] {
  if (!text) return [];
  const out: DinMatch[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
  while ((match = regex.exec(text)) !== null) {
    const normalized = normalizeDin(match[1]);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ dinValue: normalized, rawMatch: match[0], extractedBy });
  }
  return out;
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/**
 * Convert HEIC/HEIF image bytes to JPEG. Throws if conversion fails.
 * Lazy-loaded because `heic-convert` pulls in a ~10MB native decoder.
 */
async function heicToJpeg(data: Uint8Array): Promise<Uint8Array> {
  const mod = await import("heic-convert");
  const convert = (mod as unknown as { default: (opts: {
    buffer: Buffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }) => Promise<ArrayBuffer> }).default;
  const output = await convert({
    buffer: Buffer.from(data),
    format: "JPEG",
    quality: 0.85,
  });
  return new Uint8Array(output);
}

/**
 * Normalize a photo for Claude Vision:
 * - HEIC/HEIF → JPEG
 * - Anything else → pass through
 *
 * Returns the bytes plus the effective mime type Anthropic will see.
 */
async function prepareImageForClaude(
  data: Uint8Array,
  mimeType: string
): Promise<{ data: Uint8Array; mimeType: string }> {
  const lower = mimeType.toLowerCase();
  if (lower.includes("heic") || lower.includes("heif")) {
    const jpeg = await heicToJpeg(data);
    return { data: jpeg, mimeType: "image/jpeg" };
  }
  return { data, mimeType };
}

/**
 * Ask Claude Vision to extract all DIN numbers from an image or PDF.
 *
 * Anthropic's vision API accepts image/jpeg, image/png, image/gif,
 * image/webp (and application/pdf via the document block). For
 * non-supported types (TIFF, BMP) the caller should fall back to
 * tesseract.
 */
async function extractWithClaude(
  data: Uint8Array,
  mimeType: string,
  credentials: DinExtractorCredentials
): Promise<DinMatch[]> {
  if (!credentials.anthropicApiKey) return [];
  if (!isClaudeCompatible(mimeType)) return [];

  const prepared = await prepareImageForClaude(data, mimeType);
  const model = credentials.anthropicModel ?? DEFAULT_VISION_MODEL;
  const isPdf = prepared.mimeType.toLowerCase().includes("pdf");

  const contentBlock = isPdf
    ? {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: toBase64(prepared.data),
        },
      }
    : {
        type: "image",
        source: {
          type: "base64",
          media_type: prepared.mimeType,
          data: toBase64(prepared.data),
        },
      };

  const instructions = [
    "You are looking at a photograph of a solar inverter or utility meter label.",
    'Find every "DIN" (Device Identification Number) printed on the label.',
    'A DIN looks like "DIN:1538000-45-A---GF2230670002NB" — usually digits, then dashes, then an alphanumeric tail.',
    "Return STRICT JSON only, no prose, matching this schema:",
    '{ "dins": string[] }',
    "Each string is a single DIN value, exactly as printed (keep the dashes).",
    "If no DIN is visible, return { \"dins\": [] }.",
  ].join(" ");

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": credentials.anthropicApiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: [
              contentBlock,
              { type: "text", text: instructions },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.warn(
      "[dinExtractor.claude] fetch failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn(
      `[dinExtractor.claude] Anthropic API ${response.status} ${response.statusText}: ${body.slice(0, 400)}`
    );
    return [];
  }

  let body: { content?: Array<{ type: string; text?: string }> };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return [];
  }

  const text = body.content?.find((b) => b.type === "text")?.text ?? "";
  if (!text) return [];

  // Parse the JSON payload (model sometimes wraps it in fences).
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const payload = fenceMatch ? fenceMatch[1] : text;
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start < 0 || end <= start) {
    // Fall back to regex on the raw response.
    return collectDinsFromText(text, "claude");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.slice(start, end + 1));
  } catch {
    return collectDinsFromText(text, "claude");
  }

  if (!parsed || typeof parsed !== "object") return [];
  const dinList = (parsed as { dins?: unknown }).dins;
  if (!Array.isArray(dinList)) return [];

  const seen = new Set<string>();
  const out: DinMatch[] = [];
  for (const entry of dinList) {
    if (typeof entry !== "string") continue;
    const cleaned = entry.trim();
    if (!cleaned) continue;
    // Apply the same normalization so duplicates collapse across
    // photos regardless of whether Claude kept the triple-dash or
    // condensed it to a single dash.
    const normalized = normalizeDin(cleaned);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ dinValue: normalized, rawMatch: entry, extractedBy: "claude" });
  }
  return out;
}

/**
 * Tesseract fallback for photos when Anthropic is unavailable or the
 * image format isn't one Claude Vision accepts. Lazy-loaded because
 * tesseract.js ships a ~30MB wasm bundle.
 */
async function extractWithTesseract(
  data: Uint8Array,
  mimeType: string
): Promise<DinMatch[]> {
  const prepared =
    mimeType.toLowerCase().includes("heic") || mimeType.toLowerCase().includes("heif")
      ? await heicToJpeg(data)
      : data;

  const mod = await import("tesseract.js");
  const recognize = (mod as unknown as {
    recognize: (
      image: Buffer,
      lang?: string,
      options?: Record<string, unknown>
    ) => Promise<{ data: { text: string } }>;
  }).recognize;

  const result = await recognize(Buffer.from(prepared), "eng");
  return collectDinsFromText(result.data.text, "tesseract");
}

/**
 * Extract DIN text from a PDF using pdfjs text extraction. Returns
 * an empty array if the PDF is image-only.
 */
async function extractWithPdfjs(data: Uint8Array): Promise<DinMatch[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const chunks: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: unknown) => {
        const str = (item as { str?: unknown }).str;
        return typeof str === "string" ? str : "";
      })
      .join(" ");
    chunks.push(pageText);
  }
  const fullText = chunks.join("\n");
  return collectDinsFromText(fullText, "pdfjs");
}

/**
 * Main entry point. Given raw photo/PDF bytes, try every reasonable
 * extractor and return the unique set of DINs found. Order of
 * preference: pdfjs (PDFs) → Claude → tesseract.
 *
 * `credentials.anthropicApiKey` may be null — in that case we skip
 * Claude and go straight to tesseract for images.
 */
export async function extractDinsFromPhoto(
  data: Uint8Array,
  mimeType: string,
  credentials: DinExtractorCredentials
): Promise<DinMatch[]> {
  const lower = mimeType.toLowerCase();
  const isPdf = lower.includes("pdf");

  if (isPdf) {
    // Try embedded text first — much cheaper than vision.
    try {
      const fromText = await extractWithPdfjs(data);
      if (fromText.length > 0) return fromText;
    } catch (err) {
      console.warn(
        "[dinExtractor] pdfjs text extraction failed:",
        err instanceof Error ? err.message : err
      );
    }
    // Fall through to Claude (handles scanned PDFs too).
  }

  // Prefer Claude for images — field photos with glare / angle /
  // reflections are where vision models outperform raw OCR.
  if (credentials.anthropicApiKey) {
    try {
      const fromClaude = await extractWithClaude(data, mimeType, credentials);
      if (fromClaude.length > 0) return fromClaude;
    } catch (err) {
      console.warn(
        "[dinExtractor] Claude extraction failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // Tesseract fallback. Only attempt on raster image formats —
  // tesseract.js can't parse PDFs directly.
  if (!isPdf) {
    try {
      return await extractWithTesseract(data, mimeType);
    } catch (err) {
      console.warn(
        "[dinExtractor] Tesseract extraction failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  return [];
}

export const __test__ = {
  normalizeDin,
  collectDinsFromText,
  DIN_REGEX,
};
