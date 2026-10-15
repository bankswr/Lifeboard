// Health data stored by Lifeboard. Each day's row has a fixed id made from its date, so the
// same day fetched on both devices is one record after syncing, not two.
import type { NutritionDay } from "./cronometer/parse.ts";
import { get, type Db } from "./db/types.ts";
import { saveRecord } from "./sync/records.ts";

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
