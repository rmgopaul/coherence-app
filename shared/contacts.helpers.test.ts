/**
 * Phase E (2026-04-28) — tests for personal contacts pure helpers.
 */
import { describe, expect, it } from "vitest";
import {
  categorizeContactStaleness,
  filterContacts,
  formatLastContactedLabel,
  groupContactsByStaleness,
  parseContactTags,
  type ContactRow,
} from "./contacts.helpers";

function row(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: overrides.id ?? "id-1",
    userId: overrides.userId ?? 1,
    name: overrides.name ?? "Alice Anderson",
    email: overrides.email ?? null,
    phone: overrides.phone ?? null,
    role: overrides.role ?? null,
    company: overrides.company ?? null,
    notes: overrides.notes ?? null,
    tags: overrides.tags ?? null,
    lastContactedAt: overrides.lastContactedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-01-01"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01"),
  };
}

describe("categorizeContactStaleness", () => {
  // 2026-04-28 12:00 UTC = 07:00 CDT (vitest pins TZ=America/Chicago).
  const NOW = new Date("2026-04-28T15:00:00Z"); // 10:00 CDT

  it("returns 'never' for null / undefined / empty / unparseable", () => {
    expect(categorizeContactStaleness(null, NOW)).toBe("never");
    expect(categorizeContactStaleness(undefined, NOW)).toBe("never");
    expect(categorizeContactStaleness("", NOW)).toBe("never");
    expect(categorizeContactStaleness("not-a-date", NOW)).toBe("never");
  });

  it("returns 'today' for a stamp on the same local day", () => {
    expect(
      categorizeContactStaleness(new Date(NOW.getTime() - 60_000), NOW)
    ).toBe("today");
  });

  it("returns 'today' defensively when the stamp is in the future", () => {
    expect(
      categorizeContactStaleness(new Date(NOW.getTime() + 5 * 60_000), NOW)
    ).toBe("today");
  });

  it("returns 'this-week' for stamps 1-6 days back (not same day)", () => {
    expect(
      categorizeContactStaleness(new Date(NOW.getTime() - 2 * 86_400_000), NOW)
    ).toBe("this-week");
    expect(
      categorizeContactStaleness(new Date(NOW.getTime() - 6 * 86_400_000), NOW)
    ).toBe("this-week");
  });

  it("returns 'this-month' for stamps 7-29 days back", () => {
    expect(
      categorizeContactStaleness(new Date(NOW.getTime() - 8 * 86_400_000), NOW)
    ).toBe("this-month");
    expect(
      categorizeContactStaleness(
        new Date(NOW.getTime() - 29 * 86_400_000),
        NOW
      )
    ).toBe("this-month");
  });

  it("returns 'stale' for stamps 30+ days back", () => {
    expect(
      categorizeContactStaleness(
        new Date(NOW.getTime() - 30 * 86_400_000),
        NOW
      )
    ).toBe("stale");
    expect(
      categorizeContactStaleness(
        new Date(NOW.getTime() - 365 * 86_400_000),
        NOW
      )
    ).toBe("stale");
  });

  it("accepts ISO strings (tRPC wire payload)", () => {
    const yesterday = new Date(NOW.getTime() - 2 * 86_400_000);
    expect(
      categorizeContactStaleness(yesterday.toISOString(), NOW)
    ).toBe("this-week");
  });
});

describe("formatLastContactedLabel", () => {
  const NOW = new Date("2026-04-28T15:00:00Z"); // 10:00 CDT

  it("returns 'Never' when no stamp", () => {
    expect(formatLastContactedLabel(null, NOW)).toBe("Never");
    expect(formatLastContactedLabel(undefined, NOW)).toBe("Never");
    expect(formatLastContactedLabel("not-a-date", NOW)).toBe("Never");
  });

  it("returns 'Today' for same-day stamps", () => {
    expect(
      formatLastContactedLabel(new Date(NOW.getTime() - 30 * 60_000), NOW)
    ).toBe("Today");
  });

  it("returns 'Yesterday' for the previous local day", () => {
    const yesterday = new Date(
      NOW.getFullYear(),
      NOW.getMonth(),
      NOW.getDate() - 1,
      14,
      0,
      0
    );
    expect(formatLastContactedLabel(yesterday, NOW)).toBe("Yesterday");
  });

  it("returns 'N days ago' for 2-6 days back", () => {
    expect(
      formatLastContactedLabel(new Date(NOW.getTime() - 3 * 86_400_000), NOW)
    ).toBe("3 days ago");
  });

  it("returns 'N week(s) ago' for 7-29 days back", () => {
    expect(
      formatLastContactedLabel(new Date(NOW.getTime() - 7 * 86_400_000), NOW)
    ).toBe("1 week ago");
    expect(
      formatLastContactedLabel(new Date(NOW.getTime() - 21 * 86_400_000), NOW)
    ).toBe("3 weeks ago");
  });

  it("returns 'N month(s) ago' for 30-364 days back", () => {
    expect(
      formatLastContactedLabel(new Date(NOW.getTime() - 30 * 86_400_000), NOW)
    ).toBe("1 month ago");
    expect(
      formatLastContactedLabel(new Date(NOW.getTime() - 90 * 86_400_000), NOW)
    ).toBe("3 months ago");
  });

  it("returns 'N year(s) ago' for 365+ days back", () => {
    expect(
      formatLastContactedLabel(new Date(NOW.getTime() - 365 * 86_400_000), NOW)
    ).toBe("1 year ago");
    expect(
      formatLastContactedLabel(
        new Date(NOW.getTime() - 730 * 86_400_000),
        NOW
      )
    ).toBe("2 years ago");
  });
});

describe("filterContacts", () => {
  const rows = [
    row({ id: "alice", name: "Alice Anderson", company: "Acme" }),
    row({ id: "bob", name: "Bob Brown", email: "bob@beta.com" }),
    row({ id: "cara", name: "Cara C.", role: "Engineer", tags: "client,vip" }),
    row({ id: "dave", name: "Dave D.", notes: "Met at Acme conference" }),
  ];

  it("returns every row when query is empty / whitespace", () => {
    expect(filterContacts(rows, "")).toHaveLength(4);
    expect(filterContacts(rows, "  ")).toHaveLength(4);
  });

  it("matches case-insensitively against name", () => {
    const out = filterContacts(rows, "ALICE");
    expect(out.map((r) => r.id)).toEqual(["alice"]);
  });

  it("matches against company AND notes (Acme appears in both)", () => {
    const out = filterContacts(rows, "acme");
    expect(out.map((r) => r.id)).toEqual(["alice", "dave"]);
  });

  it("matches against email", () => {
    const out = filterContacts(rows, "beta.com");
    expect(out.map((r) => r.id)).toEqual(["bob"]);
  });

  it("matches against role and tags", () => {
    expect(filterContacts(rows, "engineer").map((r) => r.id)).toEqual([
      "cara",
    ]);
    expect(filterContacts(rows, "vip").map((r) => r.id)).toEqual(["cara"]);
  });

  it("does not mutate the input list", () => {
    const before = rows.map((r) => r.id).join(",");
    filterContacts(rows, "alice");
    expect(rows.map((r) => r.id).join(",")).toBe(before);
  });
});

describe("groupContactsByStaleness", () => {
  const NOW = new Date("2026-04-28T15:00:00Z");

  it("buckets every row exactly once", () => {
    const rows = [
      row({ id: "today", lastContactedAt: NOW }),
      row({
        id: "week",
        lastContactedAt: new Date(NOW.getTime() - 3 * 86_400_000),
      }),
      row({
        id: "month",
        lastContactedAt: new Date(NOW.getTime() - 14 * 86_400_000),
      }),
      row({
        id: "stale",
        lastContactedAt: new Date(NOW.getTime() - 60 * 86_400_000),
      }),
      row({ id: "never", lastContactedAt: null }),
    ];
    const out = groupContactsByStaleness(rows, NOW);
    expect(out.today.map((r) => r.id)).toEqual(["today"]);
    expect(out["this-week"].map((r) => r.id)).toEqual(["week"]);
    expect(out["this-month"].map((r) => r.id)).toEqual(["month"]);
    expect(out.stale.map((r) => r.id)).toEqual(["stale"]);
    expect(out.never.map((r) => r.id)).toEqual(["never"]);
  });

  it("returns empty arrays for buckets with no rows", () => {
    const out = groupContactsByStaleness([], NOW);
    expect(out.today).toEqual([]);
    expect(out.never).toEqual([]);
    expect(out.stale).toEqual([]);
  });
});

describe("parseContactTags", () => {
  it("returns [] for null / empty", () => {
    expect(parseContactTags(null)).toEqual([]);
    expect(parseContactTags("")).toEqual([]);
    expect(parseContactTags("   ")).toEqual([]);
  });

  it("splits, trims, and lowercases", () => {
    expect(parseContactTags("Client, VIP, Family")).toEqual([
      "client",
      "vip",
      "family",
    ]);
  });

  it("drops empty entries from leading/trailing/repeated commas", () => {
    expect(parseContactTags(",,client,, ,vip,")).toEqual(["client", "vip"]);
  });
});
