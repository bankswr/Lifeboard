// Estimating how much food the feeders have left. The F01W reports no food level, so
// (user's design, 2026-10-16):
// - The user presses "Refilled" on a feeder's card each time they fill it (always to full).
// - The time between two refills is taken as one full hopper used up: the portions the
//   meal schedule dispensed in that time are one sample of the hopper's capacity. If the
//   feeder reported a feed of 0 portions (ran dry) before the press, counting stops there.
// - All feeders are the same model with the same food, so their samples are pooled and the
//   median is the capacity. A feeder's first refill only sets its starting point.
// - Food left ≈ capacity − portions scheduled since the last refill; days left divides that
//   by the schedule's portions per day. Yellow/red thresholds are in days, with an optional
//   "Refill the feeders" task at red (like the Litter-Robot's).
// Refills and run-dry sightings are synced events, so both devices estimate the same.
import { localDate } from "../dates.ts";
import { get, type Db } from "../db/types.ts";
import { listDeviceStatuses } from "../devices.ts";
import { deliverAlerts } from "../notify.ts";
import { recordAlert, type NewAlert } from "../rules.ts";
import { queueChange } from "../schedule/edit.ts";
import { deleteRecord, saveRecord } from "../sync/records.ts";
import type { LevelState } from "../whisker/levels.ts";
import type { FeederStatus, Meal } from "./feeder.ts";
import { median } from "../energy.ts";

export interface FeederSettings {
  /** Days of food left at which the bar turns yellow, and red (alarm). */
  warningDays: number;
  alarmDays: number;
  /** At alarm: add a "Refill the feeders" task for today and raise an alert. */
  refillTaskAtAlarm: boolean;
}

export const DEFAULT_FEEDER_SETTINGS: FeederSettings = { warningDays: 3, alarmDays: 1, refillTaskAtAlarm: false };

export interface FoodEstimate {
  /** When this feeder was last marked refilled; null before the first press. */
  lastRefill: string | null;
  /** Null until there's at least one sample (a second refill of any feeder). */
  capacityPortions: number | null;
  /** The estimate; null while learning. Empty once the feeder reported a 0-portion feed. */
  portionsLeft: number | null;
  percentLeft: number | null;
  daysLeft: number | null;
  state: LevelState;
}

/** One recorded refill and the sample it gave (null for a feeder's first refill). */
export interface RefillEntry {
  id: string;
  feederId: string;
  feederName: string;
  at: string;
  portions: number | null;
}

// ---------- counting portions from the schedule ----------

/** Portions the schedule dispenses after `from` and up to `to`. */
export function scheduledPortions(meals: Meal[], from: Date, to: Date): number {
  let total = 0;
  for (let day = new Date(from.getFullYear(), from.getMonth(), from.getDate()); day <= to; day.setDate(day.getDate() + 1)) {
    const weekday = (day.getDay() + 6) % 7; // Monday first, as in the meal plan
    for (const meal of meals) {
      if (!meal.enabled || !meal.days[weekday]) continue;
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), meal.hour, meal.minute);
      if (at > from && at <= to) total += meal.portions;
    }
  }
  return total;
}

export function portionsPerDay(meals: Meal[]): number {
  const week = meals.filter((m) => m.enabled).reduce((sum, m) => sum + m.portions * m.days.filter(Boolean).length, 0);
  return week / 7;
}

// median moved to core/energy.ts; re-exported for the callers that import it from here.
export { median };

// ---------- settings ----------

const SETTING_ID = "feeder_levels";

export async function getFeederSettings(db: Db): Promise<FeederSettings> {
  const row = await get(db, "SELECT value FROM setting WHERE id = ? AND deleted = 0", [SETTING_ID]);
  return row ? { ...DEFAULT_FEEDER_SETTINGS, ...JSON.parse(row.value) } : DEFAULT_FEEDER_SETTINGS;
}

export async function saveFeederSettings(db: Db, settings: FeederSettings): Promise<void> {
  if (![settings.warningDays, settings.alarmDays].every((days) => Number.isFinite(days) && days >= 0)) {
    throw new Error("Days must be 0 or more.");
  }
  if (settings.warningDays <= settings.alarmDays) throw new Error("The warning must be more days than the alarm.");
  await saveRecord(db, "setting", { id: SETTING_ID, value: JSON.stringify(settings) });
}

// ---------- events ----------

async function feederEvents(db: Db, feederId: string, kind: "refill" | "empty") {
  return db.all("SELECT * FROM feeder_event WHERE feeder_id = ? AND kind = ? AND deleted = 0 ORDER BY at", [feederId, kind]);
}

async function feederStatuses(db: Db): Promise<FeederStatus[]> {
  return (await listDeviceStatuses(db)).filter((d) => d.kind === "feeder").map((d) => d.data as FeederStatus);
}

/**
 * Records that a feeder was just filled. Unless it's the feeder's first refill, the portions
 * dispensed since its previous one become a capacity sample.
 */
export async function markRefilled(db: Db, feederId: string, now = new Date()): Promise<void> {
  const feeder = (await feederStatuses(db)).find((f) => f.id === feederId);
  if (!feeder) throw new Error("That feeder hasn't been read yet.");
  const previous = (await feederEvents(db, feederId, "refill")).at(-1);
  let portions: number | null = null;
  if (previous) {
    const from = new Date(previous.at);
    const ranDry = (await feederEvents(db, feederId, "empty")).find((event) => new Date(event.at) > from);
    portions = scheduledPortions(feeder.meals, from, ranDry ? new Date(ranDry.at) : now);
  }
  await saveRecord(db, "feeder_event", { feeder_id: feederId, kind: "refill", at: now.toISOString(), portions });
}

/** Marks every feeder refilled at the same moment ("Refilled all"). */
export async function markAllRefilled(db: Db, now = new Date()): Promise<void> {
  await db.transaction(async () => {
    for (const feeder of await feederStatuses(db)) await markRefilled(db, feeder.id, now);
  });
}

/** Notes the first 0-portion feed seen since the last refill: the feeder ran dry around then. */
export async function noteRanDry(db: Db, feeders: FeederStatus[], now = new Date()): Promise<void> {
  for (const feeder of feeders.filter((f) => f.lastFeedPortions === 0)) {
    const lastRefill = (await feederEvents(db, feeder.id, "refill")).at(-1);
    const empties = await feederEvents(db, feeder.id, "empty");
    if (empties.some((event) => !lastRefill || event.at > lastRefill.at)) continue;
    await saveRecord(db, "feeder_event", { feeder_id: feeder.id, kind: "empty", at: now.toISOString(), portions: null });
  }
}

/** Every refill with its sample, newest first, for Settings → Feeders. */
export async function listRefills(db: Db): Promise<RefillEntry[]> {
  const names = new Map((await feederStatuses(db)).map((f) => [f.id, f.name]));
  const rows = await db.all("SELECT * FROM feeder_event WHERE kind = 'refill' AND deleted = 0 ORDER BY at DESC");
  return rows.map((row) => ({ id: row.id, feederId: row.feeder_id, feederName: names.get(row.feeder_id) ?? "Feeder", at: row.at, portions: row.portions }));
}

/** Removes a refill (e.g. a double press). Later samples are not recounted. */
export async function deleteRefill(db: Db, id: string): Promise<void> {
  await deleteRecord(db, "feeder_event", id);
}

/** The hopper capacity in portions: the median of all samples (tiny ones from double presses ignored). */
export async function hopperCapacity(db: Db): Promise<number | null> {
  const rows = await db.all("SELECT portions FROM feeder_event WHERE kind = 'refill' AND deleted = 0 AND portions >= 1");
  return median(rows.map((row) => row.portions));
}

// ---------- the estimate ----------

export async function estimateFood(db: Db, feeder: FeederStatus, now = new Date()): Promise<FoodEstimate> {
  const settings = await getFeederSettings(db);
  const capacity = await hopperCapacity(db);
  const lastRefill = (await feederEvents(db, feeder.id, "refill")).at(-1)?.at ?? null;
  const learning = { lastRefill, capacityPortions: capacity, portionsLeft: null, percentLeft: null, daysLeft: null, state: "ok" as const };
  if (!lastRefill || capacity === null) return learning;

  const ranDry = (await feederEvents(db, feeder.id, "empty")).some((event) => event.at > lastRefill);
  const used = scheduledPortions(feeder.meals, new Date(lastRefill), now);
  const portionsLeft = ranDry ? 0 : Math.max(0, capacity - used);
  const perDay = portionsPerDay(feeder.meals);
  const daysLeft = perDay > 0 ? portionsLeft / perDay : null;
  const state: LevelState =
    daysLeft === null ? "ok" : daysLeft <= settings.alarmDays ? "alarm" : daysLeft <= settings.warningDays ? "warning" : "ok";
  return { lastRefill, capacityPortions: capacity, portionsLeft, percentLeft: Math.round((portionsLeft / capacity) * 100), daysLeft, state };
}

/** Estimates for every feeder, by feeder id. */
export async function estimateAllFood(db: Db, now = new Date()): Promise<Record<string, FoodEstimate>> {
  const estimates: Record<string, FoodEstimate> = {};
  for (const feeder of await feederStatuses(db)) estimates[feeder.id] = await estimateFood(db, feeder, now);
  return estimates;
}

/**
 * When enabled: for feeders whose estimate has just reached the alarm level, adds one
 * "Refill the feeders" task for today (fixed id per day, so both devices make the same one)
 * and alerts.
 */
export async function checkFeederAlarms(db: Db, feeders: FeederStatus[], now = new Date()): Promise<NewAlert[]> {
  const settings = await getFeederSettings(db);
  const newlyLow: { feeder: FeederStatus; estimate: FoodEstimate }[] = [];
  for (const feeder of feeders) {
    const estimate = await estimateFood(db, feeder, now);
    const inAlarm = estimate.state === "alarm";
    const before = await get(db, "SELECT matched FROM rule_state WHERE rule_id = 'feeder-alarm' AND subject = ?", [feeder.id]);
    await db.run("INSERT OR REPLACE INTO rule_state (rule_id, subject, matched) VALUES ('feeder-alarm', ?, ?)", [feeder.id, inAlarm ? 1 : 0]);
    if (inAlarm && before?.matched !== 1) newlyLow.push({ feeder, estimate });
  }
  if (newlyLow.length === 0 || !settings.refillTaskAtAlarm) return [];

  const which = newlyLow.map(({ feeder, estimate }) => `${feeder.name} (about ${estimate.daysLeft!.toFixed(1)} days left)`).join(", ");
  const added = await addRefillTask(db, which, localDate(now));
  const alerts = [
    await recordAlert(db, "Feeders", `Feeders running low: ${which}. ${added ? "Added “Refill the feeders” to today." : "Couldn't add a task: Google Tasks hasn't been read yet."}`),
  ];
  await deliverAlerts(alerts);
  return alerts;
}

async function addRefillTask(db: Db, which: string, today: string): Promise<boolean> {
  const list = await get(db, "SELECT id FROM task_list WHERE deleted = 0 ORDER BY position LIMIT 1");
  if (!list) return false;
  const id = `auto-feeders-${today}`;
  if (await get(db, "SELECT 1 FROM task WHERE id = ?", [id])) return true;
  await saveRecord(db, "task", {
    id, list_id: list.id, google_id: null, title: "Refill the feeders", notes: `Added by Lifeboard: ${which}.`,
    due: today, time: null, done: 0, completed_at: null, repeat: null, etag: null,
  });
  await queueChange(db, { type: "task.create", rowId: id, listId: list.id });
  return true;
}

