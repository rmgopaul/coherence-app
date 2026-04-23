/**
 * QR-code decoding for DIN extraction.
 *
 * Tesla / SolarEdge / Enphase / etc. inverter labels print a QR code
 * right next to the DIN that encodes the same DIN in machine-readable
 * form. QR is deterministic — if we decode it, we have ground truth,
 * and never need to trust a vision model's reading of sticker text.
 *
 * Performance matters hugely here. iPhone photos are 12 MP (~3024 ×
 * 4032). Running jsqr + tile extraction at that resolution is ~30 s
 * per photo. On a 9-photo site with no-QR photos present, that
 * compounds to 4-5 minutes per site before any Claude call. For
 * batch jobs we need to stay under 30 s per photo worst case.
 *
 * Current strategy:
 *
 *   1. Downsample to max 1500 px on the long edge. QR modules at
 *      that resolution are still 5-10 px wide — well above jsqr's
 *      detection floor — and sharp.extract() runs 4× faster.
 *   2. Try full image + 2×2 + 3×3 overlapping tiles (1 + 4 + 9 = 14
 *      regions). A QR that's 10% of the frame fills ~30% of a 3×3
 *      tile, which is plenty.
 *   3. jsqr only. Earlier versions also ran ZXing as a fallback,
 *      but jsqr is proven to decode these Tesla codes (see
 *      production logs) and ZXing adds 15+ s per miss without
 *      catching anything jsqr doesn't.
 *
 * No preprocessing (normalize / sharpen) — both damage the 1-module-
 * wide bars. Decoders have their own adaptive threshold stage.
 */

const JSQR_INVERSION_MODE = "attemptBoth" as const;

type JsQrFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: "attemptBoth" | "dontInvert" | "onlyInvert" | "invertFirst" }
) => { data: string } | null;

export type QrDecodeResult = {
  payloads: string[];
  attempts: number;
  /** Which decoder+region combo succeeded, for debugging. */
  winningStrategy?: string;
};

/**
 * Top-level entry. Returns every distinct QR payload decoded from
 * the image, along with how many decoder invocations we made before
 * finding one (or giving up).
 */
// Max long-edge pixel count we feed to the QR pipeline. Anything
// larger gets downsampled once up front; QR modules remain well
// above jsqr's ~5 px detection threshold at this resolution, and
// sharp.extract() is ~4× faster on the downsampled image.
const QR_WORKING_LONG_EDGE = 1500;

export async function decodeQrPayloads(
  data: Uint8Array
): Promise<QrDecodeResult> {
  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  // One-time: honor EXIF, downsample to QR_WORKING_LONG_EDGE, and
  // re-encode as JPEG. Every region extract downstream operates on
  // THIS buffer, not the original 12 MP input.
  let workingBytes: Buffer;
  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(Buffer.from(data)).rotate().metadata();
    const rawW = meta.width ?? 0;
    const rawH = meta.height ?? 0;
    if (rawW === 0 || rawH === 0) {
      return { payloads: [], attempts: 0 };
    }
    const longEdge = Math.max(rawW, rawH);
    const downsampleScale =
      longEdge > QR_WORKING_LONG_EDGE ? QR_WORKING_LONG_EDGE / longEdge : 1;

    const pipeline = sharp(Buffer.from(data), { failOn: "none" }).rotate();
    const scaled =
      downsampleScale < 1
        ? pipeline.resize({
            width: Math.round(rawW * downsampleScale),
            height: Math.round(rawH * downsampleScale),
            fit: "fill",
            kernel: "lanczos3",
          })
        : pipeline;

    const { data: jpeg, info } = await scaled
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    workingBytes = jpeg;
    width = info.width;
    height = info.height;
  } catch {
    return { payloads: [], attempts: 0 };
  }

  const extractRgba = async (
    left: number,
    top: number,
    w: number,
    h: number
  ): Promise<{ pixels: Uint8ClampedArray; width: number; height: number } | null> => {
    try {
      const clampedLeft = Math.max(0, Math.min(left, width - 1));
      const clampedTop = Math.max(0, Math.min(top, height - 1));
      const clampedW = Math.max(1, Math.min(w, width - clampedLeft));
      const clampedH = Math.max(1, Math.min(h, height - clampedTop));

      const { data: raw, info } = await sharp(workingBytes, { failOn: "none" })
        .extract({
          left: clampedLeft,
          top: clampedTop,
          width: clampedW,
          height: clampedH,
        })
        .toColorspace("srgb")
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pixels = new Uint8ClampedArray(raw.length);
      pixels.set(raw);
      return { pixels, width: info.width, height: info.height };
    } catch {
      return null;
    }
  };

  const jsqrMod = await import("jsqr");
  const jsqrCandidate =
    (jsqrMod as unknown as { default?: unknown }).default ?? jsqrMod;
  const jsQR = jsqrCandidate as JsQrFn;

  const runJsqr = (
    frame: { pixels: Uint8ClampedArray; width: number; height: number }
  ): string | null => {
    try {
      const result = jsQR(frame.pixels, frame.width, frame.height, {
        inversionAttempts: JSQR_INVERSION_MODE,
      });
      return result && typeof result.data === "string" && result.data.trim()
        ? result.data.trim()
        : null;
    } catch {
      return null;
    }
  };

  // Region plan: full + 2×2 + 3×3 = 14 regions. Previous 4×4 layer
  // (16 more regions) never caught a QR that 3×3 missed in
  // production logs, so we dropped it to save ~15 s per miss.
  type Region = { left: number; top: number; w: number; h: number; label: string };
  const regions: Region[] = [
    { left: 0, top: 0, w: width, h: height, label: "full" },
  ];
  for (const grid of [2, 3] as const) {
    const tileW = Math.ceil(width / grid);
    const tileH = Math.ceil(height / grid);
    const overlap = 0.3;
    const stepW = Math.max(1, Math.round(tileW * (1 - overlap)));
    const stepH = Math.max(1, Math.round(tileH * (1 - overlap)));
    for (let y = 0; y + tileH <= height + stepH; y += stepH) {
      for (let x = 0; x + tileW <= width + stepW; x += stepW) {
        regions.push({
          left: x,
          top: y,
          w: tileW,
          h: tileH,
          label: `${grid}x${grid}@(${x},${y})`,
        });
      }
    }
  }

  let attempts = 0;
  for (const region of regions) {
    const frame = await extractRgba(region.left, region.top, region.w, region.h);
    if (!frame) continue;
    attempts += 1;
    const payload = runJsqr(frame);
    if (payload) {
      return {
        payloads: [payload],
        attempts,
        winningStrategy: `jsqr ${region.label}`,
      };
    }
  }

  return { payloads: [], attempts };
}
