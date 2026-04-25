/**
 * Today's health snapshot — unifies WhoopCard + SamsungHealthCard.
 *
 * Reuses the existing dashboard components directly. This page is the
 * second surface for them; both surfaces share the same tRPC queries.
 */

import { useMemo } from "react";
import { WhoopCard } from "@/components/dashboard/WhoopCard";
import { SamsungHealthCard } from "@/components/dashboard/SamsungHealthCard";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";

export function HealthTodayPanel() {
  const { user } = useAuth();

  const {
    data: integrations,
    isFetching: integrationsFetching,
    refetch: refetchIntegrations,
  } = trpc.integrations.list.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const hasWhoop = !!integrations?.some((i) => i.provider === "whoop");
  const hasSamsungHealth = !!integrations?.some(
    (i) => i.provider === "samsung-health"
  );

  const samsungSnapshot = useMemo(() => {
    const integration = integrations?.find((i) => i.provider === "samsung-health");
    if (!integration?.metadata) return null;

    try {
      const parsed = JSON.parse(integration.metadata) as Record<string, unknown>;
      const summary = (parsed?.summary ?? {}) as Record<string, unknown>;
      const sync = (parsed?.sync ?? {}) as Record<string, unknown>;
      const toNullableNumber = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const manualScores =
        parsed?.manualScores && typeof parsed.manualScores === "object"
          ? (parsed.manualScores as Record<string, unknown>)
          : {};
      const manualSleepScore = toNullableNumber(manualScores?.sleepScore);
      const manualEnergyScore = toNullableNumber(manualScores?.energyScore);

      return {
        receivedAt:
          typeof parsed?.receivedAt === "string" && parsed.receivedAt.length > 0
            ? parsed.receivedAt
            : null,
        sourceProvider:
          typeof summary?.sourceProvider === "string" && summary.sourceProvider.length > 0
            ? summary.sourceProvider
            : "unknown",
        steps: toNullableNumber(summary?.steps),
        sleepTotalMinutes: toNullableNumber(summary?.sleepTotalMinutes),
        sleepScore: manualSleepScore ?? toNullableNumber(summary?.sleepScore),
        energyScore: manualEnergyScore ?? toNullableNumber(summary?.energyScore),
        spo2AvgPercent: toNullableNumber(summary?.spo2AvgPercent),
        sleepSessionsCount: toNullableNumber(summary?.sleepSessionsCount),
        heartRateSamplesCount: toNullableNumber(summary?.heartRateSamplesCount),
        recordTypesAttempted: toNullableNumber(summary?.recordTypesAttempted),
        recordTypesSucceeded: toNullableNumber(summary?.recordTypesSucceeded),
        permissionsGranted: Boolean(sync?.permissionsGranted),
        warnings: Array.isArray(sync?.warnings) ? (sync.warnings as string[]) : [],
      };
    } catch {
      return null;
    }
  }, [integrations]);

  const {
    data: whoopSummary,
    isLoading: whoopLoading,
    isFetching: whoopFetching,
    error: whoopError,
    refetch: refetchWhoop,
  } = trpc.whoop.getSummary.useQuery(undefined, {
    enabled: !!user && hasWhoop,
    retry: false,
    staleTime: 20 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <WhoopCard
        whoopSummary={whoopSummary}
        hasWhoop={hasWhoop}
        isLoading={whoopLoading}
        isFetching={whoopFetching}
        errorMessage={whoopError?.message ?? null}
        onRefresh={() => {
          void refetchWhoop();
        }}
        sectionRating={undefined}
      />
      <SamsungHealthCard
        snapshot={samsungSnapshot}
        hasSamsungHealth={hasSamsungHealth}
        isRefreshing={integrationsFetching}
        onRefresh={() => {
          void refetchIntegrations();
        }}
        sectionRating={undefined}
      />
    </div>
  );
}
