/**
 * Weather router — Phase D.
 *
 * Thin wrapper over OpenWeatherMap's One Call 3.0 API with a 15-minute
 * per-location in-process cache. Degrades to `{ offline: true }` when
 * no API key is configured or the upstream call fails — the client
 * renders a "NO FEED CONFIGURED" empty state in that case.
 *
 * Env vars (all read from `process.env` directly — env.ts wiring is
 * mid-split and untouched in this commit):
 *   OPENWEATHER_API_KEY    — required to activate live data
 *   DEFAULT_WEATHER_LAT    — fallback lat, defaults to 37.8044 (Oakland)
 *   DEFAULT_WEATHER_LNG    — fallback lng, defaults to -122.2712
 *   DEFAULT_WEATHER_LABEL  — human-readable name, defaults to "Home"
 *
 * Spec: productivity-hub/handoff/new-integrations.md §"Weather"
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";

const ONE_CALL_URL = "https://api.openweathermap.org/data/3.0/onecall";
const CACHE_MS = 15 * 60_000;

interface WeatherPayload {
  offline: boolean;
  label: string;
  tempF?: number | null;
  feelsLikeF?: number | null;
  hiF?: number | null;
  loF?: number | null;
  description?: string | null;
  icon?: string | null;
  fetchedAt: string;
}

const cache = new Map<
  string,
  { at: number; payload: WeatherPayload }
>();

function defaultLocation() {
  const latRaw = process.env.DEFAULT_WEATHER_LAT;
  const lngRaw = process.env.DEFAULT_WEATHER_LNG;
  const label =
    (process.env.DEFAULT_WEATHER_LABEL ?? "").trim() || "Home";
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  return {
    lat: Number.isFinite(lat) ? lat : 37.8044,
    lng: Number.isFinite(lng) ? lng : -122.2712,
    label,
  };
}

function offlinePayload(label: string): WeatherPayload {
  return {
    offline: true,
    label,
    fetchedAt: new Date().toISOString(),
  };
}

function cacheKey(lat: number, lng: number): string {
  // Round to 4 decimals (~11m) to share cache across minor coord drift.
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

export const weatherRouter = router({
  getCurrent: protectedProcedure
    .input(
      z
        .object({
          lat: z.number().min(-90).max(90).optional(),
          lng: z.number().min(-180).max(180).optional(),
          label: z.string().max(64).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const defaults = defaultLocation();
      const lat = input?.lat ?? defaults.lat;
      const lng = input?.lng ?? defaults.lng;
      const label = input?.label ?? defaults.label;

      const apiKey = process.env.OPENWEATHER_API_KEY?.trim();
      if (!apiKey) {
        return offlinePayload(label);
      }

      const key = cacheKey(lat, lng);
      const cached = cache.get(key);
      if (cached && Date.now() - cached.at < CACHE_MS) {
        return { ...cached.payload, label };
      }

      const url =
        `${ONE_CALL_URL}?lat=${lat}&lon=${lng}` +
        `&units=imperial&exclude=minutely,alerts,hourly&appid=${encodeURIComponent(apiKey)}`;

      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(6_000),
        });
        if (!response.ok) {
          console.warn(
            `[weather] OpenWeatherMap responded ${response.status} ${response.statusText}`
          );
          return offlinePayload(label);
        }
        const json = (await response.json()) as {
          current?: {
            temp?: number;
            feels_like?: number;
            weather?: Array<{ description?: string; icon?: string }>;
          };
          daily?: Array<{
            temp?: { max?: number; min?: number };
          }>;
        };

        const tempF =
          typeof json.current?.temp === "number"
            ? Math.round(json.current.temp)
            : null;
        const feelsLikeF =
          typeof json.current?.feels_like === "number"
            ? Math.round(json.current.feels_like)
            : null;
        const description =
          json.current?.weather?.[0]?.description?.toString() ?? null;
        const icon = json.current?.weather?.[0]?.icon?.toString() ?? null;
        const hiF =
          typeof json.daily?.[0]?.temp?.max === "number"
            ? Math.round(json.daily[0].temp.max)
            : null;
        const loF =
          typeof json.daily?.[0]?.temp?.min === "number"
            ? Math.round(json.daily[0].temp.min)
            : null;

        const payload: WeatherPayload = {
          offline: false,
          label,
          tempF,
          feelsLikeF,
          description,
          icon,
          hiF,
          loF,
          fetchedAt: new Date().toISOString(),
        };
        cache.set(key, { at: Date.now(), payload });
        return payload;
      } catch (err) {
        console.warn("[weather] fetch failed:", err);
        return offlinePayload(label);
      }
    }),
});

export type WeatherResponse = WeatherPayload;
