/**
 * QR-code decoding for DIN extraction.
 *
 * Modern inverter/meter labels print "Scan QR to Commission" with a
 * QR code that encodes the DIN, Wi-Fi SSID, and password. Decoding
 * the QR is deterministic — orders of magnitude more reliable than
 * asking a vision model to read digits off a sticker at an angle.
 *
 * Real-world QR codes in field photos are hard:
 * - The QR is often 5–10 % of the total frame, surrounded by cables,
 *   wiring diagrams, and other stickers that look like QR finder
 *   patterns to jsqr.
 * - Phones auto-rotate on EXIF; downloaded bytes may be pre-rotated.
 * - Lighting and glare wash out the black/white contrast jsqr relies on.
 *
 * The strategy here is "try hard before giving up":
 *
 *   1. Preprocess the full image for high-contrast QR edges
 *      (grayscale → Otsu-style normalization → mild sharpen).
 *   2. Scan the full image at multiple scales.
 *   3. Tile: 2×2 and 3×3 overlapping crops, scan each.
 *
 * All attempts are logged on the returned rotationTried list so the
 * extractor log shows how hard we tried before falling back to Claude.
 */

import { decodeQrOnPixels, preprocessForQr, sliceTiles } from "./imageOps";

export type QrDecodeResult = {
  payloads: string[]; // raw text decoded from QR(s)
  attempts: number;   // how many tile/scale/rotation combos we tried
};

/**
 * Try to decode one or more QR codes from the image bytes. Returns
 * every distinct payload we could read across every attempt we made.
 * Empty `payloads` means no QR was legible under any strategy —
 * caller should fall through to the vision model path.
 */
export async function decodeQrPayloads(
  data: Uint8Array
): Promise<QrDecodeResult> {
  const payloads = new Set<string>();
  let attempts = 0;

  // One preprocessed master image — high-contrast grayscale is the
  // single biggest jsqr reliability win.
  const master = await preprocessForQr(data);

  // Pass 1: full image as-is.
  attempts += 1;
  const fromFull = await decodeQrOnPixels(master);
  for (const p of fromFull) payloads.add(p);
  if (payloads.size > 0) return { payloads: Array.from(payloads), attempts };

  // Pass 2: 2×2 overlapping tiles. A QR that occupies ~10 % of the
  // full image occupies ~30 % of a 2×2 tile — enough for jsqr's
  // finder-pattern detector to lock on.
  const tiles2 = await sliceTiles(master, 2, 2, 0.25);
  for (const tile of tiles2) {
    attempts += 1;
    const found = await decodeQrOnPixels(tile);
    for (const p of found) payloads.add(p);
    if (payloads.size > 0) return { payloads: Array.from(payloads), attempts };
  }

  // Pass 3: 3×3 overlapping tiles. Last resort for small QRs in
  // very busy scenes.
  const tiles3 = await sliceTiles(master, 3, 3, 0.3);
  for (const tile of tiles3) {
    attempts += 1;
    const found = await decodeQrOnPixels(tile);
    for (const p of found) payloads.add(p);
    if (payloads.size > 0) return { payloads: Array.from(payloads), attempts };
  }

  return { payloads: Array.from(payloads), attempts };
}
