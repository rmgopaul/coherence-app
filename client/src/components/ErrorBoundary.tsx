import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  incidentId: string | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, incidentId: null };
  }

  static getDerivedStateFromError(error: Error): State {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    return { hasError: true, error, incidentId: `${stamp}-${suffix}` };
  }

  render() {
    if (this.state.hasError) {
      const conciseMessage = this.state.error?.message || "Unexpected runtime error";
      return (
        <div className="flex items-center justify-center min-h-screen p-8 bg-background">
          <div className="flex flex-col items-center w-full max-w-2xl p-8">
            <AlertTriangle
              size={48}
              className="text-destructive mb-6 flex-shrink-0"
            />

            <h2 className="text-xl mb-3">Something went wrong.</h2>
            <p className="text-sm text-muted-foreground mb-2">
              The page hit an error and stopped rendering.
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              Incident ID: <span className="font-mono">{this.state.incidentId || "N/A"}</span>
            </p>

            <div className="p-4 w-full rounded bg-muted overflow-auto mb-6">
              <pre className="text-sm text-muted-foreground whitespace-break-spaces">
                {conciseMessage}
              </pre>
            </div>

            <button
              onClick={() => window.location.reload()}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg",
                "bg-primary text-primary-foreground",
                "hover:opacity-90 cursor-pointer"
              )}
            >
              <RotateCcw size={16} />
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
