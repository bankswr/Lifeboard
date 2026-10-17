// Energy expenditure and adaptive targets (docs/PLAN.md phase 7a; reasoning in
// agent-notes/2026-10-16-health-targets.md). Pure functions over day rows the caller has
// already cleaned (flagged items left out), so the arithmetic can be tested on its own;
// core/healthTargets.ts loads the data and saves the results.
import { addDays } from "./dates.ts";

const LBS_PER_KG = 2.20462262185;
/** Energy in a pound of body weight change, the common rule of thumb. */
export const KCAL_PER_LB = 3500;
/** Advanced model (Hall 2008): energy in fat mass and in lean mass, per pound of each. */
export const KCAL_PER_LB_FAT = 9400 / LBS_PER_KG;
export const KCAL_PER_LB_LEAN = 1800 / LBS_PER_KG;
/**
 * Net energy of one step per kg of body weight: walking costs ~0.5 kcal/kg/km above rest
 * (ACSM walking equation) at ~1,300 steps/km, so 10,000 steps ≈ 350 kcal at 200 lb.
 */
export const KCAL_PER_STEP_PER_KG = 0.5 / 1300;
/** Weight and body fat averages: days averaged, and weigh-ins needed for an average to count. */
export const AVERAGE_DAYS = 7;
export const MIN_WEIGH_INS = 3;

export type EnergyModel = "simple" | "split";

export interface TargetSettings {
  /** Goal rate of weight change, lb/week (negative to lose). */
  goalLbsPerWeek: number;
  /** g per lb of lean body mass. */
  proteinPerLbLean: number;
  fatPerLbLean: number;
  /** Days of history the expenditure estimate is fitted over. */
  windowDays: number;
  /** "simple": 3,500 kcal per lb of trend; "split": fat and lean mass changes counted separately. */
  energyModel: EnergyModel;
  /** Informational limits on the goal rate, % of body weight per week. */
  lossWarnPercent: number;
  gainWarnPercent: number;
  /** BMR multiplier used while there's too little history to fit (the fallback). */
  fallbackActivityFactor: number;
  /** With a maintenance goal, a day's calories count as on target within ± this % of the target. */
  maintenanceTolerancePercent: number;
}

/** One day's inputs, already cleaned: null where there's no value or it was left out. */
export interface EnergyDay {
  date: string;
  /** Intake; null when the day doesn't count toward the fit (not logged, flagged, rejected). */
  calories: number | null;
  steps: number | null;
  /** True when `steps` is the typical day filled in for a day without steps. */
  stepsEstimated?: boolean;
  /** Net energy of the day's detected workouts beyond their steps (core/workouts.ts). */
  workoutKcal?: number;
  weightLbs: number | null;
  bodyFatPercent: number | null;
}

export interface Targets {
  /** The day these targets are for. They use only days before it. */
  date: string;
  /** "trend": fitted from intake and the weight trend; "fallback": BMR × activity factor. */
  method: "trend" | "fallback";
  energyModel: EnergyModel;
  /** 7-day averages as of the day before. */
  weightLbs: number;
  bodyFatPercent: number;
  leanLbs: number;
  bmr: number;
  /** Trend of the 7-day average weight over the window, lb/week; null when it can't be fitted. */
  weightTrendLbsPerWeek: number | null;
  /** Average daily expenditure over the window: what the targets are built on. */
  expenditure: number;
  /** The day before's own expenditure, spread by its steps and workouts; null without a fit or steps. */
  previousDayExpenditure: number | null;
  /** Expenditure besides steps and workouts, as a multiple of BMR (fitted); null on the fallback. */
  activityMultiplier: number | null;
  /**
   * The fit's parts, for "How this is worked out" (added 2026-10-17; absent from targets saved
   * before then): average logged intake, energy stored per day by the weight trend, and the
   * window's average step and workout energy. null on the fallback.
   */
  averageIntake?: number | null;
  storedPerDay?: number | null;
  averageStepKcal?: number | null;
  averageWorkoutKcal?: number | null;
  /** The day before's steps were the typical day filled in. */
  previousDayStepsEstimated?: boolean;
  windowDays: number;
  /** Days in the window with usable intake. */
  validDays: number;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  goalLbsPerWeek: number;
  /** Things to know about these numbers, e.g. the fallback was used or carbs ran out. */
  warnings: string[];
}

// ---------- building blocks ----------

/** Katch-McArdle basal metabolic rate, kcal/day. */
export function katchMcArdle(leanLbs: number): number {
  return 370 + 21.6 * (leanLbs / LBS_PER_KG);
}

/** Net energy of a day's steps, kcal. */
export function stepEnergy(steps: number, weightLbs: number): number {
  return steps * KCAL_PER_STEP_PER_KG * (weightLbs / LBS_PER_KG);
}

export interface AveragePoint {
  value: number | null;
  /** True when too few weigh-ins and the last valid average was carried forward. */
  carried: boolean;
}

/**
 * The 7-day trailing average of `valueOf` for each date in `dates` (ascending, consecutive).
 * An average needs MIN_WEIGH_INS values in its 7 days; otherwise the previous one carries
 * forward. Values before the first date count toward the early averages.
 */
export function trailingAverages(dates: string[], valueOf: (date: string) => number | null): Map<string, AveragePoint> {
  const result = new Map<string, AveragePoint>();
  let last: number | null = null;
  for (const date of dates) {
    const values: number[] = [];
    for (let back = 0; back < AVERAGE_DAYS; back++) {
      const value = valueOf(addDays(date, -back));
      if (value !== null) values.push(value);
    }
    if (values.length >= MIN_WEIGH_INS) {
      last = mean(values);
      result.set(date, { value: last, carried: false });
    } else {
      result.set(date, { value: last, carried: true });
    }
  }
  return result;
}

/** Least-squares slope of y over x, or null with fewer than two distinct x values. */
export function slope(points: { x: number; y: number }[]): number | null {
  if (points.length < 2) return null;
  const meanX = mean(points.map((p) => p.x));
  const meanY = mean(points.map((p) => p.y));
  const spread = points.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
  if (spread === 0) return null;
  return points.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0) / spread;
}

export function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** The middle value (mean of the two middle ones for an even count); null for no values. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// ---------- the estimate ----------

/**
 * Targets for `date` from `days`, which must cover the window before it plus 6 more days
 * for the first averages (any order; missing dates count as empty). Returns null when there
 * isn't a weight and body fat average to start from.
 */
export function computeTargets(date: string, days: EnergyDay[], settings: TargetSettings): Targets | null {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const windowStart = addDays(date, -settings.windowDays);
  const lastDay = addDays(date, -1);
  const windowDates = datesBetween(windowStart, lastDay);

  const weight = trailingAverages(windowDates, (d) => byDate.get(d)?.weightLbs ?? null);
  const bodyFat = trailingAverages(windowDates, (d) => byDate.get(d)?.bodyFatPercent ?? null);
  const currentWeight = weight.get(lastDay)!.value;
  const currentBodyFat = bodyFat.get(lastDay)!.value;
  if (currentWeight === null || currentBodyFat === null) return null;

  const leanLbs = currentWeight * (1 - currentBodyFat / 100);
  const bmr = katchMcArdle(leanLbs);
  const warnings: string[] = [];

  const fit = fitExpenditure(windowDates, byDate, weight, bodyFat, settings);
  let expenditure: number;
  if (fit) {
    expenditure = fit.expenditure;
  } else {
    expenditure = bmr * settings.fallbackActivityFactor;
    warnings.push(
      `Too little history for a fitted estimate (needs ${minimumDays(settings)} logged days and weigh-ins in the last ${settings.windowDays}); using BMR × ${settings.fallbackActivityFactor}.`,
    );
  }

  const previous = byDate.get(lastDay);
  const previousDayExpenditure = fit && previous?.steps != null
    ? fit.activityMultiplier * bmr + stepEnergy(previous.steps, currentWeight) + (previous.workoutKcal ?? 0)
    : null;

  const calories = expenditure + (settings.goalLbsPerWeek * KCAL_PER_LB) / 7;
  const proteinG = settings.proteinPerLbLean * leanLbs;
  const fatG = settings.fatPerLbLean * leanLbs;
  const carbCalories = calories - proteinG * 4 - fatG * 9;
  if (carbCalories < 0) {
    warnings.push(`Protein and fat alone exceed the calorie target by ${Math.round(-carbCalories)} kcal; carbs set to 0.`);
  }
  warnings.push(...goalWarnings(settings, currentWeight));

  return {
    date,
    method: fit ? "trend" : "fallback",
    energyModel: settings.energyModel,
    weightLbs: currentWeight,
    bodyFatPercent: currentBodyFat,
    leanLbs,
    bmr,
    weightTrendLbsPerWeek: fit ? fit.weightTrendPerDay * 7 : null,
    expenditure,
    previousDayExpenditure,
    activityMultiplier: fit?.activityMultiplier ?? null,
    averageIntake: fit?.averageIntake ?? null,
    storedPerDay: fit?.storedPerDay ?? null,
    averageStepKcal: fit?.averageStepKcal ?? null,
    averageWorkoutKcal: fit?.averageWorkoutKcal ?? null,
    previousDayStepsEstimated: previous?.stepsEstimated === true,
    windowDays: settings.windowDays,
    validDays: windowDates.filter((d) => isLogged(byDate.get(d))).length,
    calories,
    proteinG,
    carbsG: Math.max(0, carbCalories) / 4,
    fatG,
    goalLbsPerWeek: settings.goalLbsPerWeek,
    warnings,
  };
}

/** Logged days and fresh (not carried) averages a fit needs: half the window. */
export function minimumDays(settings: Pick<TargetSettings, "windowDays">): number {
  return Math.ceil(settings.windowDays / 2);
}

interface Fit {
  expenditure: number;
  weightTrendPerDay: number;
  activityMultiplier: number;
  averageIntake: number;
  storedPerDay: number;
  averageStepKcal: number;
  averageWorkoutKcal: number;
}

/**
 * Average expenditure over the window = average intake − energy stored per day, where the
 * energy stored comes from the slope of the 7-day averages. Then splits that average into
 * steps (fixed cost per step) and the rest, as a multiple of BMR: the rest is what a single
 * window can fit, since it gives one average, not one value per day.
 */
function fitExpenditure(
  windowDates: string[],
  byDate: Map<string, EnergyDay>,
  weight: Map<string, AveragePoint>,
  bodyFat: Map<string, AveragePoint>,
  settings: TargetSettings,
): Fit | null {
  const intakes = windowDates.map((d) => byDate.get(d)).filter(isLogged).map((day) => day.calories!);
  const freshDates = windowDates.filter((d) => !weight.get(d)!.carried && weight.get(d)!.value !== null);
  const needed = minimumDays(settings);
  if (intakes.length < needed || freshDates.length < needed) return null;

  const x = (d: string) => (Date.parse(d) - Date.parse(windowDates[0])) / 86_400_000;
  const weightTrendPerDay = slope(freshDates.map((d) => ({ x: x(d), y: weight.get(d)!.value! })));
  if (weightTrendPerDay === null) return null;

  let storedPerDay = weightTrendPerDay * KCAL_PER_LB;
  if (settings.energyModel === "split") {
    const split = splitTrend(freshDates.filter((d) => !bodyFat.get(d)!.carried), weight, bodyFat, x);
    if (split === null) return null;
    storedPerDay = split.fatPerDay * KCAL_PER_LB_FAT + split.leanPerDay * KCAL_PER_LB_LEAN;
  }
  const averageIntake = mean(intakes);
  const expenditure = averageIntake - storedPerDay;

  // Each day's BMR, step energy and workout energy, from that day's averages.
  const bmrs: number[] = [];
  const stepKcal: number[] = [];
  const workoutKcal: number[] = [];
  for (const d of windowDates) {
    const w = weight.get(d)!.value;
    const bf = bodyFat.get(d)!.value;
    if (w === null || bf === null) continue;
    bmrs.push(katchMcArdle(w * (1 - bf / 100)));
    const day = byDate.get(d);
    if (day?.steps != null) stepKcal.push(stepEnergy(day.steps, w));
    workoutKcal.push(day?.workoutKcal ?? 0);
  }
  const averageStepKcal = stepKcal.length ? mean(stepKcal) : 0;
  const averageWorkoutKcal = workoutKcal.length ? mean(workoutKcal) : 0;
  return {
    expenditure, weightTrendPerDay, averageIntake, storedPerDay, averageStepKcal, averageWorkoutKcal,
    activityMultiplier: (expenditure - averageStepKcal - averageWorkoutKcal) / mean(bmrs),
  };
}

/** Days without steps in the median of these many days before them (the typical day). */
const TYPICAL_DAY_SPAN = 14;
const TYPICAL_DAY_MIN_VALUES = 3;

/**
 * Fills each day without steps with the typical day: the median of the measured steps in the
 * 14 days before it (user, 2026-10-17), marked as estimated. Days with fewer than 3 measured
 * days before them stay empty. Returns new rows; `days` may be in any order.
 */
export function fillMissingSteps(days: EnergyDay[]): EnergyDay[] {
  const measured = new Map(days.filter((d) => d.steps !== null && !d.stepsEstimated).map((d) => [d.date, d.steps!]));
  return days.map((day) => {
    if (day.steps !== null) return day;
    const before: number[] = [];
    for (let back = 1; back <= TYPICAL_DAY_SPAN; back++) {
      const steps = measured.get(addDays(day.date, -back));
      if (steps !== undefined) before.push(steps);
    }
    if (before.length < TYPICAL_DAY_MIN_VALUES) return day;
    return { ...day, steps: Math.round(median(before)!), stepsEstimated: true };
  });
}


/** Slopes of fat mass and lean mass (lb/day), from days with fresh weight and body fat averages. */
function splitTrend(
  dates: string[],
  weight: Map<string, AveragePoint>,
  bodyFat: Map<string, AveragePoint>,
  x: (date: string) => number,
): { fatPerDay: number; leanPerDay: number } | null {
  const fat = dates.map((d) => ({ x: x(d), y: weight.get(d)!.value! * (bodyFat.get(d)!.value! / 100) }));
  const lean = dates.map((d) => ({ x: x(d), y: weight.get(d)!.value! * (1 - bodyFat.get(d)!.value! / 100) }));
  const fatPerDay = slope(fat);
  const leanPerDay = slope(lean);
  return fatPerDay === null || leanPerDay === null ? null : { fatPerDay, leanPerDay };
}

function goalWarnings(settings: TargetSettings, weightLbs: number): string[] {
  const percent = (Math.abs(settings.goalLbsPerWeek) / weightLbs) * 100;
  if (settings.goalLbsPerWeek < 0 && percent > settings.lossWarnPercent) {
    return [`Goal loss is ${percent.toFixed(2)}% of body weight per week, above the ${settings.lossWarnPercent}% limit.`];
  }
  if (settings.goalLbsPerWeek > 0 && percent > settings.gainWarnPercent) {
    return [`Goal gain is ${percent.toFixed(2)}% of body weight per week, above the ${settings.gainWarnPercent}% limit.`];
  }
  return [];
}

function isLogged(day: EnergyDay | undefined): day is EnergyDay {
  return day?.calories != null && day.calories > 0;
}

/** Every date from `start` to `end`, both included, ascending. */
export function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

// ---------- a day's intake against its targets ----------

export interface Intake {
  calories: number;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

/** Which of a day's totals met their targets. Carbs are only the remainder, so they aren't judged. */
export interface IntakeCheck {
  calories: boolean;
  protein: boolean;
  fat: boolean;
}

/**
 * The user's rules (2026-10-16): protein and fat meet the target at or above it. Calories meet
 * it at or below for a loss goal, at or above for a gain goal, and within ± the tolerance for
 * maintenance.
 */
export function checkIntake(
  intake: Intake, targets: Pick<Targets, "calories" | "proteinG" | "fatG" | "goalLbsPerWeek">, maintenanceTolerancePercent: number,
): IntakeCheck {
  const goal = targets.goalLbsPerWeek;
  let calories: boolean;
  if (goal < 0) calories = intake.calories <= targets.calories;
  else if (goal > 0) calories = intake.calories >= targets.calories;
  else calories = Math.abs(intake.calories - targets.calories) <= (targets.calories * maintenanceTolerancePercent) / 100;
  return {
    calories,
    protein: intake.proteinG !== null && intake.proteinG >= targets.proteinG,
    fat: intake.fatG !== null && intake.fatG >= targets.fatG,
  };
}
