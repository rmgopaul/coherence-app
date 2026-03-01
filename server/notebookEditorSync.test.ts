import { describe, expect, it } from "vitest";
import {
  resolveNotebookEditorSnapshot,
  shouldApplySelectionUpdate,
  type NotebookEditorDraft,
  type NotebookEditorNote,
} from "../client/src/lib/notebookEditorSync";

describe("resolveNotebookEditorSnapshot", () => {
  const notes: NotebookEditorNote[] = [
    {
      id: "A",
      title: "Alpha",
      notebook: "General",
      content: "<p>Alpha content</p>",
    },
    {
      id: "B",
      title: "Beta",
      notebook: "Meetings",
      content: "<p>Beta content</p>",
    },
  ];

  it("switches A -> B -> A and restores the correct content", () => {
    const draftsByKey: Record<string, NotebookEditorDraft> = {};

    const selectedA = resolveNotebookEditorSnapshot({
      selectedNoteId: "A",
      isDraftMode: false,
      notes,
      draftsByKey,
    });
    expect(selectedA.title).toBe("Alpha");
    expect(selectedA.content).toContain("Alpha content");

    const selectedB = resolveNotebookEditorSnapshot({
      selectedNoteId: "B",
      isDraftMode: false,
      notes,
      draftsByKey,
    });
    expect(selectedB.title).toBe("Beta");
    expect(selectedB.content).toContain("Beta content");

    draftsByKey["note:A"] = {
      title: "Alpha draft",
      notebook: "General",
      contentHtml: "<p>Alpha unsaved draft</p>",
      dirty: true,
      updatedAt: Date.now(),
    };

    const backToA = resolveNotebookEditorSnapshot({
      selectedNoteId: "A",
      isDraftMode: false,
      notes,
      draftsByKey,
    });
    expect(backToA.source).toBe("draft");
    expect(backToA.content).toContain("Alpha unsaved draft");
    expect(backToA.dirty).toBe(true);
  });

  it("does not force-blank when selected note is temporarily missing during async refresh", () => {
    const snapshot = resolveNotebookEditorSnapshot({
      selectedNoteId: "A",
      isDraftMode: false,
      notes: [],
      draftsByKey: {},
    });
    expect(snapshot).toBeNull();
  });
});

describe("shouldApplySelectionUpdate", () => {
  it("rejects stale out-of-order async updates", () => {
    const stale = shouldApplySelectionUpdate({
      requestId: 1,
      currentRequestId: 2,
      requestedNoteId: "A",
      currentSelectedNoteId: "B",
    });
    expect(stale).toBe(false);

    const current = shouldApplySelectionUpdate({
      requestId: 3,
      currentRequestId: 3,
      requestedNoteId: "B",
      currentSelectedNoteId: "B",
    });
    expect(current).toBe(true);
  });
});
