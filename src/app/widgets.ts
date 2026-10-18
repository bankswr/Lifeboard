// Android home-screen widgets (docs/PLAN.md phase 8), the app's side: hands the snapshot
// built in core/widgets.ts to the widgets through capacitor-widget-bridge (shared
// preferences + a redraw request), applies what the widgets queued while the app was closed
// (list ticks, items added on the Lists widget, task ticks on the Calendar widget), and
// opens the page a widget tap asks for. The widgets themselves are native
// (android/app/src/main/java/org/lifeboard/app/widgets/) and only draw the snapshot.
import { App } from "@capacitor/app";
import { WidgetBridgePlugin } from "capacitor-widget-bridge";
import { call } from "./backend.ts";
import { refresh } from "./ui/app.ts";

/** Shared with the native widgets (WidgetStore.java): preferences file and keys. */
const GROUP = "lifeboard_widgets";
const SNAPSHOT_KEY = "snapshot";
/** Lists widget ticks: { itemId: done }. */
const TICKS_KEY = "ticks";
/** Items added on the Lists widget: [{ listId, text }]. */
const ADDS_KEY = "adds";
/** Calendar widget task ticks: { taskId: done }. */
const TASK_TICKS_KEY = "taskTicks";
const PROVIDERS = ["Health", "Calendar", "Alerts", "Pets", "Lists"].map((name) => `org.lifeboard.app.widgets.${name}Widget`);
/** Edits come in bursts (e.g. ticking several items); one refresh after they settle is enough. */
const REFRESH_DELAY_MS = 1000;

/** Call once at start: registers the widget classes and the tap-to-open handling. */
export async function setUpWidgets(): Promise<void> {
  await WidgetBridgePlugin.setRegisteredWidgets({ widgets: PROVIDERS });
  const launch = await App.getLaunchUrl();
  if (launch?.url) openLink(launch.url);
  await App.addListener("appUrlOpen", ({ url }) => openLink(url));
  // Back from the background: the widgets may have queued changes meanwhile.
  await App.addListener("resume", () => void applyWidgetQueues().then(refresh).then(refreshWidgets));
}

/** "lifeboard://open/health" → #/health. */
function openLink(url: string) {
  const match = /^lifeboard:\/\/open\/(.*)$/.exec(url);
  if (match) location.hash = `#/${match[1]}`;
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Rebuilds the snapshot and redraws the widgets, shortly after the last change. */
export function refreshWidgetsSoon(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void refreshWidgets(), REFRESH_DELAY_MS);
}

export async function refreshWidgets(): Promise<void> {
  try {
    const snapshot = await call("getWidgetSnapshot");
    await WidgetBridgePlugin.setItem({ group: GROUP, key: SNAPSHOT_KEY, value: JSON.stringify(snapshot) });
    await WidgetBridgePlugin.reloadAllTimelines();
  } catch (error) {
    console.warn("Widgets not updated:", error);
  }
}

/**
 * Applies what the widgets queued, through the normal core calls, so each change syncs (and,
 * for tasks, goes to Google and reschedules reminders: see main.ts) as if made in the app.
 * Items or tasks deleted meanwhile are skipped.
 */
export async function applyWidgetQueues(): Promise<void> {
  const ticks = await takeQueued<Record<string, boolean>>(TICKS_KEY);
  for (const [itemId, done] of Object.entries(ticks ?? {})) {
    await call("setTodoItemDone", itemId, done).catch((error) => console.warn("Widget tick skipped:", error));
  }
  const adds = await takeQueued<{ listId: string; text: string }[]>(ADDS_KEY);
  for (const { listId, text } of adds ?? []) {
    await call("addTodoItem", listId, text).catch((error) => console.warn("Widget item not added:", error));
  }
  const taskTicks = await takeQueued<Record<string, boolean>>(TASK_TICKS_KEY);
  for (const [taskId, done] of Object.entries(taskTicks ?? {})) {
    await call("setTaskDone", taskId, done).catch((error) => console.warn("Widget task tick skipped:", error));
  }
}

/**
 * Reads and removes one widget queue. Removed before it is applied, so anything queued while
 * it is applied stays for next time (a change made in the moment between reading and
 * removing would be lost; see the agent note).
 */
async function takeQueued<T>(key: string): Promise<T | null> {
  try {
    const stored = (await WidgetBridgePlugin.getItem({ group: GROUP, key })).results;
    if (!stored) return null;
    await WidgetBridgePlugin.removeItem({ group: GROUP, key });
    return JSON.parse(stored) as T;
  } catch (error) {
    console.warn(`Widget queue "${key}" not applied:`, error);
    return null;
  }
}
