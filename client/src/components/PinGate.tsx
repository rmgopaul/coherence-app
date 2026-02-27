import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Lock } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type PinStatus = {
  enabled: boolean;
  unlocked: boolean;
};

type PinGateProps = {
  children: React.ReactNode;
};

export default function PinGate({ children }: PinGateProps) {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetPinMailto =
    "mailto:rhett.gopaul@gmail.com?subject=Coherence%20PIN%20Reset%20Request&body=Please%20reset%20my%20Coherence%20PIN.%0A%0ATime:%20";

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/pin/status", { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Failed to load PIN status (${res.status})`);
      }
      const nextStatus = (await res.json()) as PinStatus;
      setStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load PIN status");
      setStatus({ enabled: true, unlocked: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const isUnlocked = useMemo(() => {
    if (!status) return false;
    if (!status.enabled) return true;
    return status.unlocked;
  }, [status]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pin.trim()) {
      setError("Enter PIN");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/pin/verify", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pin: pin.trim() }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Invalid PIN");
      }

      setPin("");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlock");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-6 w-6 animate-spin text-slate-600" />
      </div>
    );
  }

  if (isUnlocked) return <>{children}</>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Lock className="h-5 w-5 text-slate-700" />
          <h1 className="text-lg font-semibold text-slate-900">PIN Protected</h1>
        </div>
        <p className="text-sm text-slate-600 mb-4">
          Enter your PIN to access Coherence.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Input
            type="password"
            inputMode="numeric"
            placeholder="Enter PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button className="flex-1" type="submit" disabled={submitting}>
              {submitting ? "Unlocking..." : "Unlock"}
            </Button>
            <Button type="button" variant="outline" onClick={fetchStatus} disabled={submitting}>
              Refresh
            </Button>
          </div>
          <div className="pt-1">
            <a
              href={`${resetPinMailto}${encodeURIComponent(new Date().toISOString())}`}
              className="text-xs text-slate-600 underline underline-offset-2 hover:text-slate-900"
            >
              Forgot PIN? Request reset
            </a>
          </div>
        </form>
      </div>
    </div>
  );
}
