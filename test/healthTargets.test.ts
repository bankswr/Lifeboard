import { describe, expect, it } from "vitest";
import { addDays } from "../src/core/dates.ts";
import { migrate } from "../src/core/db/schema.ts";
import {
  checkIntake, computeTargets, datesBetween, katchMcArdle, KCAL_PER_LB_FAT, KCAL_PER_LB_LEAN, slope, trailingAverages, type EnergyDay,
} from "../src/core/energy.ts";
import { replaceHealthPoints, saveNutritionDays, type HealthDay } from "../src/core/health.ts";
import { alertNewFlags, reviewDays, setVerdict, type Verdict } from "../src/core/healthReview.ts";
import { healthPage } from "../src/core/healthPage.ts";
import { analyzeHealth, DEFAULT_HEALTH_SETTINGS, saveHealthSettings, targetHistory } from "../src/core/healthTargets.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

const TODAY = "2026-10-16";
// The cases below were built around a 14-day window.
const settings = { ...DEFAULT_HEALTH_SETTINGS, windowDays: 14 };

/** `count` days ending the day before TODAY, weight falling 0.1 lb/day to 200, 20% body fat. */
function steadyLoss(count: number, overrides: (day: EnergyDay, index: number) => Partial<EnergyDay> = () => ({})): EnergyDay[] {
  return datesBetween(addDays(TODAY, -count), addDays(TODAY, -1)).map((date, index) => {
    const day = { date, calories: 2000, steps: 8000, weightLbs: 200 + 0.1 * (count - 1 - index), bodyFatPercent: 20 };
    return { ...day, ...overrides(day, index) };
  });
}

describe("energy building blocks", () => {
  it("Katch-McArdle from lean mass", () => {
    expect(katchMcArdle(150)).toBeCloseTo(370 + 21.6 * (150 / 2.20462262185));
  });

  it("slope of a line", () => {
    expect(slope([{ x: 0, y: 5 }, { x: 1, y: 7 }, { x: 2, y: 9 }])).toBeCloseTo(2);
    expect(slope([{ x: 1, y: 5 }])).toBeNull();
  });

  it("averages need 3 weigh-ins in 7 days, otherwise the last average carries forward", () => {
    const values = new Map([["2026-10-01", 200], ["2026-10-02", 202], ["2026-10-03", 204]]);
    const averages = trailingAverages(datesBetween("2026-10-02", "2026-10-12"), (d) => values.get(d) ?? null);
    expect(averages.get("2026-10-02")).toEqual({ value: null, carried: true });
    expect(averages.get("2026-10-03")).toEqual({ value: 202, carried: false });
    expect(averages.get("2026-10-12")).toEqual({ value: 202, carried: true });
  });
});

describe("computeTargets", () => {
  it("expenditure = intake − 3,500 kcal × the weight trend", () => {
    const targets = computeTargets(TODAY, steadyLoss(30), { ...settings, goalLbsPerWeek: -0.5 })!;
    expect(targets.method).toBe("trend");
    expect(targets.weightTrendLbsPerWeek).toBeCloseTo(-0.7);
    expect(targets.expenditure).toBeCloseTo(2350); // 2000 + 0.1 lb/day × 3,500
    expect(targets.calories).toBeCloseTo(2350 - 250);
    // Weight average of the last 7 days (200.0–200.6) at 20% body fat.
    expect(targets.weightLbs).toBeCloseTo(200.3);
    expect(targets.leanLbs).toBeCloseTo(200.3 * 0.8);
    expect(targets.proteinG).toBeCloseTo(200.3 * 0.8);
    expect(targets.fatG).toBeCloseTo(200.3 * 0.8 * 0.4);
    expect(targets.carbsG * 4 + targets.proteinG * 4 + targets.fatG * 9).toBeCloseTo(targets.calories);
    expect(targets.warnings).toEqual([]);
  });

  it("the advanced model counts fat and lean mass changes separately", () => {
    const targets = computeTargets(TODAY, steadyLoss(30), { ...settings, energyModel: "split" })!;
    expect(targets.expenditure).toBeCloseTo(2000 + 0.02 * KCAL_PER_LB_FAT + 0.08 * KCAL_PER_LB_LEAN);
  });

  it("splits the expenditure into steps and the rest, which the previous day's steps then spread", () => {
    const targets = computeTargets(TODAY, steadyLoss(30, (_, i) => (i === 29 ? { steps: 16000 } : {})), settings)!;
    expect(targets.activityMultiplier).toBeGreaterThan(1);
    expect(targets.previousDayExpenditure).toBeGreaterThan(targets.expenditure);
  });

  it("ignores days left out (null intake) and falls back with too few", () => {
    const sparse = steadyLoss(30, (_, i) => (i >= 20 && i % 2 === 0 ? {} : i >= 16 ? { calories: null } : {}));
    const targets = computeTargets(TODAY, sparse, settings)!;
    expect(targets.method).toBe("fallback");
    expect(targets.expenditure).toBeCloseTo(targets.bmr * 1.375);
    expect(targets.warnings[0]).toMatch(/Too little history/);
  });

  it("returns null without weight and body fat", () => {
    expect(computeTargets(TODAY, steadyLoss(30, () => ({ bodyFatPercent: null })), settings)).toBeNull();
  });

  it("warns when carbs run out and when the goal rate is past its limit", () => {
    const targets = computeTargets(TODAY, steadyLoss(30), { ...settings, goalLbsPerWeek: -5, proteinPerLbLean: 2, fatPerLbLean: 1 })!;
    expect(targets.carbsG).toBe(0);
    expect(targets.warnings.join(" ")).toMatch(/carbs set to 0/);
    expect(targets.warnings.join(" ")).toMatch(/above the 1% limit/);
  });
});

describe("reviewDays", () => {
  const day = (date: string, fields: Partial<HealthDay>): HealthDay => ({
    date, calories: 2200, proteinG: null, carbsG: null, fatG: null, weightLbs: 200, bodyFatPercent: 20, steps: 8000,
    averageHeartRate: null, restingHeartRate: null, ...fields,
  });
  const week = datesBetween("2026-10-01", "2026-10-10");

  it("flags low intake, high steps, weigh-in and body fat jumps, and unlogged days after the first log", () => {
    const days = week.map((date) => day(date, {
      "2026-10-08": { calories: 600 },
      "2026-10-09": { steps: 55000, weightLbs: 206 },
      "2026-10-10": { calories: null, bodyFatPercent: 25 },
    }[date] ?? {}));
    const { flags, cleaned } = reviewDays(days, new Map(), settings, 1.375, "2026-10-01");
    expect(flags.map((f) => f.id)).toEqual(["2026-10-08-low-calories", "2026-10-09-weight", "2026-10-09-high-steps", "2026-10-10-body-fat", "2026-10-10-no-log"]);
    const byDate = new Map(cleaned.map((d) => [d.date, d]));
    expect(byDate.get("2026-10-08")!.calories).toBeNull();
    expect(byDate.get("2026-10-09")).toMatchObject({ calories: null, weightLbs: null });
    expect(byDate.get("2026-10-10")!.bodyFatPercent).toBeNull();
  });

  it("accepted items count again; rejected and unreviewed ones don't", () => {
    const days = week.map((date) => day(date, date === "2026-10-08" ? { calories: 600 } : {}));
    const run = (verdict?: Verdict) =>
      reviewDays(days, new Map(verdict ? [["2026-10-08-low-calories", verdict]] : []), settings, 1.375, null).cleaned.find((d) => d.date === "2026-10-08")!.calories;
    expect(run()).toBeNull();
    expect(run("rejected")).toBeNull();
    expect(run("accepted")).toBe(600);
  });

  it("doesn't flag unlogged days before the first Cronometer entry", () => {
    const { flags } = reviewDays([day("2026-10-01", { calories: null })], new Map(), settings, 1.375, "2026-10-05");
    expect(flags).toEqual([]);
  });
});

describe("analyzeHealth (database)", () => {
  async function seededDb({ withBodyFat = true } = {}) {
    const db = openNodeDb(":memory:");
    await migrate(db);
    const days = steadyLoss(45); // enough for the default 28-day window plus its averages
    await saveNutritionDays(db, days.map((d) => ({ date: d.date, calories: d.calories!, proteinG: 150, carbsG: 200, fatG: 70 })));
    const point = (type: "weight" | "body-fat", d: EnergyDay, value: number) => ({
      id: `${type}-${d.date}`, type, day: d.date, startTime: `${d.date}T12:00:00Z`, endTime: `${d.date}T12:00:00Z`, value, source: "scale",
    });
    const range = [`${days[0].date}T00:00:00Z`, `${TODAY}T00:00:00Z`] as const;
    await replaceHealthPoints(db, "weight", ...range, days.map((d) => point("weight", d, d.weightLbs! / 0.00220462262185)));
    if (withBodyFat) await replaceHealthPoints(db, "body-fat", ...range, days.map((d) => point("body-fat", d, 20)));
    return db;
  }

  it("computes today's targets from stored data and saves them to history", async () => {
    const db = await seededDb();
    const analysis = await analyzeHealth(db, TODAY);
    expect(analysis.targets!.expenditure).toBeCloseTo(2350);
    expect(analysis.pendingCount).toBe(0);
    const history = await targetHistory(db);
    expect(history).toHaveLength(1);
    expect(history[0].targets.date).toBe(TODAY);
    // Yesterday: 2,000 kcal eaten against a maintenance target worked out for that day.
    expect(analysis.yesterday.intake!.calories).toBe(2000);
    expect(analysis.yesterday.targets!.date).toBe(addDays(TODAY, -1));
    expect(analysis.yesterday.met!.protein).toBe(false);
  });

  it("a flagged day is left out until accepted, alerts once, and a settings change reaches today's saved targets", async () => {
    const db = await seededDb();
    await saveNutritionDays(db, [{ date: addDays(TODAY, -2), calories: 500, proteinG: 20, carbsG: 50, fatG: 10 }]);
    const flagged = await analyzeHealth(db, TODAY);
    expect(flagged.pendingCount).toBe(1);
    expect(flagged.targets!.warnings[0]).toMatch(/1 item awaiting review is left out/);
    expect(await alertNewFlags(db, flagged.flags)).toHaveLength(1);
    expect(await alertNewFlags(db, flagged.flags)).toHaveLength(0);

    await setVerdict(db, flagged.flags[0].id, "accepted");
    const accepted = await analyzeHealth(db, TODAY);
    expect(accepted.pendingCount).toBe(0);
    expect(accepted.targets!.expenditure).toBeLessThan(flagged.targets!.expenditure);

    await saveHealthSettings(db, { ...DEFAULT_HEALTH_SETTINGS, goalLbsPerWeek: 1 });
    await analyzeHealth(db, TODAY);
    expect((await targetHistory(db))[0].targets.goalLbsPerWeek).toBe(1);
  });

  it("gives the Health page each day with the targets that applied, saved or worked out afterwards", async () => {
    const db = await seededDb();
    // A weigh-in far off the average: flagged, awaiting review.
    const odd = addDays(TODAY, -3);
    await replaceHealthPoints(db, "weight", `${odd}T00:00:00Z`, `${addDays(odd, 1)}T00:00:00Z`, [
      { id: `weight-${odd}`, type: "weight", day: odd, startTime: `${odd}T12:00:00Z`, endTime: `${odd}T12:00:00Z`, value: 210 / 0.00220462262185, source: "scale" },
    ]);
    const page = await healthPage(db, TODAY);
    expect(page.days).toHaveLength(90);
    expect(page.days.at(-1)!.date).toBe(TODAY);
    expect(page.days.at(-1)!.targets!.workedOut).toBe(false); // saved by today's analysis
    const yesterday = page.days.at(-2)!;
    expect(yesterday.targets!.workedOut).toBe(true);
    expect(yesterday.intake!.calories).toBe(2000);
    expect(yesterday.met).not.toBeNull();
    expect(yesterday.expenditureSimple).toBeCloseTo(2350, -1);
    expect(page.days.find((d) => d.date === odd)!.weightState).toBe("pending");
  });

  it("projects the weight, body fat, lean and fat mass trends a week on from the end of their averages", async () => {
    const page = await healthPage(await seededDb(), TODAY);
    const { weight, bodyFat, lean, fat } = page.trends;
    expect(weight!.perDay).toBeCloseTo(-0.1);
    expect(weight!.points).toHaveLength(8);
    // It carries on from the end of the average line (today), so the two don't fork.
    expect(weight!.points[0]).toEqual({ date: TODAY, value: page.days.at(-1)!.weightAverage });
    expect(weight!.points.at(-1)!.date).toBe(addDays(TODAY, 7));
    expect(weight!.points.at(-1)!.value).toBeCloseTo(weight!.points[0].value - 0.7);
    expect(bodyFat!.perDay).toBeCloseTo(0);
    expect(lean!.perDay).toBeCloseTo(-0.08); // 80% of the weight lost
    expect(fat!.perDay).toBeCloseTo(-0.02);
    expect(page.days.at(-2)!.leanAverage! + page.days.at(-2)!.fatAverage!).toBeCloseTo(page.days.at(-2)!.weightAverage!);
  });

  describe("FFMI (72 in tall)", () => {
    const HEIGHT_M = 72 * 0.0254;

    it("is lean mass in kg over height squared, from the 7-day averages", async () => {
      const yesterday = (await healthPage(await seededDb(), TODAY)).days.at(-2)!;
      // Worked by hand: 200.3 lb average × 80% lean = 160.24 lb = 72.84 kg; ÷ 1.8288² m² = 21.78.
      expect(yesterday.ffmi!).toBeCloseTo(21.778, 2);
      expect(yesterday.ffmi!).toBeCloseTo(yesterday.leanAverage! / 2.2 / HEIGHT_M ** 2);
    });

    it("adjusted FFMI adds 6.1 × (1.8 m − height) on every day", async () => {
      const page = await healthPage(await seededDb(), TODAY);
      const withValues = page.days.filter((d) => d.ffmi !== null);
      expect(withValues.length).toBeGreaterThan(0);
      for (const day of withValues) expect(day.adFfmi! - day.ffmi!).toBeCloseTo(6.1 * (1.8 - HEIGHT_M)); // −0.176
    });

    it("trends follow lean mass and carry on from the end of their own average lines", async () => {
      const page = await healthPage(await seededDb(), TODAY);
      const { lean, ffmi, adFfmi } = page.trends;
      expect(ffmi!.perDay).toBeCloseTo(lean!.perDay / 2.2 / HEIGHT_M ** 2); // ≈ −0.011 per day
      // A constant offset doesn't change the slope ...
      expect(adFfmi!.perDay).toBeCloseTo(ffmi!.perDay);
      // ... but each line starts at its own average, so the adjusted one doesn't fork from its line.
      expect(ffmi!.points[0]).toEqual({ date: TODAY, value: page.days.at(-1)!.ffmi });
      expect(adFfmi!.points[0]).toEqual({ date: TODAY, value: page.days.at(-1)!.adFfmi });
      expect(adFfmi!.points).toHaveLength(8);
    });

    it("is missing, with no trend, without body fat readings", async () => {
      const page = await healthPage(await seededDb({ withBodyFat: false }), TODAY);
      expect(page.days.every((d) => d.ffmi === null && d.adFfmi === null)).toBe(true);
      expect(page.trends.ffmi).toBeNull();
      expect(page.trends.adFfmi).toBeNull();
      expect(page.days.at(-2)!.weightAverage).not.toBeNull(); // weight alone still shows
    });
  });

  it("rejects out-of-range settings and accepting an unlogged day", async () => {
    const db = await seededDb();
    await expect(saveHealthSettings(db, { ...DEFAULT_HEALTH_SETTINGS, windowDays: 3 })).rejects.toThrow(/fit window/);
    await expect(setVerdict(db, "2026-10-10-no-log", "accepted")).rejects.toThrow(/skipped/);
  });
});

describe("checkIntake", () => {
  const targets = (goalLbsPerWeek: number) =>
    ({ ...computeTargets(TODAY, steadyLoss(30), settings)!, calories: 2000, proteinG: 150, fatG: 60, goalLbsPerWeek });
  const intake = (calories: number) => ({ calories, proteinG: 150, carbsG: 200, fatG: 59 });

  it("protein and fat meet the target at or above it", () => {
    expect(checkIntake(intake(2000), targets(-1), 5)).toMatchObject({ protein: true, fat: false });
  });

  it("calories: at or below to lose, at or above to gain, within the tolerance to maintain", () => {
    expect(checkIntake(intake(1950), targets(-1), 5).calories).toBe(true);
    expect(checkIntake(intake(2050), targets(-1), 5).calories).toBe(false);
    expect(checkIntake(intake(2050), targets(1), 5).calories).toBe(true);
    expect(checkIntake(intake(1950), targets(1), 5).calories).toBe(false);
    expect(checkIntake(intake(2100), targets(0), 5).calories).toBe(true);
    expect(checkIntake(intake(2101), targets(0), 5).calories).toBe(false);
  });
});
