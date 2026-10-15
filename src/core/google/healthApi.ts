// Google Health API v4 data points (ported from FitThing client.py and datatypes.py), for
// the three types Lifeboard uses. Each type is queried with an AIP-160 filter over a date
// range; FitThing's agent-notes explain the field names (2026-09-16-account-not-linked-finding).
const BASE_URL = "https://health.googleapis.com/v4";

export type HealthType = "steps" | "weight" | "body-fat";

/** The time field each type is filtered on. */
const FILTER_FIELD: Record<HealthType, string> = {
  steps: "steps.interval.start_time",
  weight: "weight.sample_time.physical_time",
  "body-fat": "body_fat.sample_time.physical_time",
};

export type DataPoint = Record<string, any>;

/** Every point of `type` from `start` up to (not including) `end`, both "YYYY-MM-DD" (UTC midnight, as in FitThing). */
export async function listDataPoints(token: string, type: HealthType, start: string, end: string): Promise<DataPoint[]> {
  const field = FILTER_FIELD[type];
  const filter = `${field} >= "${start}T00:00:00Z" AND ${field} < "${end}T00:00:00Z"`;
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
