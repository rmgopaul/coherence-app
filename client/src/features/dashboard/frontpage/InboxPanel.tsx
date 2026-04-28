/**
 * InboxPanel — front-page Unread + Important strip (Phase F5).
 *
 * Sits below the three newsprint columns. The server's
 * `getGmailMessages` already filters to `is:important is:unread`, so
 * everything here is high-signal. We split the list into two visual
 * bands matching the wireframe:
 *
 *   ★ IMPORTANT — messages with the STARRED label (yellow band)
 *   ● UNREAD    — the remainder (ink band)
 *
 * Rows:
 *   - dot (red for important, yellow for unread)
 *   - sender name + optional tag (IPA, CSG, AUTO …) inferred from the
 *     domain
 *   - subject (Instrument Serif, two-line clamp)
 *   - thread snippet hint + relative time
 *   - × marks the thread as read via trpc.google.markGmailAsRead
 *
 * Spec: handoff CLAUDE_CODE_PROMPT §"Phase F5" + wireframe d1-inbox.jpg
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import type { GmailMessage } from "../types";
import { buildInboxRow, type InboxRowData } from "./inbox.helpers";
// Task 10.1 (2026-04-28): uniform per-row action menu replacing
// the old single-button "mark as read" affordance.
import { SignalActions } from "./SignalActions";

interface InboxPanelProps {
  messages: GmailMessage[];
}

type MessageRow = InboxRowData;

export function InboxPanel({ messages }: InboxPanelProps) {
  const utils = trpc.useUtils();
  const markRead = trpc.google.markGmailAsRead.useMutation({
    onSuccess: () => {
      void utils.google.getGmailMessages.invalidate();
    },
  });

  const rows = useMemo<MessageRow[]>(() => {
    return (messages ?? [])
      .map((m) => buildInboxRow(m))
      .filter((row): row is MessageRow => row !== null);
  }, [messages]);

  const important = rows.filter((r) => r.starred).slice(0, 4);
  const unread = rows.filter((r) => !r.starred).slice(0, 6);
  const totalUnread = rows.length;

  if (totalUnread === 0) return null;

  return (
    <section className="fp-inbox" aria-label="Inbox unread and important">
      <header className="fp-inbox__head">
        <h2 className="fp-col__title">INBOX · UNREAD &amp; IMPORTANT</h2>
        <span className="mono-label">
          {totalUnread} UNREAD
          {important.length > 0 && (
            <>
              {" · "}
              <em className="fp-inbox__important-count">
                ★ {important.length} IMPORTANT
              </em>
            </>
          )}
        </span>
      </header>

      {important.length > 0 && (
        <>
          <div className="fp-inbox-band fp-inbox-band--important">
            <span>★ IMPORTANT</span>
            <span className="fp-inbox-band__right">flagged · oldest 2h</span>
          </div>
          <ol className="fp-inbox__list">
            {important.map((row) => (
              <InboxRow
                key={row.id}
                row={row}
                onArchive={() => markRead.mutate({ messageId: row.id })}
                busy={markRead.isPending && markRead.variables?.messageId === row.id}
              />
            ))}
          </ol>
        </>
      )}

      {unread.length > 0 && (
        <>
          <div className="fp-inbox-band fp-inbox-band--unread">
            <span>● UNREAD · {totalUnread} · SHOWING {unread.length}</span>
            <span className="fp-inbox-band__right">/UNREAD</span>
          </div>
          <ol className="fp-inbox__list">
            {unread.map((row) => (
              <InboxRow
                key={row.id}
                row={row}
                onArchive={() => markRead.mutate({ messageId: row.id })}
                busy={markRead.isPending && markRead.variables?.messageId === row.id}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function InboxRow({
  row,
  onArchive,
  busy,
}: {
  row: MessageRow;
  onArchive: () => void;
  busy: boolean;
}) {
  const href = `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(row.threadId)}`;
  return (
    <li className={`fp-inbox-row${row.starred ? " fp-inbox-row--i" : " fp-inbox-row--u"}${busy ? " fp-inbox-row--busy" : ""}`}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="fp-inbox-row__link"
      >
        <span className="fp-inbox-row__dot" aria-hidden="true" />
        <div className="fp-inbox-row__body">
          <div className="fp-inbox-row__from">
            <span className="fp-inbox-row__name">{row.fromName}</span>
            {row.fromTag && (
              <span className="fp-inbox-row__tag">{row.fromTag}</span>
            )}
          </div>
          <div className="fp-inbox-row__subj">{row.subject}</div>
          {row.snippet && (
            <div className="fp-inbox-row__snippet">{row.snippet}</div>
          )}
        </div>
        <span className="fp-inbox-row__when mono-label">{row.ts}</span>
      </a>
      <button
        type="button"
        className="fp-inbox-row__archive"
        onClick={onArchive}
        disabled={busy}
        aria-label="Mark as read"
        title="Mark as read"
      >
        ×
      </button>
      {/* Task 10.1: cross-cutting actions (Drop to Dock / Pin as
          King / Create Todoist Task / Archive). The row's existing
          × keeps "Mark as read" because it's the most-used action
          and the menu would otherwise add a click. */}
      <SignalActions
        row={{
          kind: "gmail",
          messageId: row.id,
          subject: row.subject,
          threadUrl: href,
          sender: row.fromName,
        }}
        triggerClassName="fp-inbox-row__menu"
        ariaLabel={`Actions for: ${row.subject}`}
      />
    </li>
  );
}

export default InboxPanel;
