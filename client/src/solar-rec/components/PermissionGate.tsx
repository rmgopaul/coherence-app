/**
 * Page-level permission gate. Wrap a page body in this to enforce
 * `useSolarRecPermission(moduleKey).canRead`. Renders a friendly
 * "no access" card when denied; renders children otherwise.
 *
 * The middleware on the server is the actual security boundary — this
 * component just keeps the UI from rendering controls a user can't use.
 */

import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Lock } from "lucide-react";
import { useSolarRecPermission } from "../hooks/useSolarRecPermission";
import { getModule, type ModuleKey } from "@shared/solarRecModules";

export function PermissionGate({
  moduleKey,
  children,
}: {
  moduleKey: ModuleKey;
  children: ReactNode;
}) {
  const gate = useSolarRecPermission(moduleKey);

  if (gate.loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!gate.canRead) {
    const meta = getModule(moduleKey);
    return (
      <div className="max-w-xl mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4 text-muted-foreground" />
              Access denied
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              You don&rsquo;t have access to{" "}
              <span className="font-medium text-foreground">{meta.label}</span>.
              Ask a Solar REC admin to grant permission for this module.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
