// Google integration: Google Health (steps, weight, body fat into the health_point table),
// then the Schedule's calendar and tasks (core/schedule/push.ts).
// Signing in needs a browser redirect, which only the desktop can do for now
// (src/desktop/googleSignIn.ts); the phone gets this data through LAN sync.
import { getCredential } from "../credentials.ts";
import { addDays, localDate } from "../dates.ts";
import { latestHealthDay, replaceHealthPoints, type HealthPoint, type PointType } from "../health.ts";
import type { Integration } from "../integration.ts";
import { syncSchedule } from "../schedule/push.ts";
import { listDataPoints, type DataPoint } from "./healthApi.ts";
import { accessToken, HEALTH_SCOPES, type GoogleClient } from "./oauth.ts";

export interface GoogleCredential extends GoogleClient {
  refreshToken: string;
}

const TYPES: PointType[] = ["steps", "weight", "body-fat"];
/** Days fetched the first time; later fetches re-read 3 days before the newest stored day. */
const FIRST_PULL_DAYS = 30;
const OVERLAP_DAYS = 3;

export const google: Integration = {
  id: "google",
  name: "Google",
  signInMethod: "google",

  async isSetUp(db) {
    return Boolean(await getCredential(db, "google"));
  },

  async update(db) {
    const credential = (await getCredential<GoogleCredential>(db, "google"))!;
    const token = await accessToken(credential, credential.refreshToken, HEALTH_SCOPES);
    // Up to today (not included), as FitThing did: today isn't complete yet.
    const end = localDate();
    for (const type of TYPES) {
      const latest = await latestHealthDay(db, type);
      const start = latest ? addDays(latest, -OVERLAP_DAYS) : addDays(end, -FIRST_PULL_DAYS);
      const points = await listDataPoints(token, type, start, end);
      const stored = points.map((point) => toHealthPoint(type, point)).filter((p): p is HealthPoint => p !== null);
      await replaceHealthPoints(db, type, `${start}T00:00:00Z`, `${end}T00:00:00Z`, stored);
    }
    await syncSchedule(db);
    return [];
  },
};

/** Converts one API point to the stored form; null if it lacks what's needed. */
export function toHealthPoint(type: PointType, point: DataPoint): HealthPoint | null {
  const source: string = point.dataSource?.application?.packageName ?? "unknown";
  try {
    if (type === "steps") {
      const interval = point.steps.interval;
      return {
        // Step points have no name, so the id is built from what identifies them.
        id: `google-steps-${source}-${interval.startTime}-${interval.endTime}`,
        type,
        day: civilDate(interval.civilStartTime.date),
        startTime: interval.startTime,
        endTime: interval.endTime,
        value: Number(point.steps.count),
        source,
      };
    }
    const reading = type === "weight" ? point.weight : point.bodyFat;
    return {
      id: `google-${point.name}`,
      type,
      day: civilDate(reading.sampleTime.civilTime.date),
      startTime: reading.sampleTime.physicalTime,
      endTime: reading.sampleTime.physicalTime,
      value: Number(type === "weight" ? reading.weightGrams : reading.percentage),
      source,
    };
  } catch {
    return null; // a point missing expected fields is skipped, as in FitThing
  }
}

function civilDate(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}
