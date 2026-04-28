/**
 * Phase E (2026-04-28) — Test Connection probe button used on every
 * per-vendor meter-read page.
 *
 * The vendor router doesn't expose a dedicated probe endpoint
 * (each one would require a per-vendor implementation across
 * different auth schemes). Instead, this component is a thin
 * orchestrator: it times the caller-supplied `runProbe` function
 * (which is wired to the page's existing `listSystems` /
 * `listSites` query refetch) and renders a one-line result so a
 * user can verify "is the credential still valid + can we still
 * reach the API" without having to interpret an empty Systems
 * table or a snapshot error.
 *
 * Props:
 *   - runProbe: returns the discovered system/site count on success.
 *               Throw on failure — the catch path captures the error
 *               for the result message.
 *   - sampleNoun: "systems" / "sites" / etc. for the result string.
 *   - disabled: when true (e.g. no credential registered yet) the
 *               button is greyed out and a hint replaces the result.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import {
  formatProbeLatency,
  summarizeProbeResult,
  trimProbeErrorMessage,
  type ProbeResult,
} from "@shared/meterReadProbe";

export interface MeterReadConnectionProbeProps {
  /**
   * Function that performs the probe and resolves with the count of
   * systems/sites returned. Throws on failure; the component
   * renders the error message inline.
   */
  runProbe: () => Promise<number>;
  /** Plural noun for the result — "systems" (default), "sites", etc. */
  sampleNoun?: string;
  /** When true the button is disabled (e.g. credential not registered). */
  disabled?: boolean;
  /** Hint shown next to a disabled button. */
  disabledHint?: string;
}

export function MeterReadConnectionProbe({
  runProbe,
  sampleNoun = "systems",
  disabled = false,
  disabledHint = "Connect a credential first.",
}: MeterReadConnectionProbeProps) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const handleClick = async () => {
    if (pending || disabled) return;
    const startedAt = performance.now();
    setPending(true);
    setResult(null);
    try {
      const count = await runProbe();
      const latencyMs = Math.round(performance.now() - startedAt);
      const r: ProbeResult = {
        ok: true,
        latencyMs,
        sampleCount: typeof count === "number" ? count : undefined,
      };
      setResult(r);
      toast.success(summarizeProbeResult(r, { sampleNoun }));
    } catch (error: unknown) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const r: ProbeResult = {
        ok: false,
        latencyMs,
        error: trimProbeErrorMessage(error),
      };
      setResult(r);
      toast.error(summarizeProbeResult(r, { sampleNoun }));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleClick()}
        disabled={disabled || pending}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
        ) : result?.ok === false ? (
          <ShieldAlert className="h-3.5 w-3.5 mr-1 text-rose-600" />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5 mr-1" />
        )}
        Test Connection
      </Button>

      {disabled ? (
        <span className="text-xs text-muted-foreground">{disabledHint}</span>
      ) : pending ? (
        <span className="text-xs text-muted-foreground">Probing…</span>
      ) : result ? (
        <ProbeResultBadge result={result} sampleNoun={sampleNoun} />
      ) : null}
    </div>
  );
}

function ProbeResultBadge({
  result,
  sampleNoun,
}: {
  result: ProbeResult;
  sampleNoun: string;
}) {
  if (result.ok) {
    return (
      <Badge
        variant="default"
        className="bg-emerald-500/15 text-emerald-700 border-emerald-500/40"
      >
        {typeof result.sampleCount === "number"
          ? `${result.sampleCount} ${sampleNoun} · ${formatProbeLatency(result.latencyMs)}`
          : `OK · ${formatProbeLatency(result.latencyMs)}`}
      </Badge>
    );
  }
  return (
    <Badge
      variant="destructive"
      className="bg-rose-500/15 text-rose-700 border-rose-500/40 max-w-[36ch] truncate"
      title={result.error ?? "Unknown error"}
    >
      {result.error ?? "Unknown error"}
    </Badge>
  );
}

export default MeterReadConnectionProbe;
