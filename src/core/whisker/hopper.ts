// LitterHopper estimate (user, 2026-10-19): how much litter is left in the Litter-Robot's
// hopper accessory. Whisker reports no hopper fill level, but the activity log has a
// `litterHopperDispensed` entry for each dispense, so the scheme is the feeders' one
// (core/smartlife/food.ts) counted in dispenses:
// - Each update stores the dispenses in the activity log it read (ids from the log's
//   timestamps, so re-reading the same hours or both devices reading them adds nothing).
// - The user presses "Hopper refilled" each time they fill it (to full). Each refill after a
//   robot's first counts the dispenses since its previous refill as one full hopper; the
//   median of those samples is the capacity. The first refill only sets the starting point.
// - Left ≈ capacity − dispenses since the last refill; days left divides that by the
//   dispenses per day over the last RATE_WINDOW_DAYS. Thresholds in days (Settings →
//   Litter-Robot), with an optional "Refill the litter hopper" task at red.
// Dispenses and refills are synced rows, so the phone estimates from the desktop's reads.
import { localDate } from "../dates.ts";
import { get, type Db } from "../db/types.ts";
import { median } from "../energy.ts";
import { recordAlert, type NewAlert } from "../rules.ts";
import { queueChange } from "../schedule/edit.ts";
import { deleteRecord, saveRecord } from "../sync/records.ts";
import type { ActivityEntry } from "./api.ts";
import { getLitterSettings, type LevelState } from "./levels.ts";
import { activityTime } from "./stalls.ts";
import type { LitterRobotStatus } from "./status.ts";

const DAY_MS = 86_400_000;
const DISPENSE_VALUE = "litterHopperDispensed";
/** The dispense rate is taken over this many recent days... */
const RATE_WINDOW_DAYS = 14;
/** ...and needs at least this long since the first dispense seen, or it's still learning. */
const MIN_RATE_DAYS = 1;

export interface HopperEstimate {
  /** When the hopper was last marked refilled; null before the first press. */
  lastRefill: string | null;
  /** Dispenses in a full hopper; null until there's a sample (a second refill). */
  capacity: number | null;
  /** Dispenses since the last refill. */
  usedSinceRefill: number;
  dispensesLeft: number | null;
  percentLeft: number | null;
  /** Null while the capacity or the dispense rate is still being learned. */
  daysLeft: number | null;
  state: LevelState;
}

/** One recorded refill and the sample it gave (null for a robot's first refill). */
export interface HopperRefill {
  id: string;
  serial: string;
  at: string;
  dispenses: number | null;
}

// ---------- dispenses ----------

/** Stores the dispenses in an activity log read, skipping ones already stored. */
export async function recordHopperDispenses(db: Db, serial: string, entries: ActivityEntry[]): Promise<void> {
  for (const entry of entries.filter((e) => e.value === DISPENSE_VALUE)) {
    const at = new Date(activityTime(entry.timestamp)).toISOString();
    const id = `${serial}-dispense-${at}`;
    if (await get(db, "SELECT 1 FROM litter_hopper_event WHERE id = ?", [id])) continue;
    await saveRecord(db, "litter_hopper_event", { id, serial, kind: "dispense", at, dispenses: null });
  }
}

async function countDispenses(db: Db, serial: string, after: string, upTo: string): Promise<number> {
  const row = await get(
    db,
    "SELECT COUNT(*) AS n FROM litter_hopper_event WHERE serial = ? AND kind = 'dispense' AND deleted = 0 AND at > ? AND at <= ?",
    [serial, after, upTo],
  );
  return Number(row?.n ?? 0);
}

/** Dispenses per day lately; null until dispenses have been seen for MIN_RATE_DAYS. */
async function dispensesPerDay(db: Db, serial: string, now: Date): Promise<number | null> {
  const first = await get(db, "SELECT MIN(at) AS at FROM litter_hopper_event WHERE serial = ? AND kind = 'dispense' AND deleted = 0", [serial]);
  if (!first?.at) return null;
  const windowStart = Math.max(new Date(first.at).getTime(), now.getTime() - RATE_WINDOW_DAYS * DAY_MS);
  const days = (now.getTime() - windowStart) / DAY_MS;
  if (days < MIN_RATE_DAYS) return null;
  // The first dispense seen opens the window, so it isn't counted in it.
  return (await countDispenses(db, serial, new Date(windowStart).toISOString(), now.toISOString())) / days;
}

// ---------- refills ----------

async function lastRefill(db: Db, serial: string): Promise<string | null> {
  const row = await get(
    db,
    "SELECT at FROM litter_hopper_event WHERE serial = ? AND kind = 'refill' AND deleted = 0 ORDER BY at DESC LIMIT 1",
    [serial],
  );
  return row?.at ?? null;
}

/** Records that a robot's hopper was just filled; unless it's the first refill, the dispenses since the previous one are a sample. */
export async function markHopperRefilled(db: Db, serial: string, now = new Date()): Promise<void> {
  const previous = await lastRefill(db, serial);
  const at = now.toISOString();
  const dispenses = previous ? await countDispenses(db, serial, previous, at) : null;
  await saveRecord(db, "litter_hopper_event", { serial, kind: "refill", at, dispenses });
}

/** Every refill with its sample, newest first, for Settings → Litter-Robot. */
export async function listHopperRefills(db: Db): Promise<HopperRefill[]> {
  const rows = await db.all("SELECT id, serial, at, dispenses FROM litter_hopper_event WHERE kind = 'refill' AND deleted = 0 ORDER BY at DESC");
  return rows.map((row) => ({ id: row.id, serial: row.serial, at: row.at, dispenses: row.dispenses }));
}

/** Removes a refill (e.g. a double press). Later samples are not recounted. */
export async function deleteHopperRefill(db: Db, id: string): Promise<void> {
  await deleteRecord(db, "litter_hopper_event", id);
}

/** The hopper capacity in dispenses: the median of the robot's samples (empty ones from double presses ignored). */
export async function hopperCapacity(db: Db, serial: string): Promise<number | null> {
  const rows = await db.all(
    "SELECT dispenses FROM litter_hopper_event WHERE serial = ? AND kind = 'refill' AND deleted = 0 AND dispenses >= 1",
    [serial],
  );
  return median(rows.map((row) => row.dispenses));
}

// ---------- the estimate ----------

export async function estimateHopper(db: Db, serial: string, now = new Date()): Promise<HopperEstimate> {
  const settings = await getLitterSettings(db);
  const refilled = await lastRefill(db, serial);
  const capacity = await hopperCapacity(db, serial);
  const usedSinceRefill = refilled ? await countDispenses(db, serial, refilled, now.toISOString()) : 0;
  if (!refilled || capacity === null) {
    return { lastRefill: refilled, capacity, usedSinceRefill, dispensesLeft: null, percentLeft: null, daysLeft: null, state: "ok" };
  }
  const dispensesLeft = Math.max(0, capacity - usedSinceRefill);
  const perDay = await dispensesPerDay(db, serial, now);
  const daysLeft = perDay ? dispensesLeft / perDay : null;
  const state: LevelState =
    daysLeft === null ? "ok" : daysLeft <= settings.hopperAlarmDays ? "alarm" : daysLeft <= settings.hopperWarningDays ? "warning" : "ok";
  return { lastRefill: refilled, capacity, usedSinceRefill, dispensesLeft, percentLeft: Math.round((dispensesLeft / capacity) * 100), daysLeft, state };
}

/** Estimates for every robot that has hopper dispenses or refills, by serial. */
export async function hopperEstimates(db: Db, now = new Date()): Promise<Record<string, HopperEstimate>> {
  const rows = await db.all("SELECT DISTINCT serial FROM litter_hopper_event WHERE deleted = 0");
  const estimates: Record<string, HopperEstimate> = {};
  for (const row of rows) estimates[row.serial] = await estimateHopper(db, row.serial, now);
  return estimates;
}

/**
 * When enabled: for each robot whose hopper estimate has just reached the alarm level, adds
 * "Refill the litter hopper" for today (fixed id per robot and day, so both devices make the
 * same task) and alerts.
 */
export async function checkHopperAlarms(db: Db, robots: LitterRobotStatus[], now = new Date()): Promise<NewAlert[]> {
  const settings = await getLitterSettings(db);
  const alerts: NewAlert[] = [];
  for (const robot of robots) {
    const estimate = await estimateHopper(db, robot.serial, now);
    const inAlarm = estimate.state === "alarm";
    const before = await get(db, "SELECT matched FROM rule_state WHERE rule_id = 'hopper-alarm' AND subject = ?", [robot.serial]);
    await db.run("INSERT OR REPLACE INTO rule_state (rule_id, subject, matched) VALUES ('hopper-alarm', ?, ?)", [robot.serial, inAlarm ? 1 : 0]);
    if (!inAlarm || before?.matched === 1 || !settings.hopperTaskAtAlarm) continue;

    const why = `about ${estimate.daysLeft!.toFixed(1)} days of litter left in the hopper`;
    const added = await addRefillTask(db, robot, why, localDate(now));
    alerts.push(
      await recordAlert(db, robot.name, `${robot.name}: ${why}. ${added ? "Added “Refill the litter hopper” to today." : "Couldn't add a task: Google Tasks hasn't been read yet."}`),
    );
  }
  return alerts;
}

async function addRefillTask(db: Db, robot: LitterRobotStatus, why: string, today: string): Promise<boolean> {
  const list = await get(db, "SELECT id FROM task_list WHERE deleted = 0 ORDER BY position LIMIT 1");
  if (!list) return false;
  const id = `auto-hopper-${robot.serial}-${today}`;
  if (await get(db, "SELECT 1 FROM task WHERE id = ?", [id])) return true;
  await saveRecord(db, "task", {
    id, list_id: list.id, google_id: null, title: "Refill the litter hopper", notes: `Added by Lifeboard: ${robot.name}, ${why}.`,
    due: today, time: null, done: 0, completed_at: null, repeat: null, etag: null,
  });
  await queueChange(db, { type: "task.create", rowId: id, listId: list.id });
  return true;
}
