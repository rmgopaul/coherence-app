/**
 * sharp-based image preprocessing for the DIN extractor.
 *
 * Responsibilities:
 * - `normalizeForExtraction` prepares an image for the vision / OCR
 *   paths: honor EXIF, upscale small images, re-encode as JPEG so
 *   everything downstream sees a consistent format.
 * - `rotateImage` rotates a JPEG by 90/180/270 for the rotation-
 *   retry loop.
 *
 * QR decoding deliberately lives in `qrDecoder.ts` and does its own
 * region extraction against the original bytes — preprocessing QR
 * pixels with normalize/sharpen damaged the finder patterns.
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

