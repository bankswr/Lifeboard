// Keeping the Schedule in step with Google, on the device signed in to Google (the
// desktop): first send the queued changes (schedule/edit.ts) in order, then re-read
// calendars, events and tasks and replace the local rows with Google's versions.
//
// Google wins conflicts (docs/PLAN.md): before changing or deleting something, its current
// etag is compared with the one the edit was based on. If Google's copy changed in between,
// the edit is dropped and an alert says so; the re-read then shows Google's version.
// A failed request stops the run; what's left in the queue is retried next time.
import { getCredential } from "../credentials.ts";
import { addDays, localDate } from "../dates.ts";
import { get, type Db, type Row } from "../db/types.ts";
import type { GoogleCredential } from "../google/integration.ts";
import { accessToken, SCHEDULE_SCOPES } from "../google/oauth.ts";
import { deliverAlerts } from "../notify.ts";
import { recordAlert, type NewAlert } from "../rules.ts";
import { deleteRecord, saveRecord } from "../sync/records.ts";
import { eventTimes, recurrenceLines, type EventInput, type ScheduleOp } from "./edit.ts";
import { GoogleGoneError, googleScheduleApi, type GoogleEvent, type ScheduleGoogle } from "./googleApi.ts";
import { endRecurrenceBefore } from "./repeat.ts";
import { eventRow, taskRow } from "./store.ts";

/** How much of the calendar is kept locally, in days around today. */
const DAYS_BACK = 365;
const DAYS_AHEAD = 730;

let running: Promise<unknown> = Promise.resolve();

/**
 * Sends queued changes to Google and re-reads it. Does nothing on a device not signed in to
 * Google (the phone): its queue reaches the desktop through LAN sync. One run at a time.
 */
export function syncSchedule(db: Db, google?: ScheduleGoogle): Promise<NewAlert[]> {
  const run = running.then(async () => {
    const api = google ?? (await signedInGoogle(db));
    if (!api) return [];
    const alerts = await pushChanges(db, api);
    // Re-read only with an empty queue, so Google's rows never hide an edit still waiting.
    if (!(await hasQueuedChanges(db))) await refreshFromGoogle(db, api);
    await deliverAlerts(alerts);
    return alerts;
  });
  running = run.catch(() => {});
  return run;
}

/** Like syncSchedule, but only logs failures: for runs nobody is waiting on. */
export async function syncScheduleQuietly(db: Db): Promise<void> {
  try {
    await syncSchedule(db);
  } catch (error) {
    console.warn("Schedule sync with Google failed:", error);
  }
}

async function signedInGoogle(db: Db): Promise<ScheduleGoogle | null> {
  const credential = await getCredential<GoogleCredential>(db, "google");
  if (!credential) return null;
  return googleScheduleApi(await accessToken(credential, credential.refreshToken, SCHEDULE_SCOPES));
}

export async function hasQueuedChanges(db: Db): Promise<boolean> {
  return Boolean(await get(db, "SELECT 1 FROM schedule_change WHERE deleted = 0 LIMIT 1"));
}

// ---------- sending changes ----------

/** A queued edit was dropped because Google's copy had changed. */
class ConflictError extends Error {}

export async function pushChanges(db: Db, google: ScheduleGoogle): Promise<NewAlert[]> {
  const alerts: NewAlert[] = [];
  // Etags Google gave our own changes during this run, so a second queued edit to the same
  // item (made before the first was sent) isn't mistaken for a conflict.
  const ours = new Set<string>();
  const queued = await db.all("SELECT id, op FROM schedule_change WHERE deleted = 0 ORDER BY created_at, id");
  for (const change of queued) {
    const op = JSON.parse(change.op) as ScheduleOp;
    try {
      await applyChange(db, google, op, ours);
    } catch (error) {
      if (error instanceof ConflictError) alerts.push(await recordAlert(db, "Schedule", error.message));
      else if (!(error instanceof GoogleGoneError)) throw error; // already gone in Google: nothing left to do
    }
    await deleteRecord(db, "schedule_change", change.id);
  }
  return alerts;
}

async function applyChange(db: Db, google: ScheduleGoogle, op: ScheduleOp, ours: Set<string>): Promise<void> {
  const checkEvent = async (calendarId: string, eventId: string, baseEtag: string | null, title: string) => {
    const current = await google.getEvent(calendarId, eventId);
    if (baseEtag && current.etag !== baseEtag && !ours.has(current.etag)) throw conflict(title);
    return current;
  };
  const mine = <T extends { etag?: string }>(result: T) => {
    if (result.etag) ours.add(result.etag);
    return result;
  };

  switch (op.type) {
    case "event.create": {
      const row = await anyRow(db, "calendar_event", op.rowId);
      if (!row || row.deleted) return; // deleted before it was sent
      const created = mine(await google.insertEvent(op.calendarId, newEvent(op.input)));
      // A new series' occurrences arrive with the re-read; a single event keeps its row.
      if (op.input.repeat) await deleteRecord(db, "calendar_event", row.id);
      else await saveRecord(db, "calendar_event", { ...row, ...eventRow(op.calendarId, created) });
      return;
    }
    case "event.patch": {
      const row = await anyRow(db, "calendar_event", op.rowId);
      if (!row?.google_id || row.deleted) return;
      await checkEvent(op.calendarId, row.google_id, op.baseEtag, op.input.title);
      const changes: GoogleEvent = eventBody(op.input, true);
      if (op.withRepeat) changes.recurrence = recurrenceLines(op.input);
      mine(await google.patchEvent(op.calendarId, row.google_id, changes));
      return;
    }
    case "event.series": {
      const series = await checkEvent(op.calendarId, op.seriesId, op.baseEtag, op.input.title);
      if (op.mode === "all" || isFirstOccurrence(series, op.originalStart)) {
        mine(await google.patchEvent(op.calendarId, op.seriesId, wholeSeriesChanges(series, op.originalStart, op.input)));
      } else {
        // This and following: end the old series just before this occurrence, start a new one here.
        mine(await google.patchEvent(op.calendarId, op.seriesId, { recurrence: endRecurrenceBefore(series.recurrence, op.originalStart, isAllDay(series)) }));
        mine(await google.insertEvent(op.calendarId, newEvent(op.input)));
      }
      return;
    }
    case "event.delete": {
      const row = await anyRow(db, "calendar_event", op.rowId);
      if (!row?.google_id) return; // never reached Google
      await checkEvent(op.calendarId, row.google_id, op.baseEtag, row.title);
      await google.deleteEvent(op.calendarId, row.google_id);
      return;
    }
    case "event.seriesDelete": {
      const series = await checkEvent(op.calendarId, op.seriesId, op.baseEtag, "A repeating event");
      if (op.mode === "all" || isFirstOccurrence(series, op.originalStart)) await google.deleteEvent(op.calendarId, op.seriesId);
      else mine(await google.patchEvent(op.calendarId, op.seriesId, { recurrence: endRecurrenceBefore(series.recurrence, op.originalStart, isAllDay(series)) }));
      return;
    }
    case "task.create": {
      const row = await anyRow(db, "task", op.rowId);
      // Already in Google: both devices made the same task (e.g. an automatic one).
      if (!row || row.deleted || row.google_id) return;
      const created = mine(await google.insertTask(op.listId, taskBody(row)));
      await saveRecord(db, "task", { ...row, google_id: created.id, etag: created.etag ?? null });
      return;
    }
    case "task.patch": {
      const row = await anyRow(db, "task", op.rowId);
      if (!row?.google_id || row.deleted) return;
      const current = await google.getTask(op.listId, row.google_id);
      if (op.baseEtag && current.etag !== op.baseEtag && !ours.has(current.etag)) throw conflict(row.title);
      const updated = mine(await google.patchTask(op.listId, row.google_id, taskBody(row)));
      await saveRecord(db, "task", { ...row, etag: updated.etag ?? null });
      return;
    }
    case "task.delete": {
      const row = await anyRow(db, "task", op.rowId);
      if (!row?.google_id) return;
      const current = await google.getTask(op.listId, row.google_id);
      if (op.baseEtag && current.etag !== op.baseEtag && !ours.has(current.etag)) throw conflict(row.title);
      await google.deleteTask(op.listId, row.google_id);
      return;
    }
  }
}

function conflict(title: string): ConflictError {
  return new ConflictError(`"${title}" was changed in Google before your edit reached it, so Google's version was kept.`);
}

/** A row by id, including a deleted one (its Google id is still needed to delete it there). */
async function anyRow(db: Db, table: "calendar_event" | "task", id: string): Promise<Row | undefined> {
  return get(db, `SELECT * FROM ${table} WHERE id = ?`, [id]);
}

/**
 * Google's fields for the input, times in this device's time zone. For a patch, the unused
 * one of date/dateTime is sent as null so switching between all-day and timed clears it.
 */
function eventBody(input: EventInput, forPatch = false): GoogleEvent {
  const body: GoogleEvent = { summary: input.title, location: input.location, description: input.notes };
  const { start, end } = eventTimes(input);
  const clear = forPatch ? null : undefined;
  if (input.allDay) {
    body.start = { date: start, dateTime: clear, timeZone: clear };
    body.end = { date: end, dateTime: clear, timeZone: clear };
  } else {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    body.start = { dateTime: start, timeZone, date: clear };
    body.end = { dateTime: end, timeZone, date: clear };
  }
  return body;
}

/** A new event for Google; repeat lines only when it repeats. */
function newEvent(input: EventInput): GoogleEvent {
  const lines = recurrenceLines(input);
  return lines.length > 0 ? { ...eventBody(input), recurrence: lines } : eventBody(input);
}

function isAllDay(event: GoogleEvent): boolean {
  return Boolean(event.start?.date);
}

/** The stored form of a Google start: a date, or a UTC ISO time. */
function startOf(event: GoogleEvent): string {
  return event.start.date ?? new Date(event.start.dateTime).toISOString();
}

function isFirstOccurrence(series: GoogleEvent, originalStart: string): boolean {
  return startOf(series) === originalStart;
}

/**
 * Changes for "all events": the form's fields, with the date moved by as many days as the
 * user moved this occurrence (so changing one Tuesday to Wednesday moves the whole series a
 * day), and the form's repeat. EXDATE and other non-RRULE lines are kept.
 */
function wholeSeriesChanges(series: GoogleEvent, originalStart: string, input: EventInput): GoogleEvent {
  const dateOf = (start: string) => (start.length === 10 ? start : localDate(new Date(start)));
  const shift = daysBetween(dateOf(originalStart), input.date);
  const body = eventBody({ ...input, date: addDays(dateOf(startOf(series)), shift) }, true);
  const otherLines = (series.recurrence as string[]).filter((line) => !line.startsWith("RRULE:"));
  body.recurrence = input.repeat ? [...recurrenceLines(input), ...otherLines] : [];
  return body;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function taskBody(row: Row) {
  return {
    title: row.title,
    notes: row.notes,
    due: row.due ? `${row.due}T00:00:00.000Z` : null,
    status: row.done ? "completed" : "needsAction",
    completed: row.done ? (row.completed_at ?? undefined) : null,
  };
}

// ---------- reading Google ----------

export async function refreshFromGoogle(db: Db, google: ScheduleGoogle, today = localDate()): Promise<void> {
  const windowStart = addDays(today, -DAYS_BACK);
  const timeMin = `${windowStart}T00:00:00Z`;
  const timeMax = `${addDays(today, DAYS_AHEAD)}T00:00:00Z`;

  const calendars = await google.calendars();
  await db.transaction(async () => {
    const stored = new Map((await db.all("SELECT * FROM calendar WHERE deleted = 0")).map((row) => [row.id, row]));
    for (const calendar of calendars) {
      const existing = stored.get(calendar.id);
      stored.delete(calendar.id);
      // Only the main calendar is shown at first; Settings → Calendars adds others.
      const row = { name: calendar.name, is_primary: calendar.primary ? 1 : 0, included: existing ? existing.included : calendar.primary ? 1 : 0 };
      if (!existing || !sameFields(existing, row)) await saveRecord(db, "calendar", { id: calendar.id, ...row });
    }
    for (const gone of stored.keys()) await deleteRecord(db, "calendar", gone);
  });

  const included = await db.all("SELECT id FROM calendar WHERE deleted = 0 AND included = 1");
  for (const { id } of included) {
    const instances = (await google.eventInstances(id, timeMin, timeMax)).filter((event) => event.status !== "cancelled");
    const series = await google.eventSeries(id, timeMin, timeMax);
    await db.transaction(async () => {
      await replaceEvents(db, id, instances.map((event) => eventRow(id, event)), false, windowStart);
      await replaceEvents(db, id, series.map((event) => eventRow(id, event, true)), true, windowStart);
    });
  }
  // Events of calendars no longer shown.
  await db.transaction(async () => {
    const hidden = await db.all(
      "SELECT id FROM calendar_event WHERE deleted = 0 AND calendar_id NOT IN (SELECT id FROM calendar WHERE deleted = 0 AND included = 1)",
    );
    for (const { id } of hidden) await deleteRecord(db, "calendar_event", id);
  });

  const lists = await google.taskLists();
  for (const list of lists) {
    const tasks = (await google.tasks(list.id)).filter((task) => !task.deleted);
    await db.transaction(async () => replaceTasks(db, list.id, tasks.map((task) => taskRow(list.id, task))));
  }
  await db.transaction(async () => {
    const stored = new Map((await db.all("SELECT * FROM task_list WHERE deleted = 0")).map((row) => [row.id, row]));
    for (const [position, list] of lists.entries()) {
      const existing = stored.get(list.id);
      stored.delete(list.id);
      const row = { title: list.title, position };
      if (!existing || !sameFields(existing, row)) await saveRecord(db, "task_list", { id: list.id, ...row });
    }
    for (const gone of stored.keys()) {
      await deleteRecord(db, "task_list", gone);
      for (const { id } of await db.all("SELECT id FROM task WHERE list_id = ? AND deleted = 0", [gone])) await deleteRecord(db, "task", id);
    }
  });
}

/**
 * Saves the fetched events of one kind (occurrences or series) for a calendar, skipping
 * unchanged ones, and deletes stored ones Google no longer has. Occurrences are only
 * compared within the fetched window.
 */
async function replaceEvents(db: Db, calendarId: string, rows: Row[], series: boolean, windowStart: string) {
  const stored = await db.all(
    `SELECT * FROM calendar_event WHERE calendar_id = ? AND is_series = ? AND deleted = 0 AND google_id IS NOT NULL
       AND (is_series = 1 OR start_at >= ?)`,
    [calendarId, series ? 1 : 0, windowStart],
  );
  const byGoogleId = new Map(stored.map((row) => [row.google_id, row]));
  for (const row of rows) {
    const existing = byGoogleId.get(row.google_id);
    byGoogleId.delete(row.google_id);
    if (existing && sameFields(existing, row)) continue;
    await saveRecord(db, "calendar_event", { id: existing?.id ?? `${series ? "evs" : "ev"}:${calendarId}:${row.google_id}`, ...row });
  }
  for (const gone of byGoogleId.values()) await deleteRecord(db, "calendar_event", gone.id);
}

/** Like replaceEvents for one task list. Keeps the Lifeboard-only time and repeat of each task. */
async function replaceTasks(db: Db, listId: string, rows: Row[]) {
  const stored = await db.all("SELECT * FROM task WHERE list_id = ? AND deleted = 0 AND google_id IS NOT NULL", [listId]);
  const byGoogleId = new Map(stored.map((row) => [row.google_id, row]));
  for (const row of rows) {
    const existing = byGoogleId.get(row.google_id);
    byGoogleId.delete(row.google_id);
    if (existing && sameFields(existing, row)) continue;
    await saveRecord(db, "task", {
      id: existing?.id ?? `task:${row.google_id}`,
      ...row,
      time: existing?.time ?? null,
      repeat: existing?.repeat ?? null,
    });
  }
  for (const gone of byGoogleId.values()) await deleteRecord(db, "task", gone.id);
}

function sameFields(existing: Row, row: Row): boolean {
  return Object.entries(row).every(([key, value]) => existing[key] === value);
}
