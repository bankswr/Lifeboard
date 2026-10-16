// The Schedule's local copy of Google Calendar events and Google Tasks: converting Google's
// JSON to rows, reading them back, and laying them out by day for the Schedule screen.
// Google is the source of truth: schedule/push.ts replaces these rows with what Google
// returns after sending it any pending changes (schedule/edit.ts).
import { addDays, localDate } from "../dates.ts";
import { get, type Db, type Row } from "../db/types.ts";
import type { GoogleEvent, GoogleTask } from "./googleApi.ts";
import { fromRecurrence, type Repeat } from "./repeat.ts";

export interface EventItem {
  id: string;
  calendarId: string;
  title: string;
  location: string;
  notes: string;
  allDay: boolean;
  /** All-day: "YYYY-MM-DD"; timed: UTC ISO time. */
  start: string;
  /** All-day: the day after the last day (Google's convention); timed: UTC ISO time. */
  end: string;
  /** Part of a repeating series. */
  recurring: boolean;
  /** Made in Lifeboard and not in Google yet. */
  pending: boolean;
}

export interface TaskItem {
  id: string;
  listId: string;
  title: string;
  notes: string;
  due: string | null;
  /** Lifeboard only: Google Tasks keeps dates, not times. "HH:MM". */
  time: string | null;
  done: boolean;
  completedAt: string | null;
  repeat: Repeat | null;
  pending: boolean;
}

export interface ScheduleDay {
  date: string;
  /** Open tasks first (overdue ones on today), then done ones, crossed out on screen. */
  tasks: (TaskItem & { overdue: boolean })[];
  allDay: EventItem[];
  timed: EventItem[];
}

// ---------- Google → rows ----------

/** Row fields for a Google event (an occurrence or a single event, or a series with isSeries). */
export function eventRow(calendarId: string, event: GoogleEvent, isSeries = false): Row {
  const allDay = Boolean(event.start?.date);
  const time = (point: { date?: string; dateTime?: string }) => point.date ?? new Date(point.dateTime!).toISOString();
  return {
    calendar_id: calendarId,
    google_id: event.id,
    recurring_id: event.recurringEventId ?? null,
    is_series: isSeries ? 1 : 0,
    title: event.summary ?? "(No title)",
    location: event.location ?? "",
    notes: event.description ?? "",
    all_day: allDay ? 1 : 0,
    start_at: time(event.start),
    end_at: time(event.end),
    time_zone: event.start?.timeZone ?? null,
    recurrence: isSeries ? JSON.stringify(event.recurrence ?? []) : null,
    original_start: event.originalStartTime ? time(event.originalStartTime) : null,
    etag: event.etag ?? null,
  };
}

/** Row fields Google decides for a task. Lifeboard-only fields (time, repeat) are kept separately. */
export function taskRow(listId: string, task: GoogleTask): Row {
  return {
    list_id: listId,
    google_id: task.id,
    title: task.title || "(No title)",
    notes: task.notes ?? "",
    due: task.due ? String(task.due).slice(0, 10) : null,
    done: task.status === "completed" ? 1 : 0,
    completed_at: task.completed ?? null,
    etag: task.etag ?? null,
  };
}

// ---------- rows → items ----------

export function toEventItem(row: Row): EventItem {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    title: row.title,
    location: row.location,
    notes: row.notes,
    allDay: row.all_day === 1,
    start: row.start_at,
    end: row.end_at,
    recurring: Boolean(row.recurring_id),
    pending: !row.google_id,
  };
}

export function toTaskItem(row: Row): TaskItem {
  return {
    id: row.id,
    listId: row.list_id,
    title: row.title,
    notes: row.notes,
    due: row.due,
    time: row.time,
    done: row.done === 1,
    completedAt: row.completed_at,
    repeat: row.repeat ? JSON.parse(row.repeat) : null,
    pending: !row.google_id,
  };
}

export async function getEventRow(db: Db, id: string): Promise<Row | undefined> {
  return get(db, "SELECT * FROM calendar_event WHERE id = ? AND deleted = 0", [id]);
}

export async function getTaskRow(db: Db, id: string): Promise<Row | undefined> {
  return get(db, "SELECT * FROM task WHERE id = ? AND deleted = 0", [id]);
}

/** The series an occurrence belongs to, if it's stored. */
export async function getSeriesRow(db: Db, calendarId: string, seriesGoogleId: string): Promise<Row | undefined> {
  return get(db, "SELECT * FROM calendar_event WHERE calendar_id = ? AND google_id = ? AND is_series = 1 AND deleted = 0", [
    calendarId, seriesGoogleId,
  ]);
}

/** An event for the edit form, with its series' repeat when it's part of one. */
export async function getEvent(db: Db, id: string): Promise<(EventItem & { repeat: Repeat | null; timeZone: string | null }) | null> {
  const row = await getEventRow(db, id);
  if (!row) return null;
  const series = row.recurring_id ? await getSeriesRow(db, row.calendar_id, row.recurring_id) : undefined;
  return { ...toEventItem(row), timeZone: row.time_zone, repeat: series ? fromRecurrence(JSON.parse(series.recurrence)) : null };
}

export async function getTask(db: Db, id: string): Promise<TaskItem | null> {
  const row = await getTaskRow(db, id);
  return row ? toTaskItem(row) : null;
}

export interface ScheduleOptions {
  /** Calendars shown on the Schedule (the main one plus any added in Settings); main first. */
  calendars: { id: string; name: string; primary: boolean }[];
  taskLists: { id: string; title: string }[];
}

export async function getScheduleOptions(db: Db): Promise<ScheduleOptions> {
  const calendars = await db.all("SELECT id, name, is_primary FROM calendar WHERE included = 1 AND deleted = 0 ORDER BY is_primary DESC, name");
  const lists = await db.all("SELECT id, title FROM task_list WHERE deleted = 0 ORDER BY position");
  return {
    calendars: calendars.map((c) => ({ id: c.id, name: c.name, primary: c.is_primary === 1 })),
    taskLists: lists.map((l) => ({ id: l.id, title: l.title })),
  };
}

/** Every Google calendar, for choosing which ones the Schedule shows (Settings). */
export async function listCalendars(db: Db) {
  const rows = await db.all("SELECT id, name, is_primary, included FROM calendar WHERE deleted = 0 ORDER BY is_primary DESC, name");
  return rows.map((c) => ({ id: c.id, name: c.name, primary: c.is_primary === 1, included: c.included === 1 }));
}

// ---------- the Schedule screen ----------

/** The days from `from` to `to` (inclusive) with their tasks and events. */
export async function getSchedule(db: Db, from: string, to: string, today = localDate()): Promise<ScheduleDay[]> {
  // Loose bounds in SQL (all-day dates and UTC times sort together well enough); exact
  // placement is worked out in scheduleDays. Multi-day all-day events can start up to a
  // month before the range.
  const events = await db.all(
    `SELECT * FROM calendar_event WHERE deleted = 0 AND is_series = 0 AND start_at >= ? AND start_at < ?
       AND calendar_id IN (SELECT id FROM calendar WHERE included = 1 AND deleted = 0)`,
    [addDays(from, -31), addDays(to, 2)],
  );
  const tasks = await db.all(
    `SELECT * FROM task WHERE deleted = 0 AND (done = 0 OR COALESCE(due, substr(completed_at, 1, 10)) >= ? OR completed_at >= ?)`,
    [addDays(from, -2), addDays(from, -2)],
  );
  return scheduleDays(events.map(toEventItem), tasks.map(toTaskItem), from, to, today);
}

/**
 * Lays tasks and events out by day. Per day: tasks (overdue, then by time, then done ones),
 * all-day events, then timed events by start (user's order, 2026-10-16).
 * - An open task due before today, or with no date, shows on today; overdue ones are flagged.
 * - A done task shows on its due day, or on the day it was done if that was later.
 * - An all-day event shows on each day it covers; a timed event on the day it starts.
 */
export function scheduleDays(events: EventItem[], tasks: TaskItem[], from: string, to: string, today: string): ScheduleDay[] {
  const days = new Map<string, ScheduleDay>();
  for (let date = from; date <= to; date = addDays(date, 1)) days.set(date, { date, tasks: [], allDay: [], timed: [] });

  for (const event of events) {
    if (event.allDay) {
      for (let date = event.start; date < event.end; date = addDays(date, 1)) days.get(date)?.allDay.push(event);
    } else {
      days.get(localDate(new Date(event.start)))?.timed.push(event);
    }
  }
  for (const task of tasks) {
    const { day, overdue } = taskDay(task, today);
    days.get(day)?.tasks.push({ ...task, overdue });
  }

  for (const day of days.values()) {
    day.tasks.sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        Number(b.overdue) - Number(a.overdue) ||
        (a.time ?? "99:99").localeCompare(b.time ?? "99:99") ||
        a.title.localeCompare(b.title),
    );
    day.allDay.sort((a, b) => a.title.localeCompare(b.title));
    day.timed.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  }
  return [...days.values()];
}

function taskDay(task: TaskItem, today: string): { day: string; overdue: boolean } {
  if (task.done) {
    const doneDay = task.completedAt ? localDate(new Date(task.completedAt)) : today;
    return { day: task.due && task.due >= doneDay ? task.due : doneDay, overdue: false };
  }
  if (!task.due) return { day: today, overdue: false };
  if (task.due < today) return { day: today, overdue: true };
  return { day: task.due, overdue: false };
}
