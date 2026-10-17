// Android home-screen widgets (docs/PLAN.md phase 8), the app's side: hands the snapshot
// built in core/widgets.ts to the widgets through capacitor-widget-bridge (shared
// preferences + a redraw request), applies list ticks the Lists widget queued while the app
// was closed, and opens the page a widget tap asks for. The widgets themselves are native
// (android/app/src/main/java/org/lifeboard/app/widgets/) and only draw the snapshot.
import { App } from "@capacitor/app";
import { WidgetBridgePlugin } from "capacitor-widget-bridge";
import { call } from "./backend.ts";
import { refresh } from "./ui/app.ts";

/** Shared with the native widgets (WidgetStore.java): preferences file and keys. */
const GROUP = "lifeboard_widgets";
const SNAPSHOT_KEY = "snapshot";
const TICKS_KEY = "ticks";
const PROVIDERS = ["Health", "Calendar", "Alerts", "Pets", "Lists"].map((name) => `org.lifeboard.app.widgets.${name}Widget`);
/** Edits come in bursts (e.g. ticking several items); one refresh after they settle is enough. */
const REFRESH_DELAY_MS = 1000;

/** Call once at start: registers the widget classes and the tap-to-open handling. */
export async function setUpWidgets(): Promise<void> {
  await WidgetBridgePlugin.setRegisteredWidgets({ widgets: PROVIDERS });
  const launch = await App.getLaunchUrl();
  if (launch?.url) openLink(launch.url);
  await App.addListener("appUrlOpen", ({ url }) => openLink(url));
  // Back from the background: ticks may have been queued on the widget meanwhile.
  await App.addListener("resume", () => void applyWidgetTicks().then(refresh).then(refreshWidgets));
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
 * Applies the ticks queued on the Lists widget ({ itemId: done }) through the normal core
 * path, so they sync like any other change. Items deleted meanwhile are skipped.
 */
export async function applyWidgetTicks(): Promise<void> {
  try {
    const stored = (await WidgetBridgePlugin.getItem({ group: GROUP, key: TICKS_KEY })).results;
    if (!stored) return;
    // Removed first: a tick made while these are applied stays queued for next time
    // (a tick in the moment between reading and removing would be lost; see the agent note).
    await WidgetBridgePlugin.removeItem({ group: GROUP, key: TICKS_KEY });
    const ticks = JSON.parse(stored) as Record<string, boolean>;
    for (const [itemId, done] of Object.entries(ticks)) {
      await call("setTodoItemDone", itemId, done).catch((error) => console.warn("Widget tick skipped:", error));
    }
  } catch (error) {
    console.warn("Widget ticks not applied:", error);
  }
}
