import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { extractContractDataFromPdfBuffer } from "./contractScannerServer";

const FIXTURE_PATH = resolve(
  __dirname,
  "../../../test-fixtures/REC-Agreement-todd-metz.pdf"
);

describe("extractContractDataFromPdfBuffer — CRGA Notice check", () => {
  it("detects CRGA Notice present on page 1", async () => {
    const pdf = readFileSync(FIXTURE_PATH);
    const result = await extractContractDataFromPdfBuffer(
      new Uint8Array(pdf),
      "REC-Agreement-todd-metz.pdf"
    );

    expect(result.crgaNoticePresent).toBe(true);
    expect(result.crgaNoticeMisplaced).toBe(false);
    expect(result.crgaNoticeFlag).toBeNull();
    // 30s timeout (vs vitest's 5s default): parsing the real
    // REC-Agreement fixture — pdfjs cold-start + embedded font data —
    // runs ~2s locally but intermittently exceeds 5s on the slower CI
    // runner, which left the `test` job persistently red across PRs.
    // The work is real PDF parsing, not a hang; a higher cap is the
    // correct fix.
  }, 30_000);

  it("flags missing notice when PDF has no CRGA Notice text", async () => {
    // Build a minimal valid PDF with no CRGA Notice text.
    // This is the smallest valid single-page PDF with just "Hello".
    const minimalPdf = buildMinimalPdf("Hello World — Cover Sheet A");
    const result = await extractContractDataFromPdfBuffer(
      new Uint8Array(minimalPdf),
      "no-notice.pdf"
    );

    expect(result.crgaNoticePresent).toBe(false);
    expect(result.crgaNoticeMisplaced).toBe(false);
    expect(result.crgaNoticeFlag).toBe(
      "CRGA Notice of Potential Changes missing from contract stack"
    );
    // Same 30s cap as the sibling test — both share the pdfjs parse
    // path that's slow to cold-start on CI.
  }, 30_000);
});

/**
 * Builds a minimal single-page PDF containing the given text.
 * Just enough structure for pdfjs-dist to parse it.
 */
function buildMinimalPdf(text: string): Buffer {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  const content = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const contentLength = Buffer.byteLength(content, "ascii");

  const lines = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj`,
    `4 0 obj << /Length ${contentLength} >> stream`,
    content,
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    `0000000${String(280).padStart(3, "0")} 00000 n `,
    `0000000${String(280 + contentLength + 44).padStart(3, "0")} 00000 n `,
    "trailer << /Size 6 /Root 1 0 R >>",
    "startxref",
    "9",
    "%%EOF",
  ];

  return Buffer.from(lines.join("\n"), "ascii");
}
