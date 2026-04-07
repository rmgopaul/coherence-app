export default function SolarRecLoginPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #f1f5f9, #ffffff, #f1f5f9)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          borderRadius: "12px",
          border: "1px solid #e2e8f0",
          background: "#ffffff",
          padding: "32px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          textAlign: "center",
        }}
      >
        {/* Sun icon */}
        <div style={{ marginBottom: "16px" }}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m6.34 17.66-1.41 1.41" />
            <path d="m19.07 4.93-1.41 1.41" />
          </svg>
        </div>

        <h1
          style={{
            fontSize: "22px",
            fontWeight: 700,
            color: "#0f172a",
            margin: "0 0 8px 0",
          }}
        >
          Solar REC Dashboard
        </h1>
        <p
          style={{
            fontSize: "14px",
            color: "#64748b",
            margin: "0 0 24px 0",
          }}
        >
          Sign in to access meter reads, monitoring, and REC data.
        </p>

        <a
          href="/solar-rec/api/auth/google"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            width: "100%",
            padding: "10px 16px",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            background: "#ffffff",
            color: "#334155",
            fontSize: "14px",
            fontWeight: 500,
            cursor: "pointer",
            textDecoration: "none",
            transition: "background 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#f8fafc";
            e.currentTarget.style.borderColor = "#cbd5e1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#ffffff";
            e.currentTarget.style.borderColor = "#e2e8f0";
          }}
        >
          {/* Google logo */}
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Sign in with Google
        </a>

        <p
          style={{
            fontSize: "12px",
            color: "#94a3b8",
            marginTop: "20px",
          }}
        >
          Not authorized? Ask your admin for an invite.
        </p>
      </div>
    </div>
  );
}
