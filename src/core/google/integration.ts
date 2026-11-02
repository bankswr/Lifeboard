// Google integration: Google Health (steps, weight, body fat, heart rate into the
// health_point table),
// then the Schedule's calendar and tasks (core/schedule/push.ts).
// Health is pulled at most once per calendar day per device (user, 2026-10-17): the analysis
// uses only days before today, so later pulls the same day would change nothing it shows.
// The Schedule syncs on every update, and so does a small check that the health data is still
// arriving at Google (agent-notes/2026-10-15-google-health-port.md).
// The desktop signs in with a browser redirect (src/desktop/googleSignIn.ts). The phone can
// sign in with Android's own Google authorization as a backup, used only while it's away
// from the desktop (token.ts); otherwise it gets this data through LAN sync.
import { getCredential, saveCredential } from "../credentials.ts";
import { addDays, localDate } from "../dates.ts";
import type { Db } from "../db/types.ts";
import { healthCatchUpDay, latestRawPointTime, replaceHealthPoints, type HealthPoint, type PointType } from "../health.ts";
import { summarizeDays } from "../healthSummary.ts";
import { getHealthSettings } from "../healthTargets.ts";
import { SignedOutError, type Integration } from "../integration.ts";
import type { Reading } from "../readings.ts";
import { STEP_SOURCES } from "../steps.ts";
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

/**
 * The data that should arrive every day, so its silence means something stopped syncing rather
 * than a quiet day. Two because they fail separately: the ring went silent for days while the
 * phone's steps kept arriving (2026-10-29). Over 90 days neither had a gap above 12 hours.
 */
const HEALTH_CANARIES: { subject: string; type: PointType; sources: string[] }[] = [
  { subject: "Phone steps", type: "steps", sources: ["com.android.healthconnect.phone", "com.google.android.apps.fitness"] },
  { subject: "Ring heart rate", type: "heart-rate", sources: STEP_SOURCES.primary },
];

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
    return checkHealthDataArriving(db, credential);
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
    const catchUpFrom = await healthCatchUpDay(db, type, end);
    const start = catchUpFrom && !needsHistory ? addDays(catchUpFrom, -OVERLAP_DAYS) : historyStart;
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

/**
 * One reading per canary, read from Google itself: the stored data can't tell, since it's pulled
 * once a day and stops at the start of today. Only the last days are asked for; older points
 * come from what's stored. A failed check says nothing about the data, so it stays quiet (the
 * next update tries again) and doesn't mark the connection as having a problem.
 */
async function checkHealthDataArriving(db: Db, credential: GoogleCredential): Promise<Reading[]> {
  try {
    const token = await googleAccessToken(credential, HEALTH_SCOPES);
    const { healthDataStaleHours } = await getHealthSettings(db);
    const today = localDate();
    const readings: Reading[] = [];
    for (const { subject, type, sources } of HEALTH_CANARIES) {
      // Two days ahead: the query's bounds are UTC, which is already tomorrow on evenings here.
      const points = await listDataPoints(token, type, addDays(today, -1), addDays(today, 2));
      const fetched = points
        .map((point) => toHealthPoint(type, point))
        .filter((point): point is HealthPoint => point !== null && sources.includes(point.source))
        .map((point) => point.endTime);
      const stored = await latestRawPointTime(db, type, sources);
      const newest = [...fetched, ...(stored ? [stored] : [])];
      // A source that has never reported isn't one that stopped.
      if (newest.length > 0) readings.push(healthDataReading(subject, newest, healthDataStaleHours));
    }
    return readings;
  } catch (error) {
    if (error instanceof SignedOutError) throw error;
    console.warn("Couldn't check that health data is arriving:", error);
    return [];
  }
}

/** The reading for one canary, given the end times of its points (at least one). */
export function healthDataReading(subject: string, times: string[], staleHours: number, now = new Date()): Reading {
  const newest = Math.max(...times.map((time) => Date.parse(time)));
  const hours = Math.max(0, (now.getTime() - newest) / 3_600_000);
  return { type: "health_data", subject, data: { stale: hours > staleHours, hoursSinceData: Math.round(hours) } };
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
