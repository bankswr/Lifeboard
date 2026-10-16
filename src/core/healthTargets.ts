// Health analysis settings, today's targets and their saved history (docs/PLAN.md phase 7a).
// Loads the days the calculations need, runs the review (healthReview.ts) and the estimate
// (energy.ts), and saves each day's targets the first time they're computed: synced, one
// row per day (fixed id), so past days keep the targets that applied then even if settings
// change later. Today's row is rewritten while today's inputs change (new data, a verdict).
import { addDays, localDate } from "./dates.ts";
import { get, type Db } from "./db/types.ts";
import { checkIntake, computeTargets, AVERAGE_DAYS, type EnergyDay, type Intake, type IntakeCheck, type TargetSettings, type Targets } from "./energy.ts";
import { healthDays, type HealthDay } from "./health.ts";
import { alertNewFlags, loadVerdicts, reviewDays, type Flag, type FlagSettings } from "./healthReview.ts";
import type { NewAlert } from "./rules.ts";
import { saveRecord } from "./sync/records.ts";

export type HealthSettings = TargetSettings & FlagSettings;

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  goalLbsPerWeek: 0,
  proteinPerLbLean: 1.0,
  fatPerLbLean: 0.4,
  windowDays: 28,
  energyModel: "simple",
  lossWarnPercent: 1,
  gainWarnPercent: 0.5,
  fallbackActivityFactor: 1.375,
  maintenanceTolerancePercent: 5,
  lowCaloriesPercent: 50,
  lowCaloriesFloor: 1000,
  maxSteps: 40000,
  weightJumpLbs: 3,
  bodyFatJumpPoints: 2,
};

const SETTING_ID = "health_targets";

export async function getHealthSettings(db: Db): Promise<HealthSettings> {
  const row = await get(db, "SELECT value FROM setting WHERE id = ? AND deleted = 0", [SETTING_ID]);
  return row ? { ...DEFAULT_HEALTH_SETTINGS, ...JSON.parse(row.value) } : DEFAULT_HEALTH_SETTINGS;
}

export async function saveHealthSettings(db: Db, settings: HealthSettings): Promise<void> {
  const numbers: [keyof HealthSettings, string, number, number][] = [
    ["goalLbsPerWeek", "The goal", -5, 5],
    ["proteinPerLbLean", "Protein", 0, 3],
    ["fatPerLbLean", "Fat", 0, 2],
    ["windowDays", "The fit window", 7, 60],
    ["lossWarnPercent", "The loss warning", 0, 5],
    ["gainWarnPercent", "The gain warning", 0, 5],
    ["fallbackActivityFactor", "The activity factor", 1, 2.5],
    ["maintenanceTolerancePercent", "The maintenance tolerance", 0, 25],
    ["lowCaloriesPercent", "The low-calorie percentage", 0, 100],
    ["lowCaloriesFloor", "The low-calorie floor", 0, 5000],
    ["maxSteps", "The step limit", 1000, 200000],
    ["weightJumpLbs", "The weigh-in limit", 0.5, 50],
    ["bodyFatJumpPoints", "The body fat limit", 0.5, 20],
  ];
  for (const [key, label, min, max] of numbers) {
    const value = settings[key] as number;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  if (!Number.isInteger(settings.windowDays)) throw new Error("The fit window must be a whole number of days.");
  if (settings.energyModel !== "simple" && settings.energyModel !== "split") throw new Error("Unknown energy model.");
  await saveRecord(db, "setting", { id: SETTING_ID, value: JSON.stringify(settings) });
}

// ---------- today's targets ----------

export interface HealthAnalysis {
  /** null when there's no weight and body fat average yet. */
  targets: Targets | null;
  /** Flags in the days the calculations look at, newest first. */
  flags: Flag[];
  /** Flags awaiting review (they're left out until then). */
  pendingCount: number;
  /** Yesterday's totals against the targets that applied to it. */
  yesterday: DayComparison;
  settings: HealthSettings;
}

export interface DayComparison {
  date: string;
  /** What was logged; null when nothing was. */
  intake: Intake | null;
  targets: Targets | null;
  /** null unless both intake and targets are known. */
  met: IntakeCheck | null;
}

/**
 * Works out the flags and the targets for `today`, saving the targets to history. The review
 * looks back over the fit window plus two averaging spans: one for the first averages in the
 * window, one more so the measurements at its start have earlier ones to be compared with.
 */
export async function analyzeHealth(db: Db, today = localDate()): Promise<HealthAnalysis> {
  const settings = await getHealthSettings(db);
  const start = addDays(today, -(settings.windowDays + 2 * AVERAGE_DAYS));
  const days = await healthDays(db, start, addDays(today, -1));
  const firstLogged = (await get(db, "SELECT MIN(date) AS date FROM nutrition_day WHERE deleted = 0 AND calories > 0"))?.date ?? null;
  const { flags, cleaned } = reviewDays(days, await loadVerdicts(db), settings, settings.fallbackActivityFactor, firstLogged);

  const pendingCount = flags.filter((flag) => flag.verdict === null).length;
  const targets = computeTargets(today, cleaned, settings);
  if (targets && pendingCount > 0) {
    targets.warnings.unshift(`${pendingCount} item${pendingCount === 1 ? "" : "s"} awaiting review ${pendingCount === 1 ? "is" : "are"} left out.`);
  }
  if (targets) await saveTargets(db, targets);
  const yesterday = await compareYesterday(db, today, days, cleaned, settings);
  return { targets, flags: flags.reverse(), pendingCount, yesterday, settings };
}

/**
 * Yesterday's intake against the targets saved for it. Before targets were first saved there's
 * no row, so they're worked out the way yesterday would have (from the days before it).
 */
async function compareYesterday(
  db: Db, today: string, days: HealthDay[], cleaned: EnergyDay[], settings: HealthSettings,
): Promise<DayComparison> {
  const date = addDays(today, -1);
  const saved = await get(db, "SELECT data FROM health_target WHERE id = ? AND deleted = 0", [`targets-${date}`]);
  const targets: Targets | null = saved ? JSON.parse(saved.data) : computeTargets(date, cleaned, settings);
  const day = days.find((d) => d.date === date);
  const intake = day?.calories ? { calories: day.calories, proteinG: day.proteinG, carbsG: day.carbsG, fatG: day.fatG } : null;
  const met = intake && targets ? checkIntake(intake, targets, settings.maintenanceTolerancePercent) : null;
  return { date, intake, targets, met };
}

/** Saves a day's targets unless the stored copy is the same (so re-reading doesn't churn sync). */
async function saveTargets(db: Db, targets: Targets): Promise<void> {
  const id = `targets-${targets.date}`;
  const data = JSON.stringify(targets);
  const existing = await get(db, "SELECT data FROM health_target WHERE id = ? AND deleted = 0", [id]);
  if (existing?.data === data) return;
  await saveRecord(db, "health_target", { id, date: targets.date, data });
}

/** At each update: refreshes today's targets and alerts on newly flagged items. */
export async function checkHealth(db: Db): Promise<NewAlert[]> {
  const { flags } = await analyzeHealth(db);
  return alertNewFlags(db, flags);
}

// ---------- history ----------

export interface TargetHistoryEntry {
  targets: Targets;
  /** What was logged that day, for comparison; null when nothing was. */
  intake: { calories: number; proteinG: number | null; carbsG: number | null; fatG: number | null } | null;
}

/** Saved targets, newest first, each with that day's intake. */
export async function targetHistory(db: Db, limit = 90): Promise<TargetHistoryEntry[]> {
  const rows = await db.all(
    `SELECT t.data, n.calories, n.protein_g, n.carbs_g, n.fat_g FROM health_target t
     LEFT JOIN nutrition_day n ON n.date = t.date AND n.deleted = 0
     WHERE t.deleted = 0 ORDER BY t.date DESC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    targets: JSON.parse(row.data),
    intake: row.calories > 0 ? { calories: row.calories, proteinG: row.protein_g, carbsG: row.carbs_g, fatG: row.fat_g } : null,
  }));
}
