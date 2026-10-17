// Litter-Robot time estimates (docs/PLAN.md phase 8, user 2026-10-17): when the waste drawer
// will reach its alarm level and when the litter will fall to its alarm level (thresholds
// under Settings → Litter-Robot).
// - Each update records the drawer and litter levels. Readings are synced, so the phone
//   gets the desktop's hourly history and can estimate without signing in to Whisker itself.
// - The drawer's history restarts when it was emptied (a drop of DRAWER_EMPTIED points
//   between readings), the litter's when it was refilled (a rise of LITTER_REFILLED points).
// - The rate is the least-squares slope of the readings since then; the estimate is when
//   that rate reaches the alarm level, given as a time (not a countdown) so a widget showing
//   it stays right between updates.
import { slope } from "../energy.ts";
import { get, type Db } from "../db/types.ts";
import { saveRecord } from "../sync/records.ts";
import { getLitterSettings, type LitterSettings } from "./levels.ts";
import type { LitterRobotStatus } from "./status.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Readings closer together than this (e.g. both devices updating) add nothing. */
const MIN_READING_GAP_MS = 30 * 60_000;
/** A fall this large means the drawer was emptied; a rise this large, the litter refilled. */
const DRAWER_EMPTIED = 15;
const LITTER_REFILLED = 10;
/** An estimate needs readings spanning this long, and a rate at least this steep (points/day). */
const MIN_SPAN_MS = 6 * HOUR_MS;
const MIN_RATE_PER_DAY = 0.5;

export interface LevelReading {
  at: string;
  drawer: number;
  litter: number;
}

export interface LevelEstimate {
  /** When the level is expected to reach its alarm; null when unknown or already there. */
  at: string | null;
  /** Points per day, positive for the drawer filling and the litter running down. */
  ratePerDay: number | null;
  /** The level is already at or past its alarm. */
  reached: boolean;
}

export interface LitterEstimate {
  serial: string;
  drawer: LevelEstimate;
  litter: LevelEstimate;
}

/** Stores each robot's levels, unless this robot was read moments ago. */
export async function recordLitterLevels(db: Db, robots: LitterRobotStatus[], now = new Date()): Promise<void> {
  for (const robot of robots) {
    const last = await get(db, "SELECT at FROM litter_level WHERE serial = ? AND deleted = 0 ORDER BY at DESC LIMIT 1", [robot.serial]);
    if (last && now.getTime() - new Date(last.at).getTime() < MIN_READING_GAP_MS) continue;
    const at = now.toISOString();
    await saveRecord(db, "litter_level", { id: `${robot.serial}-${at}`, serial: robot.serial, at, drawer: robot.drawerLevel, litter: robot.litterLevel });
  }
}

/** Estimates for every robot that has readings. */
export async function litterEstimates(db: Db): Promise<Record<string, LitterEstimate>> {
  const settings = await getLitterSettings(db);
  const rows = await db.all("SELECT serial, at, drawer, litter FROM litter_level WHERE deleted = 0 ORDER BY serial, at");
  const bySerial = new Map<string, LevelReading[]>();
  for (const row of rows) {
    const list = bySerial.get(row.serial) ?? bySerial.set(row.serial, []).get(row.serial)!;
    list.push({ at: row.at, drawer: row.drawer, litter: row.litter });
  }
  const result: Record<string, LitterEstimate> = {};
  for (const [serial, readings] of bySerial) result[serial] = estimateLitter(serial, readings, settings);
  return result;
}

export function estimateLitter(serial: string, readings: LevelReading[], settings: LitterSettings): LitterEstimate {
  const drawerReadings = sinceReset(readings, (previous, next) => previous.drawer - next.drawer >= DRAWER_EMPTIED);
  const litterReadings = sinceReset(readings, (previous, next) => next.litter - previous.litter >= LITTER_REFILLED);
  return {
    serial,
    // The drawer fills (rises) toward its alarm; the litter runs down (falls) toward its alarm.
    drawer: estimateLevel(drawerReadings.map((r) => ({ at: r.at, level: r.drawer })), settings.drawerAlarm, 1),
    litter: estimateLevel(litterReadings.map((r) => ({ at: r.at, level: r.litter })), settings.litterAlarm, -1),
  };
}

/** The readings after the last reset (emptied or refilled); all of them if there was none. */
function sinceReset(readings: LevelReading[], isReset: (previous: LevelReading, next: LevelReading) => boolean): LevelReading[] {
  let start = 0;
  for (let i = 1; i < readings.length; i++) if (isReset(readings[i - 1], readings[i])) start = i;
  return readings.slice(start);
}

/**
 * `direction` is 1 for a level that rises toward its alarm, −1 for one that falls toward it.
 * The estimate starts from the latest reading and its time.
 */
function estimateLevel(points: { at: string; level: number }[], alarm: number, direction: 1 | -1): LevelEstimate {
  const latest = points.at(-1);
  if (!latest) return { at: null, ratePerDay: null, reached: false };
  if ((latest.level - alarm) * direction >= 0) return { at: null, ratePerDay: null, reached: true };
  const first = new Date(points[0].at).getTime();
  const latestTime = new Date(latest.at).getTime();
  const perMs = slope(points.map((p) => ({ x: new Date(p.at).getTime() - first, y: p.level })));
  const ratePerDay = perMs === null ? null : perMs * DAY_MS * direction;
  if (ratePerDay === null || latestTime - first < MIN_SPAN_MS || ratePerDay < MIN_RATE_PER_DAY) {
    return { at: null, ratePerDay, reached: false };
  }
  const daysLeft = ((alarm - latest.level) * direction) / ratePerDay;
  return { at: new Date(latestTime + daysLeft * DAY_MS).toISOString(), ratePerDay, reached: false };
}
