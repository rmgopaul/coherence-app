/**
 * Phase E (2026-04-28) — meter-read "Test Connection" probe helpers.
 *
 * Pure formatting + summarization helpers shared by the probe UI on
 * every per-vendor meter-read page. No DOM, no network — just data
 * shaping over the `{ok, latencyMs, sampleCount, error}` result a
 * client-side probe produces by timing the existing
 * `<vendor>.listSystems` / `listSites` query.
 *
 * Lives in `shared/` so a future server-side dispatcher proc (if we
 * ever consolidate the probes server-side) can reuse the same
 * formatting without re-implementing the strings.
 */

export interface ProbeResult {
  ok: boolean;
  /** Round-trip in milliseconds. 0 when the probe didn't make a request. */
  latencyMs: number;
  /** Number of items the listSystems / listSites call returned, when known. */
  sampleCount?: number;
  /** Message to surface on failure. Pulled from the thrown error. */
  error?: string;
}

/**
 * Format a probe round-trip duration. Prefers `ms` for sub-second
 * results and `Xs` for longer probes.
 *
 *   312     → "312ms"
 *   1245    → "1.2s"
 *   12500   → "12.5s"
 *   0       → "0ms"
 *
 * Rounded conservatively — the probe surface isn't a benchmark, so
 * decimal precision past one digit is noise.
 */
export function formatProbeLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${seconds.toFixed(1)}s`;
}

/**
 * Trim a vendor error message to the first useful line and strip
 * leading framework prefixes ("TRPCClientError: ", "Error: "). Pure
 * — exposed for testability so the badge always renders something
 * concise enough to fit alongside the probe button.
 *
 * Empty input or a string of only whitespace becomes the canonical
 * fallback "Unknown error" so the UI never renders a blank failure.
 */
export function trimProbeErrorMessage(raw: unknown): string {
  if (raw == null) return "Unknown error";
  const message =
    typeof raw === "string"
      ? raw
      : raw instanceof Error
        ? raw.message
        : typeof raw === "object" && raw && "message" in raw
          ? String((raw as { message?: unknown }).message ?? "")
          : String(raw);
  const cleaned = message
    .replace(/^TRPCClientError:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .split(/\r?\n/)[0]
    ?.trim();
  if (!cleaned) return "Unknown error";
  // Keep the badge from blowing out the layout — long stack-y
  // messages get clipped at 160 chars with an ellipsis (the "…"
  // counts as one Unicode char, so we slice at 159).
  if (cleaned.length > 160) return `${cleaned.slice(0, 159)}…`;
  return cleaned;
}

/**
 * Produce a one-line summary of the probe result. Used both for the
 * inline status badge and for the toast that fires on completion.
 *
 *   { ok: true, latencyMs: 312, sampleCount: 7 }
 *     → "Connected — 7 systems · 312ms"
 *   { ok: true, latencyMs: 245 }
 *     → "Connected · 245ms"
 *   { ok: false, latencyMs: 1234, error: "401 Unauthorized" }
 *     → "Failed: 401 Unauthorized · 1.2s"
 *   { ok: false, latencyMs: 0, error: "Not connected" }
 *     → "Failed: Not connected"
 */
export function summarizeProbeResult(
  result: ProbeResult,
  opts: { sampleNoun?: string } = {}
): string {
  const sampleNoun = opts.sampleNoun ?? "systems";
  const latencyText =
    result.latencyMs > 0 ? ` · ${formatProbeLatency(result.latencyMs)}` : "";
  if (result.ok) {
    if (typeof result.sampleCount === "number") {
      const label =
        result.sampleCount === 1
          ? singularize(sampleNoun)
          : sampleNoun;
      return `Connected — ${result.sampleCount} ${label}${latencyText}`;
    }
    return `Connected${latencyText}`;
  }
  const err = trimProbeErrorMessage(result.error ?? "Unknown error");
  return `Failed: ${err}${latencyText}`;
}

function singularize(noun: string): string {
  if (noun.endsWith("ies") && noun.length > 3) {
    return `${noun.slice(0, -3)}y`;
  }
  if (noun.endsWith("s") && !noun.endsWith("ss")) {
    return noun.slice(0, -1);
  }
  return noun;
}
