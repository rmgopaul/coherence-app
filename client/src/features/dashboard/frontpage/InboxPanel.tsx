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
import { daysAgoLabel, extractName } from "./newsprint.helpers";

interface InboxPanelProps {
  messages: GmailMessage[];
}

interface MessageRow {
  id: string;
  threadId: string;
  fromName: string;
  fromTag: string | null;
  subject: string;
  snippet: string;
  ts: string;
  starred: boolean;
}

function getHeader(message: GmailMessage, headerName: string): string {
  const headers = message.payload?.headers as
    | Array<{ name?: string; value?: string }>
    | undefined;
  if (!Array.isArray(headers)) return "";
  const found = headers.find(
    (h) => (h.name ?? "").toLowerCase() === headerName.toLowerCase()
  );
  return found?.value ?? "";
}

/**
 * Pull a 2–4 char domain tag from the From header — IPA, CSG, AUTO,
 * UTIL, etc. Used as the colored label next to the sender name.
 */
function inferDomainTag(rawFrom: string): string | null {
  const match = /<([^>]+)>$/.exec(rawFrom.trim());
  const email = match ? match[1] : rawFrom;
  const at = email.indexOf("@");
  if (at < 0) return null;
  const host = email.slice(at + 1).toLowerCase();
  // Strip the TLD, keep the right-most label of the SLD as the tag.
  // gmail.com → gmail; carbonsolutionsgroup.com → carbonsolutionsgroup.
  // Then upper-case + cap to 4 chars.
  const sld = host.split(".").slice(-2, -1)[0] ?? "";
  if (!sld) return null;
  return sld.toUpperCase().slice(0, 4);
}

function relativeTime(internalDateMs: number, now = Date.now()): string {
  const diff = now - internalDateMs;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return daysAgoLabel(new Date(internalDateMs).toISOString(), now);
}

export function InboxPanel({ messages }: InboxPanelProps) {
  const utils = trpc.useUtils();
  const markRead = trpc.google.markGmailAsRead.useMutation({
    onSuccess: () => {
      void utils.google.getGmailMessages.invalidate();
    },
  });

  const rows = useMemo<MessageRow[]>(() => {
    return (messages ?? [])
      .map((m): MessageRow | null => {
        if (!m.id) return null;
        const internalMs = Number(
          (m as { internalDate?: string | number }).internalDate ?? 0
        );
        const fromRaw = getHeader(m, "From");
        const fromName = extractName(fromRaw);
        const subjectRaw = getHeader(m, "Subject") || "(no subject)";
        const labels = (m.labelIds ?? []) as string[];
        return {
          id: m.id,
          threadId: m.threadId ?? m.id,
          fromName,
          fromTag: inferDomainTag(fromRaw),
          subject: subjectRaw,
          snippet: (m.snippet ?? "").slice(0, 140),
          ts: relativeTime(internalMs),
          starred: labels.includes("STARRED"),
        };
      })
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
    </li>
  );
}

export default InboxPanel;
