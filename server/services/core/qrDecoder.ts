/**
 * QR-code decoding for DIN extraction.
 *
 * Modern inverter and meter labels print "Scan QR to Commission" with
 * a QR code that encodes the DIN, Wi-Fi SSID, and password. Decoding
 * the QR is orders of magnitude more reliable than OCR:
 * - Zero cost (no model call)
 * - Deterministic (QR payloads are unambiguous, unlike glare-obscured
 *   sticker text)
 * - Works on rotated stickers (QR has its own orientation markers)
 *
 * We try the full image first, then rotate by 90/180/270 and retry —
 * small QR codes that are at a 45° angle to the camera sometimes
 * only decode after a square-aligned rotation.
 *
 * Payload formats observed in the wild:
 *   DIN:1538000-45-A---GF22300670002NB;PASS:abc;SSID:TEG-2NB
 *   tegos://commission?din=1538000-45-A---GF22300670002NB&pw=...
 *   plain "1538000-45-A---GF22300670002NB"
 * We run our DIN regex over whatever text comes out.
 */

import { decodeToRgba, rotateImage } from "./imageOps";

export type QrDecodeResult = {
  payloads: string[]; // raw text decoded from QR(s)
  rotationTried: Array<0 | 90 | 180 | 270>;
};

/**
 * Try to decode one or more QR codes from the image bytes. Returns
 * every distinct payload we could read, across rotation retries.
 * An empty `payloads` array means no QR was legible — the caller
 * should fall through to Claude/tesseract.
 */
export async function decodeQrPayloads(
  data: Uint8Array
): Promise<QrDecodeResult> {
  const jsqrMod = await import("jsqr");
  // jsQR's types package uses named export; the runtime module exposes
  // both default and named. Normalize.
  const jsQR =
    (jsqrMod as unknown as { default: typeof jsqrMod.default }).default ??
    (jsqrMod as unknown as { jsQR?: typeof jsqrMod.default }).jsQR ??
    (jsqrMod as unknown as typeof jsqrMod.default);

  const payloads = new Set<string>();
  const rotationsAttempted: Array<0 | 90 | 180 | 270> = [];

  const rotations: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];
  for (const angle of rotations) {
    rotationsAttempted.push(angle);
    try {
      const bytes = angle === 0 ? data : await rotateImage(data, angle);
      const { pixels, width, height } = await decodeToRgba(bytes);
      if (width <= 0 || height <= 0) continue;

      const result = jsQR(pixels, width, height, {
        inversionAttempts: "attemptBoth",
      });
      if (result && typeof result.data === "string" && result.data.trim()) {
        payloads.add(result.data.trim());
        // Found at least one QR at this rotation — return early. Most
        // photos have a single QR, and further rotations would
        // decode the same one (wasting CPU).
        return { payloads: Array.from(payloads), rotationTried: rotationsAttempted };
      }
    } catch (err) {
      // Sharp can throw on malformed inputs; swallow and try next angle.
      console.warn(
        `[qrDecoder] decode failed at rotation ${angle}°:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { payloads: [], rotationTried: rotationsAttempted };
}
