// Task reminders (user, 2026-10-17; docs/PLAN.md phase 5): a notification at the time of each
// open task that has a Lifeboard-only time. Phone only: the phone schedules them in advance
// with Android's local notifications (src/app/reminders.ts), so they arrive with the app
// closed. This module decides *what* to schedule; it never talks to Android.
//
// Snoozes are kept per device in the meta table (not synced): a snooze is about this phone's
// notification, not about the task.
//
// Missed reminders (user, 2026-10-17): when the app runs, any open task whose reminder time
// passed since the app last checked (at most MISSED_LOOKBACK_HOURS back) and whose reminder
// isn't showing is notified then, once, as "missed": the phone was off, the task reached
// the phone only after its time (set on the desktop), or the reminder was swiped away
// without Done.
import { localDate } from "./dates.ts";
import { getMeta, setMeta } from "./db/meta.ts";
import type { Db } from "./db/types.ts";

/** How long Snooze puts a reminder off (user, 2026-10-17). */
export const SNOOZE_MINUTES = 10;
/** Reminders are scheduled this many days ahead; each open, update or sync extends it. */
export const REMINDER_DAYS_AHEAD = 14;

export interface Reminder {
  taskId: string;
  title: string;
  /** When to notify, ISO 8601 UTC. */
  at: string;
  /** Android notification id: fixed per task, so rescheduling replaces rather than repeats. */
  notificationId: number;
  snoozed: boolean;
}

const SNOOZE_KEY = "reminder_snoozes";
/** When missed reminders were last looked for, ISO 8601. */
const CHECKED_KEY = "reminders_checked_at";
/** Missed reminders older than this aren't shown: a stale "missed" isn't useful. */
export const MISSED_LOOKBACK_HOURS = 48;

/**
 * The reminders that should be pending now: open tasks with a date and time still ahead
 * (within REMINDER_DAYS_AHEAD days), plus snoozed ones whose new time is ahead. A snooze
 * replaces the task's own time.
 */
export async function upcomingReminders(db: Db, now = new Date()): Promise<Reminder[]> {
  const last = localDate(new Date(now.getTime() + REMINDER_DAYS_AHEAD * 86_400_000));
  const tasks = await db.all(
    `SELECT id, title, due, time FROM task
     WHERE deleted = 0 AND done = 0 AND due IS NOT NULL AND time IS NOT NULL AND due BETWEEN ? AND ?
     ORDER BY due, time`,
    [localDate(new Date(now.getTime() - 86_400_000)), last],
  );
  const snoozes = await readSnoozes(db);
  const reminders: Reminder[] = [];
  for (const task of tasks) {
    const snoozedUntil = snoozes[task.id];
    const at = snoozedUntil ? new Date(snoozedUntil) : localDateTime(task.due, task.time);
    if (at.getTime() <= now.getTime()) continue; // its time has passed: no late reminder
    reminders.push({ taskId: task.id, title: task.title, at: at.toISOString(), notificationId: notificationId(task.id), snoozed: Boolean(snoozedUntil) });
  }
  return reminders;
}

/**
 * The reminders missed since the last check, oldest first, and records this check, so each
 * is returned once. `showingTaskIds`: tasks whose reminder is still in the notification
 * shade (not missed). The very first check only records the time, so installing or
 * updating the app doesn't bring up old reminders.
 */
export async function takeMissedReminders(db: Db, showingTaskIds: string[], now = new Date()): Promise<Reminder[]> {
  const checked = await getMeta(db, CHECKED_KEY);
  await setMeta(db, CHECKED_KEY, now.toISOString());
  if (!checked) return [];
  const since = Math.max(new Date(checked).getTime(), now.getTime() - MISSED_LOOKBACK_HOURS * 3_600_000);
  const tasks = await db.all(
    `SELECT id, title, due, time FROM task
     WHERE deleted = 0 AND done = 0 AND due IS NOT NULL AND time IS NOT NULL AND due BETWEEN ? AND ?
     ORDER BY due, time`,
    [localDate(new Date(since - 86_400_000)), localDate(now)],
  );
  const snoozes = await readSnoozes(db);
  const missed: Reminder[] = [];
  for (const task of tasks) {
    if (showingTaskIds.includes(task.id)) continue;
    const snoozedUntil = snoozes[task.id];
    const at = snoozedUntil ? new Date(snoozedUntil) : localDateTime(task.due, task.time);
    if (at.getTime() <= since || at.getTime() > now.getTime()) continue;
    missed.push({ taskId: task.id, title: task.title, at: at.toISOString(), notificationId: notificationId(task.id), snoozed: Boolean(snoozedUntil) });
  }
  return missed;
}

/** Puts a task's reminder off by SNOOZE_MINUTES from now. */
export async function snoozeReminder(db: Db, taskId: string, now = new Date()): Promise<void> {
  const snoozes = await readSnoozes(db);
  snoozes[taskId] = new Date(now.getTime() + SNOOZE_MINUTES * 60_000).toISOString();
  // Old snoozes are dropped here, so the list never grows.
  for (const [id, until] of Object.entries(snoozes)) {
    if (new Date(until).getTime() <= now.getTime()) delete snoozes[id];
  }
  await setMeta(db, SNOOZE_KEY, JSON.stringify(snoozes));
}

async function readSnoozes(db: Db): Promise<Record<string, string>> {
  return JSON.parse((await getMeta(db, SNOOZE_KEY)) ?? "{}");
}

/** "2026-10-17" + "07:30" in this device's local time. */
function localDateTime(date: string, time: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes);
}

/**
 * A stable Android notification id for a task: a hash of its id, kept between 1,000,000,000
 * and 2,147,483,647 (Java int) so it never clashes with alert notifications, whose ids stay
 * below 1,000,000 (src/app/notify.ts).
 */
export function notificationId(taskId: string): number {
  let hash = 0;
  for (const char of taskId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 1_000_000_000 + (hash % 1_000_000_000);
}
