// Litter-Robot level settings (Settings → Litter-Robot): at what drawer and litter levels the
// bars turn yellow (warning) and red (alarm), and whether reaching an alarm adds a "Clean the
// litter box" task for today plus an alert (user, 2026-10-16). Also the LitterHopper
// estimate's thresholds in days (hopper.ts). Stored in the synced `setting`
// table so both devices use the same values.
import { localDate } from "../dates.ts";
import { get, type Db } from "../db/types.ts";
import { deliverAlerts } from "../notify.ts";
import { recordAlert, type NewAlert } from "../rules.ts";
import { queueChange } from "../schedule/edit.ts";
import { saveRecord } from "../sync/records.ts";
import type { LitterRobotStatus } from "./status.ts";

export interface LitterSettings {
  /** Waste drawer, % full: higher is worse. */
  drawerWarning: number;
  drawerAlarm: number;
  /** Litter, % left: lower is worse. */
  litterWarning: number;
  litterAlarm: number;
  /** At alarm: add a "Clean the litter box" task for today and raise an alert. */
  cleanTaskAtAlarm: boolean;
  /** Alert when a cat's visit gets no clean cycle within this many minutes; null = off (stalls.ts). */
  stallAlertMinutes: number | null;
  /** LitterHopper, estimated days of litter left at which its bar turns yellow, and red (hopper.ts). */
  hopperWarningDays: number;
  hopperAlarmDays: number;
  /** At the hopper's alarm: add a "Refill the litter hopper" task for today and raise an alert. */
  hopperTaskAtAlarm: boolean;
}

export type LevelState = "ok" | "warning" | "alarm";

export const DEFAULT_LITTER_SETTINGS: LitterSettings = {
  drawerWarning: 70, drawerAlarm: 90, litterWarning: 40, litterAlarm: 20, cleanTaskAtAlarm: false,
  stallAlertMinutes: 60, hopperWarningDays: 3, hopperAlarmDays: 1, hopperTaskAtAlarm: false,
};

const SETTING_ID = "litter_levels";

export async function getLitterSettings(db: Db): Promise<LitterSettings> {
  const row = await get(db, "SELECT value FROM setting WHERE id = ? AND deleted = 0", [SETTING_ID]);
  return row ? { ...DEFAULT_LITTER_SETTINGS, ...JSON.parse(row.value) } : DEFAULT_LITTER_SETTINGS;
}

export async function saveLitterSettings(db: Db, settings: LitterSettings): Promise<void> {
  const levels = [settings.drawerWarning, settings.drawerAlarm, settings.litterWarning, settings.litterAlarm];
  if (levels.some((level) => !Number.isFinite(level) || level < 0 || level > 100)) throw new Error("Levels are percentages from 0 to 100.");
  if (settings.drawerWarning >= settings.drawerAlarm) throw new Error("The drawer warning must be below its alarm level.");
  if (settings.litterWarning <= settings.litterAlarm) throw new Error("The litter warning must be above its alarm level.");
  if (settings.stallAlertMinutes !== null && !(Number.isInteger(settings.stallAlertMinutes) && settings.stallAlertMinutes >= 15)) {
    throw new Error("The clean-cycle alert needs whole minutes, at least 15 (the robot can wait up to 15 minutes itself), or blank for off.");
  }
  if (![settings.hopperWarningDays, settings.hopperAlarmDays].every((days) => Number.isFinite(days) && days >= 0)) {
    throw new Error("Hopper days must be 0 or more.");
  }
  if (settings.hopperWarningDays <= settings.hopperAlarmDays) throw new Error("The hopper warning must be more days than its alarm.");
  await saveRecord(db, "setting", { id: SETTING_ID, value: JSON.stringify(settings) });
}

export function drawerState(robot: Pick<LitterRobotStatus, "drawerLevel" | "drawerFull">, settings: LitterSettings): LevelState {
  if (robot.drawerFull || robot.drawerLevel >= settings.drawerAlarm) return "alarm";
  return robot.drawerLevel >= settings.drawerWarning ? "warning" : "ok";
}

export function litterState(robot: Pick<LitterRobotStatus, "litterLevel">, settings: LitterSettings): LevelState {
  if (robot.litterLevel <= settings.litterAlarm) return "alarm";
  return robot.litterLevel <= settings.litterWarning ? "warning" : "ok";
}

/**
 * When enabled: for each robot whose drawer or litter has just reached its alarm level (it
 * wasn't there at the last check), adds a "Clean the litter box" task for today and alerts.
 * The task's id is fixed per robot and day, so if both devices make it, sync merges the two
 * and Google gets it once.
 */
export async function checkLitterAlarms(db: Db, robots: LitterRobotStatus[], today = localDate()): Promise<NewAlert[]> {
  const settings = await getLitterSettings(db);
  const alerts: NewAlert[] = [];
  for (const robot of robots) {
    const reasons = [
      drawerState(robot, settings) === "alarm" ? `drawer ${robot.drawerLevel}% full` : null,
      litterState(robot, settings) === "alarm" ? `litter down to ${robot.litterLevel}%` : null,
    ].filter((reason): reason is string => reason !== null);
    const inAlarm = reasons.length > 0;
    const before = await get(db, "SELECT matched FROM rule_state WHERE rule_id = 'litter-alarm' AND subject = ?", [robot.serial]);
    await db.run("INSERT OR REPLACE INTO rule_state (rule_id, subject, matched) VALUES ('litter-alarm', ?, ?)", [robot.serial, inAlarm ? 1 : 0]);
    if (!inAlarm || before?.matched === 1 || !settings.cleanTaskAtAlarm) continue;

    const why = reasons.join(", ");
    const added = await addCleanTask(db, robot, why, today);
    alerts.push(
      await recordAlert(db, robot.name, `${robot.name}: ${why}. ${added ? "Added “Clean the litter box” to today." : "Couldn't add a task: Google Tasks hasn't been read yet."}`),
    );
  }
  await deliverAlerts(alerts);
  return alerts;
}

/** Adds today's clean-up task unless it's already there. False when there's no task list to add it to. */
async function addCleanTask(db: Db, robot: LitterRobotStatus, why: string, today: string): Promise<boolean> {
  const list = await get(db, "SELECT id FROM task_list WHERE deleted = 0 ORDER BY position LIMIT 1");
  if (!list) return false;
  const id = `auto-litter-${robot.serial}-${today}`;
  if (await get(db, "SELECT 1 FROM task WHERE id = ?", [id])) return true;
  await saveRecord(db, "task", {
    id, list_id: list.id, google_id: null, title: "Clean the litter box", notes: `Added by Lifeboard: ${robot.name} ${why}.`,
    due: today, time: null, done: 0, completed_at: null, repeat: null, etag: null,
  });
  await queueChange(db, { type: "task.create", rowId: id, listId: list.id });
  return true;
}
