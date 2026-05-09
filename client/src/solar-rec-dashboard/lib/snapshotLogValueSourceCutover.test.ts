import { describe, expect, it } from "vitest";
import {
  findValueSourceCutoverLabel,
  type CutoverCandidate,
} from "./snapshotLogValueSourceCutover";

function row(
  label: string,
  valueSource: CutoverCandidate["valueSource"]
): CutoverCandidate {
  return { label, valueSource };
}

describe("findValueSourceCutoverLabel", () => {
  it("returns null for an empty array (no entries → no marker)", () => {
    expect(findValueSourceCutoverLabel([])).toBeNull();
  });

  it("returns null when no entry has valueSource === 'slim' (fully pre-cutover)", () => {
    expect(
      findValueSourceCutoverLabel([
        row("4/1", "row-walk"),
        row("4/8", "row-walk"),
        row("4/15", null),
      ])
    ).toBeNull();
  });

  it("returns null when the FIRST entry is already slim (fully post-cutover, no discontinuity)", () => {
    expect(
      findValueSourceCutoverLabel([
        row("5/1", "slim"),
        row("5/8", "slim"),
      ])
    ).toBeNull();
  });

  it("returns the label of the first slim entry when prior entries are row-walk", () => {
    expect(
      findValueSourceCutoverLabel([
        row("4/1", "row-walk"),
        row("4/8", "row-walk"),
        row("4/15", "slim"), // cutover lands here
        row("4/22", "slim"),
      ])
    ).toBe("4/15");
  });

  it("returns the label of the first slim entry when prior entries are null (pre-FU-4)", () => {
    expect(
      findValueSourceCutoverLabel([
        row("4/1", null),
        row("4/8", null),
        row("4/15", "slim"),
      ])
    ).toBe("4/15");
  });

  it("treats undefined as 'not slim' (defensive: matches the missing-field case)", () => {
    expect(
      findValueSourceCutoverLabel([
        row("4/1", undefined),
        row("4/8", "slim"),
      ])
    ).toBe("4/8");
  });

  it("interleaved entries (e.g. localStorage import) — marker lands at the first slim chronologically", () => {
    // The trend-row builder sorts by `createdAt` upstream, so by
    // the time these reach this helper they're already
    // chronological. Pinning the helper's behavior on the
    // chronologically-ordered shape.
    expect(
      findValueSourceCutoverLabel([
        row("4/1", "row-walk"),
        row("5/1", "slim"),
        row("6/1", "row-walk"), // out-of-order legacy entry restored from localStorage
        row("7/1", "slim"),
      ])
    ).toBe("5/1");
  });

  it("only the FIRST slim entry triggers the marker — subsequent rows are ignored", () => {
    // The cutover is a single point in time; subsequent rows
    // either confirm the post-cutover state or (in pathological
    // cases) regress, but the marker doesn't move.
    const result = findValueSourceCutoverLabel([
      row("4/1", "row-walk"),
      row("4/15", "slim"),
      row("5/1", "row-walk"),
      row("6/1", "slim"),
    ]);
    expect(result).toBe("4/15");
  });
});
