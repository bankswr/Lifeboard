// Everything the Health page shows (docs/PLAN.md phase 7a, Health page work), in one call:
// today's analysis, then one row per day for the graphs and the table, and the workouts found
// in the heart rate. Each day carries the targets that applied to it: the saved ones, or for
// days before targets were saved, the ones that day would have had ("worked out after the
// fact", marked as such), from the same data and current settings. Weight, body fat, lean
// mass and fat mass also carry their trend, projected a week past the last reading.
import { addDays, localDate } from "./dates.ts";
import type { Db } from "./db/types.ts";
import { checkIntake, computeTargets, datesBetween, minimumDays, slope, trailingAverages, type AveragePoint, type EnergyDay, type Intake, type IntakeCheck, type Targets } from "./energy.ts";
import { analyzeHealth, getHealthSettings, prepareDays, type HealthAnalysis } from "./healthTargets.ts";
import type { Flag } from "./healthReview.ts";
import { workoutEnergy, type Workout } from "./workouts.ts";

/** Days the page covers (its longest graph range). */
export const HEALTH_PAGE_DAYS = 90;
/** Days a trend is projected past the last reading. */
export const TREND_DAYS = 7;

/** A measurement's review state: null when it wasn't flagged. */
export type ReviewState = "pending" | "accepted" | "rejected" | null;

export interface DayTargets {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** True when no targets were saved that day and these were worked out afterwards. */
  workedOut: boolean;
}

export interface HealthPageDay {
  date: string;
  intake: Intake | null;
  targets: DayTargets | null;
  /** Which totals met their targets; null without both. */
  met: IntakeCheck | null;
  /** The day's own weigh-in (average of the day's readings) and its review state. */
  weightLbs: number | null;
  weightState: ReviewState;
  /** 7-day average of the valid weigh-ins. */
  weightAverage: number | null;
  bodyFatPercent: number | null;
  bodyFatState: ReviewState;
  bodyFatAverage: number | null;
  /** Lean and fat mass from the 7-day averages of weight and body fat, lb. */
  leanAverage: number | null;
  fatAverage: number | null;
  steps: number | null;
  /** The typical day filled in for a day without steps. */
  stepsEstimated: boolean;
  restingHeartRate: number | null;
  /** Average daily burn as estimated that morning (from the days before), with each model. */
  expenditureSimple: number | null;
  expenditureSplit: number | null;
  /** The day's own burn, spread by its steps and workouts; null for today or without a fit. */
  burn: number | null;
  workoutKcal: number;
}

export interface PageWorkout extends Workout {
  kcal: number;
}

export interface TrendPoint {
  date: string;
  value: number;
}

/**
 * A 7-day average's straight-line trend over the fit window up to the last reading, projected
 * TREND_DAYS on from where the average line ends, on the assumption it carries on.
 */
export interface BodyTrend {
  perDay: number;
  /** From the last day of the 7-day average, at its value, one point per day. */
  points: TrendPoint[];
}

export interface BodyTrends {
  weight: BodyTrend | null;
  bodyFat: BodyTrend | null;
  lean: BodyTrend | null;
  fat: BodyTrend | null;
}

export interface HealthPage {
  analysis: HealthAnalysis;
  /** Oldest first, ending today (today has targets but no totals yet). */
  days: HealthPageDay[];
  /** Newest first. */
  workouts: PageWorkout[];
  trends: BodyTrends;
}

export async function healthPage(db: Db, today = localDate()): Promise<HealthPage> {
  const analysis = await analyzeHealth(db, today);
  const settings = await getHealthSettings(db);
  const first = addDays(today, -(HEALTH_PAGE_DAYS - 1));
  // Enough before the first shown day for its window and averages, plus the review's lookback.
  const spanStart = addDays(first, -(settings.windowDays + 3 * 7));
  const { days, flags, cleaned, workouts } = await prepareDays(db, spanStart, addDays(today, -1), settings);

  const rawByDate = new Map(days.map((day) => [day.date, day]));
  const cleanedByDate = new Map(cleaned.map((day) => [day.date, day]));
  const states = reviewStates(flags);
  const spanDates = datesBetween(spanStart, today);
  const weightAverages = trailingAverages(spanDates, (d) => cleanedByDate.get(d)?.weightLbs ?? null);
  const bodyFatAverages = trailingAverages(spanDates, (d) => cleanedByDate.get(d)?.bodyFatPercent ?? null);
  const leanOn = (date: string) => massAverage(weightAverages.get(date), bodyFatAverages.get(date), (bf) => 1 - bf / 100);
  const fatOn = (date: string) => massAverage(weightAverages.get(date), bodyFatAverages.get(date), (bf) => bf / 100);
  const saved = await savedTargets(db, first, today);

  const simple = new Map<string, Targets | null>();
  const split = new Map<string, Targets | null>();
  for (const date of datesBetween(first, today)) {
    simple.set(date, computeTargets(date, cleaned, { ...settings, energyModel: "simple" }));
    split.set(date, computeTargets(date, cleaned, { ...settings, energyModel: "split" }));
  }
  const current = settings.energyModel === "split" ? split : simple;
  // The day after's estimate holds each day's own burn (it uses only earlier days).
  const nextDay = (date: string) => (date < today ? current.get(addDays(date, 1)) ?? null : null);

  const rows: HealthPageDay[] = datesBetween(first, today).map((date) => {
    const raw = rawByDate.get(date);
    const energy: EnergyDay | undefined = cleanedByDate.get(date);
    const intake = raw?.calories ? { calories: raw.calories, proteinG: raw.proteinG, carbsG: raw.carbsG, fatG: raw.fatG } : null;
    const targets = dayTargets(saved.get(date) ?? null, current.get(date) ?? null);
    return {
      date,
      intake,
      targets,
      met: intake && targets
        ? checkIntake(intake, { ...targets, goalLbsPerWeek: goalFor(saved.get(date), settings.goalLbsPerWeek) }, settings.maintenanceTolerancePercent)
        : null,
      weightLbs: raw?.weightLbs ?? null,
      weightState: states.get(`${date}-weight`) ?? null,
      weightAverage: weightAverages.get(date)?.value ?? null,
      bodyFatPercent: raw?.bodyFatPercent ?? null,
      bodyFatState: states.get(`${date}-body-fat`) ?? null,
      bodyFatAverage: bodyFatAverages.get(date)?.value ?? null,
      leanAverage: leanOn(date)?.value ?? null,
      fatAverage: fatOn(date)?.value ?? null,
      steps: energy?.steps ?? null,
      stepsEstimated: energy?.stepsEstimated === true,
      restingHeartRate: raw?.restingHeartRate ?? null,
      expenditureSimple: simple.get(date)?.expenditure ?? null,
      expenditureSplit: split.get(date)?.method === "trend" ? split.get(date)!.expenditure : null,
      burn: nextDay(date)?.previousDayExpenditure ?? null,
      workoutKcal: energy?.workoutKcal ?? 0,
    };
  });

  const pageWorkouts = workouts
    .filter((workout) => workout.date >= first)
    .map((workout) => {
      const weight = rows.find((row) => row.date === workout.date)?.weightAverage ?? analysis.targets?.weightLbs ?? null;
      return { ...workout, kcal: weight === null ? 0 : workoutEnergy(workout, weight, settings) };
    })
    .reverse();

  // Lean and fat mass change when either reading does, so their fits end at the last of either.
  const lastReading = (has: (day: EnergyDay) => boolean) => cleaned.filter(has).at(-1)?.date ?? null;
  const lastWeight = lastReading((day) => day.weightLbs !== null);
  const lastBodyFat = lastReading((day) => day.bodyFatPercent !== null);
  const lastEither = lastReading((day) => day.weightLbs !== null || day.bodyFatPercent !== null);
  // Each trend carries on from where its 7-day average line ends (today, as the average
  // covers the days before), so the two don't fork on the last days.
  const lastAverage = (average: (row: HealthPageDay) => number | null) => rows.filter((row) => average(row) !== null).at(-1)?.date ?? null;
  const trends: BodyTrends = {
    weight: projectTrend(lastWeight, lastAverage((row) => row.weightAverage), settings.windowDays, (date) => weightAverages.get(date)),
    bodyFat: projectTrend(lastBodyFat, lastAverage((row) => row.bodyFatAverage), settings.windowDays, (date) => bodyFatAverages.get(date)),
    lean: projectTrend(lastEither, lastAverage((row) => row.leanAverage), settings.windowDays, leanOn),
    fat: projectTrend(lastEither, lastAverage((row) => row.fatAverage), settings.windowDays, fatOn),
  };
  return { analysis, days: rows, workouts: pageWorkouts, trends };
}

/** Weight × a share of it set by body fat (lean or fat mass), fresh only when both averages are. */
function massAverage(weight: AveragePoint | undefined, bodyFat: AveragePoint | undefined, share: (bodyFat: number) => number): AveragePoint | null {
  if (weight?.value == null || bodyFat?.value == null) return null;
  return { value: weight.value * share(bodyFat.value), carried: weight.carried || bodyFat.carried };
}

/**
 * The slope of the fresh (not carried) averages over the `windowDays` ending at `fitEnd` (the
 * last reading), the same fit the targets use for the weight trend, drawn from the average
 * on `start` (where the average line ends) out TREND_DAYS. Null without a reading or an
 * average, or with fewer fresh averages than a fit needs.
 */
function projectTrend(
  fitEnd: string | null,
  start: string | null,
  windowDays: number,
  averageOn: (date: string) => AveragePoint | null | undefined,
): BodyTrend | null {
  if (fitEnd === null || start === null) return null;
  const startValue = averageOn(start)?.value;
  if (startValue == null) return null;
  const windowDates = datesBetween(addDays(fitEnd, -(windowDays - 1)), fitEnd);
  const fresh = windowDates.flatMap((date, x) => {
    const average = averageOn(date);
    return average && !average.carried && average.value !== null ? [{ x, y: average.value }] : [];
  });
  if (fresh.length < minimumDays({ windowDays })) return null;
  const perDay = slope(fresh);
  if (perDay === null) return null;
  const points = datesBetween(start, addDays(start, TREND_DAYS)).map((date, days) => ({ date, value: startValue + perDay * days }));
  return { perDay, points };
}

function reviewStates(flags: Flag[]): Map<string, ReviewState> {
  return new Map(flags.map((flag) => [flag.id, flag.verdict === null ? "pending" : flag.verdict]));
}

async function savedTargets(db: Db, first: string, last: string): Promise<Map<string, Targets>> {
  const rows = await db.all("SELECT date, data FROM health_target WHERE date BETWEEN ? AND ? AND deleted = 0", [first, last]);
  return new Map(rows.map((row) => [row.date, JSON.parse(row.data) as Targets]));
}

function dayTargets(saved: Targets | null, workedOut: Targets | null): DayTargets | null {
  const source = saved ?? workedOut;
  if (!source) return null;
  return { calories: source.calories, proteinG: source.proteinG, carbsG: source.carbsG, fatG: source.fatG, workedOut: saved === null };
}

/** The goal a day's calories are judged by: the one saved with its targets, else today's setting. */
function goalFor(saved: Targets | undefined, currentGoal: number): number {
  return saved?.goalLbsPerWeek ?? currentGoal;
}
