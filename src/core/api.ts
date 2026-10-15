// Every operation the UI can ask for. Each takes the database first, then plain JSON-safe
// arguments, and returns JSON-safe data. On the phone the UI calls these directly; on the
// desktop it calls them through the server (POST /api/<name>), which runs the same code.
import { getDeviceId, getMeta, setMeta } from "./db/meta.ts";
import { SCHEMA_VERSION } from "./db/schema.ts";
import { get, type Db } from "./db/types.ts";
import { deliverAlerts } from "./notify.ts";
import { READING_TYPES } from "./readings.ts";
import * as rules from "./rules.ts";
import * as todos from "./todos.ts";
import { deleteCredential } from "./credentials.ts";
import { signInToCronometer } from "./cronometer/integration.ts";
import { dailyHealth, recentNutrition } from "./health.ts";
import { INTEGRATIONS } from "./integrations.ts";
import { lastUpdateAt, listConnections, runUpdate } from "./updates.ts";

export interface AppInfo {
  deviceId: string;
  schemaVersion: number;
}

async function getAppInfo(db: Db): Promise<AppInfo> {
  return { deviceId: await getDeviceId(db), schemaVersion: SCHEMA_VERSION };
}

/** Phone only: where the desktop is and the key it gave for syncing. */
export interface SyncSettings {
  desktopAddress: string;
  syncKey: string;
  lastSyncedAt: string | null;
}

async function getSyncSettings(db: Db): Promise<SyncSettings> {
  const peer = await get(db, "SELECT last_synced_at FROM sync_peer WHERE peer_id = ?", [await getMeta(db, "sync_peer_id")]);
  return {
    desktopAddress: (await getMeta(db, "desktop_address")) ?? "",
    syncKey: (await getMeta(db, "sync_key")) ?? "",
    lastSyncedAt: peer?.last_synced_at ?? null,
  };
}

async function saveSyncSettings(db: Db, desktopAddress: string, syncKey: string): Promise<void> {
  await setMeta(db, "desktop_address", desktopAddress.trim().replace(/\/+$/, ""));
  await setMeta(db, "sync_key", syncKey.trim());
}

/** Runs an update now and shows notifications for any new alerts. */
async function updateNow(db: Db) {
  const result = await runUpdate(db);
  await deliverAlerts(result.alerts);
  return result;
}

/** Everything the home screen shows about updates and alerts. */
async function getStatus(db: Db) {
  return {
    lastUpdateAt: await lastUpdateAt(db),
    connections: await listConnections(db),
    alerts: await rules.recentAlerts(db),
  };
}

/** Each integration and whether this device is signed in to it. */
async function listIntegrations(db: Db) {
  return Promise.all(
    INTEGRATIONS.map(async (i) => ({ id: i.id, name: i.name, signInMethod: i.signInMethod, signedIn: await i.isSetUp(db) })),
  );
}

/** Forgets this device's sign-in to an integration. Data already fetched is kept. */
async function signOut(db: Db, integrationId: string) {
  await deleteCredential(db, integrationId);
  await db.run("DELETE FROM connection WHERE id = ?", [integrationId]);
}

export const api = {
  getAppInfo,
  getSyncSettings,
  saveSyncSettings,
  listTodoLists: todos.listTodoLists,
  getTodoList: todos.getTodoList,
  createTodoList: todos.createTodoList,
  renameTodoList: todos.renameTodoList,
  deleteTodoList: todos.deleteTodoList,
  addTodoItem: todos.addTodoItem,
  setTodoItemDone: todos.setTodoItemDone,
  editTodoItem: todos.editTodoItem,
  deleteTodoItem: todos.deleteTodoItem,
  clearDoneTodoItems: todos.clearDoneTodoItems,
  updateNow,
  getStatus,
  getReadingTypes: async (_db: Db) => READING_TYPES,
  listRules: rules.listRules,
  getRule: rules.getRule,
  saveRule: rules.saveRule,
  deleteRule: rules.deleteRule,
  listIntegrations,
  signInToCronometer,
  signOut,
  recentNutrition,
  dailyHealth,
};

export type Api = typeof api;
export type ApiName = keyof Api;
/** The arguments of an API function, without the leading db. */
export type ApiArgs<Name extends ApiName> = Api[Name] extends (db: Db, ...args: infer Args) => unknown ? Args : never;
export type ApiResult<Name extends ApiName> = Awaited<ReturnType<Api[Name]>>;
