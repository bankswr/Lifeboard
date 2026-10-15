// Health data stored by Lifeboard. Each day's row has a fixed id made from its date, so the
// same day fetched on both devices is one record after syncing, not two.
import type { NutritionDay } from "./cronometer/parse.ts";
import { addDays, localDate } from "./dates.ts";
import { get, type Db } from "./db/types.ts";
import { stepsByDay } from "./steps.ts";
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

// ---------- Google Health points (steps, weight, body fat) ----------

export type PointType = "steps" | "weight" | "body-fat";

/** One measurement as stored. Weight is in grams, body fat in percent, steps a count. */
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
 * Stores the points fetched for one type and time range, and deletes stored points in that
 * range that Google no longer returned (removed or replaced at the source).
 * `rangeStart`/`rangeEnd` are the UTC ISO bounds the fetch used (end not included).
 */
export async function replaceHealthPoints(db: Db, type: PointType, rangeStart: string, rangeEnd: string, points: HealthPoint[]) {
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

/** The newest day stored for a type, or null. */
export async function latestHealthDay(db: Db, type: PointType): Promise<string | null> {
  return (await get(db, "SELECT MAX(day) AS day FROM health_point WHERE type = ? AND deleted = 0", [type]))?.day ?? null;
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
}

const LBS_PER_GRAM = 0.00220462262185;

/** One row per day for the last `days` days (newest first, ending yesterday), every source combined. */
export async function dailyHealth(db: Db, days = 14): Promise<HealthDay[]> {
  const end = addDays(localDate(), -1);
  const start = addDays(end, -(days - 1));
  const nutrition = new Map(
    (await db.all("SELECT * FROM nutrition_day WHERE date BETWEEN ? AND ? AND deleted = 0", [start, end])).map((row) => [row.date, row]),
  );
  const points = await db.all("SELECT * FROM health_point WHERE day BETWEEN ? AND ? AND deleted = 0", [start, end]);
  const average = (type: PointType, day: string) => {
    const values = points.filter((p) => p.type === type && p.day === day).map((p) => p.value);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const steps = stepsByDay(
    points
      .filter((p) => p.type === "steps")
      .map((p) => ({ day: p.day, start: Date.parse(p.start_time), end: Date.parse(p.end_time), count: p.value, source: p.source })),
  );

  const rows: HealthDay[] = [];
  for (let date = end; date >= start; date = addDays(date, -1)) {
    const food = nutrition.get(date);
    const grams = average("weight", date);
    rows.push({
      date,
      calories: food?.calories ?? null,
      proteinG: food?.protein_g ?? null,
      carbsG: food?.carbs_g ?? null,
      fatG: food?.fat_g ?? null,
      weightLbs: grams === null ? null : grams * LBS_PER_GRAM,
      bodyFatPercent: average("body-fat", date),
      steps: steps.has(date) ? Math.round(steps.get(date)!) : null,
    });
  }
  return rows;
}
