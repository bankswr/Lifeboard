// Maintenance (Details → Maintenance): recurring chores such as "Replace HVAC filter", entered
// like a calendar entry that repeats by default (user, 2026-10-16). On each day an item comes
// due, Lifeboard adds a task for it to Google Tasks that day.
// - Task ids are fixed per item and date, so both devices make the same task once.
// - If updates didn't run across several due days, only the latest missed one gets a task
//   (it shows as overdue on today) rather than a pile of them.
// - The schedule follows when the work is done (user, 2026-10-22): while an item's latest
//   task is open, no new one is made; once it's done on another day than its due date, the
//   next due dates count from the day it was done, at the same frequency. Weekly items stay
//   on their chosen weekdays. A deleted task counts as skipped (no move), unticking a task
//   undoes its move until the next task is made, and editing the start date or repeat starts
//   the schedule over.
// - An item can be limited to part of the year (user, 2026-10-28): an active window from one
//   day-month to another, every year, which may wrap over the new year (Nov 15 – Mar 15).
//   Due dates outside it are skipped, and the schedule starts over each time the window opens
//   (on its first day, or the first chosen weekday from it), so the dates are the same each
//   year. Set in the form's Advanced section.
// Items are synced; `last_generated` is the latest due date a task was made for.
import { addDays, localDate } from "./dates.ts";
import { get, type Db, type Row } from "./db/types.ts";
import { queueChange } from "./schedule/edit.ts";
import { addMonths, describeRepeat, mondayFirstWeekday, nextDate, type Repeat } from "./schedule/repeat.ts";
import { deleteRecord, saveRecord } from "./sync/records.ts";

export interface MaintenanceItem {
  id: string;
  name: string;
  notes: string;
  /** The first due date. */
  startDate: string;
  /** "HH:MM", Lifeboard only (Google Tasks keeps dates); copied onto each task. */
  time: string | null;
  /** Null: a one-off item. */
  repeat: Repeat | null;
  lastGenerated: string | null;
  /** The task made for `lastGenerated`, which the next due date waits for. Null after a schedule edit. */
  waitsForTask: string | null;
  /** Set once a task done off its date has moved the schedule: the day it counts from. */
  shiftedFrom: string | null;
  /** The repeat counted from `shiftedFrom` (an "after N times" end holds what's left). */
  shiftedRepeat: Repeat | null;
  /** Null: active all year. */
  activeWindow: ActiveWindow | null;
}

/** Part of every year, as "MM-DD" days; `from` after `to` wraps over the new year. */
export interface ActiveWindow {
  from: string;
  to: string;
}

export interface MaintenanceInput {
  id?: string;
  name: string;
  notes: string;
  startDate: string;
  time: string | null;
  repeat: Repeat | null;
  activeWindow: ActiveWindow | null;
}

/** What became of the task an item waits for. */
export type LastTask = "open" | "gone" | { doneOn: string };

/**
 * A run of due dates counted from `from` by `repeat`. `from` is itself due for the original
 * schedule (the start date) but not for a moved one (the day a task was done).
 */
export interface Series {
  from: string;
  fromIsDue: boolean;
  repeat: Repeat | null;
  window: ActiveWindow | null;
}

/** Safety stop for very long series (a daily item over decades). */
const MAX_OCCURRENCES = 50_000;

function fromRow(row: Row): MaintenanceItem {
  return {
    id: row.id, name: row.name, notes: row.notes, startDate: row.start_date, time: row.time,
    repeat: row.repeat ? JSON.parse(row.repeat) : null, lastGenerated: row.last_generated,
    waitsForTask: row.waits_for_task, shiftedFrom: row.shifted_from,
    shiftedRepeat: row.shifted_repeat ? JSON.parse(row.shifted_repeat) : null,
    activeWindow: row.active_window ? JSON.parse(row.active_window) : null,
  };
}

// ---------- active window ----------

export function inWindow(date: string, window: ActiveWindow): boolean {
  const day = date.slice(5);
  if (window.from <= window.to) return day >= window.from && day <= window.to;
  return day >= window.from || day <= window.to;
}

/** The first day of the window after `date`. */
function nextOpening(date: string, window: ActiveWindow): string {
  const year = Number(date.slice(0, 4));
  const opening = `${year}-${window.from}`;
  return opening > date ? opening : `${year + 1}-${window.from}`;
}

/** The last day of the window that `date` (inside it) belongs to. */
export function windowEnd(date: string, window: ActiveWindow): string {
  const year = Number(date.slice(0, 4));
  const wrapsIntoNextYear = window.from > window.to && date.slice(5) >= window.from;
  return `${wrapsIntoNextYear ? year + 1 : year}-${window.to}`;
}

/** Where a schedule restarts when the window opens: that day, or a weekly item's first chosen weekday from it. */
function restartDate(repeat: Repeat | null, opening: string): string {
  if (repeat?.freq !== "weekly" || repeat.weekdays.length === 0) return opening;
  let date = opening;
  while (!repeat.weekdays.includes(mondayFirstWeekday(date))) date = addDays(date, 1);
  return date;
}

function validWindow(window: ActiveWindow): boolean {
  return [window.from, window.to].every((day) => {
    const match = /^(\d{2})-(\d{2})$/.exec(day);
    if (!match) return false;
    const [month, date] = [Number(match[1]), Number(match[2])];
    // Feb 29 is left out: most years it doesn't exist, so a window couldn't open on it.
    const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return daysInMonth !== undefined && date >= 1 && date <= daysInMonth;
  });
}

// ---------- occurrences ----------

/**
 * Due dates in order, each with the repeat left from it (an "after N times" end counts this
 * one). Monthly and yearly dates are counted from `from` rather than from the previous date,
 * so an item on the 31st is due on the last day of a short month and on the 31st again after.
 * A date outside the active window isn't due; the schedule restarts when the window opens.
 */
function* occurrences(series: Series): Generator<{ due: string; repeat: Repeat | null }> {
  const { repeat, window } = series;
  if (!repeat && !series.fromIsDue) return;
  let from = series.from;
  let left = repeat?.end.kind === "count" ? repeat.end.count : Infinity;
  let step = series.fromIsDue ? 0 : 1;
  let due = series.fromIsDue ? from : stepDate(repeat!, from, from, step);
  for (let n = 0; n < MAX_OCCURRENCES && left > 0; n++) {
    if (repeat?.end.kind === "until" && due > repeat.end.date) return;
    if (window && !inWindow(due, window)) {
      from = restartDate(repeat, nextOpening(due, window));
      step = 0;
      due = from;
      continue;
    }
    yield { due, repeat: repeat && withCountLeft(repeat, left) };
    if (!repeat) return;
    left--;
    step++;
    due = stepDate(repeat, from, due, step);
  }
}

/** The `step`th date from `from`; daily and weekly dates step on from `previous`. */
function stepDate(repeat: Repeat, from: string, previous: string, step: number): string {
  if (repeat.freq === "monthly") return addMonths(from, step * repeat.interval);
  if (repeat.freq === "yearly") return addMonths(from, step * 12 * repeat.interval);
  return nextDate(repeat, previous);
}

function withCountLeft(repeat: Repeat, left: number): Repeat {
  return repeat.end.kind === "count" ? { ...repeat, end: { kind: "count", count: left } } : repeat;
}

/** The schedule the latest task belongs to: the moved one if a task moved it, else the original. */
function currentSeries(item: MaintenanceItem): Series {
  const window = item.activeWindow;
  if (item.shiftedFrom && item.shiftedRepeat) return { from: item.shiftedFrom, fromIsDue: false, repeat: item.shiftedRepeat, window };
  return { from: item.startDate, fromIsDue: true, repeat: item.repeat, window };
}

/**
 * The schedule the next due date comes from, given what became of the latest task: "waiting"
 * while it's open, a moved schedule if it was done on another day, null if the repeat has ended.
 */
export function upcomingSeries(item: MaintenanceItem, last: LastTask | null): Series | "waiting" | null {
  const current = currentSeries(item);
  if (!item.lastGenerated || !last || last === "gone") return current;
  if (last === "open") return "waiting";
  if (last.doneOn === item.lastGenerated || !current.repeat) return current;
  const left = repeatAfter(current, item.lastGenerated);
  if (left === undefined) return current; // the date isn't in this schedule; nothing to move from
  if (left === null) return null;
  return movedSeries(item, left, last.doneOn);
}

/** The repeat left after `due` (null if it was the last one), or undefined if `due` isn't in the series. */
function repeatAfter(series: Series, due: string): Repeat | null | undefined {
  for (const occurrence of occurrences(series)) {
    if (occurrence.due > due) return undefined;
    if (occurrence.due !== due) continue;
    const repeat = occurrence.repeat!;
    if (repeat.end.kind !== "count") return repeat;
    return repeat.end.count > 1 ? withCountLeft(repeat, repeat.end.count - 1) : null;
  }
  return undefined;
}

/**
 * The schedule after a task due on `item.lastGenerated` was done on `doneOn`: the same repeat
 * counted from that day. Weekly items keep their weekdays (the start date's when none were
 * chosen) and so restart at the next chosen day; done early, they keep their dates.
 */
function movedSeries(item: MaintenanceItem, repeat: Repeat, doneOn: string): Series {
  const window = item.activeWindow;
  if (repeat.freq !== "weekly") return { from: doneOn, fromIsDue: false, repeat, window };
  const weekdays = repeat.weekdays.length > 0 ? repeat.weekdays : [mondayFirstWeekday(item.startDate)];
  const from = doneOn > item.lastGenerated! ? doneOn : item.lastGenerated!;
  return { from, fromIsDue: false, repeat: { ...repeat, weekdays }, window };
}

/** Due dates in `series` that haven't had a task yet. */
function* untaskedDates(item: MaintenanceItem, series: Series): Generator<string> {
  for (const { due } of occurrences(series)) {
    if (!item.lastGenerated || due > item.lastGenerated) yield due;
  }
}

/** The latest untasked due date on or before `today`, or null if none is due yet. */
export function latestDue(item: MaintenanceItem, series: Series, today: string): string | null {
  let latest: string | null = null;
  for (const due of untaskedDates(item, series)) {
    if (due > today) break;
    latest = due;
  }
  return latest;
}

/** The next due date that hasn't had a task yet (today's counts until its task is made). */
export function nextDue(item: MaintenanceItem, series: Series, today: string): string | null {
  for (const due of untaskedDates(item, series)) {
    if (due >= today) return due;
  }
  return null;
}

/** What became of the task the item waits for; null if it waits for none. */
async function lastTask(db: Db, item: MaintenanceItem): Promise<LastTask | null> {
  if (!item.waitsForTask) return null;
  const task = await get(db, "SELECT deleted, done, completed_at FROM task WHERE id = ?", [item.waitsForTask]);
  if (!task || task.deleted) return "gone";
  if (!task.done) return "open";
  // completed_at is a UTC time (from Google or setTaskDone); the day that counts is the local one.
  return { doneOn: task.completed_at ? localDate(new Date(task.completed_at)) : item.lastGenerated! };
}

// ---------- reading and editing ----------

export async function listMaintenance(db: Db, today = localDate()) {
  const rows = await db.all("SELECT * FROM maintenance_item WHERE deleted = 0");
  const items = [];
  for (const item of rows.map(fromRow)) {
    const series = upcomingSeries(item, await lastTask(db, item));
    const waiting = series === "waiting";
    // While its task is open, the item is shown by that task's date.
    const due = waiting ? item.lastGenerated : series ? nextDue(item, series, today) : null;
    items.push({ ...item, nextDue: due, waiting, repeatText: item.repeat ? describeRepeat(item.repeat) : "Once" });
  }
  return items.sort((a, b) => (a.nextDue ?? "9999").localeCompare(b.nextDue ?? "9999") || a.name.localeCompare(b.name));
}

export async function getMaintenance(db: Db, id: string): Promise<MaintenanceItem | null> {
  const row = await get(db, "SELECT * FROM maintenance_item WHERE id = ? AND deleted = 0", [id]);
  return row ? fromRow(row) : null;
}

/** Creates or edits an item, then makes today's task if it's due. Returns its id. */
export async function saveMaintenance(db: Db, input: MaintenanceInput, today = localDate()): Promise<string> {
  if (!input.name.trim()) throw new Error("Give the item a name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new Error("Choose the first due date.");
  if (input.activeWindow && !validWindow(input.activeWindow)) throw new Error("Choose real days for the active period (Feb 29 can't be used).");
  const existing = input.id ? await get(db, "SELECT * FROM maintenance_item WHERE id = ? AND deleted = 0", [input.id]) : undefined;
  if (input.id && !existing) throw new Error("This item no longer exists.");
  const repeat = input.repeat ? JSON.stringify(input.repeat) : null;
  const activeWindow = input.activeWindow ? JSON.stringify(input.activeWindow) : null;
  // A new start date, repeat or window starts the schedule over: no move, no waiting for the old task.
  const keepSchedule = existing && existing.start_date === input.startDate && existing.repeat === repeat
    && existing.active_window === activeWindow;
  const id = await saveRecord(db, "maintenance_item", {
    ...(existing ? { id: existing.id } : {}),
    name: input.name.trim(),
    notes: input.notes.trim(),
    start_date: input.startDate,
    time: input.time || null,
    repeat,
    active_window: activeWindow,
    last_generated: existing?.last_generated ?? null,
    waits_for_task: keepSchedule ? existing.waits_for_task : null,
    shifted_from: keepSchedule ? existing.shifted_from : null,
    shifted_repeat: keepSchedule ? existing.shifted_repeat : null,
  });
  await generateMaintenanceTasks(db, today);
  return id;
}

/** Deletes an item. Tasks already made for it stay in Google Tasks. */
export async function deleteMaintenance(db: Db, id: string): Promise<void> {
  await deleteRecord(db, "maintenance_item", id);
}

// ---------- making tasks ----------

/**
 * For each item due today or earlier without a task for that date yet (and whose latest task
 * isn't still open), adds the task (to the first Google task list) and remembers the date and
 * the schedule it came from. Returns how many tasks were added. Does nothing until the task
 * lists have been read from Google.
 */
export async function generateMaintenanceTasks(db: Db, today = localDate()): Promise<number> {
  const list = await get(db, "SELECT id FROM task_list WHERE deleted = 0 ORDER BY position LIMIT 1");
  if (!list) return 0;
  let added = 0;
  await db.transaction(async () => {
    for (const row of await db.all("SELECT * FROM maintenance_item WHERE deleted = 0")) {
      const item = fromRow(row);
      const series = upcomingSeries(item, await lastTask(db, item));
      if (!series || series === "waiting") continue;
      const due = latestDue(item, series, today);
      if (!due) continue;
      const taskId = `maint-${item.id}-${due}`;
      if (!(await get(db, "SELECT 1 FROM task WHERE id = ?", [taskId]))) {
        await saveRecord(db, "task", {
          id: taskId, list_id: list.id, google_id: null, title: item.name,
          notes: item.notes ? `${item.notes}\n(Maintenance item from Lifeboard)` : "Maintenance item from Lifeboard",
          due, time: item.time, done: 0, completed_at: null, repeat: null, etag: null,
        });
        await queueChange(db, { type: "task.create", rowId: taskId, listId: list.id });
        added++;
      }
      const moved = !series.fromIsDue;
      await saveRecord(db, "maintenance_item", {
        ...row, last_generated: due, waits_for_task: taskId,
        shifted_from: moved ? series.from : null,
        shifted_repeat: moved ? JSON.stringify(series.repeat) : null,
      });
    }
  });
  return added;
}
