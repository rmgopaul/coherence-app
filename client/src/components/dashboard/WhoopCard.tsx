import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HeartPulse, RefreshCw, Loader2 } from "lucide-react";
import { SectionRating } from "@/components/SectionRating";
import { useLocation } from "wouter";

const toPercent = (value: number | null) =>
  value === null ? "-" : `${Math.round(value)}%`;
const toOneDecimal = (value: number | null) =>
  value === null ? "-" : value.toFixed(1);
const celsiusToFahrenheit = (value: number | null) =>
  value === null ? null : Number(((value * 9) / 5 + 32).toFixed(1));
const kilojouleToCalories = (value: number | null) =>
  value === null ? null : Number((value / 4.184).toFixed(0));

interface WhoopCardProps {
  whoopSummary: any;
  hasWhoop: boolean;
  isLoading: boolean;
  isFetching: boolean;
  errorMessage: string | null;
  onRefresh: () => void;
  sectionRating?: number;
}

export function WhoopCard({
  whoopSummary,
  hasWhoop,
  isLoading,
  isFetching,
  errorMessage,
  onRefresh,
  sectionRating,
}: WhoopCardProps) {
  const [, setLocation] = useLocation();
  const [metricsExpanded, setMetricsExpanded] = useState(false);

  return (
    <Card className="flex flex-col border-zinc-900 bg-zinc-950 text-zinc-100 shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <HeartPulse className="h-4 w-4 text-lime-300" />
          <CardTitle className="text-base text-white">WHOOP</CardTitle>
        </div>
        <div className="flex items-center gap-1">
          <SectionRating sectionId="section-whoop" currentRating={sectionRating as any} />
          {hasWhoop && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={isLoading || isFetching}
              className="h-8 px-2 text-zinc-100 hover:text-white hover:bg-zinc-800"
            >
              <RefreshCw
                className={`h-4 w-4 ${isLoading || isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasWhoop ? (
          <div className="text-center py-5 text-zinc-300">
            <HeartPulse className="h-8 w-8 mx-auto mb-2 text-zinc-500" />
            <p className="text-sm">Connect WHOOP in Settings</p>
            <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2 text-lime-300">
              Go to Settings
            </Button>
          </div>
        ) : isLoading ? (
          <div className="flex justify-center py-5">
            <Loader2 className="h-6 w-6 animate-spin text-lime-300" />
          </div>
        ) : whoopSummary ? (
          <>
            <p className="text-xs text-zinc-300">
              Auto-refresh every 5m.
              {whoopSummary.dataDate ? ` Data: ${whoopSummary.dataDate}.` : ""}
              {whoopSummary.profile
                ? ` ${whoopSummary.profile.firstName} ${whoopSummary.profile.lastName}`.trim()
                : ""}
            </p>
            {/* Hero metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-lg border border-lime-300/30 bg-lime-300/10 p-3">
                <p className="text-xs uppercase tracking-wide text-lime-200">Recovery</p>
                <p className="text-xl font-bold text-lime-300 mt-1">
                  {toPercent(whoopSummary.recoveryScore)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3">
                <p className="text-xs uppercase tracking-wide text-zinc-400">Day Strain</p>
                <p className="text-xl font-bold text-white mt-1">
                  {toOneDecimal(whoopSummary.dayStrain)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3">
                <p className="text-xs uppercase tracking-wide text-zinc-400">Sleep</p>
                <p className="text-xl font-bold text-white mt-1">
                  {whoopSummary.sleepHours !== null ? `${whoopSummary.sleepHours}h` : "-"}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3">
                <p className="text-xs uppercase tracking-wide text-zinc-400">HRV</p>
                <p className="text-xl font-bold text-white mt-1">
                  {whoopSummary.hrvRmssdMilli !== null
                    ? `${Math.round(whoopSummary.hrvRmssdMilli)} ms`
                    : "-"}
                </p>
              </div>
            </div>
            {/* Expandable detailed metrics */}
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-7 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              onClick={() => setMetricsExpanded((v) => !v)}
            >
              {metricsExpanded ? "Hide details" : "Show all metrics"}
            </Button>
            {metricsExpanded && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                {[
                  { label: "Time In Bed", value: whoopSummary.timeInBedHours !== null ? `${whoopSummary.timeInBedHours}h` : "-" },
                  { label: "Light Sleep", value: whoopSummary.lightSleepHours !== null ? `${whoopSummary.lightSleepHours}h` : "-" },
                  { label: "Deep Sleep", value: whoopSummary.deepSleepHours !== null ? `${whoopSummary.deepSleepHours}h` : "-" },
                  { label: "REM Sleep", value: whoopSummary.remSleepHours !== null ? `${whoopSummary.remSleepHours}h` : "-" },
                  { label: "Awake", value: whoopSummary.awakeHours !== null ? `${whoopSummary.awakeHours}h` : "-" },
                  { label: "Sleep Performance", value: toPercent(whoopSummary.sleepPerformance) },
                  { label: "Sleep Efficiency", value: toPercent(whoopSummary.sleepEfficiency) },
                  { label: "Sleep Consistency", value: toPercent(whoopSummary.sleepConsistency) },
                  {
                    label: "Energy",
                    value: kilojouleToCalories(whoopSummary.kilojoule) !== null
                      ? `${kilojouleToCalories(whoopSummary.kilojoule)} cal`
                      : "-",
                  },
                  {
                    label: "Resting HR",
                    value: whoopSummary.restingHeartRate !== null
                      ? `${whoopSummary.restingHeartRate} bpm`
                      : "-",
                  },
                  {
                    label: "Respiratory Rate",
                    value: whoopSummary.respiratoryRate !== null
                      ? `${whoopSummary.respiratoryRate.toFixed(1)} br/min`
                      : "-",
                  },
                  {
                    label: "Skin Temp",
                    value: celsiusToFahrenheit(whoopSummary.skinTempCelsius) !== null
                      ? `${celsiusToFahrenheit(whoopSummary.skinTempCelsius)?.toFixed(1)}F`
                      : "-",
                  },
                  { label: "SpO2", value: toPercent(whoopSummary.spo2Percentage) },
                  {
                    label: "Avg HR",
                    value: whoopSummary.averageHeartRate !== null
                      ? `${Math.round(whoopSummary.averageHeartRate)} bpm`
                      : "-",
                  },
                  {
                    label: "Max HR",
                    value: whoopSummary.maxHeartRate !== null
                      ? `${Math.round(whoopSummary.maxHeartRate)} bpm`
                      : "-",
                  },
                  { label: "Workout Strain", value: toOneDecimal(whoopSummary.latestWorkoutStrain) },
                ].map((metric) => (
                  <div key={metric.label} className="rounded-md border border-zinc-800 p-2 bg-zinc-900">
                    <p className="text-xs text-zinc-400">{metric.label}</p>
                    <p className="text-sm font-semibold text-white">{metric.value}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="rounded-md border border-lime-300 bg-lime-300/10 p-2">
              <p className="text-xs text-lime-200">Last Update</p>
              <p className="text-xs font-semibold text-lime-100">
                {new Date(whoopSummary.updatedAt).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
            </div>
          </>
        ) : (
          <div className="text-center py-5 text-zinc-300">
            <p className="text-sm">Unable to load WHOOP data</p>
            {errorMessage && (
              <p className="text-xs text-rose-400 mt-2 break-words">
                {errorMessage}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
