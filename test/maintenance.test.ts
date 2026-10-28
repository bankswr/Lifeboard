import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import { generateMaintenanceTasks, latestDue, listMaintenance, nextDue, saveMaintenance, upcomingSeries, type MaintenanceItem } from "../src/core/maintenance.ts";
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

const base: MaintenanceItem = {
  id: "i", name: "Filter", notes: "", startDate: "2026-08-15", time: null, repeat: monthly,
  lastGenerated: null, waitsForTask: null, shiftedFrom: null, shiftedRepeat: null, activeWindow: null, weather: [],
};

/** The schedule after the latest task; fails if it's waiting or ended. */
function seriesOf(item: MaintenanceItem, last: Parameters<typeof upcomingSeries>[1] = null) {
  const series = upcomingSeries(item, last);
  if (!series || series === "waiting") throw new Error(`no series: ${series}`);
  return series;
}

describe("maintenance due dates", () => {
  it("finds the latest and next due dates", () => {
    const item = base;
    expect(latestDue(item, seriesOf(item), "2026-10-16")).toBe("2026-10-15");
    expect(latestDue(item, seriesOf(item), "2026-08-01")).toBeNull();
    expect(nextDue(item, seriesOf(item), "2026-10-16")).toBe("2026-11-15");
    expect(nextDue(item, seriesOf(item), "2026-10-15")).toBe("2026-10-15"); // today, no task yet
    const made = { ...item, lastGenerated: "2026-10-15" };
    expect(nextDue(made, seriesOf(made), "2026-10-15")).toBe("2026-11-15");
    const twice = { ...item, repeat: { ...monthly, end: { kind: "count" as const, count: 2 } } };
    expect(nextDue(twice, seriesOf(twice), "2026-10-01")).toBeNull(); // Aug 15 and Sep 15 only
  });

  it("goes back to the 31st after a short month", () => {
    const item = { ...base, startDate: "2026-01-31" };
    const dates = [];
    for (let today = "2026-02-01", made: MaintenanceItem = item; dates.length < 4; ) {
      const due = nextDue(made, seriesOf(made), today)!;
      dates.push(due);
      made = { ...made, lastGenerated: due };
      today = due;
    }
    expect(dates).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    const leap = { ...base, startDate: "2028-02-29", repeat: { ...monthly, freq: "yearly" as const } };
    expect(nextDue(leap, seriesOf(leap), "2029-01-01")).toBe("2029-02-28");
    expect(nextDue(leap, seriesOf(leap), "2032-01-01")).toBe("2032-02-29");
  });

  it("waits while the latest task is open and skips a deleted one", () => {
    const item = { ...base, lastGenerated: "2026-10-15", waitsForTask: "t" };
    expect(upcomingSeries(item, "open")).toBe("waiting");
    expect(nextDue(item, seriesOf(item, "gone"), "2026-10-20")).toBe("2026-11-15");
    expect(nextDue(item, seriesOf(item, { doneOn: "2026-10-15" }), "2026-10-20")).toBe("2026-11-15"); // on time
  });

  it("counts from the day a task was done, late or early", () => {
    const item = { ...base, lastGenerated: "2026-10-15", waitsForTask: "t" };
    expect(nextDue(item, seriesOf(item, { doneOn: "2026-10-25" }), "2026-10-25")).toBe("2026-11-25");
    expect(nextDue(item, seriesOf(item, { doneOn: "2026-10-12" }), "2026-10-15")).toBe("2026-11-12");
    const daily = { ...item, startDate: "2026-10-09", repeat: { ...monthly, freq: "daily" as const, interval: 3 } };
    expect(nextDue(daily, seriesOf(daily, { doneOn: "2026-10-17" }), "2026-10-17")).toBe("2026-10-20");
    const quarterly = { ...item, startDate: "2026-01-05", lastGenerated: "2026-01-05", repeat: { ...monthly, interval: 3 } };
    expect(nextDue(quarterly, seriesOf(quarterly, { doneOn: "2026-01-20" }), "2026-01-20")).toBe("2026-04-20");
  });

  it("keeps weekly items on their weekdays", () => {
    const weekly: Repeat = { freq: "weekly", interval: 1, weekdays: [0, 3], end: { kind: "never" } }; // Mon, Thu
    const item = { ...base, startDate: "2026-10-05", repeat: weekly, lastGenerated: "2026-10-12", waitsForTask: "t" }; // Mon
    expect(nextDue(item, seriesOf(item, { doneOn: "2026-10-14" }), "2026-10-14")).toBe("2026-10-15"); // Wed → Thu
    expect(nextDue(item, seriesOf(item, { doneOn: "2026-10-16" }), "2026-10-16")).toBe("2026-10-19"); // Fri → Mon
    expect(nextDue(item, seriesOf(item, { doneOn: "2026-10-10" }), "2026-10-12")).toBe("2026-10-15"); // early: as scheduled
    const fortnightly = { ...item, startDate: "2026-09-28", repeat: { ...weekly, interval: 2, weekdays: [0] } };
    expect(nextDue(fortnightly, seriesOf(fortnightly, { doneOn: "2026-10-14" }), "2026-10-14")).toBe("2026-10-26");
  });

  it("keeps counting down an \"after N times\" end and keeps an end date", () => {
    const thrice = { ...base, lastGenerated: "2026-09-15", waitsForTask: "t", repeat: { ...monthly, end: { kind: "count" as const, count: 3 } } };
    const moved = seriesOf(thrice, { doneOn: "2026-09-20" }); // the 2nd of 3
    expect(moved.repeat?.end).toEqual({ kind: "count", count: 1 });
    expect(nextDue(thrice, moved, "2026-09-20")).toBe("2026-10-20");
    expect(upcomingSeries({ ...thrice, lastGenerated: "2026-10-15" }, { doneOn: "2026-10-20" })).toBeNull(); // the last one
    const until = { ...thrice, repeat: { ...monthly, end: { kind: "until" as const, date: "2026-10-18" } } };
    expect(nextDue(until, seriesOf(until, { doneOn: "2026-09-20" }), "2026-09-20")).toBeNull(); // Oct 20 is after the end
  });
});

describe("maintenance active window", () => {
  /** The first `n` due dates, each made and done on its day. */
  function dueDates(item: MaintenanceItem, today: string, n: number): string[] {
    const dates: string[] = [];
    for (let made = item; dates.length < n; ) {
      const due = nextDue(made, seriesOf(made, made.lastGenerated ? { doneOn: made.lastGenerated } : null), today);
      if (!due) break;
      dates.push(due);
      made = { ...made, lastGenerated: due };
      today = due;
    }
    return dates;
  }
  const weekly: Repeat = { freq: "weekly", interval: 1, weekdays: [5], end: { kind: "never" } }; // Sat

  it("skips dates outside the window and restarts when it opens", () => {
    const item = { ...base, startDate: "2026-09-05", repeat: weekly, activeWindow: { from: "10-01", to: "10-31" } };
    expect(dueDates(item, "2026-09-01", 6)).toEqual(["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31", "2027-10-02"]);
    // Every 2 weeks: each October starts on its first Saturday, whatever last year's rhythm was.
    const fortnightly = { ...item, repeat: { ...weekly, interval: 2 } };
    expect(dueDates(fortnightly, "2026-09-01", 4)).toEqual(["2026-10-03", "2026-10-17", "2026-10-31", "2027-10-02"]);
  });

  it("restarts monthly items on the window's first day, and wraps over the new year", () => {
    const item = { ...base, startDate: "2026-06-15", activeWindow: { from: "11-15", to: "02-10" } };
    expect(dueDates(item, "2026-06-01", 5)).toEqual(["2026-11-15", "2026-12-15", "2027-01-15", "2027-11-15", "2027-12-15"]);
    const quarterly = { ...base, startDate: "2026-10-01", repeat: { ...monthly, interval: 3 }, activeWindow: { from: "10-01", to: "10-31" } };
    expect(dueDates(quarterly, "2026-09-01", 2)).toEqual(["2026-10-01", "2027-10-01"]);
  });

  it("counts only dates in the window toward an \"after N times\" end", () => {
    const item = { ...base, startDate: "2026-10-30", repeat: { ...monthly, freq: "daily" as const, end: { kind: "count" as const, count: 4 } }, activeWindow: { from: "10-01", to: "10-31" } };
    expect(dueDates(item, "2026-10-01", 10)).toEqual(["2026-10-30", "2026-10-31", "2027-10-01", "2027-10-02"]);
  });

  it("checks the window's days", async () => {
    const db = await newDb();
    const input = { name: "Mow", notes: "", startDate: "2026-10-01", time: null, repeat: weekly, weather: [] };
    await expect(saveMaintenance(db, { ...input, activeWindow: { from: "02-29", to: "03-31" } })).rejects.toThrow("active period");
    await expect(saveMaintenance(db, { ...input, activeWindow: { from: "04-31", to: "05-31" } })).rejects.toThrow("active period");
    expect(await saveMaintenance(db, { ...input, activeWindow: { from: "04-01", to: "02-28" } }, "2026-09-01")).toBeTruthy();
  });
});

describe("maintenance tasks", () => {
  it("adds a task on the day an item comes due, once", async () => {
    const db = await newDb();
    await saveMaintenance(db, { name: "Replace HVAC filter", notes: "20x25x1", startDate: "2026-10-20", time: "09:00", repeat: monthly, activeWindow: null, weather: [] }, "2026-10-16");
    expect(await db.all("SELECT id FROM task")).toEqual([]); // not due yet

    expect((await generateMaintenanceTasks(db, "2026-10-20")).added).toBe(1);
    expect((await generateMaintenanceTasks(db, "2026-10-20")).added).toBe(0);
    expect(await db.all("SELECT title, due, time FROM task")).toEqual([{ title: "Replace HVAC filter", due: "2026-10-20", time: "09:00" }]);
    expect((await listMaintenance(db, "2026-10-21"))[0]).toMatchObject({ nextDue: "2026-10-20", waiting: true }); // task open
    expect(await db.all("SELECT COUNT(*) AS n FROM schedule_change WHERE deleted = 0")).toEqual([{ n: 1 }]); // queued for Google
  });

  it("makes only the latest missed task after a gap, and waits for the task lists", async () => {
    const db = await newDb(false);
    const daily: Repeat = { freq: "daily", interval: 1, weekdays: [], end: { kind: "never" } };
    await saveMaintenance(db, { name: "Scoop", notes: "", startDate: "2026-10-01", time: null, repeat: daily, activeWindow: null, weather: [] }, "2026-10-01");
    expect((await generateMaintenanceTasks(db, "2026-10-05")).added).toBe(0); // no Google task list yet

    await db.run("INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)");
    expect((await generateMaintenanceTasks(db, "2026-10-05")).added).toBe(1);
    expect(await db.all("SELECT due FROM task")).toEqual([{ due: "2026-10-05" }]);
  });

  it("follows the task: waits while open, moves when done late, undoes on untick", async () => {
    const db = await newDb();
    const id = await saveMaintenance(db, { name: "Filter", notes: "", startDate: "2026-10-01", time: null, repeat: monthly, activeWindow: null, weather: [] }, "2026-10-01");
    expect(await db.all("SELECT id FROM task")).toEqual([{ id: `maint-${id}-2026-10-01` }]);

    expect((await generateMaintenanceTasks(db, "2026-11-02")).added).toBe(0); // still open: no Nov 1 task
    expect((await listMaintenance(db, "2026-11-02"))[0]).toMatchObject({ nextDue: "2026-10-01", waiting: true });

    await db.run("UPDATE task SET done = 1, completed_at = ?", [new Date(2026, 10, 2, 18).toISOString()]); // Nov 2, local
    expect((await listMaintenance(db, "2026-11-02"))[0]).toMatchObject({ nextDue: "2026-12-02", waiting: false });
    await db.run("UPDATE task SET done = 0, completed_at = NULL");
    expect((await listMaintenance(db, "2026-11-02"))[0].waiting).toBe(true);

    await db.run("UPDATE task SET done = 1, completed_at = ?", [new Date(2026, 10, 2, 18).toISOString()]);
    expect((await generateMaintenanceTasks(db, "2026-12-02")).added).toBe(1);
    expect((await db.all("SELECT due FROM task ORDER BY due")).map((row) => row.due)).toEqual(["2026-10-01", "2026-12-02"]);

    // Done on time from the moved schedule: it stays on the 2nd.
    await db.run("UPDATE task SET done = 1, completed_at = ? WHERE due = '2026-12-02'", [new Date(2026, 11, 2, 9).toISOString()]);
    expect((await listMaintenance(db, "2026-12-03"))[0].nextDue).toBe("2027-01-02");

    // Editing the schedule starts it over from the new start date.
    await saveMaintenance(db, { id, name: "Filter", notes: "", startDate: "2027-01-10", time: null, repeat: monthly, activeWindow: null, weather: [] }, "2026-12-03");
    expect((await listMaintenance(db, "2026-12-03"))[0].nextDue).toBe("2027-01-10");
  });
});
