// Google Health API v4 data points (ported from FitThing client.py and datatypes.py), for
// the types Lifeboard uses. Each type is queried with an AIP-160 filter over a date
// range; FitThing's agent-notes explain the field names (2026-09-16-account-not-linked-finding).
import { addDays } from "../dates.ts";

const BASE_URL = "https://health.googleapis.com/v4";

export type HealthType = "steps" | "weight" | "body-fat" | "heart-rate" | "daily-resting-heart-rate";

/** The field each type is filtered on: a time for most, a plain date for daily types. */
const FILTER_FIELD: Record<HealthType, string> = {
  steps: "steps.interval.start_time",
  weight: "weight.sample_time.physical_time",
  "body-fat": "body_fat.sample_time.physical_time",
  "heart-rate": "heart_rate.sample_time.physical_time",
  "daily-resting-heart-rate": "daily_resting_heart_rate.date",
};

/** Daily types take dates in the filter ("2026-10-05"), as in FitThing's raw exports. */
const DAILY_TYPES: HealthType[] = ["daily-resting-heart-rate"];

/**
 * The longest date range one query may cover (developers.google.com/health/data-types,
 * checked 2026-10-16): 14 days for heart rate, 90 for the rest. Longer ranges are split.
 */
function maxQueryDays(type: HealthType): number {
  return type === "heart-rate" ? 14 : 90;
}

export type DataPoint = Record<string, any>;

/** Every point of `type` from `start` up to (not including) `end`, both "YYYY-MM-DD" (UTC midnight, as in FitThing). */
export async function listDataPoints(token: string, type: HealthType, start: string, end: string): Promise<DataPoint[]> {
  const points: DataPoint[] = [];
  for (let from = start; from < end; from = addDays(from, maxQueryDays(type))) {
    const to = addDays(from, maxQueryDays(type));
    points.push(...(await listRange(token, type, from, to < end ? to : end)));
  }
  return points;
}

/** One query's worth: a range no longer than the type allows. */
async function listRange(token: string, type: HealthType, start: string, end: string): Promise<DataPoint[]> {
  const field = FILTER_FIELD[type];
  const bound = (date: string) => (DAILY_TYPES.includes(type) ? date : `${date}T00:00:00Z`);
  const filter = `${field} >= "${bound(start)}" AND ${field} < "${bound(end)}"`;
  const points: DataPoint[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: "10000", filter });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`${BASE_URL}/users/me/dataTypes/${type}/dataPoints?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Google Health answered ${response.status} for ${type}: ${(await response.text()).slice(0, 200)}`);
    const page = await response.json();
    points.push(...(page.dataPoints ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return points;
}
