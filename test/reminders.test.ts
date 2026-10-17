import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import { notificationId, snoozeReminder, takeMissedReminders, upcomingReminders } from "../src/core/reminders.ts";
import { saveTask, setTaskDone } from "../src/core/schedule/edit.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

async function newDb() {
  const db = openNodeDb(":memory:");
  await migrate(db);
  await db.run(
    "INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)",
  );
  return db;
}

// Local times throughout, so the tests don't depend on the machine's time zone.
const now = new Date(2026, 9, 17, 9, 0);
const task = (title: string, date: string, time: string) => ({ title, notes: "", date, time, repeat: null });

describe("task reminders", () => {
  it("reminds of open tasks with a time still ahead, at that time", async () => {
    const db = await newDb();
    const later = await saveTask(db, task("Take meds", "2026-10-17", "20:00"));
    await saveTask(db, task("Already past", "2026-10-17", "08:00"));
    await saveTask(db, { title: "No time", notes: "", date: "2026-10-17", time: "", repeat: null });
    const done = await saveTask(db, task("Done already", "2026-10-17", "21:00"));
    await setTaskDone(db, done, true);
    await saveTask(db, task("Too far ahead", "2026-11-30", "09:00"));

    const reminders = await upcomingReminders(db, now);
    expect(reminders).toEqual([
      { taskId: later, title: "Take meds", at: new Date(2026, 9, 17, 20, 0).toISOString(), notificationId: notificationId(later), snoozed: false },
    ]);
  });

  it("snoozes a reminder 10 minutes from now, even after its own time", async () => {
    const db = await newDb();
    const id = await saveTask(db, task("Call the vet", "2026-10-17", "09:00"));
    expect(await upcomingReminders(db, now)).toEqual([]); // 09:00 is now: not ahead

    await snoozeReminder(db, id, now);
    const [reminder] = await upcomingReminders(db, now);
    expect(reminder).toMatchObject({ taskId: id, at: new Date(2026, 9, 17, 9, 10).toISOString(), snoozed: true });
    // Once its snooze time has passed, nothing is left to schedule.
    expect(await upcomingReminders(db, new Date(2026, 9, 17, 9, 11))).toEqual([]);
  });

  it("gives each task a stable id outside the alert ids' range", () => {
    const id = notificationId("6f1c2d0e-1111-4c4c-9999-123456789abc");
    expect(id).toBe(notificationId("6f1c2d0e-1111-4c4c-9999-123456789abc"));
    expect(id).toBeGreaterThanOrEqual(1_000_000_000);
    expect(id).toBeLessThanOrEqual(2_147_483_647);
  });

  it("returns reminders missed since the last check once, skipping ones still showing", async () => {
    const db = await newDb();
    expect(await takeMissedReminders(db, [], now)).toEqual([]); // first check: only records the time
    const missed = await saveTask(db, task("Missed it", "2026-10-17", "10:00"));
    const showing = await saveTask(db, task("Still in the shade", "2026-10-17", "10:30"));
    await saveTask(db, task("Not yet", "2026-10-17", "13:00"));
    const done = await saveTask(db, task("Done anyway", "2026-10-17", "10:15"));
    await setTaskDone(db, done, true);

    const later = new Date(2026, 9, 17, 12, 0);
    const result = await takeMissedReminders(db, [showing], later);
    expect(result.map((r) => r.taskId)).toEqual([missed]);
    expect(await takeMissedReminders(db, [], later)).toEqual([]); // already returned
  });

  it("doesn't bring up reminders older than 48 hours", async () => {
    const db = await newDb();
    await takeMissedReminders(db, [], new Date(2026, 9, 10, 9, 0));
    await saveTask(db, task("Long ago", "2026-10-11", "09:00"));
    const recent = await saveTask(db, task("Yesterday", "2026-10-16", "18:00"));
    expect((await takeMissedReminders(db, [], now)).map((r) => r.taskId)).toEqual([recent]);
  });
});
