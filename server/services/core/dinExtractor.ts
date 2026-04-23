/**
 * Extract DIN (Device Identification Number) values from photos of
 * inverter and meter labels plus from PDF documents.
 *
 * Pipeline (per photo):
 *
 *   1. Normalize      — honor EXIF orientation, upscale small images,
 *                        rasterize PDFs to PNG so every path downstream
 *                        gets a consistent "type: image" payload.
 *   2. QR decode      — free, deterministic, and works on rotated
 *                        stickers. Modern Tesla/SolarEdge/etc. labels
 *                        print "Scan QR to Commission" and encode the
 *                        DIN in the QR payload. If we find one, done.
 *   3. Claude vision  — primary OCR. Retries at 0°/90°/180°/270° on
 *                        zero-result (many field photos have stickers
 *                        physically mounted sideways on the hardware).
 *   4. Tesseract      — last-resort local OCR when Claude is
 *                        unavailable or the model can't read the sticker.
 *
 * The return value carries a `log` object that captures every
 * extractor attempt — rotations tried, raw model responses, reasons
 * for empty results — so that zero-DIN cases are debuggable from the
 * Sites tab without re-scraping.
 */

import { fetchJson, HttpClientError } from "./httpClient";
import { normalizeForExtraction, rotateImage } from "./imageOps";
import { decodeQrPayloads, decodeQrInRegions } from "./qrDecoder";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_VISION_TIMEOUT_MS = 60_000;
const ANTHROPIC_VISION_MAX_TOKENS = 2048;
// Sonnet 4.6 is the default. Rationale: QR decoding now handles
// inverter sticker labels deterministically (the original reason
// to pick Opus was accuracy on those). Claude is only invoked as a
// safety net for non-sticker frames — wide shots, diagnostic
// screenshots, meter photos without QR — where Sonnet is both
// faster and under a much higher TPM cap. Opus's stricter rate
// limits were causing the whole job to stall behind 429-retry
// backoffs with concurrency=4. Override via integration
// metadata.model if you want Opus anyway.
const DEFAULT_VISION_MODEL = "claude-sonnet-4-6";

// Anthropic vision only accepts these raster types; TIFF/BMP/HEIC-raw
// return HTTP 400. After normalizeForExtraction everything becomes
// image/jpeg, so this check is a belt-and-suspenders guard for
// callers that bypass normalization.
const CLAUDE_SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isClaudeCompatibleImage(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return CLAUDE_SUPPORTED_IMAGE_MIMES.has(lower);
}

// 1538000-45-A---GF2230670002NB  — allow space / dash (ASCII or
// unicode en/em) as separators; OCR routinely substitutes dashes.
const DIN_REGEX =
  /\b([0-9]{4,}[-–—\s]+[0-9]{1,3}[-–—\s]+[A-Z][-–—\s]+[A-Z0-9]{4,})\b/gi;

// Tesla System Tesla Energy ID — "STE" + 8-digit install date +
// "-" + 5-digit sequence, e.g. STE20230612-00205. Appears in
// Powerhub-app diagnostics screenshots and on some installation
// paperwork. Site-scoped (one per Tesla system, not per device).
const STE_ID_REGEX = /\b(STE\d{8}-\d{5})\b/gi;

function normalizeSteId(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Collect every distinct STE ID from a block of free text (OCR
 * output or a model response). Used opportunistically: whenever
 * we already have text for DIN extraction, we scan the same text
 * for STE IDs at zero extra cost.
 */
function extractSteIds(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const regex = new RegExp(STE_ID_REGEX.source, STE_ID_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    seen.add(normalizeSteId(match[1]));
  }
  return Array.from(seen);
}

export type DinExtractor = "claude" | "tesseract" | "pdfjs" | "qr";

export type DinMatch = {
  dinValue: string;
  rawMatch: string;
  extractedBy: DinExtractor;
};

export type DinExtractorCredentials = {
  anthropicApiKey: string | null;
  anthropicModel: string | null;
};

/**
 * Structured audit trail for a single photo's extraction attempts.
 * Serialized as JSON into `dinScrapeResults.extractorLog` so ops can
 * see why a site produced zero DINs.
 */
export type ExtractorLog = {
  photoFileName?: string;
  photoUrl?: string;
  inputMimeType: string;
  normalizedMimeType: string;
  normalizedWidth: number;
  normalizedHeight: number;
  qr?: {
    payloads: string[];
    attempts: number;
    matchedDins: string[];
    winningStrategy?: string;
    error?: string;
  };
  /** Claude-guided QR localization attempts (step 2.5). */
  qrLocator?: {
    attempted: boolean;
    regions: Array<{
      left: number;
      top: number;
      right: number;
      bottom: number;
    }>;
    payloads: string[];
    matchedDins: string[];
    winningStrategy?: string;
    error?: string;
  };
  claude?: Array<{
    rotation: 0 | 90 | 180 | 270;
    dinsFound: number;
    rawTextSnippet: string; // first 500 chars of Claude's text
    error?: string;
  }>;
  tesseract?: {
    rotation: 0;
    dinsFound: number;
    rawTextSnippet: string;
    error?: string;
  };
  finalExtractor: DinExtractor | "none";
};

export type DinExtractionResult = {
  dins: DinMatch[];
  /**
   * Tesla STE IDs ("STE20230612-00205") seen anywhere in this
   * photo's text output (tesseract + Claude responses). The
   * runner aggregates across photos of a site and persists a
   * single STE ID onto dinScrapeResults.
   */
  steIds: string[];
  claudeAttempted: boolean;
  claudeFailed: boolean;
  log: ExtractorLog;
};

function normalizeDin(raw: string): string {
  // Strip any "DIN:" / "DIN " prefix the model might echo back, then
  // normalize whitespace + unicode dash variants down to ASCII
  // single-dashes. Case-normalize so dedup works across camelcase
  // hallucinations.
  const withoutPrefix = raw.trim().replace(/^DIN[:\s#-]*\s*/i, "");
  const trimmed = withoutPrefix.trim().replace(/[\s–—]+/g, "-");
  return trimmed.replace(/-+/g, "-").toUpperCase();
}

function collectDinsFromText(
  text: string,
  extractedBy: DinExtractor
): DinMatch[] {
  if (!text) return [];
  const out: DinMatch[] = [];
  const seen = new Set<string>();
  const regex = new RegExp(DIN_REGEX.source, DIN_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const normalized = normalizeDin(match[1]);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ dinValue: normalized, rawMatch: match[0], extractedBy });
  }
  return out;
}

/**
 * QR payloads in the CSG universe come in three observed formats:
 *
 * A. Tesla Gateway inverter (split):
 *      "WIFI:T:WPA;S:TEG-2DT;P:YTRBNPWUYF; (P)1538000-45-A (S)GF2230680002DT"
 *    Part = "1538000-45-A", Serial = "GF2230680002DT"
 *    Reassembled DIN = "1538000-45-A-GF2230680002DT"
 *
 * B. Neurio smart meter (colon-delimited, 3 fields):
 *      "P1112484-14-A:D55045:NVAH5105AB2867"
 *    Part = "1112484-14-A", middle batch-ID, Serial = "NVAH5105AB2867"
 *    Reassembled DIN = "1112484-14-A-NVAH5105AB2867"
 *
 * C. Non-Tesla inverter (colon-delimited, 2 fields):
 *      "P1546816-00-C:1TDI921327A00328"
 *    Part = "1546816-00-C", Serial = "1TDI921327A00328"
 *    Reassembled DIN = "1546816-00-C-1TDI921327A00328"
 *
 * D. Contiguous DIN text anywhere else (vendor-neutral fallback).
 *
 * The P prefix in formats B/C is sometimes dropped by the QR decoder
 * when the sticker is at an angle, leaving e.g.
 * "12484-14-A:S34939:NVAH5309AB1904" — we handle the P as optional.
 */
const TESLA_QR_REGEX =
  /\(P\)\s*([0-9]{4,}[-\s][0-9]{1,3}[-\s][A-Z])\s*\(S\)\s*([A-Z0-9]{6,})/gi;

// Colon format: optional leading "P", part number, optional middle
// field, serial. The serial segment is captured permissively — Neurio
// meters use NVAH-prefix + digits/letters; non-Tesla inverters use
// vendor-specific alphanumeric tokens; both need to be at least 6
// chars to avoid matching arbitrary short junk.
const COLON_QR_REGEX =
  /\bP?([0-9]{4,}-[0-9]{1,3}-[A-Z])(?::[A-Z0-9]+)?:([A-Z0-9]{6,})\b/gi;

function extractDinsFromQrPayload(
  payload: string,
  extractedBy: DinExtractor
): DinMatch[] {
  if (!payload) return [];
  const out: DinMatch[] = [];
  const seen = new Set<string>();

  const tryAdd = (rawPart: string, rawSerial: string, rawMatch: string) => {
    const reassembled = `${rawPart}-${rawSerial}`;
    const normalized = normalizeDin(reassembled);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ dinValue: normalized, rawMatch, extractedBy });
  };

  // Pass 1: Tesla format (P)<part> (S)<serial>.
  const teslaRegex = new RegExp(TESLA_QR_REGEX.source, TESLA_QR_REGEX.flags);
  let m: RegExpExecArray | null;
  while ((m = teslaRegex.exec(payload)) !== null) {
    tryAdd(m[1], m[2], m[0]);
  }

  // Pass 2: colon-delimited format P<part>:<middle?>:<serial>.
  // Matches both Neurio meters and non-Tesla inverters.
  const colonRegex = new RegExp(COLON_QR_REGEX.source, COLON_QR_REGEX.flags);
  while ((m = colonRegex.exec(payload)) !== null) {
    tryAdd(m[1], m[2], m[0]);
  }

  // Pass 3: any contiguous DIN elsewhere in the payload.
  for (const match of collectDinsFromText(payload, extractedBy)) {
    if (seen.has(match.dinValue)) continue;
    seen.add(match.dinValue);
    out.push(match);
  }

  return out;
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

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
    quality: 0.9,
  });
  return new Uint8Array(output);
}

async function maybeHeicToJpeg(
  data: Uint8Array,
  mimeType: string
): Promise<{ data: Uint8Array; mimeType: string }> {
  const lower = mimeType.toLowerCase();
  if (lower.includes("heic") || lower.includes("heif")) {
    return { data: await heicToJpeg(data), mimeType: "image/jpeg" };
  }
  return { data, mimeType };
}

/* --------------------------------------------------------------------- */
/*  Claude Vision                                                        */
/* --------------------------------------------------------------------- */

const CLAUDE_INSTRUCTIONS = [
  "You are looking at a photograph of a solar inverter, utility meter, or electrical equipment label.",
  "",
  "Your job: find EVERY Device Identification Number (DIN) printed on visible labels.",
  "",
  "FORMAT:",
  'A DIN is prefixed with the literal text "DIN:" or "DIN " and is a segmented alphanumeric code:',
  '  DIN:1538000-45-A---GF22306800002DT',
  '  DIN:1538000-46-B-AB1234567890XY',
  "Segments: several digits, a short number, a single letter, then an alphanumeric tail (typically starts with 2 uppercase letters then 10+ digits then 1-3 trailing letters/digits).",
  "Separators may be single dashes, multiple dashes, or whitespace.",
  "",
  "IMPORTANT HINTS:",
  "- The DIN label is often next to a QR code labeled 'Scan QR to Commission'.",
  "- The photograph MAY BE ROTATED — the sticker could be mounted sideways. Inspect at all four orientations.",
  "- Only extract values prefixed with 'DIN'. Ignore Password / SSID / part numbers nearby.",
  "- If the same DIN appears multiple times, return it once.",
  "",
  "*** ACCURACY IS CRITICAL ***",
  "Every character in the DIN's alphanumeric tail matters. If you cannot read a specific character with high confidence, DO NOT GUESS. Returning a DIN with a single wrong digit is worse than returning no DIN at all — downstream systems will trust it and misroute settlements.",
  "",
  "If any of the following are true, return an empty array:",
  "  - The label is blurry, at an angle, or partially obscured.",
  "  - Glare, shadow, or camera focus makes any character in the tail ambiguous.",
  "  - You are extrapolating or pattern-matching any character rather than reading it.",
  "",
  "OUTPUT:",
  'Return STRICT JSON ONLY, no markdown, no prose. Schema:',
  '  { "dins": string[], "confidence": "high" | "low", "reason"?: string }',
  'Omit the "DIN:" prefix — return just the segmented code.',
  'For empty results, set confidence: "low" and give a concrete reason ("tail digits ambiguous", "label glare on last segment", "no DIN sticker in frame").',
  'For populated results, set confidence: "high" — only populate dins[] when you are certain of every character.',
].join("\n");

type ClaudeCallResult = {
  dins: DinMatch[];
  rawText: string; // full Claude response text, for logging
};

async function callClaudeOnImage(
  data: Uint8Array,
  mimeType: string,
  credentials: DinExtractorCredentials
): Promise<ClaudeCallResult> {
  const model = credentials.anthropicModel ?? DEFAULT_VISION_MODEL;
  const result = await fetchJson<{
    content?: Array<{ type: string; text?: string }>;
  }>(ANTHROPIC_MESSAGES_URL, {
    service: "Anthropic (DIN vision)",
    method: "POST",
    timeoutMs: ANTHROPIC_VISION_TIMEOUT_MS,
    maxRetries: 2,
    headers: {
      "x-api-key": credentials.anthropicApiKey ?? "",
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
    body: {
      model,
      max_tokens: ANTHROPIC_VISION_MAX_TOKENS,
      // temperature=0 for deterministic output. Claude is still
      // capable of hallucinating at T=0, but at least the same
      // photo produces the same output run-to-run, which helps us
      // recognize systematic errors vs. random noise.
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: toBase64(data),
              },
            },
            { type: "text", text: CLAUDE_INSTRUCTIONS },
          ],
        },
      ],
    },
  });

  const rawText =
    result.data.content?.find((b) => b.type === "text")?.text ?? "";

  if (!rawText) return { dins: [], rawText: "" };

  // Strip ```json fences if present, then find the outermost JSON
  // object in the response.
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(rawText);
  const payload = fenceMatch ? fenceMatch[1] : rawText;
  const start = payload.indexOf("{");
  const end = payload.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { dins: collectDinsFromText(rawText, "claude"), rawText };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.slice(start, end + 1));
  } catch {
    return { dins: collectDinsFromText(rawText, "claude"), rawText };
  }

  if (!parsed || typeof parsed !== "object") {
    return { dins: [], rawText };
  }
  const parsedObj = parsed as { dins?: unknown; confidence?: unknown };
  const dinList = parsedObj.dins;
  if (!Array.isArray(dinList)) {
    return { dins: [], rawText };
  }

  // If Claude self-reported low confidence, treat as zero DINs.
  // This is the anti-hallucination gate — Claude is instructed to
  // emit confidence:"low" whenever any character of the tail is
  // ambiguous, which is exactly the case where it would otherwise
  // invent digits.
  const confidence =
    typeof parsedObj.confidence === "string"
      ? parsedObj.confidence.toLowerCase()
      : null;
  if (confidence === "low") {
    return { dins: [], rawText };
  }

  const seen = new Set<string>();
  const out: DinMatch[] = [];
  for (const entry of dinList) {
    if (typeof entry !== "string") continue;
    const cleaned = entry.trim();
    if (!cleaned) continue;
    const normalized = normalizeDin(cleaned);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ dinValue: normalized, rawMatch: entry, extractedBy: "claude" });
  }
  return { dins: out, rawText };
}

/* --------------------------------------------------------------------- */
/*  Claude-guided QR localization                                          */
/* --------------------------------------------------------------------- */

const QR_LOCATOR_INSTRUCTIONS = [
  "Look at this image. Identify every QR code visible, even if small, at an angle, or partially obscured. A QR code is a square matrix barcode with three large square 'finder patterns' in the corners.",
  "",
  "Return STRICT JSON ONLY. Schema:",
  '  { "qrs": [{ "left": number, "top": number, "right": number, "bottom": number }] }',
  "",
  "Coordinates are FRACTIONAL (0.0 to 1.0):",
  "  - left: horizontal distance from the left edge of the image",
  "  - top: vertical distance from the top edge of the image",
  "  - right: horizontal distance from the left edge (right > left)",
  "  - bottom: vertical distance from the top edge (bottom > top)",
  "",
  "Give a SNUG bounding box around the QR code itself, not the whole sticker it sits on. If a QR is visible but partially cut off, return the visible portion. If no QR codes are present, return { \"qrs\": [] }.",
].join("\n");

/**
 * Ask Claude to locate every QR code in the image and return
 * fractional bounding boxes. The caller then crops the original
 * image at full resolution for each box and runs jsqr on the
 * upscaled crop — QR decoding stays deterministic (zero
 * hallucination risk); Claude is only responsible for WHERE to
 * look, not WHAT the payload is.
 *
 * Returns an empty array on any failure. The caller falls through
 * to the general Claude extraction path.
 */
async function locateQrRegionsWithClaude(
  data: Uint8Array,
  mimeType: string,
  credentials: DinExtractorCredentials
): Promise<Array<{ left: number; top: number; right: number; bottom: number }>> {
  if (!credentials.anthropicApiKey) return [];
  if (!isClaudeCompatibleImage(mimeType)) return [];

  const model = credentials.anthropicModel ?? DEFAULT_VISION_MODEL;
  try {
    const result = await fetchJson<{
      content?: Array<{ type: string; text?: string }>;
    }>(ANTHROPIC_MESSAGES_URL, {
      service: "Anthropic (QR locator)",
      method: "POST",
      timeoutMs: ANTHROPIC_VISION_TIMEOUT_MS,
      maxRetries: 2,
      headers: {
        "x-api-key": credentials.anthropicApiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: {
        model,
        max_tokens: 512,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: toBase64(data),
                },
              },
              { type: "text", text: QR_LOCATOR_INSTRUCTIONS },
            ],
          },
        ],
      },
    });

    const rawText =
      result.data.content?.find((b) => b.type === "text")?.text ?? "";
    if (!rawText) return [];

    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(rawText);
    const payload = fenceMatch ? fenceMatch[1] : rawText;
    const start = payload.indexOf("{");
    const end = payload.lastIndexOf("}");
    if (start < 0 || end <= start) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.slice(start, end + 1));
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object") return [];
    const qrs = (parsed as { qrs?: unknown }).qrs;
    if (!Array.isArray(qrs)) return [];

    const out: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    for (const q of qrs) {
      if (!q || typeof q !== "object") continue;
      const r = q as Record<string, unknown>;
      const left = typeof r.left === "number" ? r.left : NaN;
      const top = typeof r.top === "number" ? r.top : NaN;
      const right = typeof r.right === "number" ? r.right : NaN;
      const bottom = typeof r.bottom === "number" ? r.bottom : NaN;
      if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
      if (!Number.isFinite(right) || !Number.isFinite(bottom)) continue;
      if (right <= left || bottom <= top) continue;
      if (left < 0 || top < 0 || right > 1 || bottom > 1) continue;
      out.push({ left, top, right, bottom });
    }
    return out;
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------- */
/*  Tesseract (local OCR fallback)                                        */
/* --------------------------------------------------------------------- */

/**
 * Cached tesseract worker. tesseract.js v7 requires `createWorker`
 * (the module-level `recognize` shortcut that older versions had
 * breaks under esbuild's CJS interop — this was a real bug in
 * production). Lazy-init on first use, reuse for every subsequent
 * recognize call.
 */
type TesseractWorker = {
  recognize: (image: Buffer) => Promise<{ data: { text: string } }>;
  terminate?: () => Promise<void>;
};
let cachedTesseractWorker: Promise<TesseractWorker> | null = null;

async function getTesseractWorker(): Promise<TesseractWorker> {
  if (cachedTesseractWorker) {
    try {
      return await cachedTesseractWorker;
    } catch {
      cachedTesseractWorker = null;
      // fall through and retry init
    }
  }
  const promise = (async () => {
    const mod = await import("tesseract.js");
    const createWorker =
      (mod as unknown as { createWorker?: (lang?: string) => Promise<TesseractWorker> })
        .createWorker ??
      (mod as unknown as { default: { createWorker: (lang?: string) => Promise<TesseractWorker> } })
        .default.createWorker;
    if (typeof createWorker !== "function") {
      throw new Error("tesseract.js createWorker export not found");
    }
    return createWorker("eng");
  })();
  cachedTesseractWorker = promise;
  promise.catch(() => {
    if (cachedTesseractWorker === promise) cachedTesseractWorker = null;
  });
  return promise;
}

async function tesseractRecognize(data: Uint8Array): Promise<string> {
  const worker = await getTesseractWorker();
  const result = await worker.recognize(Buffer.from(data));
  return result.data.text ?? "";
}

/* --------------------------------------------------------------------- */
/*  PDF → image bytes                                                     */
/* --------------------------------------------------------------------- */

async function extractDinsFromPdfText(data: Uint8Array): Promise<DinMatch[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Avoid spawning a worker — Node pnpm resolution was loading a
  // 5.5.207 worker against a 5.6.205 API, which threw
  // "API version does not match Worker version" on every PDF.
  // Main-thread extraction is plenty fast for the small contract
  // PDFs we see from the CSG portal. `disableWorker` is a documented
  // runtime option but missing from the public type, hence the cast.
  const pdf = await getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    ...({ disableWorker: true } as Record<string, unknown>),
  } as Parameters<typeof getDocument>[0]).promise;

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
  return collectDinsFromText(chunks.join("\n"), "pdfjs");
}

/* --------------------------------------------------------------------- */
/*  Main entry                                                            */
/* --------------------------------------------------------------------- */

export type ExtractPhotoMeta = {
  fileName?: string;
  url?: string;
};

/**
 * Main entry point. Given raw photo/PDF bytes, try every reasonable
 * extractor in order and return unique DIN matches plus an
 * ExtractorLog for debugging. The job runner reads `claudeFailed` to
 * drive its circuit breaker.
 */
export async function extractDinsFromPhoto(
  data: Uint8Array,
  mimeType: string,
  credentials: DinExtractorCredentials,
  meta?: ExtractPhotoMeta
): Promise<DinExtractionResult> {
  const lowerMime = mimeType.toLowerCase();
  const isPdf = lowerMime.includes("pdf");

  const log: ExtractorLog = {
    photoFileName: meta?.fileName,
    photoUrl: meta?.url,
    inputMimeType: mimeType,
    normalizedMimeType: "image/jpeg",
    normalizedWidth: 0,
    normalizedHeight: 0,
    finalExtractor: "none",
  };

  // STE IDs are collected opportunistically from every text source
  // the pipeline touches — tesseract output + each Claude rotation's
  // raw response text. A single Set across the whole photo so the
  // same ID, seen multiple times, only shows up once.
  const steIdsFound = new Set<string>();
  const captureStes = (text: string) => {
    for (const id of extractSteIds(text)) steIdsFound.add(id);
  };

  // Step 1 — PDFs get text extraction only; no rasterization.
  // Empirically, CSG portal PDFs are contracts / receipts / brochures
  // that don't contain DINs in image form, so the only useful thing
  // we can do is scan their embedded text.
  if (isPdf) {
    try {
      const fromText = await extractDinsFromPdfText(data);
      if (fromText.length > 0) {
        log.finalExtractor = "pdfjs";
        return finalize(fromText, log, { claudeAttempted: false, claudeFailed: false }, steIdsFound);
      }
    } catch (err) {
      log.tesseract = {
        rotation: 0,
        dinsFound: 0,
        rawTextSnippet: "",
        error: `pdfjs text extract failed: ${errMsg(err)}`,
      };
    }
    return finalize([], log, { claudeAttempted: false, claudeFailed: false }, steIdsFound);
  }

  // Step 1b (images only) — normalize bytes to a single upright JPEG.
  let workingBytes: Uint8Array;
  try {
    const preHeic = await maybeHeicToJpeg(data, mimeType);
    const normalized = await normalizeForExtraction(preHeic.data, "image/jpeg");
    workingBytes = normalized.data;
    log.normalizedMimeType = normalized.mimeType;
    log.normalizedWidth = normalized.width;
    log.normalizedHeight = normalized.height;
  } catch (err) {
    log.tesseract = {
      rotation: 0,
      dinsFound: 0,
      rawTextSnippet: "",
      error: `normalize failed: ${errMsg(err)}`,
    };
    return finalize([], log, { claudeAttempted: false, claudeFailed: false }, steIdsFound);
  }

  // Step 2 — QR decode. If any decoded payload contains a DIN, we're
  // done. Zero cost, zero model hallucination risk. Runs a multi-scale
  // tiled search (see qrDecoder.ts) with jsqr + ZXing fallback, then
  // parses every decoded payload through extractDinsFromQrPayload —
  // which handles Tesla's split (P)<part> (S)<serial> format in
  // addition to the standard contiguous DIN pattern. Without the
  // Tesla-aware parser, QR succeeded on every inverter photo but
  // returned zero DINs because my contiguous regex didn't match
  // the split form.
  try {
    const qr = await decodeQrPayloads(workingBytes);
    const matched: DinMatch[] = [];
    for (const payload of qr.payloads) {
      matched.push(...extractDinsFromQrPayload(payload, "qr"));
    }
    log.qr = {
      payloads: qr.payloads,
      attempts: qr.attempts,
      matchedDins: matched.map((m) => m.dinValue),
      winningStrategy: qr.winningStrategy,
    };
    if (matched.length > 0) {
      log.finalExtractor = "qr";
      return finalize(matched, log, { claudeAttempted: false, claudeFailed: false }, steIdsFound);
    }
  } catch (err) {
    log.qr = {
      payloads: [],
      attempts: 0,
      matchedDins: [],
      error: `qr decode failed: ${errMsg(err)}`,
    };
  }

  // Step 2.5 — Claude-guided QR localization. Only runs if the
  // tile-search QR missed AND we have an Anthropic key. Asks Claude
  // to point at the QR codes in the frame; for each bbox, we crop
  // the ORIGINAL image at full resolution, upscale the crop, and
  // run jsqr on it. QR decoding stays deterministic — Claude is
  // only used for WHERE to look, not for reading the payload.
  // This catches the wide-angle-inverter case where the QR is
  // ~150 px in a 12 MP frame and gets lost in the uniform 1500 px
  // tile search.
  if (credentials.anthropicApiKey && isClaudeCompatibleImage(log.normalizedMimeType)) {
    try {
      const regions = await locateQrRegionsWithClaude(
        workingBytes,
        "image/jpeg",
        credentials
      );
      log.qrLocator = {
        attempted: true,
        regions,
        payloads: [],
        matchedDins: [],
      };
      if (regions.length > 0) {
        const located = await decodeQrInRegions(workingBytes, regions);
        log.qrLocator.payloads = located.payloads;
        log.qrLocator.winningStrategy = located.winningStrategy;
        const locatedDins: DinMatch[] = [];
        for (const payload of located.payloads) {
          locatedDins.push(...extractDinsFromQrPayload(payload, "qr"));
        }
        log.qrLocator.matchedDins = locatedDins.map((m) => m.dinValue);
        if (locatedDins.length > 0) {
          log.finalExtractor = "qr";
          return finalize(
            locatedDins,
            log,
            { claudeAttempted: true, claudeFailed: false },
            steIdsFound
          );
        }
      }
    } catch (err) {
      log.qrLocator = {
        attempted: true,
        regions: [],
        payloads: [],
        matchedDins: [],
        error: `qr locator failed: ${errMsg(err)}`,
      };
    }
  }

  // Step 3 — Claude vision.
  //
  // Strategy:
  //   1. Rotation 0 first (single call). If it returns DINs, accept
  //      and return — with a high-accuracy model like Opus, rotation
  //      0 hits are trustworthy. We previously tried a "double-call
  //      verification" here to catch hallucinations, but at
  //      temperature=0 with identical input the model returns
  //      identical output, hallucination or not — so it was burning
  //      2× the spend for zero benefit. Accuracy comes from the
  //      stronger model + the anti-hallucination prompt + (when it
  //      works) QR ground-truth, not from repeated calls.
  //   2. If rotation 0 returns no DINs, fire rotations 90/180/270
  //      in PARALLEL (Promise.all) rather than sequentially. Takes
  //      1 call-duration wall-clock instead of 3. First non-empty
  //      response wins.
  let claudeAttempted = false;
  let claudeFailed = false;
  if (credentials.anthropicApiKey && isClaudeCompatibleImage(log.normalizedMimeType)) {
    claudeAttempted = true;
    log.claude = [];

    // Rotation 0.
    try {
      const { dins, rawText } = await callClaudeOnImage(
        workingBytes,
        "image/jpeg",
        credentials
      );
      captureStes(rawText);
      log.claude.push({
        rotation: 0,
        dinsFound: dins.length,
        rawTextSnippet: rawText.slice(0, 500),
      });
      if (dins.length > 0) {
        log.finalExtractor = "claude";
        return finalize(dins, log, { claudeAttempted, claudeFailed }, steIdsFound);
      }
    } catch (err) {
      claudeFailed = true;
      const detail =
        err instanceof HttpClientError
          ? `${err.message} (status=${err.statusCode ?? "n/a"})`
          : errMsg(err);
      log.claude.push({
        rotation: 0,
        dinsFound: 0,
        rawTextSnippet: "",
        error: detail,
      });
      // Fall through to tesseract; skip parallel rotations since
      // Anthropic is failing.
    }

    // Rotations 90/180/270 in parallel. Only runs if rotation 0
    // returned zero DINs AND didn't throw.
    if (!claudeFailed && log.claude[0] && log.claude[0].dinsFound === 0) {
      const rotatedAttempts = await Promise.allSettled(
        ([90, 180, 270] as const).map(async (rotation) => {
          const frameBytes = await rotateImage(workingBytes, rotation);
          const { dins, rawText } = await callClaudeOnImage(
            frameBytes,
            "image/jpeg",
            credentials
          );
          return { rotation, dins, rawText };
        })
      );

      for (const outcome of rotatedAttempts) {
        if (outcome.status === "fulfilled") {
          captureStes(outcome.value.rawText);
          log.claude.push({
            rotation: outcome.value.rotation,
            dinsFound: outcome.value.dins.length,
            rawTextSnippet: outcome.value.rawText.slice(0, 500),
          });
        } else {
          claudeFailed = true;
          log.claude.push({
            rotation: 0,
            dinsFound: 0,
            rawTextSnippet: "",
            error: `parallel rotation failed: ${errMsg(outcome.reason)}`,
          });
        }
      }

      // Pick the first fulfilled rotation with DINs.
      const winner = rotatedAttempts.find(
        (o): o is PromiseFulfilledResult<{
          rotation: 90 | 180 | 270;
          dins: DinMatch[];
          rawText: string;
        }> => o.status === "fulfilled" && o.value.dins.length > 0
      );
      if (winner) {
        log.finalExtractor = "claude";
        return finalize(winner.value.dins, log, { claudeAttempted, claudeFailed }, steIdsFound);
      }
    }
  }

  // Step 4 — tesseract fallback (single pass, image already normalized).
  try {
    const rawText = await tesseractRecognize(workingBytes);
    captureStes(rawText);
    const dins = collectDinsFromText(rawText, "tesseract");
    log.tesseract = {
      rotation: 0,
      dinsFound: dins.length,
      rawTextSnippet: rawText.slice(0, 500),
    };
    if (dins.length > 0) {
      log.finalExtractor = "tesseract";
      return finalize(dins, log, { claudeAttempted, claudeFailed }, steIdsFound);
    }
  } catch (err) {
    log.tesseract = {
      rotation: 0,
      dinsFound: 0,
      rawTextSnippet: "",
      error: `tesseract failed: ${errMsg(err)}`,
    };
  }

  return finalize([], log, { claudeAttempted, claudeFailed }, steIdsFound);
}

function finalize(
  dins: DinMatch[],
  log: ExtractorLog,
  flags: { claudeAttempted: boolean; claudeFailed: boolean },
  steIds: Set<string>
): DinExtractionResult {
  if (dins.length === 0 && log.finalExtractor === "none") {
    // Leave finalExtractor = "none" — signals "tried everything, got nothing"
  }
  return {
    dins,
    steIds: Array.from(steIds),
    claudeAttempted: flags.claudeAttempted,
    claudeFailed: flags.claudeFailed,
    log,
  };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const __test__ = {
  normalizeDin,
  collectDinsFromText,
  extractDinsFromQrPayload,
  extractSteIds,
  DIN_REGEX,
  TESLA_QR_REGEX,
  STE_ID_REGEX,
};
