// Maintenance (Details → Maintenance): recurring chores such as "Replace HVAC filter", entered
// like a calendar entry that repeats by default (user, 2026-10-16). On each day an item comes
// due, Lifeboard adds a task for it to Google Tasks that day.
// - Task ids are fixed per item and date, so both devices make the same task once.
// - If updates didn't run across several due days, only the latest missed one gets a task
//   (it shows as overdue on today) rather than a pile of them.
// Items are synced; `last_generated` is the latest due date a task was made for.
import { localDate } from "./dates.ts";
import { get, type Db, type Row } from "./db/types.ts";
import { queueChange } from "./schedule/edit.ts";
import { describeRepeat, nextTaskDue, type Repeat } from "./schedule/repeat.ts";
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
}

export interface MaintenanceInput {
  id?: string;
  name: string;
  notes: string;
  startDate: string;
  time: string | null;
  repeat: Repeat | null;
}

/** Safety stop for very long series (a daily item over decades). */
const MAX_OCCURRENCES = 50_000;

function fromRow(row: Row): MaintenanceItem {
  return {
    id: row.id, name: row.name, notes: row.notes, startDate: row.start_date, time: row.time,
    repeat: row.repeat ? JSON.parse(row.repeat) : null, lastGenerated: row.last_generated,
  };
}

// ---------- occurrences ----------

/**
 * Due dates in order, from the first, while `keepGoing` says so. Uses the same repeat rules
 * as repeating tasks (a COUNT end counts down, an UNTIL end stops).
 */
function* occurrences(item: Pick<MaintenanceItem, "startDate" | "repeat">): Generator<string> {
  let due: string = item.startDate;
  let repeat = item.repeat;
  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    yield due;
    if (!repeat) return;
    const next = nextTaskDue(repeat, due);
    if (!next) return;
    ({ due, repeat } = next);
  }
}

/** The latest due date on or before `today`, or null if the first is still ahead. */
export function latestDue(item: Pick<MaintenanceItem, "startDate" | "repeat">, today: string): string | null {
  let latest: string | null = null;
  for (const due of occurrences(item)) {
    if (due > today) break;
    latest = due;
  }
  return latest;
}

/** The next due date that hasn't had a task yet (today's counts until its task is made). */
export function nextDue(item: MaintenanceItem, today: string): string | null {
  for (const due of occurrences(item)) {
    if (due >= today && (!item.lastGenerated || due > item.lastGenerated)) return due;
  }
  return null;
}

// ---------- reading and editing ----------

export async function listMaintenance(db: Db, today = localDate()) {
  const rows = await db.all("SELECT * FROM maintenance_item WHERE deleted = 0");
  return rows
    .map(fromRow)
    .map((item) => ({ ...item, nextDue: nextDue(item, today), repeatText: item.repeat ? describeRepeat(item.repeat) : "Once" }))
    .sort((a, b) => (a.nextDue ?? "9999").localeCompare(b.nextDue ?? "9999") || a.name.localeCompare(b.name));
}

export async function getMaintenance(db: Db, id: string): Promise<MaintenanceItem | null> {
  const row = await get(db, "SELECT * FROM maintenance_item WHERE id = ? AND deleted = 0", [id]);
  return row ? fromRow(row) : null;
}

/** Creates or edits an item, then makes today's task if it's due. Returns its id. */
export async function saveMaintenance(db: Db, input: MaintenanceInput, today = localDate()): Promise<string> {
  if (!input.name.trim()) throw new Error("Give the item a name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new Error("Choose the first due date.");
  const existing = input.id ? await get(db, "SELECT * FROM maintenance_item WHERE id = ? AND deleted = 0", [input.id]) : undefined;
  if (input.id && !existing) throw new Error("This item no longer exists.");
  const id = await saveRecord(db, "maintenance_item", {
    ...(existing ? { id: existing.id } : {}),
    name: input.name.trim(),
    notes: input.notes.trim(),
    start_date: input.startDate,
    time: input.time || null,
    repeat: input.repeat ? JSON.stringify(input.repeat) : null,
    last_generated: existing?.last_generated ?? null,
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
 * For each item due today or earlier without a task for that date yet, adds the task (to the
 * first Google task list) and remembers the date. Returns how many tasks were added. Does
 * nothing until the task lists have been read from Google.
 */
export async function generateMaintenanceTasks(db: Db, today = localDate()): Promise<number> {
  const list = await get(db, "SELECT id FROM task_list WHERE deleted = 0 ORDER BY position LIMIT 1");
  if (!list) return 0;
  let added = 0;
  await db.transaction(async () => {
    for (const row of await db.all("SELECT * FROM maintenance_item WHERE deleted = 0")) {
      const item = fromRow(row);
      const due = latestDue(item, today);
      if (!due || (item.lastGenerated && due <= item.lastGenerated)) continue;
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
      await saveRecord(db, "maintenance_item", { ...row, last_generated: due });
    }
  });
  return added;
}
