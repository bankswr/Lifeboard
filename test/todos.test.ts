import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import * as todos from "../src/core/todos.ts";
import { answerSync, syncWithDesktop } from "../src/core/sync/sync.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

async function newDb() {
  const db = openNodeDb(":memory:");
  await migrate(db);
  return db;
}

describe("to-do lists", () => {
  it("keeps separate lists with their own items", async () => {
    const db = await newDb();
    const groceries = await todos.createTodoList(db, "Groceries");
    const chores = await todos.createTodoList(db, "  Chores ");
    await todos.addTodoItem(db, groceries, "Milk");
    await todos.addTodoItem(db, groceries, "Eggs");
    await todos.addTodoItem(db, chores, "Vacuum");

    expect(await todos.listTodoLists(db)).toEqual([
      { id: groceries, name: "Groceries", openCount: 2, doneCount: 0 },
      { id: chores, name: "Chores", openCount: 1, doneCount: 0 },
    ]);
    expect((await todos.getTodoList(db, groceries))!.open.map((i) => i.text)).toEqual(["Milk", "Eggs"]);
  });

  it("checks items off, edits them, and clears the done ones", async () => {
    const db = await newDb();
    const list = await todos.createTodoList(db, "Groceries");
    const milk = await todos.addTodoItem(db, list, "Milk");
    const eggs = await todos.addTodoItem(db, list, "Eggs");

    await todos.setTodoItemDone(db, milk, true);
    await todos.editTodoItem(db, eggs, "A dozen eggs");
    let detail = (await todos.getTodoList(db, list))!;
    expect(detail.open.map((i) => i.text)).toEqual(["A dozen eggs"]);
    expect(detail.done.map((i) => i.text)).toEqual(["Milk"]);

    await todos.clearDoneTodoItems(db, list);
    detail = (await todos.getTodoList(db, list))!;
    expect(detail.done).toEqual([]);
    expect((await todos.listTodoLists(db))[0]).toMatchObject({ openCount: 1, doneCount: 0 });
  });

  it("deletes a list with its items", async () => {
    const db = await newDb();
    const list = await todos.createTodoList(db, "Old");
    await todos.addTodoItem(db, list, "Thing");
    await todos.deleteTodoList(db, list);
    expect(await todos.listTodoLists(db)).toEqual([]);
    expect(await todos.getTodoList(db, list)).toBeUndefined();
    expect(await db.all("SELECT * FROM todo_item WHERE deleted = 0")).toEqual([]);
  });

  it("rejects empty names", async () => {
    const db = await newDb();
    await expect(todos.createTodoList(db, "   ")).rejects.toThrow("List name can't be empty.");
  });

  it("syncs lists and items between the phone and the desktop", async () => {
    const [phone, desktop] = [await newDb(), await newDb()];
    const list = await todos.createTodoList(phone, "Groceries");
    await todos.addTodoItem(phone, list, "Milk");
    await syncWithDesktop(phone, (request) => answerSync(desktop, request));

    expect((await todos.getTodoList(desktop, list))!.open.map((i) => i.text)).toEqual(["Milk"]);
  });
});
