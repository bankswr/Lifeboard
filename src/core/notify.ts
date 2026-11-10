// How a new alert reaches the user differs per device (a desktop pop-up, an Android
// notification), so each platform sets the function at start. Until it does, alerts are
// only listed in the app. Withdrawing works the same way: when an alert clears itself, the
// platform removes its notification if it can (the phone can; desktop pop-ups just expire).
import type { NewAlert } from "./rules.ts";

type Deliver = (alerts: NewAlert[]) => Promise<void>;
type Withdraw = (alertIds: number[]) => Promise<void>;

let deliver: Deliver = async () => {};
let withdraw: Withdraw = async () => {};

export function setAlertDelivery(fn: Deliver, withdrawFn?: Withdraw): void {
  deliver = fn;
  if (withdrawFn) withdraw = withdrawFn;
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

/** Removes the notifications of alerts that cleared themselves. */
export async function withdrawAlerts(alertIds: number[]): Promise<void> {
  if (alertIds.length === 0) return;
  try {
    await withdraw(alertIds);
  } catch (error) {
    console.warn("Couldn't remove notification:", error);
  }
}
