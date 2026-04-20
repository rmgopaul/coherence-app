/**
 * Pure helpers for InboxPanel — Gmail header parsing, domain tag
 * inference, and the relative-time formatter. Extracted so we can
 * test against fixture messages without mounting React.
 */
import type { GmailMessage } from "../types";
import { daysAgoLabel, extractName } from "./newsprint.helpers";

export interface InboxRowData {
  id: string;
  threadId: string;
  fromName: string;
  fromTag: string | null;
  subject: string;
  snippet: string;
  ts: string;
  starred: boolean;
}

export function getGmailHeader(message: GmailMessage, headerName: string): string {
  const headers = message.payload?.headers as
    | Array<{ name?: string; value?: string }>
    | undefined;
  if (!Array.isArray(headers)) return "";
  const lower = headerName.toLowerCase();
  return (
    headers.find((h) => (h.name ?? "").toLowerCase() === lower)?.value ?? ""
  );
}

/**
 * Pull a 2-4 char domain tag from the From header (IPA, CSG, MUCH, ...).
 * Used as the small badge next to the sender so the user can scan the
 * column by counterparty.
 */
export function inferDomainTag(rawFrom: string): string | null {
  const trimmed = rawFrom.trim();
  if (!trimmed) return null;
  const match = /<([^>]+)>$/.exec(trimmed);
  const email = match ? match[1] : trimmed;
  const at = email.indexOf("@");
  if (at < 0) return null;
  const host = email.slice(at + 1).toLowerCase();
  if (!host) return null;
  // Drop the TLD; keep the right-most label of the SLD as the tag.
  // Falls back to the host itself for single-label hosts (e.g. localhost).
  const labels = host.split(".").filter((l) => l.length > 0);
  if (labels.length === 0) return null;
  const sld = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  if (!sld) return null;
  return sld.toUpperCase().slice(0, 4);
}

export function relativeTime(internalDateMs: number, now: number = Date.now()): string {
  const diff = now - internalDateMs;
  if (diff < 0) return "now";
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return daysAgoLabel(new Date(internalDateMs).toISOString(), now);
}

/**
 * Build an InboxRowData from a raw GmailMessage. Returns null when the
 * message has no id (which Gmail's API can return for thread-only stubs).
 */
export function buildInboxRow(
  message: GmailMessage,
  now: number = Date.now()
): InboxRowData | null {
  if (!message.id) return null;
  const internalMs = Number(
    (message as { internalDate?: string | number }).internalDate ?? 0
  );
  const fromRaw = getGmailHeader(message, "From");
  const subjectRaw = getGmailHeader(message, "Subject") || "(no subject)";
  const labels = (message.labelIds ?? []) as string[];
  return {
    id: message.id,
    threadId: message.threadId ?? message.id,
    fromName: extractName(fromRaw),
    fromTag: inferDomainTag(fromRaw),
    subject: subjectRaw,
    snippet: (message.snippet ?? "").slice(0, 140),
    ts: relativeTime(internalMs, now),
    starred: labels.includes("STARRED"),
  };
}
