// Reads Cronometer's Daily Summary CSV (ported from FitThing cronometer/parse.py, calories
// and macros only for now). A required column that can't be found is an error, never a
// silent zero.
import Papa from "papaparse";

export interface NutritionDay {
  date: string;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

const KJ_PER_KCAL = 4.184;

const COLUMNS = {
  date: ["Date"],
  calories: ["Energy (kcal)", "Energy (kJ)", "Energy", "Calories (kcal)", "Calories"],
  protein: ["Protein (g)", "Protein"],
  carbs: ["Carbs (g)", "Carbohydrates (g)", "Carbs"],
  fat: ["Fat (g)", "Total Fat (g)", "Fat"],
};

export function parseDailySummary(csv: string): NutritionDay[] {
  const { data } = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  if (data.length === 0) return [];

  const headers = Object.keys(data[0]);
  const column = (name: keyof typeof COLUMNS) => {
    const found = COLUMNS[name].find((candidate) => headers.includes(candidate));
    if (!found) throw new Error(`Cronometer's export has no ${name} column. Columns: ${headers.join(", ")}`);
    return found;
  };
  const [dateColumn, caloriesColumn] = [column("date"), column("calories")];
  const [proteinColumn, carbsColumn, fatColumn] = [column("protein"), column("carbs"), column("fat")];
  const caloriesAreKj = caloriesColumn === "Energy (kJ)";

  return data
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row[dateColumn]?.trim() ?? ""))
    .map((row) => {
      const calories = number(row[caloriesColumn]);
      return {
        date: row[dateColumn].trim(),
        calories: calories !== null && caloriesAreKj ? calories / KJ_PER_KCAL : calories,
        proteinG: number(row[proteinColumn]),
        carbsG: number(row[carbsColumn]),
        fatG: number(row[fatColumn]),
      };
    });
}

function number(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
