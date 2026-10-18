// The phone's side of LAN sync: sends the exchange to the desktop set in Settings.
// fetch goes through Capacitor's native HTTP on the phone (capacitor.config.ts), which
// allows plain http:// to a LAN address.
import { App } from "@capacitor/app";
import { syncWithDesktop, type SyncSummary } from "../core/sync/sync.ts";
import { call, onPhoneDb } from "./backend.ts";
import { rescheduleReminders } from "./reminders.ts";
import { refresh } from "./ui/app.ts";
import { refreshWidgetsSoon } from "./widgets.ts";

/** How often the phone syncs while the app is open (user, 2026-10-18). */
const PERIODIC_SYNC_MS = 30 * 60 * 1000;

/** Syncs with the desktop now. Throws with a readable message if it can't. */
export async function syncNow(): Promise<SyncSummary> {
  const { desktopAddress, syncKey } = await call("getSyncSettings");
  if (!desktopAddress || !syncKey) throw new Error("Set the desktop address and sync key first.");

  const summary = await onPhoneDb((db) => syncWithDesktop(db, async (request) => {
    let response: Response;
    try {
      response = await fetch(`${desktopAddress}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncKey}` },
        body: JSON.stringify(request),
      });
    } catch {
      throw new Error(`Can't reach the desktop at ${desktopAddress}. Is it on and on the same network?`);
    }
    if (response.status === 401) throw new Error("The desktop rejected the sync key.");
    if (!response.ok) throw new Error(`The desktop answered ${response.status}: ${await response.text()}`);
    return response.json();
  }));
  // Tasks may have arrived, moved or been ticked on the desktop.
  void rescheduleReminders();
  refreshWidgetsSoon();
  return summary;
}

/** Syncs if the desktop is set up, and reports nothing on failure (the desktop may just be off). */
export async function syncQuietly(): Promise<boolean> {
  const { desktopAddress, syncKey } = await call("getSyncSettings");
  if (!desktopAddress || !syncKey) return false;
  try {
    await syncNow();
    return true;
  } catch (error) {
    console.warn("Sync skipped:", error);
    return false;
  }
}

let lastSyncAt = 0;

/**
 * Call once, after the startup sync: syncs every half hour while the app is open. The
 * WebView's timers pause while the app is in the background, so coming back also syncs
 * once a half hour has passed. Skipped while the phone has no network; a desktop that
 * can't be reached is skipped quietly, as at startup.
 */
export async function startPeriodicSync(): Promise<void> {
  lastSyncAt = Date.now();
  setInterval(() => void syncIfDue(), PERIODIC_SYNC_MS);
  await App.addListener("resume", () => void syncIfDue());
}

async function syncIfDue(): Promise<void> {
  if (!navigator.onLine || Date.now() - lastSyncAt < PERIODIC_SYNC_MS) return;
  lastSyncAt = Date.now();
  if (await syncQuietly()) await refresh();
}
