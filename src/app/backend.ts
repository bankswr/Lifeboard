// How the UI reaches the core code (src/core/api.ts). On the phone it runs the core
// directly against the on-device database; in a desktop browser it asks the desktop server,
// which runs the same code against the desktop database. Screens only use `call`.
import { Capacitor } from "@capacitor/core";
import { api, type ApiArgs, type ApiName, type ApiResult } from "../core/api.ts";
import { migrate } from "../core/db/schema.ts";
import type { Db } from "../core/db/types.ts";
import { openCapacitorDb } from "./db/capacitor.ts";

export const platform: "android" | "desktop" = Capacitor.isNativePlatform() ? "android" : "desktop";

let phoneDb: Db | null = null;

/** Opens and migrates the on-device database on the phone. Nothing to do on the desktop. */
export async function initBackend(): Promise<void> {
  if (platform === "android") {
    phoneDb = await openCapacitorDb();
    await migrate(phoneDb);
  }
}

/** The on-device database. Phone only: the sync code works on it directly. */
export function phoneDatabase(): Db {
  if (!phoneDb) throw new Error("No on-device database: this isn't the phone app.");
  return phoneDb;
}

// On the phone, database calls really wait on the native side, so two operations could
// interleave; a write made during a sync would then join the sync's transaction and be lost
// if the sync rolled back. Every phone operation (API calls, sync) therefore runs one at a
// time through this queue. The desktop doesn't need it: its database calls are synchronous.
let queue: Promise<unknown> = Promise.resolve();

/** Runs `operation` on the phone after every earlier one has finished. */
export function onPhoneDb<T>(operation: (db: Db) => Promise<T>): Promise<T> {
  const db = phoneDatabase();
  const result = queue.then(() => operation(db));
  queue = result.catch(() => {}); // a failed operation must not block the ones after it
  return result;
}

let afterPhoneCall: (name: ApiName) => void = () => {};

/** Runs after each successful API call on the phone (e.g. to reschedule reminders). */
export function setAfterPhoneCall(handler: (name: ApiName) => void) {
  afterPhoneCall = handler;
}

export async function call<Name extends ApiName>(name: Name, ...args: ApiArgs<Name>): Promise<ApiResult<Name>> {
  if (phoneDb) {
    const fn = api[name] as (db: Db, ...args: unknown[]) => Promise<ApiResult<Name>>;
    const result = await onPhoneDb((db) => fn(db, ...args));
    afterPhoneCall(name);
    return result;
  }
  const response = await fetch(`./api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `${name} failed (${response.status})`);
  return body;
}
