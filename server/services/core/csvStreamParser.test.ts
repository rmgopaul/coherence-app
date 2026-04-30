import { describe, expect, it } from "vitest";
import { parseCsvTextStreaming } from "./csvStreamParser";
import { parseCsvText } from "../../routers/helpers/scheduleB";

// `parseCsvTextStreaming` mirrors `parseCsvText`'s semantics one
// chunk at a time. These tests pin the row-level output against
// the reference implementation. The actual file-streaming
// generator (`streamCsvRowsFromFile`) reuses the same internal
// state machine, so parity here implies parity end-to-end.

function expectParity(text: string) {
  const reference = parseCsvText(text);
  const streamed = parseCsvTextStreaming(text);
  expect(streamed.headers).toEqual(reference.headers);
  expect(streamed.rows).toEqual(reference.rows);
}

describe("parseCsvTextStreaming", () => {
  it("returns empty headers/rows for empty input", () => {
    expectParity("");
  });

  it("parses a simple header + 2 rows", () => {
    expectParity("a,b,c\n1,2,3\n4,5,6\n");
  });

  it("handles CRLF line endings", () => {
    expectParity("a,b\r\n1,2\r\n3,4\r\n");
  });

  it("handles CR-only line endings", () => {
    expectParity("a,b\r1,2\r3,4");
  });

  it("handles trailing row without newline", () => {
    expectParity("a,b\n1,2\n3,4");
  });

  it("preserves quoted cells with commas + quotes", () => {
    expectParity('a,b\n"hello, world","she said ""hi"""\n');
  });

  it("preserves quoted cells spanning multiple lines", () => {
    expectParity('a,b\n"line1\nline2",ok\n');
  });

  it("drops fully-empty rows", () => {
    expectParity("a,b\n\n1,2\n,\n3,4\n\n");
  });

  it("trims + drops empty headers but keeps row cells positionally aligned", () => {
    // INTENTIONAL DIVERGENCE from `parseCsvText`. The reference
    // helper filters the headers array (drops empty strings) but
    // keeps the row-cell access by FILTERED index, which shifts
    // cells by the count of dropped headers — a latent positional-
    // alignment bug. The streaming parser keeps the headers array
    // index-aligned with row cells (empty-header columns are
    // skipped at projection time, not by pre-filtering the array),
    // so cells line up under their actual headers.
    //
    // Real production CSVs (solar vendor + portal exports) never
    // have empty header columns, so the divergence doesn't change
    // any user-visible behavior — but the streaming version is
    // the semantically correct one.
    const result = parseCsvTextStreaming(" name , , age \n a , skip , 1 \n");
    expect(result.headers).toEqual(["name", "age"]);
    expect(result.rows).toEqual([{ name: " a ", age: " 1 " }]);
  });

  it("yields empty when only headers are present", () => {
    expectParity("a,b,c\n");
  });

  it("handles 1k-row CSV (smoke test for chunk-boundary edge cases)", () => {
    const lines = ["name,value"];
    for (let i = 0; i < 1000; i += 1) {
      lines.push(`row${i},${i}`);
    }
    expectParity(lines.join("\n"));
  });

  it("handles a row with a quoted cell containing only quotes (escape stress)", () => {
    expectParity('a,b\n"""triple""",ok\n');
  });
});
