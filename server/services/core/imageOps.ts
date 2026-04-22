/**
 * sharp-based image preprocessing for the DIN extractor.
 *
 * Two distinct pipelines live here:
 *
 * - `normalizeForExtraction` prepares an image for the vision / OCR
 *   paths: honor EXIF, upscale small images, re-encode as JPEG so
 *   everything downstream sees a consistent format.
 *
 * - `preprocessForQr` / `decodeQrOnPixels` / `sliceTiles` together
 *   make the QR decoder succeed on real-world photos. QR detection
 *   is a different problem from OCR — the decoder needs very high
 *   black/white contrast and the finder patterns need to be large
 *   relative to the surrounding image. Running jsqr on a raw
 *   iPhone JPEG of a busy inverter enclosure almost always fails
 *   even when the QR is plainly readable to a human.
 *
 * sharp is lazy-imported everywhere because it ships a ~30 MB
 * native binary we don't want on cold module load.
 */

export type NormalizedImage = {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
};

/**
 * Apply EXIF rotation and upscale small images. Output is always
 * JPEG so downstream code has one format to handle.
 */
export async function normalizeForExtraction(
  data: Uint8Array,
  _mimeType: string
): Promise<NormalizedImage> {
  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  const pipeline = sharp(Buffer.from(data), { failOn: "none" }).rotate();
  const meta = await pipeline.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const longEdge = Math.max(width, height);
  const MIN_LONG_EDGE = 2000;
  let output = pipeline;
  if (longEdge > 0 && longEdge < MIN_LONG_EDGE) {
    const scale = MIN_LONG_EDGE / longEdge;
    output = output.resize({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      fit: "fill",
      kernel: "lanczos3",
    });
  }

  const buffer = await output.jpeg({ quality: 90 }).toBuffer({
    resolveWithObject: true,
  });

  return {
    data: new Uint8Array(buffer.data),
    mimeType: "image/jpeg",
    width: buffer.info.width,
    height: buffer.info.height,
  };
}

/**
 * Rotate a JPEG by 90/180/270°. Used by the Claude rotation-retry
 * loop when the upright pass returns no DINs.
 */
export async function rotateImage(
  data: Uint8Array,
  degrees: 90 | 180 | 270
): Promise<Uint8Array> {
  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  const rotated = await sharp(Buffer.from(data), { failOn: "none" })
    .rotate(degrees)
    .jpeg({ quality: 90 })
    .toBuffer();

  return new Uint8Array(rotated);
}

/* --------------------------------------------------------------------- */
/*  QR-specific helpers                                                   */
/* --------------------------------------------------------------------- */

export type QrImageFrame = {
  pixels: Uint8ClampedArray; // RGBA, 4 bytes per pixel
  width: number;
  height: number;
};

/**
 * Produce a high-contrast RGBA pixel frame optimized for jsqr:
 *   - grayscale (QR codes are black-and-white anyway — color info is noise)
 *   - linear contrast boost via sharp.normalize()
 *   - mild sharpen to make the 1-pixel-wide QR modules crisp
 *   - ensureAlpha so the output really is 4 bytes per pixel
 *
 * Keeps the original resolution — jsqr scales internally. Caller is
 * responsible for tiling if the source image is very large.
 */
export async function preprocessForQr(
  data: Uint8Array
): Promise<QrImageFrame> {
  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  const { data: raw, info } = await sharp(Buffer.from(data), { failOn: "none" })
    .rotate()
    .grayscale()
    .normalize()
    .sharpen()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return bufferToRgbaFrame(raw, info.width, info.height);
}

/**
 * Slice a prepared RGBA frame into a `cols × rows` grid of
 * overlapping tiles, each tile expressed in the same RGBA format
 * jsqr expects. Overlap is given as a fraction of the tile size
 * (so 0.25 means each tile overlaps its neighbors by 25 %). Tiling
 * is the critical trick for finding small QRs in wide-angle field
 * photos.
 */
export async function sliceTiles(
  frame: QrImageFrame,
  cols: number,
  rows: number,
  overlap: number
): Promise<QrImageFrame[]> {
  // sharp.extract() operates on encoded bytes, not raw RGBA, so
  // re-encode once then extract each tile.
  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  const encoded = await sharp(Buffer.from(frame.pixels), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .png({ compressionLevel: 1 })
    .toBuffer();

  const baseW = Math.floor(frame.width / cols);
  const baseH = Math.floor(frame.height / rows);
  const overlapW = Math.floor(baseW * overlap);
  const overlapH = Math.floor(baseH * overlap);
  const tileW = Math.min(frame.width, baseW + overlapW * 2);
  const tileH = Math.min(frame.height, baseH + overlapH * 2);

  const tiles: QrImageFrame[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const left = Math.max(0, c * baseW - overlapW);
      const top = Math.max(0, r * baseH - overlapH);
      const width = Math.min(tileW, frame.width - left);
      const height = Math.min(tileH, frame.height - top);
      if (width <= 0 || height <= 0) continue;

      const { data: raw, info } = await sharp(encoded)
        .extract({ left, top, width, height })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      tiles.push(bufferToRgbaFrame(raw, info.width, info.height));
    }
  }
  return tiles;
}

/**
 * Run jsqr on a single RGBA frame. Returns every decoded payload
 * (usually at most one per frame).
 */
export async function decodeQrOnPixels(
  frame: QrImageFrame
): Promise<string[]> {
  const jsqrMod = await import("jsqr");
  // jsqr is CJS; ESM interop puts the callable at .default.
  const candidate =
    (jsqrMod as unknown as { default?: unknown }).default ?? jsqrMod;
  const jsQR = candidate as (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options?: { inversionAttempts?: "attemptBoth" | "dontInvert" | "onlyInvert" | "invertFirst" }
  ) => { data: string } | null;

  try {
    const result = jsQR(frame.pixels, frame.width, frame.height, {
      inversionAttempts: "attemptBoth",
    });
    if (result && typeof result.data === "string" && result.data.trim()) {
      return [result.data.trim()];
    }
  } catch (err) {
    // jsqr occasionally throws on malformed pixel data — treat as miss.
    console.warn(
      "[imageOps] jsqr threw:",
      err instanceof Error ? err.message : err
    );
  }
  return [];
}

function bufferToRgbaFrame(
  raw: Buffer,
  width: number,
  height: number
): QrImageFrame {
  // Allocate a fresh Uint8ClampedArray so the pixels are decoupled
  // from sharp's internal Buffer pool. Without this, two tiles sharing
  // the same underlying ArrayBuffer can interfere with each other
  // when processed in parallel later.
  const pixels = new Uint8ClampedArray(raw.length);
  pixels.set(raw);
  return { pixels, width, height };
}
