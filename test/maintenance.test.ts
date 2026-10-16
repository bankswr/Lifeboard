import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import { generateMaintenanceTasks, latestDue, listMaintenance, nextDue, saveMaintenance } from "../src/core/maintenance.ts";
import type { Repeat } from "../src/core/schedule/repeat.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

const monthly: Repeat = { freq: "monthly", interval: 1, weekdays: [], end: { kind: "never" } };

async function newDb(withTaskList = true) {
  const db = openNodeDb(":memory:");
  await migrate(db);
  if (withTaskList) {
    await db.run("INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)");
  }
  return db;
}

describe("maintenance due dates", () => {
  it("finds the latest and next due dates", () => {
    const item = { id: "i", name: "Filter", notes: "", startDate: "2026-08-15", time: null, repeat: monthly, lastGenerated: null };
    expect(latestDue(item, "2026-10-16")).toBe("2026-10-15");
    expect(latestDue(item, "2026-08-01")).toBeNull();
    expect(nextDue(item, "2026-10-16")).toBe("2026-11-15");
    expect(nextDue({ ...item, lastGenerated: null }, "2026-10-15")).toBe("2026-10-15"); // today, no task yet
    expect(nextDue({ ...item, lastGenerated: "2026-10-15" }, "2026-10-15")).toBe("2026-11-15");
    const twice = { ...item, repeat: { ...monthly, end: { kind: "count" as const, count: 2 } } };
    expect(nextDue(twice, "2026-10-01")).toBeNull(); // Aug 15 and Sep 15 only
  });
});

describe("maintenance tasks", () => {
  it("adds a task on the day an item comes due, once", async () => {
    const db = await newDb();
    await saveMaintenance(db, { name: "Replace HVAC filter", notes: "20x25x1", startDate: "2026-10-20", time: "09:00", repeat: monthly }, "2026-10-16");
    expect(await db.all("SELECT id FROM task")).toEqual([]); // not due yet

    expect(await generateMaintenanceTasks(db, "2026-10-20")).toBe(1);
    expect(await generateMaintenanceTasks(db, "2026-10-20")).toBe(0);
    expect(await db.all("SELECT title, due, time FROM task")).toEqual([{ title: "Replace HVAC filter", due: "2026-10-20", time: "09:00" }]);
    expect((await listMaintenance(db, "2026-10-21"))[0].nextDue).toBe("2026-11-20");
    expect(await db.all("SELECT COUNT(*) AS n FROM schedule_change WHERE deleted = 0")).toEqual([{ n: 1 }]); // queued for Google
  });

  it("makes only the latest missed task after a gap, and waits for the task lists", async () => {
    const db = await newDb(false);
    const daily: Repeat = { freq: "daily", interval: 1, weekdays: [], end: { kind: "never" } };
    await saveMaintenance(db, { name: "Scoop", notes: "", startDate: "2026-10-01", time: null, repeat: daily }, "2026-10-01");
    expect(await generateMaintenanceTasks(db, "2026-10-05")).toBe(0); // no Google task list yet

    await db.run("INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)");
    expect(await generateMaintenanceTasks(db, "2026-10-05")).toBe(1);
    expect(await db.all("SELECT due FROM task")).toEqual([{ due: "2026-10-05" }]);
  });
});
