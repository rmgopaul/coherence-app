export type NoteDraftSnapshot = {
  noteId: string | null;
  title: string;
  notebook: string;
  contentHtml: string;
  pinned: boolean;
  revision: number;
};

export type SaveAttemptResult = {
  ok: boolean;
  stale: boolean;
  noteId: string | null;
  snapshot: NoteDraftSnapshot;
  error?: unknown;
};

export type SaveExecutor = (snapshot: NoteDraftSnapshot) => Promise<{ noteId: string | null }>;

type InitialSnapshot = Omit<NoteDraftSnapshot, "revision">;

export class NoteSaveController {
  private revisionCounter = 0;
  private savedRevision = 0;
  private snapshot: NoteDraftSnapshot;
  private inFlightPromise: Promise<SaveAttemptResult> | null = null;

  constructor(initial: InitialSnapshot) {
    this.snapshot = {
      ...initial,
      revision: 0,
    };
  }

  getSnapshot(): NoteDraftSnapshot {
    return this.snapshot;
  }

  isDirty(): boolean {
    return this.snapshot.revision > this.savedRevision;
  }

  isSaving(): boolean {
    return this.inFlightPromise !== null;
  }

  hydrate(snapshot: InitialSnapshot): NoteDraftSnapshot {
    this.revisionCounter += 1;
    const revision = this.revisionCounter;
    this.savedRevision = revision;
    this.snapshot = {
      ...snapshot,
      revision,
    };
    return this.snapshot;
  }

  markLocalChange(changes: Partial<Omit<NoteDraftSnapshot, "revision">>): NoteDraftSnapshot {
    this.revisionCounter += 1;
    this.snapshot = {
      ...this.snapshot,
      ...changes,
      revision: this.revisionCounter,
    };
    return this.snapshot;
  }

  private createNoopResult(): SaveAttemptResult {
    return {
      ok: true,
      stale: false,
      noteId: this.snapshot.noteId,
      snapshot: this.snapshot,
    };
  }

  async save(executor: SaveExecutor): Promise<SaveAttemptResult> {
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    if (!this.isDirty()) {
      return this.createNoopResult();
    }

    const saveSnapshot = { ...this.snapshot };

    this.inFlightPromise = (async (): Promise<SaveAttemptResult> => {
      try {
        const result = await executor(saveSnapshot);

        if (result.noteId && result.noteId !== this.snapshot.noteId) {
          this.snapshot = {
            ...this.snapshot,
            noteId: result.noteId,
          };
        }

        this.savedRevision = Math.max(this.savedRevision, saveSnapshot.revision);
        const stale = this.snapshot.revision > saveSnapshot.revision;

        return {
          ok: true,
          stale,
          noteId: this.snapshot.noteId,
          snapshot: saveSnapshot,
        };
      } catch (error) {
        return {
          ok: false,
          stale: false,
          noteId: this.snapshot.noteId,
          snapshot: saveSnapshot,
          error,
        };
      } finally {
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }

  async flush(executor: SaveExecutor, maxPasses = 12): Promise<SaveAttemptResult> {
    let lastResult = this.createNoopResult();

    for (let index = 0; index < maxPasses; index += 1) {
      if (!this.isDirty() && !this.isSaving()) {
        break;
      }

      const result = await this.save(executor);
      lastResult = result;

      if (!result.ok) {
        return result;
      }
    }

    return lastResult;
  }
}
