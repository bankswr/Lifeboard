// Creating, editing, completing and deleting events and tasks. Each edit changes the local
// rows at once (so the Schedule shows it) and queues the change for Google in the synced
// schedule_change table; schedule/push.ts sends the queue from the desktop (the phone's
// queue reaches the desktop through LAN sync). For a repeating event, only the occurrence
// on screen is updated locally; the rest of the series follows when Google is re-read.
import { addDays } from "../dates.ts";
import { get, utcNow, type Db } from "../db/types.ts";
import { deleteRecord, saveRecord } from "../sync/records.ts";
import { nextTaskDue, toRRule, type Repeat } from "./repeat.ts";
import { getEventRow, getSeriesRow, getTaskRow } from "./store.ts";

/** Which occurrences of a repeating event an edit or delete applies to. */
export type Scope = "this" | "following" | "all";

export interface EventInput {
  /** Leave out to create. */
  id?: string;
  /** For a new event; defaults to the main calendar. */
  calendarId?: string;
  title: string;
  location: string;
  notes: string;
  date: string;
  allDay: boolean;
  /** All-day events: how many days it covers (default 1). Editing keeps a multi-day event's length. */
  days?: number;
  /** "HH:MM", local time; ignored for all-day events. An end at or before the start means the next day. */
  startTime: string;
  endTime: string;
  repeat: Repeat | null;
}

export interface TaskInput {
  id?: string;
  /** For a new task; defaults to the first list. */
  listId?: string;
  title: string;
  notes: string;
  /** Null: no date (shows on today until done). */
  date: string | null;
  /** Lifeboard only. */
  time: string | null;
  repeat: Repeat | null;
}

/** A queued change for Google; see push.ts for what each does. */
export type ScheduleOp =
  | { type: "event.create"; rowId: string; calendarId: string; input: EventInput }
  | { type: "event.patch"; rowId: string; calendarId: string; input: EventInput; withRepeat: boolean; baseEtag: string | null }
  | { type: "event.series"; mode: "following" | "all"; calendarId: string; seriesId: string; originalStart: string; input: EventInput; baseEtag: string | null }
  | { type: "event.delete"; rowId: string; calendarId: string; baseEtag: string | null }
  | { type: "event.seriesDelete"; mode: "following" | "all"; calendarId: string; seriesId: string; originalStart: string; baseEtag: string | null }
  | { type: "task.create"; rowId: string; listId: string }
  | { type: "task.patch"; rowId: string; listId: string; baseEtag: string | null }
  | { type: "task.delete"; rowId: string; listId: string; baseEtag: string | null };

export async function queueChange(db: Db, op: ScheduleOp): Promise<void> {
  await saveRecord(db, "schedule_change", { created_at: utcNow(), op: JSON.stringify(op) });
}

// ---------- events ----------

/** Start and end in the stored form: dates for all-day events, UTC ISO times otherwise. */
export function eventTimes(input: Pick<EventInput, "date" | "allDay" | "startTime" | "endTime" | "days">): { start: string; end: string } {
  if (input.allDay) return { start: input.date, end: addDays(input.date, Math.max(1, input.days ?? 1)) };
  const [y, m, d] = input.date.split("-").map(Number);
  const at = (time: string, extraDays = 0) => {
    const [h, min] = time.split(":").map(Number);
    return new Date(y, m - 1, d + extraDays, h, min).toISOString();
  };
  return { start: at(input.startTime), end: at(input.endTime, input.endTime <= input.startTime ? 1 : 0) };
}

function checkEvent(input: EventInput) {
  if (!input.title.trim()) throw new Error("Give the event a name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Choose a date.");
  const isTime = (time: string) => /^\d{2}:\d{2}$/.test(time);
  if (!input.allDay && !(isTime(input.startTime) && isTime(input.endTime))) throw new Error("Choose start and end times.");
}

/** Creates an event, or saves an edit to one (for a repeating one, to `scope` of it). Returns the row id. */
export async function saveEvent(db: Db, input: EventInput, scope: Scope = "all"): Promise<string> {
  checkEvent(input);
  const clean = { ...input, title: input.title.trim() };
  const times = eventTimes(clean);
  const fields = { title: clean.title, location: clean.location.trim(), notes: clean.notes.trim(), all_day: clean.allDay ? 1 : 0, start_at: times.start, end_at: times.end };

  return db.transaction(async () => {
    if (!clean.id) {
      const calendarId = clean.calendarId ?? (await mainCalendarId(db));
      const rowId = await saveRecord(db, "calendar_event", {
        ...fields, calendar_id: calendarId, google_id: null, recurring_id: null, is_series: 0,
        time_zone: null, recurrence: null, original_start: null, etag: null,
      });
      await queueChange(db, { type: "event.create", rowId, calendarId, input: clean });
      return rowId;
    }
    const row = await getEventRow(db, clean.id);
    if (!row) throw new Error("This event no longer exists.");
    await saveRecord(db, "calendar_event", { ...row, ...fields });
    if (!row.recurring_id || scope === "this") {
      // A single event (which may gain a repeat), or one occurrence of a series.
      await queueChange(db, { type: "event.patch", rowId: row.id, calendarId: row.calendar_id, input: clean, withRepeat: !row.recurring_id, baseEtag: row.etag });
    } else {
      const series = await getSeriesRow(db, row.calendar_id, row.recurring_id);
      await queueChange(db, {
        type: "event.series", mode: scope, calendarId: row.calendar_id, seriesId: row.recurring_id,
        originalStart: row.original_start ?? row.start_at, input: clean, baseEtag: series?.etag ?? null,
      });
    }
    return row.id;
  });
}

export async function deleteEvent(db: Db, id: string, scope: Scope = "all"): Promise<void> {
  await db.transaction(async () => {
    const row = await getEventRow(db, id);
    if (!row) return;
    if (!row.recurring_id || scope === "this") {
      await deleteRecord(db, "calendar_event", row.id);
      await queueChange(db, { type: "event.delete", rowId: row.id, calendarId: row.calendar_id, baseEtag: row.etag });
      return;
    }
    const originalStart = row.original_start ?? row.start_at;
    const doomed = await db.all(
      `SELECT id FROM calendar_event WHERE calendar_id = ? AND deleted = 0 AND
         (recurring_id = ? AND (? = 'all' OR COALESCE(original_start, start_at) >= ?) OR (? = 'all' AND google_id = ? AND is_series = 1))`,
      [row.calendar_id, row.recurring_id, scope, originalStart, scope, row.recurring_id],
    );
    for (const { id: doomedId } of doomed) await deleteRecord(db, "calendar_event", doomedId);
    const series = await getSeriesRow(db, row.calendar_id, row.recurring_id);
    await queueChange(db, {
      type: "event.seriesDelete", mode: scope, calendarId: row.calendar_id, seriesId: row.recurring_id,
      originalStart, baseEtag: series?.etag ?? null,
    });
  });
}

async function mainCalendarId(db: Db): Promise<string> {
  const row = await get(db, "SELECT id FROM calendar WHERE is_primary = 1 AND deleted = 0");
  if (!row) throw new Error("Your Google calendar hasn't been read yet. Connect Google under Settings → Connections (or sync with the desktop) first.");
  return row.id;
}

/** The RRULE line for a new or changed series. */
export function recurrenceLines(input: EventInput): string[] {
  return input.repeat ? [toRRule(input.repeat, input.allDay)] : [];
}

// ---------- tasks ----------

function checkTask(input: TaskInput) {
  if (!input.title.trim()) throw new Error("Give the task a name.");
  if (input.repeat && !input.date) throw new Error("A repeating task needs a date.");
}

/** Creates or edits a task. Returns its row id. */
export async function saveTask(db: Db, input: TaskInput): Promise<string> {
  checkTask(input);
  const fields = {
    title: input.title.trim(), notes: input.notes.trim(), due: input.date || null, time: input.time || null,
    repeat: input.repeat ? JSON.stringify(input.repeat) : null,
  };
  return db.transaction(async () => {
    if (!input.id) {
      const listId = input.listId ?? (await firstTaskListId(db));
      const rowId = await saveRecord(db, "task", { ...fields, list_id: listId, google_id: null, done: 0, completed_at: null, etag: null });
      await queueChange(db, { type: "task.create", rowId, listId });
      return rowId;
    }
    const row = await getTaskRow(db, input.id);
    if (!row) throw new Error("This task no longer exists.");
    await saveRecord(db, "task", { ...row, ...fields });
    await queueChange(db, { type: "task.patch", rowId: row.id, listId: row.list_id, baseEtag: row.etag });
    return row.id;
  });
}

/**
 * Ticks a task done or not done. Ticking a repeating task makes its next occurrence, which
 * takes the repeat over (so ticking it again later can't make a second one).
 */
export async function setTaskDone(db: Db, id: string, done: boolean): Promise<void> {
  await db.transaction(async () => {
    const row = await getTaskRow(db, id);
    if (!row || (row.done === 1) === done) return;
    const repeat: Repeat | null = done && row.repeat ? JSON.parse(row.repeat) : null;
    const next = repeat && row.due ? nextTaskDue(repeat, row.due) : null;
    await saveRecord(db, "task", {
      ...row, done: done ? 1 : 0, completed_at: done ? utcNow() : null, repeat: repeat ? null : row.repeat,
    });
    await queueChange(db, { type: "task.patch", rowId: row.id, listId: row.list_id, baseEtag: row.etag });
    if (next) {
      const nextId = await saveRecord(db, "task", {
        list_id: row.list_id, google_id: null, title: row.title, notes: row.notes, due: next.due, time: row.time,
        done: 0, completed_at: null, repeat: JSON.stringify(next.repeat), etag: null,
      });
      await queueChange(db, { type: "task.create", rowId: nextId, listId: row.list_id });
    }
  });
}

export async function deleteTask(db: Db, id: string): Promise<void> {
  await db.transaction(async () => {
    const row = await getTaskRow(db, id);
    if (!row) return;
    await deleteRecord(db, "task", row.id);
    await queueChange(db, { type: "task.delete", rowId: row.id, listId: row.list_id, baseEtag: row.etag });
  });
}

async function firstTaskListId(db: Db): Promise<string> {
  const row = await get(db, "SELECT id FROM task_list WHERE deleted = 0 ORDER BY position LIMIT 1");
  if (!row) throw new Error("Your Google task lists haven't been read yet. Connect Google under Settings → Connections (or sync with the desktop) first.");
  return row.id;
}
