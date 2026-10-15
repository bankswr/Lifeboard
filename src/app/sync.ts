// The phone's side of LAN sync: sends the exchange to the desktop set in Settings.
// fetch goes through Capacitor's native HTTP on the phone (capacitor.config.ts), which
// allows plain http:// to a LAN address.
import { syncWithDesktop, type SyncSummary } from "../core/sync/sync.ts";
import { call, onPhoneDb } from "./backend.ts";

/** Syncs with the desktop now. Throws with a readable message if it can't. */
export async function syncNow(): Promise<SyncSummary> {
  const { desktopAddress, syncKey } = await call("getSyncSettings");
  if (!desktopAddress || !syncKey) throw new Error("Set the desktop address and sync key first.");

  return onPhoneDb((db) => syncWithDesktop(db, async (request) => {
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
