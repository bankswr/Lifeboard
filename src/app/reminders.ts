// Task reminders on the phone (docs/PLAN.md phase 5): scheduled in advance as Android local
// notifications, so they arrive with the app closed. core/reminders.ts decides what's due;
// this file only talks to Android. Done and Snooze buttons open the app briefly (Android
// starts it to run the button), which marks the task done or snoozes it, then reschedules.
import { LocalNotifications, type ActionPerformed } from "@capacitor/local-notifications";
import type { Reminder } from "../core/reminders.ts";
import { call } from "./backend.ts";
import { refresh } from "./ui/app.ts";

const ACTION_TYPE = "task-reminder";
/** Marks Lifeboard's reminders among pending notifications, so rescheduling leaves alerts alone. */
const KIND = "task-reminder";

/** Registers the Done / Snooze buttons and their handler. Call once at start, before rescheduling. */
export async function setUpReminders(): Promise<void> {
  await LocalNotifications.registerActionTypes({
    types: [{ id: ACTION_TYPE, actions: [{ id: "done", title: "Done" }, { id: "snooze", title: "Snooze 10 min" }] }],
  });
  await LocalNotifications.addListener("localNotificationActionPerformed", (action) => void handleAction(action));
}

let rescheduling: Promise<void> = Promise.resolve();

/**
 * Replaces every pending reminder with the current list: tasks added, moved, done or
 * deleted (here or on the desktop, after a sync) are all picked up. Runs one at a time.
 */
export function rescheduleReminders(): Promise<void> {
  rescheduling = rescheduling.then(scheduleNow).catch((error) => console.warn("Reminders not scheduled:", error));
  return rescheduling;
}

async function scheduleNow(): Promise<void> {
  const reminders = await call("getReminders");
  const pending = await LocalNotifications.getPending();
  const stale = pending.notifications.filter((n) => n.extra?.kind === KIND);
  if (stale.length > 0) await LocalNotifications.cancel({ notifications: stale.map((n) => ({ id: n.id })) });
  // Reminders still in the notification shade aren't late.
  const delivered = await LocalNotifications.getDeliveredNotifications();
  const showing = delivered.notifications.filter((n) => n.extra?.kind === KIND).map((n) => String(n.extra.taskId));
  const late = await call("takeLateReminders", showing);
  if (reminders.length === 0 && late.length === 0) return;

  // Android 13+ asks once; afterwards this returns the saved answer.
  const { display } = await LocalNotifications.requestPermissions();
  if (display !== "granted") return;
  if (late.length > 0) {
    // Shown now (no schedule), with the same buttons and ids as the reminder itself.
    await LocalNotifications.schedule({
      notifications: late.map((reminder) => ({
        id: reminder.notificationId,
        title: reminder.title,
        body: lateBody(reminder),
        actionTypeId: ACTION_TYPE,
        extra: { kind: KIND, taskId: reminder.taskId },
      })),
    });
  }
  if (reminders.length === 0) return;
  // Exact timing needs "Alarms & reminders" access. Without it the plugin would open that
  // settings screen on every schedule, so ask only from Settings (exactAlarmsAllowed) and
  // otherwise accept Android's inexact timing (usually within minutes).
  const exact = await exactAlarmsAllowed();
  await LocalNotifications.schedule({
    notifications: reminders.map((reminder) => ({
      id: reminder.notificationId,
      title: reminder.title,
      body: reminder.snoozed ? "Task reminder (snoozed)" : "Task reminder",
      schedule: { at: new Date(reminder.at), allowWhileIdle: true },
      actionTypeId: ACTION_TYPE,
      extra: { kind: KIND, taskId: reminder.taskId },
      isExactNotification: exact,
    })),
  });
}

/** A late reminder's text: plain, with when it was due only where that adds something. */
function lateBody(reminder: Reminder): string {
  if (reminder.snoozed) return "Task reminder (snoozed)";
  const at = new Date(reminder.at);
  const day = at.toDateString() === new Date().toDateString() ? "" : at.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const time = reminder.timed ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  const due = [day, time].filter(Boolean).join(", ");
  return due ? `Task reminder, due ${due}` : "Task reminder";
}

async function handleAction(action: ActionPerformed): Promise<void> {
  const taskId: string | undefined = action.notification.extra?.taskId;
  if (action.notification.extra?.kind !== KIND || !taskId) return;
  if (action.actionId === "done") {
    await call("setTaskDone", taskId, true);
  } else if (action.actionId === "snooze") {
    await call("snoozeReminder", taskId);
  } else {
    // A tap on the notification itself; it has been seen, so it isn't late once it leaves the shade.
    await call("markReminderHandled", taskId);
    location.hash = "#/schedule";
  }
  await rescheduleReminders();
  await refresh();
}

/** Whether reminders can be on time to the minute ("Alarms & reminders" access). */
export async function exactAlarmsAllowed(): Promise<boolean> {
  return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === "granted";
}

/** Opens Android's "Alarms & reminders" setting for Lifeboard; reschedules on return. */
export async function allowExactAlarms(): Promise<void> {
  await LocalNotifications.changeExactNotificationSetting();
  await rescheduleReminders();
}
