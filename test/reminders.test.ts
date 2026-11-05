import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import { markReminderHandled, notificationId, snoozeReminder, takeLateReminders, upcomingReminders } from "../src/core/reminders.ts";
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
const dateOnly = (title: string, date: string) => ({ title, notes: "", date, time: null, repeat: null });

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
      { taskId: later, title: "Take meds", at: new Date(2026, 9, 17, 20, 0).toISOString(), notificationId: notificationId(later), snoozed: false, timed: true },
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

  it("returns late reminders once, skipping ones still showing", async () => {
    const db = await newDb();
    expect(await takeLateReminders(db, [], now)).toEqual([]); // first check: only records the time
    const missed = await saveTask(db, task("Missed it", "2026-10-17", "10:00"));
    const showing = await saveTask(db, task("Still in the shade", "2026-10-17", "10:30"));
    await saveTask(db, task("Not yet", "2026-10-17", "13:00"));
    const done = await saveTask(db, task("Done anyway", "2026-10-17", "10:15"));
    await setTaskDone(db, done, true);

    const later = new Date(2026, 9, 17, 12, 0);
    const result = await takeLateReminders(db, [showing], later);
    expect(result.map((r) => r.taskId)).toEqual([missed]);
    expect(await takeLateReminders(db, [], later)).toEqual([]); // already returned
  });

  it("brings up old reminders too, once", async () => {
    const db = await newDb();
    await takeLateReminders(db, [], new Date(2026, 9, 10, 9, 0));
    const old = await saveTask(db, task("Long ago", "2026-10-11", "09:00"));
    const recent = await saveTask(db, task("Yesterday", "2026-10-16", "18:00"));
    expect((await takeLateReminders(db, [], now)).map((r) => r.taskId)).toEqual([old, recent]);
    expect(await takeLateReminders(db, [], now)).toEqual([]);
  });

  it("reminds of a date-only task at 8 AM", async () => {
    const db = await newDb();
    const id = await saveTask(db, dateOnly("No time", "2026-10-18"));
    const [reminder] = await upcomingReminders(db, now);
    expect(reminder.taskId).toBe(id);
    expect(reminder.at).toBe(new Date(2026, 9, 18, 8, 0).toISOString());
    expect(reminder.timed).toBe(false);
  });

  it("notifies a task that arrives after a check later than its reminder time", async () => {
    const db = await newDb();
    await takeLateReminders(db, [], now); // 9:00, before the task exists
    const timed = await saveTask(db, task("Morning", "2026-10-17", "07:30"));
    const untimed = await saveTask(db, dateOnly("Refill", "2026-10-17"));
    const result = await takeLateReminders(db, [], new Date(2026, 9, 17, 14, 0));
    expect(result.map((r) => r.taskId)).toEqual([timed, untimed]);
  });

  it("stays quiet on a new install's first check, later ones included", async () => {
    const db = await newDb();
    await saveTask(db, task("Old", "2026-10-16", "08:00"));
    expect(await takeLateReminders(db, [], now)).toEqual([]);
    expect(await takeLateReminders(db, [], new Date(2026, 9, 17, 10, 0))).toEqual([]);
  });

  it("doesn't bring back a reminder that was showing", async () => {
    const db = await newDb();
    await takeLateReminders(db, [], now);
    const id = await saveTask(db, task("Showing", "2026-10-17", "10:00"));
    expect(await takeLateReminders(db, [id], new Date(2026, 9, 17, 11, 0))).toEqual([]);
    expect(await takeLateReminders(db, [], new Date(2026, 9, 17, 12, 0))).toEqual([]);
  });

  it("doesn't repeat a task's reminder after a snooze ends, and does for a later time", async () => {
    const db = await newDb();
    await takeLateReminders(db, [], now);
    const id = await saveTask(db, task("Snoozed", "2026-10-17", "08:00"));
    expect(await takeLateReminders(db, [], now)).toHaveLength(1);
    await snoozeReminder(db, id, now);
    const afterSnooze = new Date(2026, 9, 17, 9, 30);
    const snoozed = await takeLateReminders(db, [], afterSnooze);
    expect(snoozed.map((r) => r.snoozed)).toEqual([true]);
    await snoozeReminder(db, "another", new Date(2026, 9, 17, 10, 0)); // drops the ended snooze
    expect(await takeLateReminders(db, [], new Date(2026, 9, 17, 11, 0))).toEqual([]);

    await saveTask(db, { ...task("Snoozed", "2026-10-17", "11:30"), id });
    expect(await takeLateReminders(db, [], new Date(2026, 9, 17, 12, 0))).toHaveLength(1);
  });

  it("doesn't notify a task typed in with its time already passed", async () => {
    const db = await newDb();
    await takeLateReminders(db, [], now);
    const typed = await saveTask(db, dateOnly("Just typed", "2026-10-17"));
    await markReminderHandled(db, typed, now);
    const ahead = await saveTask(db, task("Still ahead", "2026-10-17", "10:00"));
    await markReminderHandled(db, ahead, now);
    const result = await takeLateReminders(db, [], new Date(2026, 9, 17, 11, 0));
    expect(result.map((r) => r.taskId)).toEqual([ahead]);
  });
});
