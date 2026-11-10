// Android notifications for new alerts (the desktop shows its own; see src/desktop/notify.ts).
import { LocalNotifications } from "@capacitor/local-notifications";
import type { NewAlert } from "../core/rules.ts";

/** Marks alert notifications apart from reminders, which share the notification shade. */
const KIND = "alert";

let nextId = Date.now() % 1_000_000;

export async function showPhoneNotifications(alerts: NewAlert[]): Promise<void> {
  // Android 13+ asks the user once; afterwards this returns the saved answer.
  const { display } = await LocalNotifications.requestPermissions();
  if (display !== "granted") return;
  await LocalNotifications.schedule({
    notifications: alerts.map((alert) => ({ id: nextId++, title: "Lifeboard", body: alert.message, extra: { kind: KIND, alertId: alert.id } })),
  });
}

/** Takes cleared alerts out of the notification shade. */
export async function removePhoneNotifications(alertIds: number[]): Promise<void> {
  const delivered = await LocalNotifications.getDeliveredNotifications();
  const cleared = delivered.notifications.filter((n) => n.extra?.kind === KIND && alertIds.includes(Number(n.extra.alertId)));
  if (cleared.length > 0) await LocalNotifications.removeDeliveredNotifications({ notifications: cleared });
}
