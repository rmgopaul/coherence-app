import { useCallback, useEffect, useState } from "react";

type AuthStatus = {
  enabled: boolean;
  authenticated: boolean;
};

type SolarRecAuthGateProps = {
  children: React.ReactNode;
};

export default function SolarRecAuthGate({ children }: SolarRecAuthGateProps) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/solar-rec/api/auth/status", { credentials: "include" });
      if (!res.ok) throw new Error(`Status check failed (${res.status})`);
      const data = (await res.json()) as AuthStatus;
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check auth status");
      setStatus({ enabled: true, authenticated: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const isAuthenticated = status && (!status.enabled || status.authenticated);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password.trim()) {
      setError("Enter password");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/solar-rec/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password.trim() }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Invalid password");
      }

      setPassword("");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc" }}>
        <div style={{ color: "#64748b", fontSize: "14px" }}>Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) return <>{children}</>;

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #f1f5f9, #ffffff, #f1f5f9)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{
        width: "100%",
        maxWidth: "384px",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        background: "#ffffff",
        padding: "24px",
        boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
          </svg>
          <h1 style={{ fontSize: "18px", fontWeight: 600, color: "#0f172a", margin: 0 }}>
            Solar REC Dashboard
          </h1>
        </div>
        <p style={{ fontSize: "14px", color: "#475569", marginBottom: "16px" }}>
          Enter the password to access the Solar REC Dashboard.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Enter password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid #e2e8f0",
              fontSize: "14px",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: "8px",
            }}
          />
          {error && (
            <p style={{ fontSize: "12px", color: "#dc2626", margin: "0 0 8px 0" }}>{error}</p>
          )}
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="submit"
              disabled={submitting}
              style={{
                flex: 1,
                padding: "8px 16px",
                borderRadius: "6px",
                border: "none",
                background: "#0f172a",
                color: "#ffffff",
                fontSize: "14px",
                fontWeight: 500,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? "Signing in..." : "Sign In"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
