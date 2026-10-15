// How a new alert reaches the user differs per device (a desktop pop-up, an Android
// notification), so each platform sets the function at start. Until it does, alerts are
// only listed in the app.
import type { NewAlert } from "./rules.ts";

type Deliver = (alerts: NewAlert[]) => Promise<void>;

let deliver: Deliver = async () => {};

export function setAlertDelivery(fn: Deliver): void {
  deliver = fn;
}

export async function deliverAlerts(alerts: NewAlert[]): Promise<void> {
  if (alerts.length === 0) return;
  try {
    await deliver(alerts);
  } catch (error) {
    // A notification that can't be shown must never break the update; it's still listed in the app.
    console.warn("Couldn't show notification:", error);
  }
}
