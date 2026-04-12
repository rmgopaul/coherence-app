import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Smartphone, RefreshCw, Loader2 } from "lucide-react";
import { SectionRating } from "@/components/SectionRating";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function formatHoursAndMinutes(minutes: number) {
  const totalMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(totalMinutes / 60);
  const remainder = totalMinutes % 60;
  if (hours > 0 && remainder > 0) return `${hours}h ${remainder}m`;
  if (hours > 0) return `${hours}h`;
  return `${remainder}m`;
}

function parseScoreInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    throw new Error("Scores must be numeric");
  }
  if (numeric < 0 || numeric > 100) {
    throw new Error("Scores must be between 0 and 100");
  }
  return Math.round(numeric * 10) / 10;
}

export interface SamsungHealthSnapshot {
  receivedAt: string | null;
  sourceProvider: string;
  steps: number | null;
  sleepTotalMinutes: number | null;
  sleepScore: number | null;
  energyScore: number | null;
  spo2AvgPercent: number | null;
  sleepSessionsCount: number | null;
  heartRateSamplesCount: number | null;
  permissionsGranted: boolean;
  warnings: string[];
}

interface SamsungHealthCardProps {
  snapshot: SamsungHealthSnapshot | null;
  hasSamsungHealth: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  sectionRating?: number;
}

export function SamsungHealthCard({
  snapshot,
  hasSamsungHealth,
  isRefreshing,
  onRefresh,
  sectionRating,
}: SamsungHealthCardProps) {
  const [editingField, setEditingField] = useState<"sleep" | "energy" | null>(null);
  const [sleepScoreInput, setSleepScoreInput] = useState("");
  const [energyScoreInput, setEnergyScoreInput] = useState("");

  useEffect(() => {
    if (!snapshot) return;
    if (editingField) return;
    setSleepScoreInput(snapshot.sleepScore === null ? "" : String(snapshot.sleepScore));
    setEnergyScoreInput(snapshot.energyScore === null ? "" : String(snapshot.energyScore));
  }, [snapshot?.sleepScore, snapshot?.energyScore, editingField]);

  const saveMutation = trpc.samsungHealth.saveManualScores.useMutation({
    onSuccess: () => {
      toast.success("Samsung scores updated");
      onRefresh();
    },
    onError: (error) => {
      toast.error(`Failed to save Samsung scores: ${error.message}`);
    },
  });

  const handleSave = (onSaved?: () => void) => {
    try {
      const sleepScore = parseScoreInput(sleepScoreInput);
      const energyScore = parseScoreInput(energyScoreInput);
      saveMutation.mutate(
        { sleepScore, energyScore },
        { onSuccess: () => onSaved?.() }
      );
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <Card className="flex flex-col border-emerald-200 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 via-lime-50 to-slate-100 dark:from-emerald-950 dark:via-emerald-950/50 dark:to-slate-900 text-foreground shadow-[0_14px_34px_rgba(22,101,52,0.18)] dark:shadow-[0_14px_34px_rgba(22,101,52,0.08)]">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
          <CardTitle className="text-base">Samsung Health</CardTitle>
        </div>
        <div className="flex items-center gap-1">
          <SectionRating sectionId="section-health" currentRating={sectionRating as any} />
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="h-8 px-2"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasSamsungHealth ? (
          <div className="text-center py-5 text-muted-foreground">
            <Smartphone className="h-8 w-8 mx-auto mb-2 text-emerald-400" />
            <p className="text-sm">No Samsung Health sync detected yet.</p>
            <p className="text-xs mt-2">
              Run the Android companion and tap Sync Now.
            </p>
          </div>
        ) : !snapshot ? (
          <div className="text-center py-5 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-emerald-600 dark:text-emerald-400" />
            <p className="text-sm">Waiting for Samsung sync payload...</p>
          </div>
        ) : (
          <>
            {(() => {
              const isStale = snapshot.receivedAt
                ? Date.now() - new Date(snapshot.receivedAt).getTime() > 24 * 60 * 60 * 1000
                : false;
              const ageLabel = snapshot.receivedAt
                ? (() => {
                    const diffMs = Date.now() - new Date(snapshot.receivedAt).getTime();
                    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
                    if (diffDays >= 1) return `${diffDays}d ago`;
                    const diffHrs = Math.floor(diffMs / (60 * 60 * 1000));
                    if (diffHrs >= 1) return `${diffHrs}h ago`;
                    return "just now";
                  })()
                : null;
              return (
                <>
                  {isStale && (
                    <div className="text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 px-2 py-1 rounded mb-2">
                      Data Stale ({ageLabel}) — Check Sync App
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Source: {snapshot.sourceProvider}.{" "}
                    {ageLabel ? `Last sync ${ageLabel}.` : "No sync timestamp."}
                  </p>
                </>
              );
            })()}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <MetricTile label="Steps" value={snapshot.steps !== null ? Math.round(snapshot.steps).toLocaleString() : "-"} />
              <MetricTile label="Sleep" value={snapshot.sleepTotalMinutes !== null ? formatHoursAndMinutes(snapshot.sleepTotalMinutes) : "-"} />
              <MetricTile label="SpO2 Avg" value={snapshot.spo2AvgPercent !== null && snapshot.spo2AvgPercent > 0 ? `${snapshot.spo2AvgPercent.toFixed(1)}%` : "-"} />
              <MetricTile label="Sleep Sessions" value={snapshot.sleepSessionsCount !== null ? String(Math.round(snapshot.sleepSessionsCount)) : "-"} />
              <div
                className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-white/80 dark:bg-emerald-950/60 p-2 cursor-pointer"
                onClick={() => setEditingField("sleep")}
              >
                <p className="text-xs text-muted-foreground">Sleep Score</p>
                {editingField === "sleep" ? (
                  <div className="mt-1 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={sleepScoreInput}
                      autoFocus
                      onChange={(e) => setSleepScoreInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleSave(() => setEditingField(null));
                        } else if (e.key === "Escape") {
                          setEditingField(null);
                        }
                      }}
                      placeholder="82"
                      className="h-7 text-xs"
                    />
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => handleSave(() => setEditingField(null))}
                      disabled={saveMutation.isPending}
                    >
                      Save
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm font-semibold">
                    {snapshot.sleepScore ?? "N/A"}
                  </p>
                )}
              </div>
              <div
                className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-white/80 dark:bg-emerald-950/60 p-2 cursor-pointer"
                onClick={() => setEditingField("energy")}
              >
                <p className="text-xs text-muted-foreground">Energy Score</p>
                {editingField === "energy" ? (
                  <div className="mt-1 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={energyScoreInput}
                      autoFocus
                      onChange={(e) => setEnergyScoreInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleSave(() => setEditingField(null));
                        } else if (e.key === "Escape") {
                          setEditingField(null);
                        }
                      }}
                      placeholder="74"
                      className="h-7 text-xs"
                    />
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => handleSave(() => setEditingField(null))}
                      disabled={saveMutation.isPending}
                    >
                      Save
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm font-semibold">
                    {snapshot.energyScore ?? "N/A"}
                  </p>
                )}
              </div>
            </div>
            <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-white/80 dark:bg-emerald-950/60 p-2">
              <p className="text-xs text-muted-foreground">Sync Health</p>
              <p className="text-sm font-semibold">
                {snapshot.permissionsGranted ? "Permissions granted" : "Permissions incomplete"}
              </p>
              {snapshot.warnings.length > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                  {snapshot.warnings[0]}
                </p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-white/80 dark:bg-emerald-950/60 p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );
}
