export const DRAFT_SELECTION_KEY = "__draft__";

export type NotebookEditorDraft = {
  title: string;
  notebook: string;
  contentHtml: string;
  dirty: boolean;
  updatedAt: number;
};

export type NotebookEditorNote = {
  id: string;
  title?: string | null;
  notebook?: string | null;
  content?: string | null;
};

export type NotebookEditorSnapshot = {
  source: "note" | "draft" | "empty";
  title: string;
  notebook: string;
  content: string;
  dirty: boolean;
};

export function getSelectionDraftKey(selectedNoteId: string | null, isDraftMode: boolean): string | null {
  if (isDraftMode) return DRAFT_SELECTION_KEY;
  if (!selectedNoteId) return null;
  return `note:${selectedNoteId}`;
}

export function resolveNotebookEditorSnapshot(params: {
  selectedNoteId: string | null;
  isDraftMode: boolean;
  notes: NotebookEditorNote[];
  draftsByKey: Record<string, NotebookEditorDraft>;
}): NotebookEditorSnapshot | null {
  const { selectedNoteId, isDraftMode, notes, draftsByKey } = params;
  const draftKey = getSelectionDraftKey(selectedNoteId, isDraftMode);
  const draft = draftKey ? draftsByKey[draftKey] : undefined;

  if (draft) {
    return {
      source: "draft",
      title: draft.title || "",
      notebook: (draft.notebook || "General").trim() || "General",
      content: draft.contentHtml || "",
      dirty: Boolean(draft.dirty),
    };
  }

  if (isDraftMode) {
    return {
      source: "empty",
      title: "",
      notebook: "General",
      content: "",
      dirty: false,
    };
  }

  if (selectedNoteId) {
    const note = notes.find((row) => String(row.id) === String(selectedNoteId));
    if (note) {
      return {
        source: "note",
        title: String(note.title || ""),
        notebook: (String(note.notebook || "General").trim() || "General"),
        content: String(note.content || ""),
        dirty: false,
      };
    }
    // Selected note exists but is not in the latest dataset yet (async/refetch gap).
    // Return null so callers keep current editor state instead of blanking.
    return null;
  }

  return {
    source: "empty",
    title: "",
    notebook: "General",
    content: "",
    dirty: false,
  };
}

export function shouldApplySelectionUpdate(params: {
  requestId: number;
  currentRequestId: number;
  requestedNoteId: string | null;
  currentSelectedNoteId: string | null;
}): boolean {
  const { requestId, currentRequestId, requestedNoteId, currentSelectedNoteId } = params;
  return requestId === currentRequestId && String(requestedNoteId || "") === String(currentSelectedNoteId || "");
}
