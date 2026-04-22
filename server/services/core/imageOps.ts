/**
 * sharp-based image preprocessing for the DIN extractor.
 *
 * Responsibilities:
 * - Honor EXIF orientation tags (phones lie constantly, and if we don't
 *   auto-rotate, Claude and tesseract see the raw sensor-orientation
 *   image instead of the intended-up-is-up image).
 * - Rotate by a fixed angle (0/90/180/270) for the rotation-retry loop.
 * - Upscale small photos so tesseract and Claude Vision have enough
 *   pixels to read small sticker text.
 * - Return raw RGBA pixel buffers for the QR-code decoder (jsqr needs
 *   a Uint8ClampedArray of width × height × 4 bytes).
 *
 * sharp is lazy-imported everywhere because it ships a ~30 MB native
 * binary and we don't want to pay that startup cost on cold imports.
 */

export type NormalizedImage = {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
};

/**
 * Apply EXIF rotation so the image is "up-is-up" for downstream
 * extractors, and encode to JPEG so every caller gets a consistent
 * format. This is the first step of any vision/OCR path.
 */
export async function normalizeForExtraction(
  data: Uint8Array,
  mimeType: string
): Promise<NormalizedImage> {
  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  const pipeline = sharp(Buffer.from(data), { failOn: "none" }).rotate(); // "rotate()" with no args honors EXIF
  const meta = await pipeline.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // Upscale small images — tesseract especially wants >= ~2000px on
  // the long edge for reliable sticker text recognition.
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
 * Rotate a JPEG/PNG by a fixed multiple of 90°. Returns a JPEG.
 * Used by the rotation-retry loop when the primary extraction at
 * 0° returns no DINs — many field photos have stickers mounted
 * sideways on the hardware.
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

/**
 * Decode an image to a raw RGBA pixel buffer sized exactly
 * width × height × 4 bytes. jsqr requires this format; it cannot
 * take JPEG/PNG bytes directly.
 *
 * Callers that want to attempt QR decoding on multiple rotations
 * should call `rotateImage` first, then pass the result here.
 */
export async function decodeToRgba(
  data: Uint8Array
): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> {
  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  const { data: raw, info } = await sharp(Buffer.from(data), { failOn: "none" })
    .rotate() // honor EXIF
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    pixels: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length),
    width: info.width,
    height: info.height,
  };
}
