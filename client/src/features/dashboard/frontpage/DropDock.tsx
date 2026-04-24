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
  extractUrlFromPaste,
  hasSensitiveParams,
  type DockSource,
} from "@shared/dropdock.helpers";

const SOURCE_LABEL: Record<DockSource, string> = {
  gmail: "GMAIL",
  gcal: "GCAL",
  gsheet: "SHEET",
  todoist: "TODO",
  url: "LINK",
};

const SOURCE_COLOR: Record<DockSource, string> = {
  gmail: "fp-dock-chip__src--gmail",
  gcal: "fp-dock-chip__src--gcal",
  gsheet: "fp-dock-chip__src--gsheet",
  todoist: "fp-dock-chip__src--todoist",
  url: "fp-dock-chip__src--url",
};

export function DropDock() {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  // 200ms cooldown between accepted paste/drop events so a user
  // mashing ⌘V doesn't fire two overlapping enrich+add round-trips
  // that race the dedup check.
  const pasteCooldownRef = useRef(false);
  const [hint, setHint] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

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
  const mutationBusy = addItem.isPending || enrich.isPending;

  function armPasteCooldown() {
    pasteCooldownRef.current = true;
    window.setTimeout(() => {
      pasteCooldownRef.current = false;
    }, 200);
  }

  const handleAddText = useCallback(
    async (raw: string) => {
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

      // Optimistic title from the URL itself; the existing
      // dock.getItemDetails mutation enriches it once we have the real
      // payload (Gmail subject, calendar event title, etc.).
      let title: string | undefined;
      try {
        const detail = await enrich.mutateAsync({
          source: classified.source,
          url: classified.url,
          meta: classified.meta,
        });
        title = detail?.title;
      } catch {
        title = undefined;
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
      </header>

      <div className="fp-dock__zone" role="list">
        {isLoading && items.length === 0 && (
          <span className="fp-dock__empty">loading…</span>
        )}
        {!isLoading && items.length === 0 && (
          <span className="fp-dock__empty">drop, paste, or type a link to pin it here.</span>
        )}
        {items.map((item, idx) => (
          <a
            key={item.id}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            role="listitem"
            className={cn(
              "fp-dock-chip",
              // Light, deterministic tilt — keeps the wireframe's hand-pinned feel
              // without random jitter on every render.
              idx % 3 === 0 && "fp-dock-chip--tilt-a",
              idx % 3 === 1 && "fp-dock-chip--tilt-b",
              idx % 3 === 2 && "fp-dock-chip--tilt-c"
            )}
            title={item.url}
          >
            <span className={cn("fp-dock-chip__src", SOURCE_COLOR[item.source as DockSource])}>
              {SOURCE_LABEL[item.source as DockSource] ?? "LINK"}
            </span>
            <span className="fp-dock-chip__title">
              {item.title?.trim() || item.url}
            </span>
            <button
              type="button"
              className="fp-dock-chip__x"
              aria-label={`Remove ${item.title ?? item.url}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                removeItem.mutate({ id: item.id });
              }}
            >
              ×
            </button>
          </a>
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
