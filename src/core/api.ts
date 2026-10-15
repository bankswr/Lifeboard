// Every operation the UI can ask for. Each takes the database first, then plain JSON-safe
// arguments, and returns JSON-safe data. On the phone the UI calls these directly; on the
// desktop it calls them through the server (POST /api/<name>), which runs the same code.
import { SCHEMA_VERSION } from "./db/schema.ts";
import { get, type Db } from "./db/types.ts";

export interface AppInfo {
  deviceId: string;
  schemaVersion: number;
}

async function getAppInfo(db: Db): Promise<AppInfo> {
  const row = await get(db, "SELECT value FROM meta WHERE key = 'device_id'");
  return { deviceId: row!.value, schemaVersion: SCHEMA_VERSION };
}

export const api = {
  getAppInfo,
};

export type Api = typeof api;
export type ApiName = keyof Api;
/** The arguments of an API function, without the leading db. */
export type ApiArgs<Name extends ApiName> = Api[Name] extends (db: Db, ...args: infer Args) => unknown ? Args : never;
export type ApiResult<Name extends ApiName> = Awaited<ReturnType<Api[Name]>>;
