// Clean-cycle stalls (user, 2026-10-18): a cat used the Litter-Robot and no clean cycle
// followed. Normally a cycle follows within the robot's wait time: over a year of the user's
// activity log, 90% of visits got one within 27 minutes, and of the 39 visits that waited
// over an hour, 27 were stalls of hours or days, nearly all after the drawer was flagged full
// (agent-notes/2026-10-18-litter-cycle-stalls.md). So the alert is visit-based, not "too long
// since the last cycle", which would also fire while nobody is using the box.
// A cat detection counts as the start of a stall too (2026-11-01): the robot can stick on its
// curtain sensor ("Cat sensor timing") and log no weigh-ins at all; on 2026-10-30 it sat like
// that for two days with no alert because only weigh-ins were counted.
// The alert stays raised for the whole stall: dismissing it while the robot still hasn't
// cycled raises it again at the next update (user).
import { get, type Db } from "../db/types.ts";
import { recordAlert, type NewAlert } from "../rules.ts";
import type { ActivityEntry } from "./api.ts";
import { getLitterSettings } from "./levels.ts";
import type { LitterRobotStatus } from "./status.ts";

/** How far back each update reads the activity log: covers a stall that began before a day of downtime. */
export const ACTIVITY_LOOKBACK_HOURS = 72;
/** rule_id of the alerts this raises, so an open one can be found. */
const STALL_RULE_ID = "litter-stall";

export interface CycleStall {
  /** The first visit or cat detection the robot hasn't cleaned up after (UTC ISO). */
  since: string;
  /** Weigh-ins since the last cycle; 0 when the robot only detected a cat. */
  visits: number;
}

/** Whisker's "2026-10-18 14:03:07.123456789" (UTC) → ms since 1970. */
export function activityTime(timestamp: string): number {
  return Date.parse(`${timestamp.slice(0, 19).replace(" ", "T")}Z`);
}

/** Activity values meaning the robot sensed a cat, with or without a weigh-in. */
const CAT_DETECTIONS = ["robotStatusCatDetect", "robotCycleStateCatDetect"];

/**
 * The stall going on now, if any: visits (weigh-ins) or cat detections since the last clean
 * cycle, the first of them at least `waitMinutes` ago. One too recent to judge doesn't count yet.
 */
export function findCycleStall(entries: ActivityEntry[], now: Date, waitMinutes: number): CycleStall | null {
  const times = (value: string) => entries.filter((entry) => entry.value === value).map((entry) => activityTime(entry.timestamp));
  const lastCycle = Math.max(-Infinity, ...times("robotCycleStatusDump"));
  const afterLastCycle = (time: number) => time > lastCycle;
  const visits = times("catWeight").filter(afterLastCycle);
  const detections = CAT_DETECTIONS.flatMap(times).filter(afterLastCycle);
  const first = Math.min(...visits, ...detections);
  if (first === Infinity || now.getTime() - first < waitMinutes * 60_000) return null;
  return { since: new Date(first).toISOString(), visits: visits.length };
}

/**
 * Alerts for a robot that has stalled, unless this stall's alert is still on the Monitor
 * (not dismissed). Off when the setting is blank.
 */
export async function checkCycleStall(
  db: Db,
  robot: LitterRobotStatus,
  entries: ActivityEntry[],
  now = new Date(),
): Promise<NewAlert[]> {
  const { stallAlertMinutes } = await getLitterSettings(db);
  if (stallAlertMinutes === null) return [];
  const stall = findCycleStall(entries, now, stallAlertMinutes);
  if (!stall) return [];
  const open = await get(
    db,
    "SELECT 1 FROM alert WHERE rule_id = ? AND subject = ? AND created_at >= ? AND dismissed = 0",
    [STALL_RULE_ID, robot.name, stall.since],
  );
  if (open) return [];
  const hours = (now.getTime() - Date.parse(stall.since)) / 3_600_000;
  const waited = hours < 2 ? `${Math.round(hours * 60)} minutes` : `${Math.round(hours)} hours`;
  const cause = robot.drawerFull ? " The drawer is full." : "";
  const message =
    stall.visits === 0
      ? `${robot.name} hasn't run a clean cycle since it detected a cat ${waited} ago (status: ${robot.status}).${cause}`
      : `${robot.name} hasn't run a clean cycle after ${stall.visits === 1 ? "a cat's visit" : `${stall.visits} visits`} (first ${waited} ago).${cause}`;
  return [await recordAlert(db, robot.name, message, STALL_RULE_ID, now)];
}
