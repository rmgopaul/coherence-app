/**
 * QR-code decoding for DIN extraction.
 *
 * Tesla / SolarEdge / Enphase / etc. inverter labels print a QR code
 * right next to the DIN that encodes the same DIN in machine-readable
 * form. QR is deterministic — if we decode it, we have ground truth,
 * and never need to trust a vision model's reading of sticker text.
 *
 * Field photos are hostile to QR decoders:
 *   - The QR is typically 5-10% of the frame (small sticker in a
 *     corner, surrounded by wiring / cabinet internals).
 *   - Autofocus is imperfect; edges may be slightly soft.
 *   - Lighting is uneven (glare, shadow, reflective laminate).
 *   - The photo may contain unrelated rectangles that look like
 *     finder patterns to a naive decoder.
 *
 * Strategy — run the two best open-source decoders against multiple
 * regions of the image, accepting the first success. Order of
 * attempts:
 *
 *   1. jsqr on full image (1 call)
 *   2. jsqr on 2×2, 3×3, 4×4 overlapping tiles (4 + 9 + 16 = 29)
 *   3. If jsqr exhausted, repeat with ZXing, which has a more
 *      aggressive finder-pattern search and catches codes jsqr
 *      doesn't.
 *
 * Tiling matters because a QR that's 300 px in a 3024 px image fills
 * ~10% of the frame; in a 4×4 tile (756 px per side) it fills ~40%,
 * which is well above either decoder's detection threshold.
 *
 * We do NOT apply normalize() or sharpen() preprocessing. Both hurt
 * QR decoding: sharpen() creates halos around high-contrast edges
 * that smear the 1-module-wide bars; normalize() skews the
 * luminance histogram in ways that can invert the finder patterns.
 * Decoders have their own adaptive-threshold layer — feed them raw
 * luminance and let them do their job.
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
export async function decodeQrPayloads(
  data: Uint8Array
): Promise<QrDecodeResult> {
  const sharpMod = await import("sharp");
  const sharp = sharpMod.default;

  // Read dimensions after EXIF rotation so our crop math is correct.
  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(Buffer.from(data)).rotate().metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    return { payloads: [], attempts: 0 };
  }
  if (width === 0 || height === 0) {
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

      const { data: raw, info } = await sharp(Buffer.from(data), { failOn: "none" })
        .rotate()
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
      // Allocate fresh Uint8ClampedArray — the Buffer we got back
      // is backed by Node's internal pool, which can cause weird
      // sharing issues if multiple tiles run in parallel.
      const pixels = new Uint8ClampedArray(raw.length);
      pixels.set(raw);
      return { pixels, width: info.width, height: info.height };
    } catch {
      return null;
    }
  };

  // Lazy-load decoders once.
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

  // ZXing is initialized lazily on first use — heavier than jsqr to
  // spin up, so we only pay the cost when jsqr has already failed.
  let zxingReader: { decode: (frame: {
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
  }) => string | null } | null = null;
  const getZxing = async () => {
    if (zxingReader) return zxingReader;
    const mod = await import("@zxing/library");
    const { BinaryBitmap, HybridBinarizer, RGBLuminanceSource, MultiFormatReader, DecodeHintType, BarcodeFormat, NotFoundException } = mod;
    const reader = new MultiFormatReader();
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
    zxingReader = {
      decode: (frame) => {
        try {
          // RGBLuminanceSource takes Int32Array of 0xRRGGBBAA pixels.
          const len = frame.pixels.length / 4;
          const argbArr = new Int32Array(len);
          for (let i = 0; i < len; i++) {
            const r = frame.pixels[i * 4];
            const g = frame.pixels[i * 4 + 1];
            const b = frame.pixels[i * 4 + 2];
            argbArr[i] = (0xff << 24) | (r << 16) | (g << 8) | b;
          }
          const source = new RGBLuminanceSource(argbArr, frame.width, frame.height);
          const binary = new BinaryBitmap(new HybridBinarizer(source));
          const result = reader.decode(binary, hints);
          const text = result.getText();
          return text && text.trim() ? text.trim() : null;
        } catch (err) {
          if (err instanceof NotFoundException) return null;
          // Other errors: swallow and treat as miss.
          return null;
        }
      },
    };
    return zxingReader;
  };

  // Generate the list of regions to try, from largest (whole frame)
  // to smallest (4×4 with overlap). Each region = {left, top, w, h}.
  type Region = { left: number; top: number; w: number; h: number; label: string };
  const regions: Region[] = [
    { left: 0, top: 0, w: width, h: height, label: "full" },
  ];
  for (const grid of [2, 3, 4] as const) {
    const tileW = Math.ceil(width / grid);
    const tileH = Math.ceil(height / grid);
    // 30% overlap between tiles so QRs on tile boundaries still fit
    // cleanly inside at least one tile.
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

  // Pass 1: jsqr across every region.
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

  // Pass 2: ZXing across every region. More robust but slower to init.
  const zxing = await getZxing();
  for (const region of regions) {
    const frame = await extractRgba(region.left, region.top, region.w, region.h);
    if (!frame) continue;
    attempts += 1;
    const payload = zxing.decode(frame);
    if (payload) {
      return {
        payloads: [payload],
        attempts,
        winningStrategy: `zxing ${region.label}`,
      };
    }
  }

  return { payloads: [], attempts };
}
