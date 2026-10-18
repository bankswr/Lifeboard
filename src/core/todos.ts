// Generic lists, of two kinds (user, 2026-10-16):
// - "todo": items are ticked off (crossed out) and the ticked ones are cleared when the app
//   next loads (clearCheckedItems, called at start on each device).
// - "prototype": standard items kept to be copied into other lists; its checkboxes only
//   select items for copying (in the UI), so nothing is ever ticked or cleared.
// No outside service; both tables are synced between Lifeboard's own devices (see
// sync/records.ts). Items have no foreign key to their list, because sync may deliver an
// item before its list.
import { get, type Db } from "./db/types.ts";
import { deleteRecord, saveRecord } from "./sync/records.ts";

export type ListKind = "todo" | "prototype";

export interface TodoList {
  id: string;
  name: string;
  kind: ListKind;
  openCount: number;
  doneCount: number;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface TodoListDetail {
  id: string;
  name: string;
  kind: ListKind;
  /** Every item in list order, ticked ones where they were. */
  items: TodoItem[];
  open: TodoItem[];
  done: TodoItem[];
}

export async function listTodoLists(db: Db): Promise<TodoList[]> {
  const rows = await db.all(`
    SELECT l.id, l.name, l.kind,
      COALESCE(SUM(i.done = 0), 0) AS open_count,
      COALESCE(SUM(i.done = 1), 0) AS done_count
    FROM todo_list l
    LEFT JOIN todo_item i ON i.list_id = l.id AND i.deleted = 0
    WHERE l.deleted = 0
    GROUP BY l.id
    ORDER BY l.position, l.name`);
  return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, openCount: row.open_count, doneCount: row.done_count }));
}

/** One list with its items, open ones first; undefined if it doesn't exist (or was deleted). */
export async function getTodoList(db: Db, listId: string): Promise<TodoListDetail | undefined> {
  const list = await get(db, "SELECT id, name, kind FROM todo_list WHERE id = ? AND deleted = 0", [listId]);
  if (!list) return undefined;
  const rows = await db.all(
    "SELECT id, text, done FROM todo_item WHERE list_id = ? AND deleted = 0 ORDER BY position, text",
    [listId],
  );
  const items = rows.map((row) => ({ id: row.id, text: row.text, done: row.done === 1 }));
  return { id: list.id, name: list.name, kind: list.kind, items, open: items.filter((i) => !i.done), done: items.filter((i) => i.done) };
}

/** Every list with its items, in list order: the Lists screen shows them all at once. */
export async function getAllTodoLists(db: Db): Promise<TodoListDetail[]> {
  const lists = await listTodoLists(db);
  const details = await Promise.all(lists.map((list) => getTodoList(db, list.id)));
  return details.filter((detail): detail is TodoListDetail => detail !== undefined);
}

export async function createTodoList(db: Db, name: string, kind: ListKind = "todo"): Promise<string> {
  if (kind !== "todo" && kind !== "prototype") throw new Error("Choose To-do or Prototype.");
  return saveRecord(db, "todo_list", { name: requireText(name, "List name"), kind, position: await nextPosition(db, "todo_list") });
}

export async function renameTodoList(db: Db, listId: string, name: string): Promise<void> {
  const list = await get(db, "SELECT position, kind FROM todo_list WHERE id = ?", [listId]);
  if (!list) throw new Error("That list no longer exists.");
  await saveRecord(db, "todo_list", { id: listId, name: requireText(name, "List name"), kind: list.kind, position: list.position });
}

/** Clears every ticked item on the to-do lists: done when the app loads. */
export async function clearCheckedItems(db: Db): Promise<void> {
  await db.transaction(async () => {
    const items = await db.all(
      "SELECT id FROM todo_item WHERE done = 1 AND deleted = 0 AND list_id IN (SELECT id FROM todo_list WHERE kind = 'todo')",
    );
    for (const item of items) await deleteRecord(db, "todo_item", item.id);
  });
}

/** Deletes a list and every item on it. */
export async function deleteTodoList(db: Db, listId: string): Promise<void> {
  await db.transaction(async () => {
    const items = await db.all("SELECT id FROM todo_item WHERE list_id = ? AND deleted = 0", [listId]);
    for (const item of items) await deleteRecord(db, "todo_item", item.id);
    await deleteRecord(db, "todo_list", listId);
  });
}

export async function addTodoItem(db: Db, listId: string, text: string): Promise<string> {
  return saveRecord(db, "todo_item", {
    list_id: listId,
    text: requireText(text, "Item"),
    done: 0,
    position: await nextPosition(db, "todo_item", listId),
  });
}

export async function setTodoItemDone(db: Db, itemId: string, done: boolean): Promise<void> {
  await updateItem(db, itemId, { done: done ? 1 : 0 });
}

export async function editTodoItem(db: Db, itemId: string, text: string): Promise<void> {
  await updateItem(db, itemId, { text: requireText(text, "Item") });
}

export async function deleteTodoItem(db: Db, itemId: string): Promise<void> {
  await deleteRecord(db, "todo_item", itemId);
}

/**
 * Copies items into another list, unticked, at its end. The originals stay where they are.
 * Items whose text is already open on the target list are skipped, so copying a list twice
 * doesn't double it. Returns how many were copied and skipped.
 */
export async function copyTodoItems(db: Db, itemIds: string[], targetListId: string): Promise<{ copied: number; skipped: number }> {
  if (!(await get(db, "SELECT 1 FROM todo_list WHERE id = ? AND deleted = 0", [targetListId]))) {
    throw new Error("That list no longer exists.");
  }
  let copied = 0;
  let skipped = 0;
  await db.transaction(async () => {
    const openTexts = new Set(
      (await db.all("SELECT text FROM todo_item WHERE list_id = ? AND done = 0 AND deleted = 0", [targetListId])).map((row) => normalized(row.text)),
    );
    for (const itemId of itemIds) {
      const item = await get(db, "SELECT text FROM todo_item WHERE id = ? AND deleted = 0", [itemId]);
      if (!item) continue;
      if (openTexts.has(normalized(item.text))) {
        skipped++;
        continue;
      }
      await addTodoItem(db, targetListId, item.text);
      openTexts.add(normalized(item.text));
      copied++;
    }
  });
  return { copied, skipped };
}

/** Copies every item of a list (ticked ones too, as unticked) into another list. */
export async function copyTodoList(db: Db, sourceListId: string, targetListId: string) {
  const items = await db.all("SELECT id FROM todo_item WHERE list_id = ? AND deleted = 0 ORDER BY done, position, text", [sourceListId]);
  return copyTodoItems(db, items.map((item) => item.id), targetListId);
}

function normalized(text: string): string {
  return text.trim().toLowerCase();
}

/** Deletes every checked-off item on a list. */
export async function clearDoneTodoItems(db: Db, listId: string): Promise<void> {
  await db.transaction(async () => {
    const items = await db.all("SELECT id FROM todo_item WHERE list_id = ? AND done = 1 AND deleted = 0", [listId]);
    for (const item of items) await deleteRecord(db, "todo_item", item.id);
  });
}

/**
 * Puts the lists in the given order (the Lists screen's drag sorting). Lists left out of
 * `listIds` keep their positions; only lists whose position changes are saved (and synced).
 */
export async function reorderTodoLists(db: Db, listIds: string[]): Promise<void> {
  await db.transaction(async () => {
    for (const [index, listId] of listIds.entries()) {
      const list = await get(db, "SELECT name, kind, position FROM todo_list WHERE id = ? AND deleted = 0", [listId]);
      if (list && list.position !== index + 1) {
        await saveRecord(db, "todo_list", { id: listId, name: list.name, kind: list.kind, position: index + 1 });
      }
    }
  });
}

/** Puts a list's items in the given order (drag sorting); only moved items are saved. */
export async function reorderTodoItems(db: Db, listId: string, itemIds: string[]): Promise<void> {
  await db.transaction(async () => {
    for (const [index, itemId] of itemIds.entries()) {
      const item = await get(db, "SELECT position FROM todo_item WHERE id = ? AND list_id = ? AND deleted = 0", [itemId, listId]);
      if (item && item.position !== index + 1) await updateItem(db, itemId, { position: index + 1 });
    }
  });
}

/** Sorts every list by name, once: the order is saved, and dragging can change it again. */
export async function sortTodoListsByName(db: Db): Promise<void> {
  const lists = await listTodoLists(db);
  await reorderTodoLists(db, byText(lists, (list) => list.name).map((list) => list.id));
}

/** Sorts a list's items by text, once, like sortTodoListsByName. */
export async function sortTodoItemsByName(db: Db, listId: string): Promise<void> {
  const list = await getTodoList(db, listId);
  if (!list) throw new Error("That list no longer exists.");
  await reorderTodoItems(db, listId, byText(list.items, (item) => item.text).map((item) => item.id));
}

/** A copy sorted A–Z, ignoring case and accents, with numbers in numeric order ("2" before "10"). */
export function byText<T>(rows: T[], text: (row: T) => string): T[] {
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return [...rows].sort((a, b) => collator.compare(text(a), text(b)));
}

async function updateItem(db: Db, itemId: string, changes: { text?: string; done?: number; position?: number }): Promise<void> {
  const item = await get(db, "SELECT list_id, text, done, position FROM todo_item WHERE id = ? AND deleted = 0", [itemId]);
  if (!item) throw new Error("That item no longer exists.");
  await saveRecord(db, "todo_item", { id: itemId, list_id: item.list_id, text: item.text, done: item.done, position: item.position, ...changes });
}

/** Position after the last row: new lists and items go at the end. */
async function nextPosition(db: Db, table: "todo_list" | "todo_item", listId?: string): Promise<number> {
  const row = listId
    ? await get(db, "SELECT MAX(position) AS last FROM todo_item WHERE list_id = ?", [listId])
    : await get(db, `SELECT MAX(position) AS last FROM ${table}`);
  return (row?.last ?? 0) + 1;
}

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} can't be empty.`);
  return text;
}
