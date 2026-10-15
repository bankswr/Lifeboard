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

export async function call<Name extends ApiName>(name: Name, ...args: ApiArgs<Name>): Promise<ApiResult<Name>> {
  if (phoneDb) {
    const fn = api[name] as (db: Db, ...args: unknown[]) => Promise<ApiResult<Name>>;
    return fn(phoneDb, ...args);
  }
  const response = await fetch(`./api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });
  if (!response.ok) throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
  return response.json();
}
