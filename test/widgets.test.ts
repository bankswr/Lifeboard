import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import type { EventItem, ScheduleDay, TaskItem } from "../src/core/schedule/store.ts";
import { recordAlert } from "../src/core/rules.ts";
import * as todos from "../src/core/todos.ts";
import { calendarWidget, healthWidget, listWidgets, petsWidget, whenLabel, widgetSnapshot } from "../src/core/widgets.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

async function newDb() {
  const db = openNodeDb(":memory:");
  await migrate(db);
  return db;
}

// Local times, so the labels don't depend on the machine's time zone.
const now = new Date(2026, 9, 17, 9, 0); // Sat Oct 17, 9:00 AM

const task = (title: string, extra: Partial<TaskItem & { overdue: boolean }> = {}) => ({
  id: title, listId: "l", title, notes: "", due: "2026-10-17", time: null, done: false, completedAt: null,
  repeat: null, pending: false, overdue: false, ...extra,
});
const event = (title: string, start: string, allDay = false, end = start): EventItem => ({
  id: title, calendarId: "c", title, location: "", notes: "", allDay, start, end, recurring: false, pending: false,
});
const day = (date: string, parts: Partial<ScheduleDay> = {}): ScheduleDay => ({ date, tasks: [], allDay: [], timed: [], ...parts });

describe("widget snapshot", () => {
  it("labels times as fixed points, close ones by day name", () => {
    expect(whenLabel(new Date(2026, 9, 17, 15, 0), now, "en-US")).toBe("today 3:00 PM");
    expect(whenLabel(new Date(2026, 9, 18, 8, 30), now, "en-US")).toBe("tomorrow 8:30 AM");
    expect(whenLabel(new Date(2026, 9, 20, 15, 0), now, "en-US")).toBe("Tue 3:00 PM");
    expect(whenLabel(new Date(2026, 10, 2, 15, 0), now, "en-US")).toBe("Nov 2 3:00 PM");
  });

  it("calendar: today's open tasks and events, then upcoming events without tasks", () => {
    const days = [
      day("2026-10-17", {
        tasks: [task("Replace feliway", { overdue: true, due: "2026-10-12" }), task("Medicine", { time: "08:00" }), task("Done one", { done: true })],
        allDay: [event("Holiday", "2026-10-17", true, "2026-10-18")],
        timed: [event("Vet", new Date(2026, 9, 17, 14, 0).toISOString())],
      }),
      day("2026-10-18", { tasks: [task("Tomorrow's task", { due: "2026-10-18" })], timed: [event("Brunch", new Date(2026, 9, 18, 11, 0).toISOString())] }),
    ];
    const widget = calendarWidget(days, "2026-10-17", "en-US");
    expect(widget.rows.map((r) => [r.title, r.value ?? "", r.style])).toEqual([
      ["Today · Sat, Oct 17", "", "header"],
      ["Replace feliway", "", "alarm"],
      ["Medicine", "8:00 AM", "normal"],
      ["Holiday", "All day", "normal"],
      ["Vet", "2:00 PM", "normal"],
      ["Upcoming", "", "header"],
      ["Brunch", "Sun 11:00 AM", "normal"],
    ]);
    expect(widget.rows[1].sub).toBe("Overdue · was due Mon, Oct 12");
    // Task rows can be ticked on the widget; event and header rows can't.
    expect(widget.rows.filter((r) => r.itemId).map((r) => [r.itemId, r.done])).toEqual([["Replace feliway", false], ["Medicine", false]]);
  });

  it("pets: due times as fixed points, 'now' once reached, learning without an estimate", () => {
    const widget = petsWidget({
      devices: [{ id: "lr", kind: "litter_robot", name: "LR", updatedAt: "", data: { name: "Litter-Robot 4", serial: "S1", status: "Ready", drawerFull: false } }],
      litter: { S1: { serial: "S1", drawer: { at: new Date(2026, 9, 20, 15, 0).toISOString(), ratePerDay: 5, reached: false }, litter: { at: null, ratePerDay: null, reached: true } } },
      food: {},
      fountain: { lastRefill: null, fillDays: null, daysLeft: null, percentLeft: null, state: "ok" },
    }, now, "en-US");
    expect(widget.rows.map((r) => [r.title, r.value, r.style])).toEqual([
      ["Litter-Robot 4", "Ready", "header"],
      ["Drawer full", "≈ Tue 3:00 PM", "normal"],
      ["Litter low", "now", "alarm"],
      ["Water fountain", undefined, "header"],
      ["Water out", "learning", "muted"],
    ]);
  });

  it("health: the four targets, or an empty message before there are any", () => {
    expect(healthWidget(null).rows).toEqual([]);
  });

  it("lists: to-do lists only, open items first, each row tickable", async () => {
    const db = await newDb();
    const groceries = await todos.createTodoList(db, "Groceries");
    await todos.createTodoList(db, "Packing template", "prototype");
    const milk = await todos.addTodoItem(db, groceries, "Milk");
    await todos.addTodoItem(db, groceries, "Eggs");
    await todos.setTodoItemDone(db, milk, true);
    const lists = listWidgets(await todos.getAllTodoLists(db));
    expect(lists.map((l) => l.title)).toEqual(["Groceries"]);
    expect(lists[0].rows.map((r) => [r.title, r.done])).toEqual([["Eggs", false], ["Milk", true]]);
    expect(lists[0].rows[0].itemId).toBeTruthy();
  });

  it("gathers everything from the database", async () => {
    const db = await newDb();
    await recordAlert(db, "Whisker", "Litter-Robot: drawer 95% full.");
    const snapshot = await widgetSnapshot(db, now);
    expect(snapshot.alerts.rows.map((r) => r.title)).toEqual(["Litter-Robot: drawer 95% full."]);
    expect(snapshot.health.rows).toEqual([]); // no health data yet
    expect(snapshot.calendar.rows[0].style).toBe("header");
    expect(snapshot.takenAt).toBe(now.toISOString());
  });
});
