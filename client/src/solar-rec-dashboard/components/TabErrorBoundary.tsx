/**
 * Phase 1.2 of the dashboard foundation repair (2026-04-30) —
 * tab-scoped error boundary that catches lazy-chunk import failures
 * and runtime throws from a single dashboard tab without killing
 * the rest of the SPA shell.
 *
 * Why this exists separately from `client/src/components/ErrorBoundary.tsx`:
 *   - The shell-level `ErrorBoundary` renders `min-h-screen` and
 *     reloads the page — appropriate for a top-level crash, but
 *     wrong for a single-tab failure that should leave the tab
 *     strip and the other 19 tabs interactive.
 *   - The shell boundary lives one layer above the tab list. A
 *     boundary placed *inside* each tab's `<Suspense>` child
 *     positioning is too late to catch chunk-load rejections (the
 *     rejection happens during `lazy()`'s import, before any tab
 *     component mounts). A boundary placed *outside* the
 *     `<Suspense>` for a single tab catches both lazy-import
 *     rejections and any runtime throw inside that tab.
 *
 * The component is intentionally kept small: it shows the failing
 * tab's display label, an incident ID for support correlation, the
 * raw error message, and two recovery actions:
 *
 *   - "Retry tab" — resets boundary state. React re-attempts the
 *     `lazy()` import on the next render; if the chunk is now
 *     reachable (e.g., the network blip has cleared) the tab
 *     mounts normally.
 *   - "Reload to Overview" — navigates the browser to
 *     `/solar-rec/dashboard?tab=overview`. This is a full page
 *     load (fresh HTML + fresh chunks) AND a reset to the
 *     known-good Overview tab — so a permanently-broken tab
 *     (e.g., a fresh bug, a stale cached HTML) doesn't trap the
 *     user in a reload-loop on the broken tab.
 */

import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * Human-readable tab label, e.g. "Overview" or "Change of Ownership".
   * Surfaced in the error UI so the user knows which tab failed.
   */
  tabLabel: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  incidentId: string | null;
}

/**
 * Recognize React's chunk-load failures so we can show a more
 * specific message ("the build deleted the file your browser is
 * trying to load") rather than the generic stack-trace text.
 *
 * Patterns observed in the wild:
 *   - "Failed to fetch dynamically imported module: <url>"
 *   - "Loading chunk N failed."
 *   - `name === "ChunkLoadError"`
 */
function isChunkLoadFailure(error: Error | null): boolean {
  if (!error) return false;
  if (error.name === "ChunkLoadError") return true;
  const msg = error.message ?? "";
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Loading chunk") ||
    msg.includes("ChunkLoadError")
  );
}

class TabErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, incidentId: null };
  }

  static getDerivedStateFromError(error: Error): State {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    return { hasError: true, error, incidentId: `${stamp}-${suffix}` };
  }

  componentDidCatch(
    error: Error,
    info: { componentStack?: string | null }
  ): void {
    // eslint-disable-next-line no-console
    console.error(
      `[TabErrorBoundary] tab="${this.props.tabLabel}" incident=${this.state.incidentId}`,
      error,
      info
    );
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null, incidentId: null });
  };

  reloadToOverview = (): void => {
    // Full page load to /solar-rec/dashboard?tab=overview. The
    // browser navigation pulls a fresh HTML shell + chunks (so a
    // stale cached HTML referring to deleted chunks gets replaced)
    // AND lands on Overview rather than re-rendering the failing
    // tab — avoiding a reload-loop on a permanently-broken tab.
    window.location.href = "/solar-rec/dashboard?tab=overview";
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const message = this.state.error?.message ?? "Unexpected runtime error";
      const isChunkFailure = isChunkLoadFailure(this.state.error);
      return (
        <div className="flex flex-col items-center justify-center w-full p-8 mt-4 bg-background border border-destructive/30 rounded-md">
          <AlertTriangle
            size={32}
            className="text-destructive mb-3 flex-shrink-0"
          />
          <h3 className="text-base font-semibold mb-2">
            Failed to load the {this.props.tabLabel} tab
          </h3>
          <p className="text-sm text-muted-foreground mb-2 text-center max-w-md">
            {isChunkFailure
              ? "This tab's code couldn't be downloaded. A deploy probably happened mid-session — reloading the page will pull the new build."
              : "This tab hit an error and stopped rendering. Other tabs are unaffected."}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            Incident ID:{" "}
            <span className="font-mono">
              {this.state.incidentId ?? "N/A"}
            </span>
          </p>
          <div className="p-3 w-full max-w-md rounded bg-muted overflow-auto mb-4">
            <pre className="text-xs text-muted-foreground whitespace-break-spaces">
              {message}
            </pre>
          </div>
          <div className="flex gap-2">
            <button
              onClick={this.reset}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-sm",
                "bg-secondary text-secondary-foreground hover:opacity-90",
                "cursor-pointer"
              )}
            >
              <RotateCcw size={14} /> Retry tab
            </button>
            <button
              onClick={this.reloadToOverview}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-sm",
                "bg-primary text-primary-foreground hover:opacity-90",
                "cursor-pointer"
              )}
            >
              <RotateCcw size={14} /> Reload to Overview
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default TabErrorBoundary;
