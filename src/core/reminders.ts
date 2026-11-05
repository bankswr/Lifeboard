// Task reminders (user, 2026-10-17; docs/PLAN.md phase 5): a notification at the time of each
// open task that has a Lifeboard-only time. Phone only: the phone schedules them in advance
// with Android's local notifications (src/app/reminders.ts), so they arrive with the app
// closed. This module decides *what* to schedule; it never talks to Android.
//
// Snoozes are kept per device in the meta table (not synced): a snooze is about this phone's
// notification, not about the task.
//
// A task with a date but no time is reminded of at DEFAULT_REMINDER_TIME (user, 2026-11-05).
//
// Late reminders (user, 2026-10-17 and 2026-11-05): tasks appear on their due day, so a reminder's
// time may pass before the task reaches the phone, or with the phone off. When the app runs,
// any open task whose reminder time has passed and that hasn't been handled yet is notified
// then, once, however old. The tasks handled are remembered per task, not as a last-checked time,
// because a task can arrive after a check that was later than its reminder time.
import { localDate } from "./dates.ts";
import { getMeta, setMeta } from "./db/meta.ts";
import { get, type Db, type Row } from "./db/types.ts";

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
  /** Whether the task has its own time, rather than the default one. */
  timed: boolean;
}

const SNOOZE_KEY = "reminder_snoozes";
/** When late reminders were last looked for, ISO 8601; unset until the first check on this device. */
const CHECKED_KEY = "reminders_checked_at";
/** Per task, the latest reminder time already handled, ISO 8601. */
const HANDLED_KEY = "reminders_handled";
/** When a task with a date but no time is reminded of (user, 2026-11-05). */
export const DEFAULT_REMINDER_TIME = "08:00";

/** A task's own reminder time, or the snoozed time that replaces it. */
function reminderAt(task: Row, snoozes: Record<string, string>): Date {
  const snoozedUntil = snoozes[task.id];
  return snoozedUntil ? new Date(snoozedUntil) : localDateTime(task.due, task.time ?? DEFAULT_REMINDER_TIME);
}

function toReminder(task: Row, at: Date, snoozes: Record<string, string>): Reminder {
  return {
    taskId: task.id, title: task.title, at: at.toISOString(), notificationId: notificationId(task.id),
    snoozed: Boolean(snoozes[task.id]), timed: task.time !== null,
  };
}

/**
 * The reminders that should be pending now: open tasks with a date whose reminder is still ahead
 * (within REMINDER_DAYS_AHEAD days), plus snoozed ones whose new time is ahead. A snooze
 * replaces the task's own time.
 */
export async function upcomingReminders(db: Db, now = new Date()): Promise<Reminder[]> {
  const last = localDate(new Date(now.getTime() + REMINDER_DAYS_AHEAD * 86_400_000));
  const tasks = await db.all(
    `SELECT id, title, due, time FROM task
     WHERE deleted = 0 AND done = 0 AND due IS NOT NULL AND due BETWEEN ? AND ?
     ORDER BY due, time`,
    [localDate(new Date(now.getTime() - 86_400_000)), last],
  );
  const snoozes = await readSnoozes(db);
  const reminders: Reminder[] = [];
  for (const task of tasks) {
    const at = reminderAt(task, snoozes);
    if (at.getTime() <= now.getTime()) continue; // its time has passed: takeLateReminders' job
    reminders.push(toReminder(task, at, snoozes));
  }
  return reminders;
}

/**
 * The reminders whose time has passed and that haven't been handled, oldest first, and records
 * them as handled, so each is returned once. `showingTaskIds`: tasks whose reminder is still in
 * the notification shade, which are handled already. The first check on a device (a new install)
 * returns nothing, so installing the app doesn't bring up old reminders.
 */
export async function takeLateReminders(db: Db, showingTaskIds: string[], now = new Date()): Promise<Reminder[]> {
  const firstCheck = !(await getMeta(db, CHECKED_KEY));
  await setMeta(db, CHECKED_KEY, now.toISOString());
  const tasks = await db.all(
    "SELECT id, title, due, time FROM task WHERE deleted = 0 AND done = 0 AND due IS NOT NULL AND due <= ? ORDER BY due, time",
    [localDate(now)],
  );
  const snoozes = await readSnoozes(db);
  const previouslyHandled = await readHandled(db);
  const handled: Record<string, string> = {}; // only tasks still open, so the list never grows
  const late: Reminder[] = [];
  for (const task of tasks) {
    const at = reminderAt(task, snoozes);
    const alreadyHandled = previouslyHandled[task.id];
    if (alreadyHandled) handled[task.id] = alreadyHandled;
    if (at.getTime() > now.getTime() || (alreadyHandled && at.toISOString() <= alreadyHandled)) continue;
    handled[task.id] = at.toISOString();
    if (!firstCheck && !showingTaskIds.includes(task.id)) late.push(toReminder(task, at, snoozes));
  }
  await setMeta(db, HANDLED_KEY, JSON.stringify(handled));
  return late.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Records a task's reminder as handled if its time has already passed: for a task just typed in
 * on this device, which needs no notification straight away (user, 2026-11-05).
 */
export async function markReminderHandled(db: Db, taskId: string, now = new Date()): Promise<void> {
  const task = await get(db, "SELECT id, due, time FROM task WHERE id = ? AND deleted = 0 AND due IS NOT NULL", [taskId]);
  if (!task) return;
  const at = reminderAt(task, await readSnoozes(db));
  if (at.getTime() > now.getTime()) return;
  const handled = await readHandled(db);
  if ((handled[taskId] ?? "") >= at.toISOString()) return;
  await setMeta(db, HANDLED_KEY, JSON.stringify({ ...handled, [taskId]: at.toISOString() }));
}

async function readHandled(db: Db): Promise<Record<string, string>> {
  return JSON.parse((await getMeta(db, HANDLED_KEY)) ?? "{}");
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
