// Health data stored by Lifeboard. Each day's row has a fixed id made from its date, so the
// same day fetched on both devices is one record after syncing, not two.
import type { NutritionDay } from "./cronometer/parse.ts";
import { addDays, localDate } from "./dates.ts";
import { get, type Db } from "./db/types.ts";
import { deleteRecord, saveRecord } from "./sync/records.ts";

export async function saveNutritionDays(db: Db, days: NutritionDay[]): Promise<void> {
  await db.transaction(async () => {
    for (const day of days) {
      const id = `nutrition-${day.date}`;
      const existing = await get(db, "SELECT calories, protein_g, carbs_g, fat_g FROM nutrition_day WHERE id = ? AND deleted = 0", [id]);
      const row = { date: day.date, calories: day.calories, protein_g: day.proteinG, carbs_g: day.carbsG, fat_g: day.fatG };
      // Unchanged days are skipped so a re-fetch doesn't send every day through sync again.
      if (existing && ["calories", "protein_g", "carbs_g", "fat_g"].every((k) => existing[k] === row[k as keyof typeof row])) continue;
      await saveRecord(db, "nutrition_day", { id, ...row });
    }
  });
}

export async function latestNutritionDate(db: Db): Promise<string | null> {
  return (await get(db, "SELECT MAX(date) AS date FROM nutrition_day WHERE deleted = 0"))?.date ?? null;
}

export async function recentNutrition(db: Db, days = 14): Promise<NutritionDay[]> {
  const rows = await db.all(
    "SELECT date, calories, protein_g, carbs_g, fat_g FROM nutrition_day WHERE deleted = 0 ORDER BY date DESC LIMIT ?",
    [days],
  );
  return rows.map((row) => ({ date: row.date, calories: row.calories, proteinG: row.protein_g, carbsG: row.carbs_g, fatG: row.fat_g }));
}

// ---------- Google Health points (steps, weight, body fat, heart rate) ----------

export type PointType = "steps" | "weight" | "body-fat" | "heart-rate" | "daily-resting-heart-rate";

/**
 * One measurement as stored. Weight is in grams, body fat in percent, steps a count, heart
 * rate (samples every few minutes from the ring) and daily resting heart rate in beats per minute.
 */
export interface HealthPoint {
  id: string;
  type: PointType;
  /** Local date it counts toward. */
  day: string;
  /** UTC ISO times; equal for single readings such as weight. */
  startTime: string;
  endTime: string;
  value: number;
  /** App package that recorded it, e.g. the ring's. */
  source: string;
}

/**
 * Steps and heart-rate samples are raw data: kept only on the device that pulled them
 * (raw_health_point, not synced) and summarized per day (core/healthSummary.ts). The rest are
 * few and synced as they are: weigh-ins and body fat are reviewed one by one.
 */
export const RAW_TYPES: PointType[] = ["steps", "heart-rate"];

/** The table a type is stored in. */
function tableOf(type: PointType): "raw_health_point" | "health_point" {
  return RAW_TYPES.includes(type) ? "raw_health_point" : "health_point";
}

/**
 * Stores the points fetched for one type and time range, and deletes stored points in that
 * range that Google no longer returned (removed or replaced at the source).
 * `rangeStart`/`rangeEnd` are the UTC ISO bounds the fetch used (end not included).
 * Raw types need summarizing afterwards (summarizeDays).
 */
export async function replaceHealthPoints(db: Db, type: PointType, rangeStart: string, rangeEnd: string, points: HealthPoint[]) {
  if (tableOf(type) === "raw_health_point") return replaceRawPoints(db, type, rangeStart, rangeEnd, points);
  await db.transaction(async () => {
    const stored = await db.all(
      "SELECT id, day, start_time, end_time, value, source FROM health_point WHERE type = ? AND start_time >= ? AND start_time < ? AND deleted = 0",
      [type, rangeStart, rangeEnd],
    );
    const storedById = new Map(stored.map((row) => [row.id, row]));
    for (const point of points) {
      const row = { day: point.day, start_time: point.startTime, end_time: point.endTime, value: point.value, source: point.source };
      const existing = storedById.get(point.id);
      storedById.delete(point.id);
      if (existing && Object.entries(row).every(([key, value]) => existing[key] === value)) continue;
      await saveRecord(db, "health_point", { id: point.id, type, ...row });
    }
    for (const gone of storedById.keys()) await deleteRecord(db, "health_point", gone);
  });
}

/** Raw points: plain rows, replaced wholesale for the range (nothing to sync, so no tombstones). */
async function replaceRawPoints(db: Db, type: PointType, rangeStart: string, rangeEnd: string, points: HealthPoint[]) {
  await db.transaction(async () => {
    await db.run("DELETE FROM raw_health_point WHERE type = ? AND start_time >= ? AND start_time < ?", [type, rangeStart, rangeEnd]);
    for (const point of points) {
      await db.run(
        "INSERT OR REPLACE INTO raw_health_point (id, type, day, start_time, end_time, value, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [point.id, type, point.day, point.startTime, point.endTime, point.value, point.source],
      );
    }
  });
}

/** The newest day stored for a type, or null. */
export async function latestHealthDay(db: Db, type: PointType): Promise<string | null> {
  const table = tableOf(type);
  const live = table === "health_point" ? " AND deleted = 0" : "";
  return (await get(db, `SELECT MAX(day) AS day FROM ${table} WHERE type = ?${live}`, [type]))?.day ?? null;
}

// ---------- daily summary ----------

export interface HealthDay {
  date: string;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  weightLbs: number | null;
  bodyFatPercent: number | null;
  steps: number | null;
  /** Mean of the day's heart-rate samples. */
  averageHeartRate: number | null;
  restingHeartRate: number | null;
}

export const LBS_PER_GRAM = 0.00220462262185;

/** One row per day for the last `days` days (newest first, ending yesterday), every source combined. */
export async function dailyHealth(db: Db, days = 14): Promise<HealthDay[]> {
  const end = addDays(localDate(), -1);
  return healthDays(db, addDays(end, -(days - 1)), end);
}

/** One row per day from `start` to `end` (both included), newest first, every source combined. */
export async function healthDays(db: Db, start: string, end: string): Promise<HealthDay[]> {
  const nutrition = new Map(
    (await db.all("SELECT * FROM nutrition_day WHERE date BETWEEN ? AND ? AND deleted = 0", [start, end])).map((row) => [row.date, row]),
  );
  const averages = new Map(
    (await db.all(
      `SELECT type, day, AVG(value) AS value FROM health_point
       WHERE type IN ('weight', 'body-fat', 'daily-resting-heart-rate') AND day BETWEEN ? AND ? AND deleted = 0
       GROUP BY type, day`,
      [start, end],
    )).map((row) => [`${row.type} ${row.day}`, row.value as number]),
  );
  const average = (type: PointType, day: string) => averages.get(`${type} ${day}`) ?? null;
  // Steps and heart rate come from the synced daily summaries (core/healthSummary.ts).
  const summaries = new Map(
    (await db.all("SELECT date, steps, average_heart_rate FROM health_day_summary WHERE date BETWEEN ? AND ? AND deleted = 0", [start, end]))
      .map((row) => [row.date as string, row]),
  );

  const rows: HealthDay[] = [];
  for (let date = end; date >= start; date = addDays(date, -1)) {
    const food = nutrition.get(date);
    const grams = average("weight", date);
    const summary = summaries.get(date);
    const heartRate: number | null = summary?.average_heart_rate ?? null;
    const resting = average("daily-resting-heart-rate", date);
    rows.push({
      date,
      calories: food?.calories ?? null,
      proteinG: food?.protein_g ?? null,
      carbsG: food?.carbs_g ?? null,
      fatG: food?.fat_g ?? null,
      weightLbs: grams === null ? null : grams * LBS_PER_GRAM,
      bodyFatPercent: average("body-fat", date),
      steps: summary?.steps == null ? null : Math.round(summary.steps),
      averageHeartRate: heartRate === null ? null : Math.round(heartRate),
      restingHeartRate: resting === null ? null : Math.round(resting),
    });
  }
  return rows;
}
