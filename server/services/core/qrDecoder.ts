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

/**
 * Second-stage QR decoder: given bounding boxes produced by a
 * vision model (see `locateQrRegionsWithVision` in dinExtractor.ts),
 * crop each region FROM THE ORIGINAL image bytes at full resolution,
 * upscale the crop so the QR modules are large enough for jsqr,
 * then run jsqr on the result.
 *
 * This catches the wide-angle-inverter-cabinet case where the QR is
 * ~150 px wide in a 12 MP frame — too small after our uniform 1500 px
 * tile-search downsample, but decodable once we crop tight and
 * upscale the crop to ~1000 px.
 *
 * Coordinates are fractional (0.0 - 1.0) because the vision model
 * reasons about the image at its own internal resolution; we map
 * them to pixel coords against the original image.
 */
export async function decodeQrInRegions(
  originalBytes: Uint8Array,
  regions: Array<{ left: number; top: number; right: number; bottom: number }>
): Promise<QrDecodeResult> {
  if (regions.length === 0) return { payloads: [], attempts: 0 };

  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(Buffer.from(originalBytes)).rotate().metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    return { payloads: [], attempts: 0 };
  }
  if (width === 0 || height === 0) return { payloads: [], attempts: 0 };

  const jsqrMod = await import("jsqr");
  const jsqrCandidate =
    (jsqrMod as unknown as { default?: unknown }).default ?? jsqrMod;
  const jsQR = jsqrCandidate as JsQrFn;

  const runJsqr = (
    pixels: Uint8ClampedArray,
    w: number,
    h: number
  ): string | null => {
    try {
      const result = jsQR(pixels, w, h, {
        inversionAttempts: JSQR_INVERSION_MODE,
      });
      return result && typeof result.data === "string" && result.data.trim()
        ? result.data.trim()
        : null;
    } catch {
      return null;
    }
  };

  // ZXing is markedly more tolerant than jsqr on slight blur and
  // perspective distortion — exactly the regime where Claude-located
  // crops tend to live. Lazy-init once on first use.
  type ZxingReader = {
    decode: (pixels: Uint8ClampedArray, w: number, h: number) => string | null;
  };
  let zxingReader: ZxingReader | null = null;
  const getZxing = async (): Promise<ZxingReader> => {
    if (zxingReader) return zxingReader;
    const mod = await import("@zxing/library");
    const { BinaryBitmap, HybridBinarizer, RGBLuminanceSource, MultiFormatReader, DecodeHintType, BarcodeFormat, NotFoundException } = mod;
    const reader = new MultiFormatReader();
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
    zxingReader = {
      decode: (pixels, w, h) => {
        try {
          const len = pixels.length / 4;
          const argb = new Int32Array(len);
          for (let i = 0; i < len; i += 1) {
            const r = pixels[i * 4];
            const g = pixels[i * 4 + 1];
            const b = pixels[i * 4 + 2];
            argb[i] = (0xff << 24) | (r << 16) | (g << 8) | b;
          }
          const source = new RGBLuminanceSource(argb, w, h);
          const binary = new BinaryBitmap(new HybridBinarizer(source));
          const result = reader.decode(binary, hints);
          const text = result.getText();
          return text && text.trim() ? text.trim() : null;
        } catch (err) {
          if (err instanceof NotFoundException) return null;
          return null;
        }
      },
    };
    return zxingReader;
  };

  // Filter bboxes that are obviously too small to contain a
  // decodable QR at source resolution. Claude occasionally points
  // at compliance-mark stickers or small logos as "QR-like", and
  // those bboxes waste a sharp.extract() + decode cycle.
  const MIN_BBOX_PIXELS = 80;
  const filteredRegions = regions.filter((r) => {
    const wPx = Math.round((r.right - r.left) * width);
    const hPx = Math.round((r.bottom - r.top) * height);
    return Math.max(wPx, hPx) >= MIN_BBOX_PIXELS;
  });
  if (filteredRegions.length === 0) return { payloads: [], attempts: 0 };

  const CROP_TARGET_PX = 1000;
  // Bumped 10% → 25%. QR codes require a "quiet zone" (unprinted
  // border ≥ 4 modules). Claude tends to draw snug bboxes right
  // around the printed modules, which leaves no quiet zone and
  // makes decoders reject the code even when every pixel is
  // perfectly clear. 25% padding gives ~4 modules of whitespace on
  // all sides for a typical sticker.
  const BBOX_PAD = 0.25;

  let attempts = 0;
  for (let i = 0; i < filteredRegions.length; i += 1) {
    const region = filteredRegions[i];
    const leftFrac = Math.max(0, region.left - BBOX_PAD);
    const topFrac = Math.max(0, region.top - BBOX_PAD);
    const rightFrac = Math.min(1, region.right + BBOX_PAD);
    const bottomFrac = Math.min(1, region.bottom + BBOX_PAD);

    const left = Math.floor(leftFrac * width);
    const top = Math.floor(topFrac * height);
    const cropW = Math.max(1, Math.floor((rightFrac - leftFrac) * width));
    const cropH = Math.max(1, Math.floor((bottomFrac - topFrac) * height));
    if (cropW <= 0 || cropH <= 0) continue;

    const longEdge = Math.max(cropW, cropH);
    const scale = longEdge < CROP_TARGET_PX ? CROP_TARGET_PX / longEdge : 1;
    const outW = Math.round(cropW * scale);
    const outH = Math.round(cropH * scale);

    let pixels: Uint8ClampedArray;
    let frameW = 0;
    let frameH = 0;
    try {
      const { data: raw, info } = await sharp(Buffer.from(originalBytes), {
        failOn: "none",
      })
        .rotate()
        .extract({ left, top, width: cropW, height: cropH })
        .resize({
          width: outW,
          height: outH,
          fit: "fill",
          kernel: "lanczos3",
        })
        .toColorspace("srgb")
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      pixels = new Uint8ClampedArray(raw.length);
      pixels.set(raw);
      frameW = info.width;
      frameH = info.height;
    } catch {
      continue;
    }

    attempts += 1;
    const jsqrPayload = runJsqr(pixels, frameW, frameH);
    if (jsqrPayload) {
      return {
        payloads: [jsqrPayload],
        attempts,
        winningStrategy: `jsqr locator-crop ${i} (${left},${top} ${cropW}x${cropH} → ${outW}x${outH})`,
      };
    }

    // ZXing fallback on the same crop. Separate attempt count so
    // ZXing decodes are visible in the log independent of jsqr.
    const zxing = await getZxing();
    attempts += 1;
    const zxingPayload = zxing.decode(pixels, frameW, frameH);
    if (zxingPayload) {
      return {
        payloads: [zxingPayload],
        attempts,
        winningStrategy: `zxing locator-crop ${i} (${left},${top} ${cropW}x${cropH} → ${outW}x${outH})`,
      };
    }
  }

  return { payloads: [], attempts };
}
