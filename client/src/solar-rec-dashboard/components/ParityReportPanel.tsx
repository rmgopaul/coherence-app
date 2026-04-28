/**
 * Parity Report — dev-only UI for verifying that the server-computed
 * system snapshot matches the client-computed snapshot field-for-field.
 *
 * Visibility: shown only when IndexedDB still has the original
 * datasets (the server-side migration copied, not moved — so we can
 * recompute locally for comparison). Server-side storage is the only
 * supported runtime, so no feature-flag gate is needed.
 */

import { memo, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, Loader2, ChevronDown, ChevronUp, FlaskConical } from "lucide-react";
// Task 5.5 (2026-04-26): solarRecDashboard.* on the standalone Solar
// REC router. Alias keeps call sites unchanged.
import { solarRecTrpc as trpc } from "@/solar-rec/solarRecTrpc";
import { readIndexedDbDatasets } from "../lib/readIndexedDb";
import { isPart2VerifiedAbpRow } from "../lib/helpers/abp";
import { diffSystems, type ParityReport } from "../lib/parityDiff";
import type { CsvRow, DatasetKey, SystemRecord } from "../state/types";
import { useEffect } from "react";

const DATASET_KEYS: readonly DatasetKey[] = [
  "abpReport",
  "solarApplications",
  "contractedDate",
  "accountSolarGeneration",
  "generationEntry",
  "transferHistory",
  "deliveryScheduleBase",
];

type RunState =
  | { status: "idle" }
  | { status: "running"; stage: string }
  | { status: "done"; report: ParityReport; durationMs: number }
  | { status: "error"; message: string };

export default memo(function ParityReportPanel() {
  const [hasLocal, setHasLocal] = useState<boolean | null>(null);
  const [state, setState] = useState<RunState>({ status: "idle" });
  const [expanded, setExpanded] = useState(false);
  const trpcUtils = trpc.useUtils();

  // Probe IndexedDB once to decide whether the panel should render.
  useEffect(() => {
    let cancelled = false;
    readIndexedDbDatasets(["abpReport"]).then((result) => {
      if (cancelled) return;
      setHasLocal(result !== null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runParity = useCallback(async () => {
    setState({ status: "running", stage: "Fetching server snapshot..." });
    try {
      // 1. Resolve scope
      const { scopeId } = await trpcUtils.solarRecDashboard.getScopeId.fetch();

      // 2. Fetch server snapshot — may return building=true on first call
      //    while the server computes asynchronously. Poll until ready.
      let serverResult = await trpcUtils.solarRecDashboard.getSystemSnapshot.fetch({
        scopeId,
      });

      const MAX_POLL_SECONDS = 300;
      const POLL_INTERVAL_MS = 3000;
      const pollStart = Date.now();

      while (serverResult.building) {
        const elapsed = Math.round((Date.now() - pollStart) / 1000);
        if (elapsed > MAX_POLL_SECONDS) {
          setState({
            status: "error",
            message: `Server compute did not finish within ${MAX_POLL_SECONDS}s`,
          });
          return;
        }
        setState({
          status: "running",
          stage: `Server computing snapshot (${elapsed}s)...`,
        });
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        serverResult = await trpcUtils.solarRecDashboard.getSystemSnapshot.fetch({
          scopeId,
        });
      }

      // 3. Read IndexedDB rows
      setState({ status: "running", stage: "Reading local datasets..." });
      const localRows = await readIndexedDbDatasets(DATASET_KEYS);
      if (!localRows) {
        setState({
          status: "error",
          message: "No local datasets in IndexedDB — nothing to compare against.",
        });
        return;
      }

      // 4. Recompute client-side using the same buildSystems the server uses
      setState({ status: "running", stage: "Computing client snapshot..." });
      const { buildSystems } = await import("../lib/buildSystems");
      const abpRows: CsvRow[] = localRows["abpReport"] ?? [];
      const clientSystems: SystemRecord[] = buildSystems({
        part2VerifiedAbpRows: abpRows.filter(isPart2VerifiedAbpRow),
        solarApplicationsRows: localRows["solarApplications"] ?? [],
        contractedDateRows: localRows["contractedDate"] ?? [],
        accountSolarGenerationRows: localRows["accountSolarGeneration"] ?? [],
        generationEntryRows: localRows["generationEntry"] ?? [],
        transferHistoryRows: localRows["transferHistory"] ?? [],
        deliveryScheduleBaseRows: localRows["deliveryScheduleBase"] ?? [],
      });

      // 5. Diff
      setState({ status: "running", stage: "Diffing..." });
      const t0 = performance.now();
      const report = diffSystems(clientSystems, serverResult.systems);
      const durationMs = Math.round(performance.now() - t0);

      setState({ status: "done", report, durationMs });
      setExpanded(true);
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Parity check failed",
      });
    }
  }, [trpcUtils]);

  // Only show if we still have local data to compare against.
  if (hasLocal === null) return null; // still probing
  if (!hasLocal) return null;

  const report = state.status === "done" ? state.report : null;
  const isClean =
    report !== null &&
    report.totalFieldMismatches === 0 &&
    report.systemsOnlyOnClient.length === 0 &&
    report.systemsOnlyOnServer.length === 0;

  return (
    <div className="mx-4 mb-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-700">
          <FlaskConical className="h-4 w-4 shrink-0" />
          <div>
            {state.status === "running" ? (
              <span>
                <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                {state.stage}
              </span>
            ) : state.status === "error" ? (
              <span className="text-red-800">Parity check failed: {state.message}</span>
            ) : report ? (
              isClean ? (
                <span className="font-medium text-emerald-800">
                  <CheckCircle2 className="mr-1 inline h-4 w-4" />
                  Parity clean — {report.clientSystemCount} systems, {report.totalFieldMismatches} field mismatches ({state.status === "done" ? state.durationMs : 0}ms)
                </span>
              ) : (
                <span className="font-medium text-amber-800">
                  <AlertTriangle className="mr-1 inline h-4 w-4" />
                  {report.systemsWithMismatches} system(s) differ, {report.totalFieldMismatches} field mismatch(es)
                  {report.systemsOnlyOnClient.length > 0 && `, ${report.systemsOnlyOnClient.length} client-only`}
                  {report.systemsOnlyOnServer.length > 0 && `, ${report.systemsOnlyOnServer.length} server-only`}
                </span>
              )
            ) : (
              <span>
                <strong>Parity verification</strong> — compare server-computed snapshot against local IndexedDB recompute.
                <span className="ml-1 text-xs text-slate-500">(Only compares locally-loaded datasets. Datasets marked &ldquo;Tap tab to load&rdquo; are excluded.)</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {report && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-slate-500 hover:text-slate-800"
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={runParity}
            disabled={state.status === "running"}
          >
            {report ? "Re-run" : "Run Parity Check"}
          </Button>
        </div>
      </div>

      {report && expanded && (
        <div className="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-700 space-y-2">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 max-w-2xl">
            <div>Client systems: <strong>{report.clientSystemCount}</strong></div>
            <div>Server systems: <strong>{report.serverSystemCount}</strong></div>
            <div>Systems only on client: <strong>{report.systemsOnlyOnClient.length}</strong></div>
            <div>Systems only on server: <strong>{report.systemsOnlyOnServer.length}</strong></div>
          </div>

          {Object.keys(report.mismatchesByField).length > 0 && (
            <div>
              <div className="font-medium text-slate-800 mt-2">Mismatches by field:</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(report.mismatchesByField)
                  .sort(([, a], [, b]) => b - a)
                  .map(([field, count]) => (
                    <span key={field}>
                      <code className="bg-slate-200 px-1 rounded">{field}</code>: {count}
                    </span>
                  ))}
              </div>
            </div>
          )}

          {report.firstMismatches.length > 0 && (
            <div>
              <div className="font-medium text-slate-800 mt-2">First {report.firstMismatches.length} mismatches:</div>
              <div className="mt-1 max-h-64 overflow-y-auto rounded border border-slate-200 bg-white">
                <table className="w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      <th className="text-left px-2 py-1">System</th>
                      <th className="text-left px-2 py-1">Field</th>
                      <th className="text-left px-2 py-1">Client</th>
                      <th className="text-left px-2 py-1">Server</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.firstMismatches.map((m, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-2 py-1 font-mono text-slate-600">{m.systemKey}</td>
                        <td className="px-2 py-1 font-mono text-slate-700">{m.field}</td>
                        <td className="px-2 py-1 text-rose-700">{m.clientValue}</td>
                        <td className="px-2 py-1 text-emerald-700">{m.serverValue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(report.systemsOnlyOnClient.length > 0 || report.systemsOnlyOnServer.length > 0) && (
            <div className="mt-2 space-y-1">
              {report.systemsOnlyOnClient.length > 0 && (
                <div>
                  <span className="font-medium text-slate-800">Only on client ({report.systemsOnlyOnClient.length}):</span>{" "}
                  <span className="font-mono text-slate-600">
                    {report.systemsOnlyOnClient.slice(0, 10).join(", ")}
                    {report.systemsOnlyOnClient.length > 10 && "..."}
                  </span>
                </div>
              )}
              {report.systemsOnlyOnServer.length > 0 && (
                <div>
                  <span className="font-medium text-slate-800">Only on server ({report.systemsOnlyOnServer.length}):</span>{" "}
                  <span className="font-mono text-slate-600">
                    {report.systemsOnlyOnServer.slice(0, 10).join(", ")}
                    {report.systemsOnlyOnServer.length > 10 && "..."}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
