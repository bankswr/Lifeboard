// Google Calendar API v3 and Google Tasks API v1: the calls the Schedule makes, with plain
// fetch so it could run on the phone too (as the Google Health client does). Events and
// tasks are passed through in Google's own JSON shapes; schedule/store.ts converts them.
import { SignedOutError } from "../integration.ts";

const CALENDAR = "https://www.googleapis.com/calendar/v3";
const TASKS = "https://tasks.googleapis.com/tasks/v1";

export type GoogleEvent = Record<string, any>;
export type GoogleTask = Record<string, any>;

/** Google answered 404/410: the item is already gone. */
export class GoogleGoneError extends Error {}

/** What the Schedule needs from Google; tests swap in a fake. */
export interface ScheduleGoogle {
  calendars(): Promise<{ id: string; name: string; primary: boolean }[]>;
  /** Single events and each occurrence of repeating ones, starting in [timeMin, timeMax). */
  eventInstances(calendarId: string, timeMin: string, timeMax: string): Promise<GoogleEvent[]>;
  /** The repeating series (with their recurrence lines) that have occurrences in the range. */
  eventSeries(calendarId: string, timeMin: string, timeMax: string): Promise<GoogleEvent[]>;
  getEvent(calendarId: string, eventId: string): Promise<GoogleEvent>;
  insertEvent(calendarId: string, event: GoogleEvent): Promise<GoogleEvent>;
  patchEvent(calendarId: string, eventId: string, changes: GoogleEvent): Promise<GoogleEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;

  taskLists(): Promise<{ id: string; title: string }[]>;
  tasks(listId: string): Promise<GoogleTask[]>;
  getTask(listId: string, taskId: string): Promise<GoogleTask>;
  insertTask(listId: string, task: GoogleTask): Promise<GoogleTask>;
  patchTask(listId: string, taskId: string, changes: GoogleTask): Promise<GoogleTask>;
  deleteTask(listId: string, taskId: string): Promise<void>;
}

export function googleScheduleApi(token: string): ScheduleGoogle {
  const request = (url: string, init: RequestInit = {}) => googleRequest(token, url, init);
  const calendarUrl = (calendarId: string, rest = "") => `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events${rest}`;
  const taskUrl = (listId: string, rest = "") => `${TASKS}/lists/${encodeURIComponent(listId)}/tasks${rest}`;
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    async calendars() {
      const items = await allPages(request, `${CALENDAR}/users/me/calendarList`, {});
      return items.map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary, primary: Boolean(c.primary) }));
    },
    eventInstances: (calendarId, timeMin, timeMax) =>
      allPages(request, calendarUrl(calendarId), { singleEvents: "true", timeMin, timeMax, maxResults: "2500" }),
    async eventSeries(calendarId, timeMin, timeMax) {
      const items = await allPages(request, calendarUrl(calendarId), { singleEvents: "false", timeMin, timeMax, maxResults: "2500" });
      return items.filter((event) => event.recurrence?.length > 0 && event.status !== "cancelled");
    },
    getEvent: (calendarId, eventId) => request(calendarUrl(calendarId, `/${encodeURIComponent(eventId)}`)),
    insertEvent: (calendarId, event) => request(calendarUrl(calendarId), json("POST", event)),
    patchEvent: (calendarId, eventId, changes) => request(calendarUrl(calendarId, `/${encodeURIComponent(eventId)}`), json("PATCH", changes)),
    async deleteEvent(calendarId, eventId) {
      await request(calendarUrl(calendarId, `/${encodeURIComponent(eventId)}`), { method: "DELETE" });
    },

    async taskLists() {
      const items = await allPages(request, `${TASKS}/users/@me/lists`, { maxResults: "100" });
      return items.map((list) => ({ id: list.id, title: list.title }));
    },
    tasks: (listId) => allPages(request, taskUrl(listId), { showCompleted: "true", showHidden: "true", maxResults: "100" }),
    getTask: (listId, taskId) => request(taskUrl(listId, `/${encodeURIComponent(taskId)}`)),
    insertTask: (listId, task) => request(taskUrl(listId), json("POST", task)),
    patchTask: (listId, taskId, changes) => request(taskUrl(listId, `/${encodeURIComponent(taskId)}`), json("PATCH", changes)),
    async deleteTask(listId, taskId) {
      await request(taskUrl(listId, `/${encodeURIComponent(taskId)}`), { method: "DELETE" });
    },
  };
}

async function allPages(
  request: (url: string) => Promise<any>,
  url: string,
  params: Record<string, string>,
): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams(params);
    if (pageToken) query.set("pageToken", pageToken);
    const page = await request(`${url}?${query}`);
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

async function googleRequest(token: string, url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (response.status === 204) return {};
  const text = await response.text();
  if (response.ok) return text ? JSON.parse(text) : {};
  if (response.status === 404 || response.status === 410) throw new GoogleGoneError(`Google: not found (${response.status})`);
  if (response.status === 403 && /SERVICE_DISABLED|accessNotConfigured/.test(text)) {
    const api = url.startsWith(TASKS) ? "Google Tasks API" : "Google Calendar API";
    throw new Error(`The ${api} is turned off in Lifeboard's Google Cloud project. Turn it on under APIs & Services → Library.`);
  }
  // A sign-in from before Calendar and Tasks were added lacks their permissions.
  if (response.status === 403 && /insufficient|scope/i.test(text)) {
    throw new SignedOutError("Google needs a new sign-in to allow Calendar and Tasks. Sign in again under Settings → Connections.");
  }
  throw new Error(`Google answered ${response.status}: ${text.slice(0, 200)}`);
}
