/**
 * Rasterize a PDF into PNG page images for downstream vision/OCR.
 *
 * Anthropic's `type: "document"` block for PDFs has inconsistent
 * handling of embedded rotated photos — we see better results when
 * we render the PDF to an image ourselves and send that as an
 * `type: "image"` block. It also lets us apply the same rotation /
 * preprocessing pipeline we use for native-image photos, so the
 * code path is uniform.
 *
 * Uses `pdf-to-png-converter` (pure JS, wraps pdfjs-dist + its own
 * minimal canvas impl — no system deps, works on Render).
 */

export type PdfPageImage = {
  pageNumber: number;
  pngBytes: Uint8Array;
};

/**
 * Render each page of a PDF to PNG at a scale tuned for OCR — big
 * enough that sticker text is legible but small enough that the
 * base64-encoded payload fits well under Anthropic's 5 MB image
 * limit per content block.
 */
export async function rasterizePdfToPngs(
  data: Uint8Array,
  options?: { maxPages?: number; viewportScale?: number }
): Promise<PdfPageImage[]> {
  const maxPages = options?.maxPages ?? 4;
  const viewportScale = options?.viewportScale ?? 2; // ~144 DPI at default pdfjs units

  const mod = await import("pdf-to-png-converter");
  // Library exports the function as a named export in CJS and default
  // in ESM. Normalize.
  const pdfToPng =
    (mod as unknown as { pdfToPng?: Function }).pdfToPng ??
    (mod as unknown as { default: Function }).default;
  if (typeof pdfToPng !== "function") {
    throw new Error("pdf-to-png-converter did not expose a callable");
  }

  const pages = await pdfToPng(Buffer.from(data), {
    viewportScale,
    strictPagesToProcess: false,
    verbosityLevel: 0,
  });

  const out: PdfPageImage[] = [];
  for (const page of pages as Array<{ pageNumber: number; content: Buffer }>) {
    if (out.length >= maxPages) break;
    out.push({
      pageNumber: page.pageNumber,
      pngBytes: new Uint8Array(page.content),
    });
  }
  return out;
}
