// Suspicious health data (docs/PLAN.md phases 7 and 7a): days and entries that look wrong are
// flagged, and the user accepts or rejects each one. The verdicts are synced. A flagged item
// is left out of the calculations until it's accepted; rejecting it keeps it out and settles
// it. Flags themselves aren't stored: they're worked out again from the data each time, so
// fixing an entry in Cronometer simply makes its flag go away.
import { addDays } from "./dates.ts";
import { get, type Db } from "./db/types.ts";
import { AVERAGE_DAYS, katchMcArdle, mean, MIN_WEIGH_INS, type EnergyDay } from "./energy.ts";
import type { HealthDay } from "./health.ts";
import { recordAlert, type NewAlert } from "./rules.ts";
import { deleteRecord, saveRecord } from "./sync/records.ts";

export interface FlagSettings {
  /** Calories below this % of the estimated expenditure (BMR × fallback factor) look partly logged. */
  lowCaloriesPercent: number;
  /** ... or below this many kcal. */
  lowCaloriesFloor: number;
  maxSteps: number;
  /** A weigh-in this far from the average of the 7 days before it. */
  weightJumpLbs: number;
  /** A body fat reading this many points from the average of the 7 days before it. */
  bodyFatJumpPoints: number;
}

export type FlagKind = "no-log" | "low-calories" | "high-steps" | "weight" | "body-fat";
export type Verdict = "accepted" | "rejected";

export interface Flag {
  /** "<date>-<kind>": also the id of its verdict row. */
  id: string;
  date: string;
  kind: FlagKind;
  message: string;
  /** null while awaiting review. */
  verdict: Verdict | null;
}

/** What each kind of flag affects: the whole day's intake, or one measurement. */
const DAY_FLAGS: FlagKind[] = ["no-log", "low-calories", "high-steps"];

// ---------- finding flags ----------

/**
 * Flags the days in `days` (any order) and returns them with the cleaned inputs for the
 * calculations. Measurements are compared with the average of the earlier valid ones, so
 * days are checked oldest first. `firstLogged` is the earliest Cronometer day ever stored:
 * days before it aren't flagged as unlogged.
 */
export function reviewDays(
  days: HealthDay[],
  verdicts: Map<string, Verdict>,
  settings: FlagSettings,
  activityFactor: number,
  firstLogged: string | null,
): { flags: Flag[]; cleaned: EnergyDay[] } {
  const flags: Flag[] = [];
  const cleaned: EnergyDay[] = [];
  const validWeight = new Map<string, number>();
  const validBodyFat = new Map<string, number>();
  const earlierAverage = (values: Map<string, number>, date: string) => {
    const before: number[] = [];
    for (let back = 1; back <= AVERAGE_DAYS; back++) {
      const value = values.get(addDays(date, -back));
      if (value !== undefined) before.push(value);
    }
    return before.length >= MIN_WEIGH_INS ? mean(before) : null;
  };

  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const flag = (kind: FlagKind, message: string) => {
      const id = `${day.date}-${kind}`;
      const entry = { id, date: day.date, kind, message, verdict: verdicts.get(id) ?? null };
      flags.push(entry);
      return entry.verdict === "accepted";
    };

    // Measurements: a jump from the earlier average is flagged; only accepted ones count.
    let weight = day.weightLbs;
    const weightAverage = earlierAverage(validWeight, day.date);
    if (weight !== null && weightAverage !== null && Math.abs(weight - weightAverage) > settings.weightJumpLbs) {
      const counts = flag("weight", `Weigh-in ${weight.toFixed(1)} lb is ${(weight - weightAverage).toFixed(1)} lb from the 7-day average (${weightAverage.toFixed(1)}).`);
      if (!counts) weight = null;
    }
    if (weight !== null) validWeight.set(day.date, weight);

    let bodyFat = day.bodyFatPercent;
    const bodyFatAverage = earlierAverage(validBodyFat, day.date);
    if (bodyFat !== null && bodyFatAverage !== null && Math.abs(bodyFat - bodyFatAverage) > settings.bodyFatJumpPoints) {
      const counts = flag("body-fat", `Body fat ${bodyFat.toFixed(1)}% is ${(bodyFat - bodyFatAverage).toFixed(1)} points from the 7-day average (${bodyFatAverage.toFixed(1)}%).`);
      if (!counts) bodyFat = null;
    }
    if (bodyFat !== null) validBodyFat.set(day.date, bodyFat);

    // The day's intake: unlogged, suspiciously low, or with implausible steps.
    let dayCounts = true;
    if (day.calories === null || day.calories <= 0) {
      if (firstLogged !== null && day.date >= firstLogged) {
        flag("no-log", "Nothing logged in Cronometer.");
      }
      dayCounts = false; // an empty day never counts, whatever the verdict
    } else {
      const expected = expectedExpenditure(validWeight, validBodyFat, day.date, activityFactor);
      const percentLimit = expected === null ? 0 : (expected * settings.lowCaloriesPercent) / 100;
      if (day.calories < settings.lowCaloriesFloor || day.calories < percentLimit) {
        const reason = day.calories < settings.lowCaloriesFloor
          ? `under ${settings.lowCaloriesFloor} kcal`
          : `under ${settings.lowCaloriesPercent}% of the estimated ${Math.round(expected!)} kcal burned`;
        dayCounts = flag("low-calories", `${Math.round(day.calories)} kcal logged, ${reason}. Partly logged?`) && dayCounts;
      }
    }
    if (day.steps !== null && day.steps > settings.maxSteps) {
      dayCounts = flag("high-steps", `${day.steps.toLocaleString("en-US")} steps, over ${settings.maxSteps.toLocaleString("en-US")}.`) && dayCounts;
    }

    cleaned.push({
      date: day.date,
      calories: dayCounts ? day.calories : null,
      steps: day.steps,
      weightLbs: weight,
      bodyFatPercent: bodyFat,
    });
  }
  return { flags, cleaned };
}

/**
 * BMR × activity factor from the latest valid weigh-ins before `date`, for the low-calorie
 * check. Deliberately the simple estimate rather than the fitted one: the fit depends on
 * which days are flagged, and this check decides that.
 */
function expectedExpenditure(weights: Map<string, number>, bodyFats: Map<string, number>, date: string, activityFactor: number): number | null {
  const latest = (values: Map<string, number>) => {
    for (let back = 1; back <= 30; back++) {
      const value = values.get(addDays(date, -back));
      if (value !== undefined) return value;
    }
    return null;
  };
  const weight = latest(weights);
  const bodyFat = latest(bodyFats);
  if (weight === null || bodyFat === null) return null;
  return katchMcArdle(weight * (1 - bodyFat / 100)) * activityFactor;
}

export function isDayFlag(kind: FlagKind): boolean {
  return DAY_FLAGS.includes(kind);
}

// ---------- verdicts ----------

export async function loadVerdicts(db: Db): Promise<Map<string, Verdict>> {
  const rows = await db.all("SELECT id, verdict FROM health_review WHERE deleted = 0");
  return new Map(rows.map((row) => [row.id, row.verdict]));
}

/** Accepts or rejects a flagged item. An unlogged day can only be skipped (rejected). */
export async function setVerdict(db: Db, flagId: string, verdict: Verdict): Promise<void> {
  const match = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(flagId);
  if (!match) throw new Error("Unknown flag.");
  if (verdict !== "accepted" && verdict !== "rejected") throw new Error("Unknown verdict.");
  if (match[2] === "no-log" && verdict === "accepted") throw new Error("An unlogged day can be skipped, not accepted.");
  await saveRecord(db, "health_review", { id: flagId, date: match[1], kind: match[2], verdict });
}

/** Undoes a verdict: the item awaits review again. */
export async function clearVerdict(db: Db, flagId: string): Promise<void> {
  await deleteRecord(db, "health_review", flagId);
}

// ---------- alerts ----------

/**
 * Alerts once for each flag awaiting review that hasn't been alerted on this device yet
 * (tracked in rule_state like the rules' own alerts). The caller delivers them.
 */
export async function alertNewFlags(db: Db, flags: Flag[]): Promise<NewAlert[]> {
  const alerts: NewAlert[] = [];
  for (const flag of flags.filter((f) => f.verdict === null)) {
    if (await get(db, "SELECT 1 FROM rule_state WHERE rule_id = 'health-flag' AND subject = ?", [flag.id])) continue;
    await db.run("INSERT INTO rule_state (rule_id, subject, matched) VALUES ('health-flag', ?, 1)", [flag.id]);
    alerts.push(await recordAlert(db, "Health", `Health, ${formatDate(flag.date)}: ${flag.message} Review it on the Health page.`));
  }
  return alerts;
}

/** "2026-10-14" → "Wed, Oct 14". */
function formatDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
