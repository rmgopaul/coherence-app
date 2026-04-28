/**
 * Task 10.3 (2026-04-28) — tests for the reverse note-link helpers
 * `listNotesForExternal` + `countNoteLinksByExternalIds`. Mocks
 * `_core` getDb + withDbRetry per the established pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
}));

vi.mock("./_core", async () => {
  const actual = await vi.importActual<typeof import("./_core")>("./_core");
  return {
    ...actual,
    getDb: mocks.getDb,
    withDbRetry: mocks.withDbRetry,
  };
});

import {
  listNotesForExternal,
  countNoteLinksByExternalIds,
} from "./notes";

type StubRow = Record<string, unknown>;

function makeDbStub(rowsByQueryIndex: StubRow[][]) {
  let idx = 0;
  function makeChain() {
    const my = idx;
    idx += 1;
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      then: (resolve: (rows: StubRow[]) => unknown) =>
        Promise.resolve(rowsByQueryIndex[my] ?? []).then(resolve),
    };
    return chain;
  }
  return { select: () => makeChain() };
}

beforeEach(() => {
  mocks.getDb.mockReset();
  mocks.withDbRetry.mockReset();
  mocks.withDbRetry.mockImplementation(async (_label, fn) => fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listNotesForExternal", () => {
  it("returns empty array when no links match", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const result = await listNotesForExternal(
      1,
      "todoist_task",
      "task-1"
    );
    expect(result).toEqual([]);
  });

  it("hydrates notes from links + preserves link order (newest first)", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        // 1. links lookup — newest first
        [
          {
            noteId: "note-c",
            seriesId: "",
            occurrenceStartIso: "",
          },
          {
            noteId: "note-a",
            seriesId: "",
            occurrenceStartIso: "",
          },
          {
            noteId: "note-b",
            seriesId: "",
            occurrenceStartIso: "",
          },
        ],
        // 2. notes hydration — order doesn't matter; helper re-keys
        [
          {
            id: "note-a",
            title: "Apple",
            notebook: "Inbox",
            updatedAt: new Date("2026-04-25T00:00:00Z"),
          },
          {
            id: "note-b",
            title: "Banana",
            notebook: "Meetings",
            updatedAt: new Date("2026-04-26T00:00:00Z"),
          },
          {
            id: "note-c",
            title: "Carrot",
            notebook: "Inbox",
            updatedAt: new Date("2026-04-27T00:00:00Z"),
          },
        ],
      ])
    );

    const result = await listNotesForExternal(
      1,
      "todoist_task",
      "task-1"
    );
    // Order matches the LINK order, not the note order.
    expect(result.map((r) => r.id)).toEqual(["note-c", "note-a", "note-b"]);
    expect(result[0].notebook).toBe("Inbox");
  });

  it("filters out orphaned link rows (note row missing)", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          { noteId: "note-a", seriesId: "", occurrenceStartIso: "" },
          { noteId: "note-orphan", seriesId: "", occurrenceStartIso: "" },
        ],
        // notes hydration — orphan ID isn't in the result set
        [
          {
            id: "note-a",
            title: "Apple",
            notebook: "Inbox",
            updatedAt: new Date(),
          },
        ],
      ])
    );

    const result = await listNotesForExternal(
      1,
      "todoist_task",
      "task-1"
    );
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("note-a");
  });

  it("clamps the limit to [1, 200]", async () => {
    mocks.getDb.mockResolvedValue(makeDbStub([[]]));
    const result = await listNotesForExternal(
      1,
      "todoist_task",
      "task-1",
      { limit: 99999 }
    );
    expect(result).toEqual([]);
  });

  it("propagates seriesId + occurrenceStartIso from the link row", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          {
            noteId: "note-1",
            seriesId: "series-X",
            occurrenceStartIso: "2026-04-28T10:00:00Z",
          },
        ],
        [
          {
            id: "note-1",
            title: "Stand-up notes",
            notebook: "Meetings",
            updatedAt: new Date(),
          },
        ],
      ])
    );
    const result = await listNotesForExternal(
      1,
      "google_calendar_event",
      "evt-1"
    );
    expect(result[0].seriesId).toBe("series-X");
    expect(result[0].occurrenceStartIso).toBe("2026-04-28T10:00:00Z");
  });
});

describe("countNoteLinksByExternalIds", () => {
  it("returns empty record for empty input (no DB hit)", async () => {
    const result = await countNoteLinksByExternalIds(
      1,
      "todoist_task",
      []
    );
    expect(result).toEqual({});
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("counts distinct notes per externalId", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          { externalId: "task-1", noteId: "note-a" },
          { externalId: "task-1", noteId: "note-b" },
          { externalId: "task-2", noteId: "note-a" },
        ],
      ])
    );
    const result = await countNoteLinksByExternalIds(1, "todoist_task", [
      "task-1",
      "task-2",
      "task-3", // no links
    ]);
    expect(result).toEqual({ "task-1": 2, "task-2": 1 });
  });

  it("dedupes when the same note has multiple links to the same external", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([
        [
          // Same noteId × same externalId — different series rows.
          { externalId: "evt-1", noteId: "note-a" },
          { externalId: "evt-1", noteId: "note-a" },
          { externalId: "evt-1", noteId: "note-b" },
        ],
      ])
    );
    const result = await countNoteLinksByExternalIds(
      1,
      "google_calendar_event",
      ["evt-1"]
    );
    // 2 distinct notes despite 3 link rows.
    expect(result).toEqual({ "evt-1": 2 });
  });

  it("dedupes input externalIds before hitting the DB", async () => {
    mocks.getDb.mockResolvedValue(
      makeDbStub([[{ externalId: "task-1", noteId: "note-a" }]])
    );
    const result = await countNoteLinksByExternalIds(1, "todoist_task", [
      "task-1",
      "task-1",
      "task-1",
    ]);
    expect(result).toEqual({ "task-1": 1 });
  });
});
