// Generic to-do lists: named lists of items that can be checked off. No outside service;
// both tables are synced between Lifeboard's own devices (see sync/records.ts).
// Items have no foreign key to their list, because sync may deliver an item before its list.
import { get, type Db } from "./db/types.ts";
import { deleteRecord, saveRecord } from "./sync/records.ts";

export interface TodoList {
  id: string;
  name: string;
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
  open: TodoItem[];
  done: TodoItem[];
}

export async function listTodoLists(db: Db): Promise<TodoList[]> {
  const rows = await db.all(`
    SELECT l.id, l.name,
      COALESCE(SUM(i.done = 0), 0) AS open_count,
      COALESCE(SUM(i.done = 1), 0) AS done_count
    FROM todo_list l
    LEFT JOIN todo_item i ON i.list_id = l.id AND i.deleted = 0
    WHERE l.deleted = 0
    GROUP BY l.id
    ORDER BY l.position, l.name`);
  return rows.map((row) => ({ id: row.id, name: row.name, openCount: row.open_count, doneCount: row.done_count }));
}

/** One list with its items, open ones first; undefined if it doesn't exist (or was deleted). */
export async function getTodoList(db: Db, listId: string): Promise<TodoListDetail | undefined> {
  const list = await get(db, "SELECT id, name FROM todo_list WHERE id = ? AND deleted = 0", [listId]);
  if (!list) return undefined;
  const rows = await db.all(
    "SELECT id, text, done FROM todo_item WHERE list_id = ? AND deleted = 0 ORDER BY position, text",
    [listId],
  );
  const items = rows.map((row) => ({ id: row.id, text: row.text, done: row.done === 1 }));
  return { id: list.id, name: list.name, open: items.filter((i) => !i.done), done: items.filter((i) => i.done) };
}

export async function createTodoList(db: Db, name: string): Promise<string> {
  return saveRecord(db, "todo_list", { name: requireText(name, "List name"), position: await nextPosition(db, "todo_list") });
}

export async function renameTodoList(db: Db, listId: string, name: string): Promise<void> {
  const list = await get(db, "SELECT position FROM todo_list WHERE id = ?", [listId]);
  if (!list) throw new Error("That list no longer exists.");
  await saveRecord(db, "todo_list", { id: listId, name: requireText(name, "List name"), position: list.position });
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

/** Deletes every checked-off item on a list. */
export async function clearDoneTodoItems(db: Db, listId: string): Promise<void> {
  await db.transaction(async () => {
    const items = await db.all("SELECT id FROM todo_item WHERE list_id = ? AND done = 1 AND deleted = 0", [listId]);
    for (const item of items) await deleteRecord(db, "todo_item", item.id);
  });
}

async function updateItem(db: Db, itemId: string, changes: { text?: string; done?: number }): Promise<void> {
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
