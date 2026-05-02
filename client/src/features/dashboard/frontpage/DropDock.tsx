/**
 * DropDock — front-page universal-intake strip (Phase F3).
 *
 * Sits between the Masthead and the Hero. Three jobs:
 *
 *   1. Paste-input row: anything pasted (Gmail, Calendar, Drive, Todoist,
 *      or arbitrary URL) gets classified and added as a chip.
 *   2. Drop zone: same effect via native HTML5 drag-drop.
 *   3. Chip row: visual list of saved items, click to open, × to remove.
 *
 * State is server-persisted via trpc.dock.list / .add / .remove. URL
 * classification + canonicalization happens both client- and server-side
 * (see shared/dropdock.helpers.ts) so the dedupe key is stable.
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  classifyUrl,
  extractMarkdownLink,
  extractUrlFromPaste,
  hasSensitiveParams,
  stripMarkdownLinks,
} from "@shared/dropdock.helpers";
import { DockChip } from "./DockChip";

export function DropDock() {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const taskInputRef = useRef<HTMLInputElement>(null);
  // 200ms cooldown between accepted paste/drop events so a user
  // mashing ⌘V doesn't fire two overlapping enrich+add round-trips
  // that race the dedup check.
  const pasteCooldownRef = useRef(false);
  const [hint, setHint] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [taskInput, setTaskInput] = useState("");

  const { data: items = [], isLoading } = trpc.dock.list.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const addItem = trpc.dock.add.useMutation({
    onSuccess: (row) => {
      void utils.dock.list.invalidate();
      setHint(row.deduplicated ? "already in dock" : null);
    },
    onError: (err) => setHint(err.message ?? "failed to add"),
  });
  const removeItem = trpc.dock.remove.useMutation({
    onSuccess: () => void utils.dock.list.invalidate(),
  });
  const enrich = trpc.dock.getItemDetails.useMutation();
  const createTask = trpc.todoist.createTask.useMutation({
    onSuccess: (task) => {
      const label = task.content || "Task added";
      toast.success(`Added to Todoist: ${label}`);
      setTaskInput("");
      taskInputRef.current?.focus();
    },
    onError: (err) => {
      toast.error(`Failed to add task: ${err.message ?? "unknown error"}`);
    },
  });
  const mutationBusy = addItem.isPending || enrich.isPending;

  function armPasteCooldown() {
    pasteCooldownRef.current = true;
    window.setTimeout(() => {
      pasteCooldownRef.current = false;
    }, 200);
  }

  const handleAddText = useCallback(
    async (raw: string) => {
      // Phase E (2026-04-28) — markdown-paste support. When the
      // user pastes a "Copy task link" payload (Todoist/Linear/Slack)
      // shaped `[title](url)`, recover the title verbatim from the
      // markdown so we don't need to round-trip through
      // `getItemDetails` to learn what to call the chip.
      const markdown = extractMarkdownLink(raw);
      const url = extractUrlFromPaste(raw);
      if (!url) return;
      if (hasSensitiveParams(url)) {
        // Canonicalization strips these so the dedup key is clean,
        // but the original URL is still stored verbatim. Warn so the
        // user can decide whether to keep it.
        toast.warning(
          "URL contains auth-like parameters (token/code/state/…). Consider removing them before saving."
        );
      }
      const classified = classifyUrl(url);

      // Title resolution priority:
      //   1. enrichment success      — Gmail subject, calendar event,
      //                                 Todoist task content (markdown
      //                                 stripped server-side)
      //   2. markdown paste title    — when the user copied a
      //                                 `[title](url)` blob, the
      //                                 title in the brackets is what
      //                                 the source app meant the link
      //                                 to be called
      //   3. undefined               — server falls back to the URL
      //                                 (better than a generic
      //                                 "Email" / "Task" placeholder)
      let title: string | undefined;
      try {
        const detail = await enrich.mutateAsync({
          source: classified.source,
          url: classified.url,
          meta: classified.meta,
        });
        title = detail?.title ?? undefined;
      } catch {
        title = undefined;
      }
      if (!title && markdown?.title) {
        title = stripMarkdownLinks(markdown.title);
      }

      await addItem.mutateAsync({
        source: classified.source,
        url: classified.url,
        title,
        meta: classified.meta,
      });
    },
    [addItem, enrich]
  );

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    if (pasteCooldownRef.current || mutationBusy) {
      e.preventDefault();
      return;
    }
    const text = e.clipboardData.getData("text/uri-list") ||
      e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    armPasteCooldown();
    void handleAddText(text);
    if (inputRef.current) inputRef.current.value = "";
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pasteCooldownRef.current || mutationBusy) return;
    const value = inputRef.current?.value ?? "";
    if (!value.trim()) return;
    armPasteCooldown();
    void handleAddText(value);
    if (inputRef.current) inputRef.current.value = "";
  }

  function onQuickTaskSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const content = taskInput.trim();
    if (!content || createTask.isPending) return;
    createTask.mutate({ content });
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes("text/uri-list") || e.dataTransfer.types.includes("text/plain")) {
      e.preventDefault();
      setDragActive(true);
    }
  }
  function onDragLeave() {
    setDragActive(false);
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (pasteCooldownRef.current || mutationBusy) return;
    const text =
      e.dataTransfer.getData("text/uri-list") ||
      e.dataTransfer.getData("text/plain");
    if (text) {
      armPasteCooldown();
      void handleAddText(text);
    }
  }

  return (
    <section
      className={cn("fp-dock", dragActive && "fp-dock--drag")}
      aria-label="DropDock"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="fp-dock__head">
        <span className="fp-dock__title">
          <span className="fp-dock__dot" aria-hidden="true" />
          DROP DOCK
          <small>{items.length} pinned</small>
        </span>
        <form className="fp-dock__paste" onSubmit={onSubmit}>
          <span className="fp-dock__kbd" aria-hidden="true">⌘V</span>
          <input
            ref={inputRef}
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="paste a Gmail / Calendar / Sheets / Todoist link…"
            onPaste={onPaste}
            disabled={mutationBusy}
            aria-label="Paste a URL to add to the dock"
          />
          <button
            type="submit"
            className="fp-dock__add"
            disabled={mutationBusy}
          >
            ADD
          </button>
        </form>
        <button
          type="button"
          className="fp-dock__add fp-dock__add--ghost"
          onClick={() => void utils.dock.list.invalidate()}
          title="Refresh"
        >
          ↻
        </button>
        <form
          className="fp-dock__paste fp-dock__quick-task"
          onSubmit={onQuickTaskSubmit}
        >
          <span className="fp-dock__kbd" aria-hidden="true">+ TASK</span>
          <input
            ref={taskInputRef}
            type="text"
            spellCheck
            autoComplete="off"
            placeholder="quick add a Todoist task…"
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            disabled={createTask.isPending}
            aria-label="Quick add a Todoist task"
          />
          <button
            type="submit"
            className="fp-dock__add"
            disabled={createTask.isPending || !taskInput.trim()}
          >
            {createTask.isPending ? "…" : "ADD"}
          </button>
        </form>
      </header>

      <div className="fp-dock__zone" role="list">
        {isLoading && items.length === 0 && (
          <span className="fp-dock__empty">loading…</span>
        )}
        {!isLoading && items.length === 0 && (
          <span className="fp-dock__empty">drop, paste, or type a link to pin it here.</span>
        )}
        {items.map((item, idx) => (
          <DockChip
            key={item.id}
            item={item}
            tiltIndex={idx}
            onRemove={(id) => removeItem.mutate({ id })}
          />
        ))}
      </div>

      {hint && (
        <div className="fp-dock__hint mono-label" role="status">
          {hint}
        </div>
      )}
    </section>
  );
}

export default DropDock;
