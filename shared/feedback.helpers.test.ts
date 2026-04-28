/**
 * Phase E (2026-04-28) — tests for the shared feedback helpers used
 * by the admin review dashboard. Pure data shaping; no DOM, no DB.
 */
import { describe, expect, it } from "vitest";
import {
  filterFeedbackRows,
  sortFeedbackForReview,
  topPagePaths,
  type FeedbackRow,
} from "./feedback.helpers";

function row(overrides: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    id: overrides.id ?? "id-1",
    userId: overrides.userId ?? 1,
    pagePath: overrides.pagePath ?? "/dashboard",
    sectionId: overrides.sectionId ?? null,
    category: overrides.category ?? "improvement",
    note: overrides.note ?? "default note",
    status: overrides.status ?? "open",
    contextJson: overrides.contextJson ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-04-28T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-28T00:00:00Z"),
  };
}

describe("filterFeedbackRows", () => {
  it("returns every row when the filter is empty", () => {
    const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
    expect(filterFeedbackRows(rows, {})).toHaveLength(3);
  });

  it("treats 'all' on status / category as no-op", () => {
    const rows = [
      row({ id: "a", status: "open", category: "bug" }),
      row({ id: "b", status: "resolved", category: "improvement" }),
    ];
    expect(
      filterFeedbackRows(rows, { status: "all", category: "all" })
    ).toHaveLength(2);
  });

  it("filters by status", () => {
    const rows = [
      row({ id: "open-1", status: "open" }),
      row({ id: "open-2", status: "open" }),
      row({ id: "res", status: "resolved" }),
    ];
    const out = filterFeedbackRows(rows, { status: "open" });
    expect(out.map((r) => r.id)).toEqual(["open-1", "open-2"]);
  });

  it("filters by category", () => {
    const rows = [
      row({ id: "ui", category: "ui" }),
      row({ id: "bug", category: "bug" }),
      row({ id: "ui-2", category: "ui" }),
    ];
    const out = filterFeedbackRows(rows, { category: "ui" });
    expect(out.map((r) => r.id)).toEqual(["ui", "ui-2"]);
  });

  it("search matches note text case-insensitively", () => {
    const rows = [
      row({ id: "a", note: "Sidebar feels cramped" }),
      row({ id: "b", note: "Calendar widget is great" }),
    ];
    const out = filterFeedbackRows(rows, { search: "SIDEBAR" });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("search matches pagePath", () => {
    const rows = [
      row({ id: "a", pagePath: "/supplements" }),
      row({ id: "b", pagePath: "/dashboard" }),
    ];
    const out = filterFeedbackRows(rows, { search: "supplem" });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("search matches sectionId when present", () => {
    const rows = [
      row({ id: "a", sectionId: "section-todoist" }),
      row({ id: "b", sectionId: null }),
    ];
    const out = filterFeedbackRows(rows, { search: "todoist" });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("combines status + category + search with AND semantics", () => {
    const rows = [
      row({
        id: "match",
        status: "open",
        category: "bug",
        note: "Crash on save",
      }),
      // Same status + category but the search term doesn't match.
      row({
        id: "miss-search",
        status: "open",
        category: "bug",
        note: "Something else entirely",
      }),
      // Same search + category but wrong status.
      row({
        id: "miss-status",
        status: "resolved",
        category: "bug",
        note: "Crash on save",
      }),
    ];
    const out = filterFeedbackRows(rows, {
      status: "open",
      category: "bug",
      search: "crash",
    });
    expect(out.map((r) => r.id)).toEqual(["match"]);
  });

  it("trims whitespace-only search to a no-op", () => {
    const rows = [row({ id: "a" }), row({ id: "b" })];
    expect(filterFeedbackRows(rows, { search: "   " })).toHaveLength(2);
  });
});

describe("sortFeedbackForReview", () => {
  it("puts open / triaged / in-progress before resolved / wont-fix", () => {
    const rows = [
      row({ id: "resolved", status: "resolved" }),
      row({ id: "open", status: "open" }),
      row({ id: "wont", status: "wont-fix" }),
      row({ id: "in-progress", status: "in-progress" }),
    ];
    const sorted = sortFeedbackForReview(rows);
    const ids = sorted.map((r) => r.id);
    // The first two ids must be from the open/in-progress group
    // (relative order within the group is by createdAt — all same
    // here so we only assert grouping, not stability).
    expect(["open", "in-progress"]).toContain(ids[0]);
    expect(["open", "in-progress"]).toContain(ids[1]);
    expect(["resolved", "wont"]).toContain(ids[2]);
    expect(["resolved", "wont"]).toContain(ids[3]);
  });

  it("within a group, newer rows come first", () => {
    const rows = [
      row({
        id: "older",
        status: "open",
        createdAt: new Date("2026-04-01T00:00:00Z"),
      }),
      row({
        id: "newer",
        status: "open",
        createdAt: new Date("2026-04-28T00:00:00Z"),
      }),
    ];
    const sorted = sortFeedbackForReview(rows);
    expect(sorted.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  it("handles createdAt strings (TiDB → JSON-serialized roundtrip)", () => {
    // tRPC serializes Date through superjson, but a fallback path
    // (e.g. cached browser snapshot) may send strings. The sort
    // must not throw and must still order strictly.
    const rows = [
      row({
        id: "older",
        status: "open",
        createdAt: "2026-04-10T00:00:00Z",
      }),
      row({
        id: "newer",
        status: "open",
        createdAt: "2026-04-28T00:00:00Z",
      }),
    ];
    const sorted = sortFeedbackForReview(rows);
    expect(sorted.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  it("does not mutate the input", () => {
    const input = [
      row({ id: "a", status: "resolved" }),
      row({ id: "b", status: "open" }),
    ];
    const before = input.map((r) => r.id).join(",");
    sortFeedbackForReview(input);
    const after = input.map((r) => r.id).join(",");
    expect(after).toBe(before);
  });

  it("groups unknown status values with the actionable bucket (defensive)", () => {
    // A typo / migrated-old status shouldn't sink to the bottom and
    // get hidden — surface it where the reviewer can see it.
    const rows = [
      row({ id: "resolved", status: "resolved" }),
      row({ id: "wat", status: "WIP" }),
    ];
    const sorted = sortFeedbackForReview(rows);
    expect(sorted[0].id).toBe("wat");
  });
});

describe("topPagePaths", () => {
  it("returns descending counts of distinct page paths", () => {
    const rows = [
      row({ id: "a", pagePath: "/dashboard" }),
      row({ id: "b", pagePath: "/dashboard" }),
      row({ id: "c", pagePath: "/dashboard" }),
      row({ id: "d", pagePath: "/supplements" }),
      row({ id: "e", pagePath: "/supplements" }),
      row({ id: "f", pagePath: "/notes" }),
    ];
    const out = topPagePaths(rows);
    expect(out).toEqual([
      { pagePath: "/dashboard", count: 3 },
      { pagePath: "/supplements", count: 2 },
      { pagePath: "/notes", count: 1 },
    ]);
  });

  it("respects the limit", () => {
    const rows = [
      row({ id: "a", pagePath: "/a" }),
      row({ id: "b", pagePath: "/b" }),
      row({ id: "c", pagePath: "/c" }),
    ];
    const out = topPagePaths(rows, 2);
    expect(out).toHaveLength(2);
  });

  it("ties break alphabetically", () => {
    const rows = [
      row({ id: "a", pagePath: "/zeta" }),
      row({ id: "b", pagePath: "/alpha" }),
    ];
    const out = topPagePaths(rows);
    expect(out.map((r) => r.pagePath)).toEqual(["/alpha", "/zeta"]);
  });

  it("ignores empty page paths", () => {
    const rows = [
      row({ id: "a", pagePath: "" }),
      row({ id: "b", pagePath: "/dashboard" }),
    ];
    const out = topPagePaths(rows);
    expect(out).toEqual([{ pagePath: "/dashboard", count: 1 }]);
  });
});
