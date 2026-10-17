// Task reminders on the phone (docs/PLAN.md phase 5): scheduled in advance as Android local
// notifications, so they arrive with the app closed. core/reminders.ts decides what's due;
// this file only talks to Android. Done and Snooze buttons open the app briefly (Android
// starts it to run the button), which marks the task done or snoozes it, then reschedules.
import { LocalNotifications, type ActionPerformed } from "@capacitor/local-notifications";
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
  if (reminders.length === 0) return;

  // Android 13+ asks once; afterwards this returns the saved answer.
  const { display } = await LocalNotifications.requestPermissions();
  if (display !== "granted") return;
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

async function handleAction(action: ActionPerformed): Promise<void> {
  const taskId: string | undefined = action.notification.extra?.taskId;
  if (action.notification.extra?.kind !== KIND || !taskId) return;
  if (action.actionId === "done") {
    await call("setTaskDone", taskId, true);
  } else if (action.actionId === "snooze") {
    await call("snoozeReminder", taskId);
  } else {
    location.hash = "#/schedule"; // a tap on the notification itself
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
