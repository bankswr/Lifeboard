// Google integration: Google Health (steps, weight, body fat, heart rate into the
// health_point table),
// then the Schedule's calendar and tasks (core/schedule/push.ts).
// Health is pulled at most once per calendar day per device (user, 2026-10-17): the analysis
// uses only days before today, so later pulls the same day would change nothing it shows.
// The Schedule syncs on every update.
// The desktop signs in with a browser redirect (src/desktop/googleSignIn.ts). The phone can
// sign in with Android's own Google authorization as a backup, used only while it's away
// from the desktop (token.ts); otherwise it gets this data through LAN sync.
import { getCredential, saveCredential } from "../credentials.ts";
import { addDays, localDate } from "../dates.ts";
import type { Db } from "../db/types.ts";
import { latestHealthDay, replaceHealthPoints, type HealthPoint, type PointType } from "../health.ts";
import type { Integration } from "../integration.ts";
import { summarizeDays } from "../healthSummary.ts";
import { syncSchedule } from "../schedule/push.ts";
import { listDataPoints, type DataPoint } from "./healthApi.ts";
import { HEALTH_SCOPES } from "./oauth.ts";
import { googleAccessToken, googleActiveHere, type GoogleCredential } from "./token.ts";

export type { GoogleCredential } from "./token.ts";

const TYPES: PointType[] = ["steps", "weight", "body-fat", "heart-rate", "daily-resting-heart-rate"];
/**
 * Days of history fetched once (user, 2026-10-16: 90 days, enough heart rate and weight
 * history for the analysis); later fetches re-read 3 days before the newest stored day.
 * Raising this makes every device fetch the longer history at its next update.
 */
export const HISTORY_DAYS = 90;
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
    // The phone leaves Google to the desktop unless they haven't synced for 12+ hours.
    if (!(await googleActiveHere(db, credential))) return [];
    if (needsHealthPull(credential, localDate())) await pullHealth(db, credential);
    await syncSchedule(db);
    return [];
  },
};

/** Lets the next update pull health again today (the Re-pull button, user 2026-10-17). */
export async function allowGoogleHealthRepull(db: Db) {
  const credential = await getCredential<GoogleCredential>(db, "google");
  if (credential) await saveCredential(db, "google", { ...credential, healthPulledOn: undefined });
}

/** True unless health was already pulled today and the history has been fetched. */
export function needsHealthPull(credential: GoogleCredential, today: string): boolean {
  const needsHistory = !credential.historyFrom || credential.historyFrom > addDays(today, -HISTORY_DAYS);
  return needsHistory || credential.healthPulledOn !== today;
}

async function pullHealth(db: Db, credential: GoogleCredential) {
  const token = await googleAccessToken(credential, HEALTH_SCOPES);
  // Up to today (not included), as FitThing did: today isn't complete yet.
  const end = localDate();
  const historyStart = addDays(end, -HISTORY_DAYS);
  const needsHistory = !credential.historyFrom || credential.historyFrom > historyStart;
  let earliest = end;
  for (const type of TYPES) {
    const latest = await latestHealthDay(db, type);
    const start = latest && !needsHistory ? addDays(latest, -OVERLAP_DAYS) : historyStart;
    const points = await listDataPoints(token, type, start, end);
    const stored = points.map((point) => toHealthPoint(type, point)).filter((p): p is HealthPoint => p !== null);
    await replaceHealthPoints(db, type, `${start}T00:00:00Z`, `${end}T00:00:00Z`, stored);
    if (start < earliest) earliest = start;
  }
  // Steps and heart rate stay here as raw data; the days just fetched get their synced summaries.
  await summarizeDays(db, earliest, end);
  await saveCredential(db, "google", {
    ...credential, healthPulledOn: end, historyFrom: needsHistory ? historyStart : credential.historyFrom,
  });
}

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
    if (type === "heart-rate") {
      const sampleTime = point.heartRate.sampleTime;
      return {
        // Heart-rate points have no name either.
        id: `google-heart-rate-${source}-${sampleTime.physicalTime}`,
        type,
        day: civilDate(sampleTime.civilTime.date),
        startTime: sampleTime.physicalTime,
        endTime: sampleTime.physicalTime,
        value: Number(point.heartRate.beatsPerMinute),
        source,
      };
    }
    if (type === "daily-resting-heart-rate") {
      // A daily value with no time of its own: stored at the start of its (UTC) date so the
      // fetch range, which is compared against start_time, covers it.
      const day = civilDate(point.dailyRestingHeartRate.date);
      return {
        id: `google-resting-heart-rate-${source}-${day}`,
        type,
        day,
        startTime: `${day}T00:00:00Z`,
        endTime: `${day}T00:00:00Z`,
        value: Number(point.dailyRestingHeartRate.beatsPerMinute),
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
