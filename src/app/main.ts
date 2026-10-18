// App start: connect to the data (on-device database or desktop server) and show the app.
// On the phone, also sync with the desktop if it's reachable (then every half hour while
// open) and update if one is due.
import "./style.css";
import { setCookieSessionFactory } from "../core/http.ts";
import { setNativeGoogleAuthorizer } from "../core/google/token.ts";
import { setAlertDelivery } from "../core/notify.ts";
import { isUpdateDue } from "../core/updates.ts";
import type { ApiName } from "../core/api.ts";
import { call, initBackend, platform, setAfterPhoneCall } from "./backend.ts";
import { nativeGoogleAuthorizer } from "./googleAuth.ts";
import { nativeCookieSession } from "./nativeCookies.ts";
import { showPhoneNotifications } from "./notify.ts";
import { rescheduleReminders, setUpReminders } from "./reminders.ts";
import { startPeriodicSync, syncQuietly } from "./sync.ts";
import { applyWidgetQueues, refreshWidgets, refreshWidgetsSoon, setUpWidgets } from "./widgets.ts";
import { refresh, showBusy, start } from "./ui/app.ts";
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
/**
 * Phone Schedule edits. The phone sends them to Google itself only while away from the
 * desktop (core/google/token.ts); it does so through the phone's queue, after the edit.
 */
const SCHEDULE_EDITS = new Set<ApiName>(["saveEvent", "deleteEvent", "saveTask", "setTaskDone", "deleteTask", "setCalendarIncluded"]);
/** Calls that only read; any other call may change what a home-screen widget shows. */
const READS_ONLY = /^(get|list|analyze|recent|daily)/;

async function main() {
  await initBackend();
  // To-do items ticked last time are cleared each time the app loads (user, 2026-10-16).
  await call("clearCheckedItems");
  start();
  if (platform === "android") {
    setAlertDelivery(showPhoneNotifications);
    setCookieSessionFactory(nativeCookieSession);
    setNativeGoogleAuthorizer(nativeGoogleAuthorizer);
    await setUpReminders();
    await setUpWidgets();
    // Before the widget queues are applied, so a task ticked on the Calendar widget goes to
    // Google and reschedules reminders exactly like a tick in the app.
    setAfterPhoneCall((name) => {
      if (CHANGES_TASKS.has(name)) void rescheduleReminders();
      if (SCHEDULE_EDITS.has(name)) void call("refreshSchedule");
      if (!READS_ONLY.test(name)) refreshWidgetsSoon();
    });
    // After clearCheckedItems: list ticks made on the widget are applied now, shown crossed
    // out in the app, and cleared at the next load like ticks made in the app.
    await applyWidgetQueues();
    showBusy("Syncing with the desktop…");
    try {
      await syncQuietly();
      const { lastUpdateAt } = await call("getStatus");
      if (isUpdateDue(lastUpdateAt)) {
        showBusy("Updating devices and health…");
        await call("updateNow");
      }
    } finally {
      showBusy(null);
    }
    await rescheduleReminders(); // opening the app always refreshes them
    await refreshWidgets();
    await refresh();
    await startPeriodicSync();
  }
}

main().catch((error) => {
  console.error(error);
  document.getElementById("app")!.textContent = `Lifeboard couldn’t start: ${error?.message ?? error}`;
});
