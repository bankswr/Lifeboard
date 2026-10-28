// Weather (user, 2026-10-28): a daily forecast from Open-Meteo (free, no key), used to move
// maintenance items off days the weather rules out (core/maintenanceWeather.ts).
// - The home location is one synced setting, found by place name with Open-Meteo's geocoding.
// - Each update fetches 16 days ahead plus the past week (so "not the day after rain" works
//   for today) and stores it as a synced setting, so a device that can't fetch still gets
//   the other one's forecast. A forecast over a day old isn't used.
// Shown under Settings → Connections like any connection; it has no sign-in, only a location.
import { get, type Db } from "./db/types.ts";
import type { Integration } from "./integration.ts";
import { deleteRecord, saveRecord } from "./sync/records.ts";

export interface WeatherPlace {
  name: string;
  latitude: number;
  longitude: number;
}

/** One day's forecast (or, for past days, what happened). Null where Open-Meteo has no value. */
export interface WeatherDay {
  date: string;
  highF: number | null;
  lowF: number | null;
  /** Mean relative humidity, %. */
  humidity: number | null;
  /** Highest chance of rain in the day, %. */
  rainChance: number | null;
  /** Total rain (and melted snow), inches. */
  rainIn: number | null;
}

export interface Forecast {
  /** When it was fetched (ISO 8601 UTC). */
  fetchedAt: string;
  days: WeatherDay[];
}

const LOCATION_ID = "weather_location";
const FORECAST_ID = "weather_forecast";
const FORECAST_DAYS = 16;
const PAST_DAYS = 7;
/** An older forecast is ignored and items keep their usual dates (user, 2026-10-28). */
const STALE_MS = 24 * 60 * 60 * 1000;

// ---------- location ----------

export async function getWeatherLocation(db: Db): Promise<WeatherPlace | null> {
  const row = await get(db, "SELECT value FROM setting WHERE id = ? AND deleted = 0", [LOCATION_ID]);
  return row ? JSON.parse(row.value) : null;
}

export async function setWeatherLocation(db: Db, place: WeatherPlace): Promise<void> {
  await saveRecord(db, "setting", { id: LOCATION_ID, value: JSON.stringify(place) });
}

/** Removes the location and its forecast, on both devices. */
export async function clearWeatherLocation(db: Db): Promise<void> {
  await deleteRecord(db, "setting", LOCATION_ID);
  await deleteRecord(db, "setting", FORECAST_ID);
}

/** Places matching a name (a town, or a postal code in some countries), for the user to pick from. */
export async function findWeatherPlaces(query: string): Promise<WeatherPlace[]> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name: query.trim(), count: "8", language: "en", format: "json" }).toString();
  const body = await fetchJson(url);
  return (body.results ?? []).map((result: any) => ({
    name: [result.name, result.admin1, result.country_code].filter(Boolean).join(", "),
    latitude: result.latitude,
    longitude: result.longitude,
  }));
}

// ---------- forecast ----------

export async function fetchForecast(place: WeatherPlace, now = new Date()): Promise<Forecast> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    daily: "temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,precipitation_probability_max,precipitation_sum",
    temperature_unit: "fahrenheit",
    precipitation_unit: "inch",
    // Days in the place's own time zone, the same as the user's.
    timezone: "auto",
    forecast_days: String(FORECAST_DAYS),
    past_days: String(PAST_DAYS),
  }).toString();
  return parseForecast(await fetchJson(url), now);
}

/** Open-Meteo's column-per-measure `daily` block as one row per day. */
export function parseForecast(body: any, now = new Date()): Forecast {
  const daily = body?.daily;
  if (!Array.isArray(daily?.time)) throw new Error("Open-Meteo sent no daily forecast.");
  const value = (name: string, index: number): number | null => daily[name]?.[index] ?? null;
  return {
    fetchedAt: now.toISOString(),
    days: daily.time.map((date: string, index: number) => ({
      date,
      highF: value("temperature_2m_max", index),
      lowF: value("temperature_2m_min", index),
      humidity: value("relative_humidity_2m_mean", index),
      rainChance: value("precipitation_probability_max", index),
      rainIn: value("precipitation_sum", index),
    })),
  };
}

export async function saveForecast(db: Db, forecast: Forecast): Promise<void> {
  await saveRecord(db, "setting", { id: FORECAST_ID, value: JSON.stringify(forecast) });
}

/** The stored forecast if it's recent enough to plan by, else null. */
export async function currentForecast(db: Db, now = new Date()): Promise<Forecast | null> {
  const row = await get(db, "SELECT value FROM setting WHERE id = ? AND deleted = 0", [FORECAST_ID]);
  if (!row) return null;
  const forecast: Forecast = JSON.parse(row.value);
  return now.getTime() - new Date(forecast.fetchedAt).getTime() <= STALE_MS ? forecast : null;
}

async function fetchJson(url: URL): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}.`);
  return response.json();
}

// ---------- the connection ----------

export const weather: Integration = {
  id: "weather",
  name: "Weather",
  signInMethod: "location",
  isSetUp: async (db) => (await getWeatherLocation(db)) !== null,
  signOut: clearWeatherLocation,
  async update(db) {
    const place = await getWeatherLocation(db);
    if (place) await saveForecast(db, await fetchForecast(place));
    return [];
  },
};
