// App start: connect to the data (on-device database or desktop server) and show the app.
// On the phone, also sync with the desktop if it's reachable and update if one is due.
import "./style.css";
import { setCookieSessionFactory } from "../core/http.ts";
import { setAlertDelivery } from "../core/notify.ts";
import { isUpdateDue } from "../core/updates.ts";
import type { ApiName } from "../core/api.ts";
import { call, initBackend, platform, setAfterPhoneCall } from "./backend.ts";
import { nativeCookieSession } from "./nativeCookies.ts";
import { showPhoneNotifications } from "./notify.ts";
import { rescheduleReminders, setUpReminders } from "./reminders.ts";
import { syncQuietly } from "./sync.ts";
import { refresh, start } from "./ui/app.ts";
import "./ui/views/calendars.ts";
import "./ui/views/connections.ts";
import "./ui/views/feeders.ts";
import "./ui/views/fountain.ts";
import "./ui/views/health.ts";
import "./ui/views/healthSettings.ts";
import "./ui/views/lists.ts";
import "./ui/views/maintenance.ts";
import "./ui/views/litter.ts";
import "./ui/views/monitor.ts";
import "./ui/views/pets.ts";
import "./ui/views/schedule.ts";
import "./ui/views/scheduleForm.ts";
import "./ui/views/rules.ts";
import "./ui/views/settings.ts";

/** Phone calls after which task reminders are rescheduled (sync does it too, in sync.ts). */
const CHANGES_TASKS = new Set<ApiName>(["updateNow", "repullHealth", "saveTask", "setTaskDone", "deleteTask"]);

async function main() {
  await initBackend();
  // To-do items ticked last time are cleared each time the app loads (user, 2026-10-16).
  await call("clearCheckedItems");
  start();
  if (platform === "android") {
    setAlertDelivery(showPhoneNotifications);
    setCookieSessionFactory(nativeCookieSession);
    await setUpReminders();
    setAfterPhoneCall((name) => {
      if (CHANGES_TASKS.has(name)) void rescheduleReminders();
    });
    await syncQuietly();
    const { lastUpdateAt } = await call("getStatus");
    if (isUpdateDue(lastUpdateAt)) await call("updateNow");
    await rescheduleReminders(); // opening the app always refreshes them
    await refresh();
  }
}

main().catch((error) => {
  console.error(error);
  document.getElementById("app")!.textContent = `Lifeboard couldn’t start: ${error?.message ?? error}`;
});
