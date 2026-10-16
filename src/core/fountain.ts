// The water fountain: a device with no connection (user, 2026-10-16), estimated with the same
// learning scheme as the feeders (core/smartlife/food.ts), but in time rather than portions:
// - The user presses "Refill" each time they fill it (to full).
// - Each refill after the first records the days since the previous one: one full fountain
//   used up. The median of those samples is how long a fill lasts.
// - Days left ≈ that median − days since the last refill. Yellow/red thresholds in days, and
//   an optional "Refill the water fountain" task at red, checked at each update.
// Refills are synced rows, so both devices estimate the same.
import { localDate } from "./dates.ts";
import { get, type Db } from "./db/types.ts";
import { recordAlert, type NewAlert } from "./rules.ts";
import { queueChange } from "./schedule/edit.ts";
import { median } from "./smartlife/food.ts";
import { deleteRecord, saveRecord } from "./sync/records.ts";
import type { LevelState } from "./whisker/levels.ts";

export const FOUNTAIN_NAME = "Water fountain";
const DAY_MS = 86_400_000;
/** Refills closer together than this are double presses, not samples. */
const MIN_SAMPLE_DAYS = 0.25;

export interface FountainSettings {
  warningDays: number;
  alarmDays: number;
  refillTaskAtAlarm: boolean;
}

export const DEFAULT_FOUNTAIN_SETTINGS: FountainSettings = { warningDays: 2, alarmDays: 1, refillTaskAtAlarm: false };

export interface FountainEstimate {
  lastRefill: string | null;
  /** How long a fill lasts (median of samples), in days; null while learning. */
  fillDays: number | null;
  daysLeft: number | null;
  percentLeft: number | null;
  state: LevelState;
}

export interface FountainRefill {
  id: string;
  at: string;
  /** Days since the previous refill; null for the first one. */
  days: number | null;
}

// ---------- settings ----------

const SETTING_ID = "fountain_levels";

export async function getFountainSettings(db: Db): Promise<FountainSettings> {
  const row = await get(db, "SELECT value FROM setting WHERE id = ? AND deleted = 0", [SETTING_ID]);
  return row ? { ...DEFAULT_FOUNTAIN_SETTINGS, ...JSON.parse(row.value) } : DEFAULT_FOUNTAIN_SETTINGS;
}

export async function saveFountainSettings(db: Db, settings: FountainSettings): Promise<void> {
  if (![settings.warningDays, settings.alarmDays].every((days) => Number.isFinite(days) && days >= 0)) {
    throw new Error("Days must be 0 or more.");
  }
  if (settings.warningDays <= settings.alarmDays) throw new Error("The warning must be more days than the alarm.");
  await saveRecord(db, "setting", { id: SETTING_ID, value: JSON.stringify(settings) });
}

// ---------- refills ----------

export async function listFountainRefills(db: Db): Promise<FountainRefill[]> {
  const rows = await db.all("SELECT id, at, days FROM fountain_refill WHERE deleted = 0 ORDER BY at DESC");
  return rows.map((row) => ({ id: row.id, at: row.at, days: row.days }));
}

/** Records a refill now; unless it's the first, the days since the previous one are a sample. */
export async function refillFountain(db: Db, now = new Date()): Promise<void> {
  const previous = await get(db, "SELECT at FROM fountain_refill WHERE deleted = 0 ORDER BY at DESC LIMIT 1");
  const days = previous ? (now.getTime() - new Date(previous.at).getTime()) / DAY_MS : null;
  await saveRecord(db, "fountain_refill", { at: now.toISOString(), days });
}

export async function deleteFountainRefill(db: Db, id: string): Promise<void> {
  await deleteRecord(db, "fountain_refill", id);
}

/** How many days a fill lasts: the median of the samples, double presses ignored. */
export async function fountainFillDays(db: Db): Promise<number | null> {
  const rows = await db.all("SELECT days FROM fountain_refill WHERE deleted = 0 AND days >= ?", [MIN_SAMPLE_DAYS]);
  return median(rows.map((row) => row.days));
}

// ---------- the estimate ----------

export async function estimateFountain(db: Db, now = new Date()): Promise<FountainEstimate> {
  const settings = await getFountainSettings(db);
  const fillDays = await fountainFillDays(db);
  const last = await get(db, "SELECT at FROM fountain_refill WHERE deleted = 0 ORDER BY at DESC LIMIT 1");
  const lastRefill = last?.at ?? null;
  if (!lastRefill || fillDays === null) return { lastRefill, fillDays, daysLeft: null, percentLeft: null, state: "ok" };

  const daysLeft = Math.max(0, fillDays - (now.getTime() - new Date(lastRefill).getTime()) / DAY_MS);
  const state: LevelState = daysLeft <= settings.alarmDays ? "alarm" : daysLeft <= settings.warningDays ? "warning" : "ok";
  return { lastRefill, fillDays, daysLeft, percentLeft: Math.round((daysLeft / fillDays) * 100), state };
}

/**
 * When enabled: once the estimate reaches the alarm level (it wasn't there at the last
 * check), adds "Refill the water fountain" for today (fixed id per day, so both devices make
 * the same task) and alerts. Runs at every update (updates.ts).
 */
export async function checkFountainAlarm(db: Db, now = new Date()): Promise<NewAlert[]> {
  const settings = await getFountainSettings(db);
  const estimate = await estimateFountain(db, now);
  const inAlarm = estimate.state === "alarm";
  const before = await get(db, "SELECT matched FROM rule_state WHERE rule_id = 'fountain-alarm' AND subject = 'fountain'");
  await db.run("INSERT OR REPLACE INTO rule_state (rule_id, subject, matched) VALUES ('fountain-alarm', 'fountain', ?)", [inAlarm ? 1 : 0]);
  if (!inAlarm || before?.matched === 1 || !settings.refillTaskAtAlarm) return [];

  const added = await addRefillTask(db, localDate(now));
  const alerts = [
    await recordAlert(db, FOUNTAIN_NAME, `${FOUNTAIN_NAME}: about ${estimate.daysLeft!.toFixed(1)} days of water left. ${added ? "Added “Refill the water fountain” to today." : "Couldn't add a task: Google Tasks hasn't been read yet."}`),
  ];
  return alerts; // runUpdate returns these with the rule alerts; its caller delivers them
}

async function addRefillTask(db: Db, today: string): Promise<boolean> {
  const list = await get(db, "SELECT id FROM task_list WHERE deleted = 0 ORDER BY position LIMIT 1");
  if (!list) return false;
  const id = `auto-fountain-${today}`;
  if (await get(db, "SELECT 1 FROM task WHERE id = ?", [id])) return true;
  await saveRecord(db, "task", {
    id, list_id: list.id, google_id: null, title: "Refill the water fountain", notes: "Added by Lifeboard.",
    due: today, time: null, done: 0, completed_at: null, repeat: null, etag: null,
  });
  await queueChange(db, { type: "task.create", rowId: id, listId: list.id });
  return true;
}
