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
import { deleteCredential, saveCredential } from "./credentials.ts";
import type { PhoneGoogleCredential } from "./google/token.ts";
import { listDeviceStatuses } from "./devices.ts";
import * as fountain from "./fountain.ts";
import * as maintenance from "./maintenance.ts";
import * as food from "./smartlife/food.ts";
import { catSummaries, getCatSettings, saveCatSettings } from "./whisker/cats.ts";
import { litterEstimates } from "./whisker/estimates.ts";
import * as hopper from "./whisker/hopper.ts";
import { getLitterSettings, saveLitterSettings } from "./whisker/levels.ts";
import { dailyHealth, recentNutrition } from "./health.ts";
import { clearVerdict, setVerdict } from "./healthReview.ts";
import { healthPage } from "./healthPage.ts";
import { resummarizeAll } from "./healthSummary.ts";
import { analyzeHealth, getHealthSettings, saveHealthSettings, targetHistory, type HealthSettings } from "./healthTargets.ts";
import { allowCronometerRepull } from "./cronometer/integration.ts";
import { allowGoogleHealthRepull } from "./google/integration.ts";
import { INTEGRATIONS } from "./integrations.ts";
import * as weather from "./weather.ts";
import { widgetSnapshot } from "./widgets.ts";
import { snoozeReminder, takeMissedReminders, upcomingReminders } from "./reminders.ts";
import { lastUpdateAt, listConnections, runUpdate } from "./updates.ts";
import * as scheduleEdit from "./schedule/edit.ts";
import { sendInBackground, syncSchedule } from "./schedule/push.ts";
import * as schedule from "./schedule/store.ts";
import { saveRecord } from "./sync/records.ts";

export interface AppInfo {
  deviceId: string;
  /** The schema this code expects. */
  schemaVersion: number;
  /** The schema this device's database is at; sync needs both devices on the same one. */
  databaseVersion: number;
}

async function getAppInfo(db: Db): Promise<AppInfo> {
  const [{ user_version }] = await db.all("PRAGMA user_version");
  return { deviceId: await getDeviceId(db), schemaVersion: SCHEMA_VERSION, databaseVersion: Number(user_version) };
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
  await setMeta(db, "desktop_address", normalizeDesktopAddress(desktopAddress));
  await setMeta(db, "sync_key", syncKey.trim());
}

/**
 * "192.168.86.249:5180" → "http://192.168.86.249:5180": without a scheme the phone can't make
 * a request at all, which looked like an unreachable desktop. Trailing slashes are dropped.
 */
export function normalizeDesktopAddress(address: string): string {
  const trimmed = address.trim().replace(/\/+$/, "");
  return trimmed && !/^https?:\/\//i.test(trimmed) ? `http://${trimmed}` : trimmed;
}

/** Runs an update now and shows notifications for any new alerts. */
async function updateNow(db: Db) {
  const result = await runUpdate(db);
  await deliverAlerts(result.alerts);
  return result;
}

/**
 * Saves the Health settings, then re-detects workouts on every day that still has raw data,
 * since the workout thresholds may have changed (core/healthSummary.ts).
 */
async function saveHealthSettingsAndResummarize(db: Db, settings: HealthSettings) {
  await saveHealthSettings(db, settings);
  await resummarizeAll(db);
}

/** Pulls health data again even if it was already pulled today, as part of a full update. */
async function repullHealth(db: Db) {
  await allowCronometerRepull(db);
  await allowGoogleHealthRepull(db);
  return updateNow(db);
}

/** Everything the Hub and Details screens show about updates, alerts and devices. */
async function getStatus(db: Db) {
  return {
    lastUpdateAt: await lastUpdateAt(db),
    connections: await listConnections(db),
    alerts: await rules.recentAlerts(db),
    devices: await listDeviceStatuses(db),
    litterSettings: await getLitterSettings(db),
    litterEstimates: await litterEstimates(db),
    hopperEstimates: await hopper.hopperEstimates(db),
    foodEstimates: await food.estimateAllFood(db),
    fountain: await fountain.estimateFountain(db),
  };
}

/** Each integration and whether this device is signed in to it. */
async function listIntegrations(db: Db) {
  return Promise.all(
    INTEGRATIONS.map(async (i) => ({ id: i.id, name: i.name, signInMethod: i.signInMethod, signedIn: await i.isSetUp(db) })),
  );
}

/** Password sign-in from the Connections screen; the integration checks it with the service first. */
async function signInWithPassword(db: Db, integrationId: string, email: string, password: string) {
  const integration = INTEGRATIONS.find((i) => i.id === integrationId);
  if (!integration?.signIn) throw new Error(`${integrationId} doesn't use a password sign-in.`);
  await integration.signIn(db, email, password);
}

/** QR sign-in from the Connections screen: returns the text to show as a QR code. */
async function startQrSignIn(db: Db, integrationId: string, userCode: string) {
  return qrIntegration(integrationId).startQrSignIn!(db, userCode);
}

/** True once the QR code has been scanned and the sign-in saved; the screen asks every few seconds. */
async function finishQrSignIn(db: Db, integrationId: string) {
  return qrIntegration(integrationId).finishQrSignIn!(db);
}

function qrIntegration(integrationId: string) {
  const integration = INTEGRATIONS.find((i) => i.id === integrationId);
  if (!integration?.startQrSignIn || !integration.finishQrSignIn) throw new Error(`${integrationId} doesn't use a QR sign-in.`);
  return integration;
}

/** Sets the weather location and fetches its forecast; a failed fetch is left to the next update to report. */
async function setWeatherLocation(db: Db, place: weather.WeatherPlace) {
  await weather.setWeatherLocation(db, place);
  try {
    await weather.saveForecast(db, await weather.fetchForecast(place));
  } catch (error) {
    console.warn("Weather forecast fetch failed:", error);
  }
}

/** Records the phone's backup Google sign-in, after the app got Android's authorization. */
async function savePhoneGoogleSignIn(db: Db) {
  await saveCredential<PhoneGoogleCredential>(db, "google", { android: true });
}

/** Forgets this device's sign-in to an integration. Data already fetched is kept. */
async function signOut(db: Db, integrationId: string) {
  const integration = INTEGRATIONS.find((i) => i.id === integrationId);
  if (integration?.signOut) await integration.signOut(db);
  else await deleteCredential(db, integrationId);
  await db.run("DELETE FROM connection WHERE id = ?", [integrationId]);
}

// ---------- Schedule ----------

/**
 * Re-reads Google (after sending any queued edits), for when the Schedule opens and, on the
 * phone, after each Schedule edit. Returns a problem to show, or null. On the phone it does
 * nothing unless the phone is away from the desktop and signed in (google/token.ts).
 */
async function refreshSchedule(db: Db): Promise<string | null> {
  try {
    await syncSchedule(db);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Runs a Schedule edit, then starts sending it to Google when this device can. The screen
 * doesn't wait for Google: the edit is already saved locally and shows at once.
 */
function thenSend<Args extends unknown[], R>(edit: (db: Db, ...args: Args) => Promise<R>) {
  return async (db: Db, ...args: Args): Promise<R> => {
    const result = await edit(db, ...args);
    void sendInBackground(db);
    return result;
  };
}

/** Shows or hides a calendar on the Schedule (Settings → Calendars). */
async function setCalendarIncluded(db: Db, calendarId: string, included: boolean) {
  const row = await get(db, "SELECT * FROM calendar WHERE id = ? AND deleted = 0", [calendarId]);
  if (!row) throw new Error("That calendar is no longer in your Google account.");
  if (row.is_primary) throw new Error("Your main calendar is always shown.");
  await saveRecord(db, "calendar", { ...row, included: included ? 1 : 0 });
  void sendInBackground(db);
}

export const api = {
  getAppInfo,
  getSyncSettings,
  saveSyncSettings,
  listTodoLists: todos.listTodoLists,
  getTodoList: todos.getTodoList,
  getAllTodoLists: todos.getAllTodoLists,
  copyTodoItems: todos.copyTodoItems,
  copyTodoList: todos.copyTodoList,
  clearCheckedItems: todos.clearCheckedItems,
  createTodoList: todos.createTodoList,
  renameTodoList: todos.renameTodoList,
  deleteTodoList: todos.deleteTodoList,
  addTodoItem: todos.addTodoItem,
  setTodoItemDone: todos.setTodoItemDone,
  editTodoItem: todos.editTodoItem,
  deleteTodoItem: todos.deleteTodoItem,
  clearDoneTodoItems: todos.clearDoneTodoItems,
  reorderTodoLists: todos.reorderTodoLists,
  reorderTodoItems: todos.reorderTodoItems,
  sortTodoListsByName: todos.sortTodoListsByName,
  sortTodoItemsByName: todos.sortTodoItemsByName,
  updateNow,
  repullHealth,
  getStatus,
  getReadingTypes: async (_db: Db) => READING_TYPES,
  getLitterSettings,
  getCats: (db: Db) => catSummaries(db),
  getCatSettings,
  saveCatSettings,
  saveLitterSettings,
  markLitterHopperRefilled: (db: Db, serial: string) => hopper.markHopperRefilled(db, serial),
  listLitterHopperRefills: hopper.listHopperRefills,
  deleteLitterHopperRefill: hopper.deleteHopperRefill,
  markFeederRefilled: (db: Db, feederId: string) => food.markRefilled(db, feederId),
  markAllFeedersRefilled: (db: Db) => food.markAllRefilled(db),
  getFeederSettings: food.getFeederSettings,
  saveFeederSettings: food.saveFeederSettings,
  listFeederRefills: food.listRefills,
  deleteFeederRefill: food.deleteRefill,
  getHopperCapacity: food.hopperCapacity,
  listMaintenance: (db: Db) => maintenance.listMaintenance(db),
  getMaintenance: maintenance.getMaintenance,
  saveMaintenance: thenSend((db: Db, input: maintenance.MaintenanceInput) => maintenance.saveMaintenance(db, input)),
  deleteMaintenance: maintenance.deleteMaintenance,
  findWeatherPlaces: (_db: Db, query: string) => weather.findWeatherPlaces(query),
  getWeatherLocation: weather.getWeatherLocation,
  setWeatherLocation,
  refillFountain: (db: Db) => fountain.refillFountain(db),
  getFountainSettings: fountain.getFountainSettings,
  saveFountainSettings: fountain.saveFountainSettings,
  listFountainRefills: fountain.listFountainRefills,
  deleteFountainRefill: fountain.deleteFountainRefill,
  dismissAlert: rules.dismissAlert,
  dismissAllAlerts: rules.dismissAllAlerts,
  listRules: rules.listRules,
  getRule: rules.getRule,
  saveRule: rules.saveRule,
  deleteRule: rules.deleteRule,
  listIntegrations,
  signInWithPassword,
  startQrSignIn,
  finishQrSignIn,
  signOut,
  savePhoneGoogleSignIn,
  recentNutrition,
  dailyHealth,
  analyzeHealth: (db: Db) => analyzeHealth(db),
  getHealthPage: (db: Db) => healthPage(db),
  getHealthSettings,
  saveHealthSettings: saveHealthSettingsAndResummarize,
  setHealthVerdict: setVerdict,
  clearHealthVerdict: clearVerdict,
  getTargetHistory: (db: Db) => targetHistory(db),
  getSchedule: schedule.getSchedule,
  getScheduleOptions: schedule.getScheduleOptions,
  getEvent: schedule.getEvent,
  getTask: schedule.getTask,
  listCalendars: schedule.listCalendars,
  setCalendarIncluded,
  refreshSchedule,
  saveEvent: thenSend(scheduleEdit.saveEvent),
  deleteEvent: thenSend(scheduleEdit.deleteEvent),
  saveTask: thenSend(scheduleEdit.saveTask),
  setTaskDone: thenSend(scheduleEdit.setTaskDone),
  deleteTask: thenSend(scheduleEdit.deleteTask),
  getReminders: (db: Db) => upcomingReminders(db),
  takeMissedReminders: (db: Db, showingTaskIds: string[]) => takeMissedReminders(db, showingTaskIds),
  getWidgetSnapshot: (db: Db) => widgetSnapshot(db),
  snoozeReminder: (db: Db, taskId: string) => snoozeReminder(db, taskId),
};

export type Api = typeof api;
export type ApiName = keyof Api;
/** The arguments of an API function, without the leading db. */
export type ApiArgs<Name extends ApiName> = Api[Name] extends (db: Db, ...args: infer Args) => unknown ? Args : never;
export type ApiResult<Name extends ApiName> = Awaited<ReturnType<Api[Name]>>;
