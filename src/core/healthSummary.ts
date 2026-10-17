// Daily summaries of the raw steps and heart rate (user, 2026-10-17): the raw samples stay on
// the device that pulled them (raw_health_point, not synced) and are worked down to one synced
// row per day: total steps, average heart rate and the day's detected workouts. The rest of
// the app reads only the summaries, so the phone needs none of the raw data.
// - Summaries are worked out after each pull for the days it touched, for days that have raw
//   data but no summary yet (e.g. right after the change), and for every raw day when the
//   workout settings change.
// - Raw data is kept RAW_KEEP_DAYS days, so changed workout settings can re-check that far
//   back; older days keep the summary they had.
// - A day without raw data is never summarized here: on the phone, or past the retention,
//   its summary comes from wherever it was made.
import { addDays, localDate } from "./dates.ts";
import { get, type Db } from "./db/types.ts";
import { getHealthSettings } from "./healthTargets.ts";
import { stepsByDay, type StepPoint } from "./steps.ts";
import { saveRecord } from "./sync/records.ts";
import { detectWorkouts, type Workout } from "./workouts.ts";

/** Days of raw samples kept, as long as the history pull (google/integration.ts). */
export const RAW_KEEP_DAYS = 90;

/** Works out and saves the summaries of every day from `start` to `end` that has raw data. */
export async function summarizeDays(db: Db, start: string, end: string): Promise<void> {
  const settings = await getHealthSettings(db);
  const raw = await db.all("SELECT type, day, start_time, end_time, value, source FROM raw_health_point WHERE day BETWEEN ? AND ?", [start, end]);
  if (raw.length === 0) return;

  const stepPoints: StepPoint[] = raw.filter((row) => row.type === "steps")
    .map((row) => ({ day: row.day, start: Date.parse(row.start_time), end: Date.parse(row.end_time), count: row.value, source: row.source }));
  const samples = raw.filter((row) => row.type === "heart-rate")
    .map((row) => ({ day: row.day as string, time: Date.parse(row.start_time), bpm: row.value as number }));
  const resting = new Map<string, number>((await db.all(
    "SELECT day, AVG(value) AS value FROM health_point WHERE type = 'daily-resting-heart-rate' AND day BETWEEN ? AND ? AND deleted = 0 GROUP BY day",
    [start, end],
  )).map((row) => [row.day, row.value]));

  const steps = stepsByDay(stepPoints);
  const workoutsByDay = new Map<string, Workout[]>();
  for (const workout of detectWorkouts(samples, resting, stepPoints, settings)) {
    workoutsByDay.set(workout.date, [...(workoutsByDay.get(workout.date) ?? []), workout]);
  }
  const heartRateByDay = new Map<string, number[]>();
  for (const sample of samples) heartRateByDay.set(sample.day, [...(heartRateByDay.get(sample.day) ?? []), sample.bpm]);

  const days = new Set(raw.map((row) => row.day as string));
  await db.transaction(async () => {
    for (const date of days) {
      const beats = heartRateByDay.get(date);
      await saveSummary(db, {
        date,
        steps: steps.has(date) ? Math.round(steps.get(date)!) : null,
        average_heart_rate: beats ? Math.round(beats.reduce((sum, bpm) => sum + bpm, 0) / beats.length) : null,
        workouts: JSON.stringify(workoutsByDay.get(date) ?? []),
      });
    }
  });
}

/** Saves a day's summary unless the stored one is the same (so re-summarizing doesn't churn sync). */
async function saveSummary(db: Db, summary: { date: string; steps: number | null; average_heart_rate: number | null; workouts: string }) {
  const id = `day-${summary.date}`;
  const existing = await get(db, "SELECT steps, average_heart_rate, workouts FROM health_day_summary WHERE id = ? AND deleted = 0", [id]);
  if (existing && existing.steps === summary.steps && existing.average_heart_rate === summary.average_heart_rate && existing.workouts === summary.workouts) return;
  await saveRecord(db, "health_day_summary", { id, ...summary });
}

/**
 * At each update: summarizes raw days that have no summary yet, and drops raw data past
 * RAW_KEEP_DAYS. Days a pull just touched were summarized by the pull itself.
 */
export async function summarizeNewDays(db: Db, today = localDate()): Promise<void> {
  await db.run("DELETE FROM raw_health_point WHERE day < ?", [addDays(today, -RAW_KEEP_DAYS)]);
  const missing = await get(
    db,
    `SELECT MIN(day) AS first, MAX(day) AS last FROM raw_health_point
     WHERE day NOT IN (SELECT date FROM health_day_summary WHERE deleted = 0)`,
  );
  if (missing?.first) await summarizeDays(db, missing.first, missing.last);
}

/** Re-summarizes every day that still has raw data, e.g. after the workout settings changed. */
export async function resummarizeAll(db: Db): Promise<void> {
  const range = await get(db, "SELECT MIN(day) AS first, MAX(day) AS last FROM raw_health_point");
  if (range?.first) await summarizeDays(db, range.first, range.last);
}
