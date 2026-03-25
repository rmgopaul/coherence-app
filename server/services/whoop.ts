import { AuthError, fetchJson } from "./httpClient";

const WHOOP_BASE = "https://api.prod.whoop.com/developer";

async function getWhoopJson(path: string, accessToken: string): Promise<Record<string, any>> {
  const { data } = await fetchJson<Record<string, any>>(`${WHOOP_BASE}${path}`, {
    service: "WHOOP",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

export type WhoopSummary = {
  profile: {
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  dataDate: string | null;
  recoveryScore: number | null;
  restingHeartRate: number | null;
  hrvRmssdMilli: number | null;
  spo2Percentage: number | null;
  skinTempCelsius: number | null;
  respiratoryRate: number | null;
  sleepPerformance: number | null;
  sleepConsistency: number | null;
  sleepEfficiency: number | null;
  sleepHours: number | null;
  timeInBedHours: number | null;
  lightSleepHours: number | null;
  deepSleepHours: number | null;
  remSleepHours: number | null;
  awakeHours: number | null;
  dayStrain: number | null;
  steps: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  kilojoule: number | null;
  latestWorkoutStrain: number | null;
  updatedAt: string;
};

export async function getWhoopSummary(accessToken: string): Promise<WhoopSummary> {
  const [profile, recoveryCollection, sleepCollection, cycleCollection, workoutCollection] = await Promise.all([
    getWhoopJson("/v2/user/profile/basic", accessToken).catch(() => null),
    getWhoopJson("/v2/recovery?limit=1", accessToken).catch(() => null),
    getWhoopJson("/v2/activity/sleep?limit=1", accessToken).catch(() => null),
    getWhoopJson("/v2/cycle?limit=1", accessToken).catch(() => null),
    getWhoopJson("/v2/activity/workout?limit=1", accessToken).catch(() => null),
  ]);

  const asNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const firstNumber = (...values: unknown[]): number | null => {
    for (const value of values) {
      const num = asNumber(value);
      if (num !== null) return num;
    }
    return null;
  };

  const recovery = recoveryCollection?.records?.[0];
  const recoveryScore = asNumber(recovery?.score?.recovery_score);
  const restingHeartRate = asNumber(recovery?.score?.resting_heart_rate);
  const hrvRmssdMilli = asNumber(recovery?.score?.hrv_rmssd_milli);
  const spo2Percentage = asNumber(recovery?.score?.spo2_percentage);
  const skinTempCelsius = asNumber(recovery?.score?.skin_temp_celsius);

  const sleep = sleepCollection?.records?.[0];
  const sleepPerformance = asNumber(sleep?.score?.sleep_performance_percentage);
  const sleepConsistency = asNumber(sleep?.score?.sleep_consistency_percentage);
  const sleepEfficiency = asNumber(sleep?.score?.sleep_efficiency_percentage);
  const respiratoryRate = asNumber(sleep?.score?.respiratory_rate);
  const sleepSummary = sleep?.score?.stage_summary;
  const lightSleepMillis = sleepSummary?.total_light_sleep_time_milli || 0;
  const deepSleepMillis = sleepSummary?.total_slow_wave_sleep_time_milli || 0;
  const remSleepMillis = sleepSummary?.total_rem_sleep_time_milli || 0;
  const awakeMillis = sleepSummary?.total_awake_time_milli || 0;
  const sleepMillis =
    lightSleepMillis +
    deepSleepMillis +
    remSleepMillis;
  const timeInBedMillis = sleepSummary?.total_in_bed_time_milli || 0;

  const cycle = cycleCollection?.records?.[0];
  const dayStrain = asNumber(cycle?.score?.strain);
  const steps = firstNumber(
    cycle?.score?.steps,
    cycle?.score?.step_count,
    cycle?.score?.steps_count,
    cycle?.score?.total_steps,
    cycle?.steps,
    cycle?.step_count
  );
  const averageHeartRate = asNumber(cycle?.score?.average_heart_rate);
  const maxHeartRate = asNumber(cycle?.score?.max_heart_rate);
  const kilojoule = asNumber(cycle?.score?.kilojoule);
  const cycleDate =
    typeof cycle?.start === "string"
      ? new Date(cycle.start).toISOString().slice(0, 10)
      : null;

  const workout = workoutCollection?.records?.[0];
  const latestWorkoutStrain = asNumber(workout?.score?.strain);

  return {
    profile: profile
      ? {
          firstName: profile.first_name || "",
          lastName: profile.last_name || "",
          email: profile.email || "",
        }
      : null,
    dataDate: cycleDate,
    recoveryScore,
    restingHeartRate,
    hrvRmssdMilli,
    spo2Percentage,
    skinTempCelsius,
    respiratoryRate,
    sleepPerformance,
    sleepConsistency,
    sleepEfficiency,
    sleepHours: sleepMillis > 0 ? Number((sleepMillis / (1000 * 60 * 60)).toFixed(1)) : null,
    timeInBedHours:
      timeInBedMillis > 0 ? Number((timeInBedMillis / (1000 * 60 * 60)).toFixed(1)) : null,
    lightSleepHours:
      lightSleepMillis > 0 ? Number((lightSleepMillis / (1000 * 60 * 60)).toFixed(1)) : null,
    deepSleepHours:
      deepSleepMillis > 0 ? Number((deepSleepMillis / (1000 * 60 * 60)).toFixed(1)) : null,
    remSleepHours:
      remSleepMillis > 0 ? Number((remSleepMillis / (1000 * 60 * 60)).toFixed(1)) : null,
    awakeHours:
      awakeMillis > 0 ? Number((awakeMillis / (1000 * 60 * 60)).toFixed(1)) : null,
    dayStrain: dayStrain !== null ? Number(dayStrain.toFixed(1)) : null,
    steps: steps !== null ? Math.round(steps) : null,
    averageHeartRate,
    maxHeartRate,
    kilojoule,
    latestWorkoutStrain: latestWorkoutStrain !== null ? Number(latestWorkoutStrain.toFixed(1)) : null,
    updatedAt: new Date().toISOString(),
  };
}

const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

async function whoopTokenRequest(params: Record<string, string>): Promise<unknown> {
  const response = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const error = await response.text();
    if (response.status === 401 || response.status === 403) throw new AuthError("WHOOP", response.status);
    throw new Error(`WHOOP token error (${response.status}): ${error}`);
  }
  return response.json();
}

export async function exchangeWhoopCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }> {
  return whoopTokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  }) as Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>;
}

export async function refreshWhoopToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  return whoopTokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }) as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}
