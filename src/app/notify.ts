// Android notifications for new alerts (the desktop shows its own; see src/desktop/notify.ts).
import { LocalNotifications } from "@capacitor/local-notifications";
import type { NewAlert } from "../core/rules.ts";

let nextId = Date.now() % 1_000_000;

export async function showPhoneNotifications(alerts: NewAlert[]): Promise<void> {
  // Android 13+ asks the user once; afterwards this returns the saved answer.
  const { display } = await LocalNotifications.requestPermissions();
  if (display !== "granted") return;
  await LocalNotifications.schedule({
    notifications: alerts.map((alert) => ({ id: nextId++, title: "Lifeboard", body: alert.message })),
  });
}
