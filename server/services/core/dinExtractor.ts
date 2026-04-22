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
import { decodeQrPayloads } from "./qrDecoder";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_VISION_TIMEOUT_MS = 60_000;
const ANTHROPIC_VISION_MAX_TOKENS = 2048;
// Sonnet 4.6 balances quality (scuffed field photos) and cost; users can
// override via the integration row's metadata.model.
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

  // Step 1 — PDFs get text extraction only; no rasterization.
  // Empirically, CSG portal PDFs are contracts / receipts / brochures
  // that don't contain DINs in image form, so the only useful thing
  // we can do is scan their embedded text.
  if (isPdf) {
    try {
      const fromText = await extractDinsFromPdfText(data);
      if (fromText.length > 0) {
        log.finalExtractor = "pdfjs";
        return finalize(fromText, log, { claudeAttempted: false, claudeFailed: false });
      }
    } catch (err) {
      log.tesseract = {
        rotation: 0,
        dinsFound: 0,
        rawTextSnippet: "",
        error: `pdfjs text extract failed: ${errMsg(err)}`,
      };
    }
    return finalize([], log, { claudeAttempted: false, claudeFailed: false });
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
    return finalize([], log, { claudeAttempted: false, claudeFailed: false });
  }

  // Step 2 — QR decode. If any decoded payload contains a DIN, we're
  // done. Zero cost, zero model hallucination risk. Runs a multi-scale
  // tiled search (see qrDecoder.ts) before giving up, because the
  // small-QR-in-busy-photo case is where jsqr usually whiffs.
  try {
    const qr = await decodeQrPayloads(workingBytes);
    const matched: DinMatch[] = [];
    for (const payload of qr.payloads) {
      matched.push(...collectDinsFromText(payload, "qr"));
    }
    log.qr = {
      payloads: qr.payloads,
      attempts: qr.attempts,
      matchedDins: matched.map((m) => m.dinValue),
    };
    if (matched.length > 0) {
      log.finalExtractor = "qr";
      return finalize(matched, log, { claudeAttempted: false, claudeFailed: false });
    }
  } catch (err) {
    log.qr = {
      payloads: [],
      attempts: 0,
      matchedDins: [],
      error: `qr decode failed: ${errMsg(err)}`,
    };
  }

  // Step 3 — Claude vision with rotation retry.
  let claudeAttempted = false;
  let claudeFailed = false;
  if (credentials.anthropicApiKey && isClaudeCompatibleImage(log.normalizedMimeType)) {
    claudeAttempted = true;
    log.claude = [];
    const rotations: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];

    for (const rotation of rotations) {
      let frameBytes: Uint8Array;
      try {
        frameBytes = rotation === 0 ? workingBytes : await rotateImage(workingBytes, rotation);
      } catch (err) {
        log.claude.push({
          rotation,
          dinsFound: 0,
          rawTextSnippet: "",
          error: `rotate failed: ${errMsg(err)}`,
        });
        continue;
      }

      try {
        const { dins, rawText } = await callClaudeOnImage(
          frameBytes,
          "image/jpeg",
          credentials
        );
        log.claude.push({
          rotation,
          dinsFound: dins.length,
          rawTextSnippet: rawText.slice(0, 500),
        });
        if (dins.length > 0) {
          log.finalExtractor = "claude";
          return finalize(dins, log, { claudeAttempted, claudeFailed });
        }
      } catch (err) {
        claudeFailed = true;
        const detail =
          err instanceof HttpClientError
            ? `${err.message} (status=${err.statusCode ?? "n/a"})`
            : errMsg(err);
        log.claude.push({
          rotation,
          dinsFound: 0,
          rawTextSnippet: "",
          error: detail,
        });
        // On HTTP-layer failures, stop rotating and let the runner's
        // circuit breaker decide what to do next.
        break;
      }
    }
  }

  // Step 4 — tesseract fallback (single pass, image already normalized).
  try {
    const rawText = await tesseractRecognize(workingBytes);
    const dins = collectDinsFromText(rawText, "tesseract");
    log.tesseract = {
      rotation: 0,
      dinsFound: dins.length,
      rawTextSnippet: rawText.slice(0, 500),
    };
    if (dins.length > 0) {
      log.finalExtractor = "tesseract";
      return finalize(dins, log, { claudeAttempted, claudeFailed });
    }
  } catch (err) {
    log.tesseract = {
      rotation: 0,
      dinsFound: 0,
      rawTextSnippet: "",
      error: `tesseract failed: ${errMsg(err)}`,
    };
  }

  return finalize([], log, { claudeAttempted, claudeFailed });
}

function finalize(
  dins: DinMatch[],
  log: ExtractorLog,
  flags: { claudeAttempted: boolean; claudeFailed: boolean }
): DinExtractionResult {
  if (dins.length === 0 && log.finalExtractor === "none") {
    // Leave finalExtractor = "none" — signals "tried everything, got nothing"
  }
  return {
    dins,
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
  DIN_REGEX,
};
