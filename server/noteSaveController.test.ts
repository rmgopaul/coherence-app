import { describe, expect, it } from "vitest";
import { NoteSaveController } from "../client/src/lib/noteSaveController";

describe("NoteSaveController", () => {
  it("keeps local edits when an older save response returns", async () => {
    const controller = new NoteSaveController({
      noteId: "note-1",
      title: "Initial",
      notebook: "General",
      contentHtml: "<p>Initial</p>",
      pinned: false,
    });

    controller.hydrate({
      noteId: "note-1",
      title: "Initial",
      notebook: "General",
      contentHtml: "<p>Initial</p>",
      pinned: false,
    });

    controller.markLocalChange({ title: "First" });

    let releaseSave: (() => void) | null = null;
    const firstSave = controller.save(
      () =>
        new Promise<{ noteId: string | null }>((resolve) => {
          releaseSave = () => resolve({ noteId: "note-1" });
        })
    );

    controller.markLocalChange({ title: "Second" });

    releaseSave?.();
    const result = await firstSave;

    expect(result.ok).toBe(true);
    expect(result.stale).toBe(true);
    expect(controller.getSnapshot().title).toBe("Second");
    expect(controller.isDirty()).toBe(true);
  });

  it("deduplicates concurrent save calls", async () => {
    const controller = new NoteSaveController({
      noteId: "note-2",
      title: "A",
      notebook: "General",
      contentHtml: "<p>A</p>",
      pinned: false,
    });

    controller.hydrate({
      noteId: "note-2",
      title: "A",
      notebook: "General",
      contentHtml: "<p>A</p>",
      pinned: false,
    });

    controller.markLocalChange({ title: "B" });

    let callCount = 0;
    let releaseSave: (() => void) | null = null;

    const executor = () => {
      callCount += 1;
      return new Promise<{ noteId: string | null }>((resolve) => {
        releaseSave = () => resolve({ noteId: "note-2" });
      });
    };

    const first = controller.save(executor);
    const second = controller.save(executor);

    expect(callCount).toBe(1);

    releaseSave?.();
    const [resultOne, resultTwo] = await Promise.all([first, second]);

    expect(resultOne.ok).toBe(true);
    expect(resultTwo.ok).toBe(true);
    expect(controller.isDirty()).toBe(false);
  });

  it("flushes pending edits before switching notes", async () => {
    const controller = new NoteSaveController({
      noteId: "note-3",
      title: "Start",
      notebook: "General",
      contentHtml: "<p>Start</p>",
      pinned: false,
    });

    controller.hydrate({
      noteId: "note-3",
      title: "Start",
      notebook: "General",
      contentHtml: "<p>Start</p>",
      pinned: false,
    });

    controller.markLocalChange({ title: "First pass" });

    let callCount = 0;
    const executor = async () => {
      callCount += 1;
      if (callCount === 1) {
        controller.markLocalChange({ title: "Second pass" });
      }
      return { noteId: "note-3" };
    };

    const result = await controller.flush(executor);

    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
    expect(controller.isDirty()).toBe(false);
    expect(controller.getSnapshot().title).toBe("Second pass");
  });

  it("keeps note dirty when save fails", async () => {
    const controller = new NoteSaveController({
      noteId: "note-4",
      title: "Initial",
      notebook: "General",
      contentHtml: "<p>Initial</p>",
      pinned: false,
    });

    controller.hydrate({
      noteId: "note-4",
      title: "Initial",
      notebook: "General",
      contentHtml: "<p>Initial</p>",
      pinned: false,
    });

    controller.markLocalChange({ title: "Changed" });

    const result = await controller.save(async () => {
      throw new Error("Save failed");
    });

    expect(result.ok).toBe(false);
    expect(controller.isDirty()).toBe(true);
  });
});
