import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import type { Db } from "../src/core/db/types.ts";
import { deleteEvent, saveEvent, saveTask, setTaskDone, type EventInput } from "../src/core/schedule/edit.ts";
import type { GoogleEvent, GoogleTask, ScheduleGoogle } from "../src/core/schedule/googleApi.ts";
import { GoogleGoneError } from "../src/core/schedule/googleApi.ts";
import { hasQueuedChanges, syncSchedule } from "../src/core/schedule/push.ts";
import { endRecurrenceBefore, fromRecurrence, nextTaskDue, toRRule, type Repeat } from "../src/core/schedule/repeat.ts";
import { getEvent, getSchedule, getTask, scheduleDays, type EventItem, type TaskItem } from "../src/core/schedule/store.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

const TODAY = "2026-10-16"; // a Friday

describe("repeat rules", () => {
  const weekly: Repeat = { freq: "weekly", interval: 2, weekdays: [0, 2], end: { kind: "count", count: 5 } };

  it("round-trips the form's rules through RRULE", () => {
    expect(toRRule(weekly, false)).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5");
    expect(fromRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5"])).toEqual(weekly);
    const yearly: Repeat = { freq: "yearly", interval: 1, weekdays: [], end: { kind: "until", date: "2030-01-01" } };
    expect(fromRecurrence([toRRule(yearly, true)])).toEqual(yearly);
  });

  it("keeps rules the form can't show as custom", () => {
    const rule = "RRULE:FREQ=MONTHLY;BYDAY=2TU";
    const repeat = fromRecurrence(["EXDATE:20261020", rule])!;
    expect(repeat.custom).toBe(rule);
    expect(toRRule(repeat, false)).toBe(rule);
  });

  it("ends a series just before an occurrence", () => {
    expect(endRecurrenceBefore(["RRULE:FREQ=DAILY;COUNT=30", "EXDATE:20261018"], "2026-10-20", true)).toEqual([
      "RRULE:FREQ=DAILY;UNTIL=20261019",
      "EXDATE:20261018",
    ]);
    expect(endRecurrenceBefore(["RRULE:FREQ=DAILY"], "2026-10-20T14:00:00.000Z", false)).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261020T135959Z"]);
  });

  it("finds a repeating task's next date", () => {
    expect(nextTaskDue(weekly, "2026-10-12")).toEqual({ due: "2026-10-14", repeat: { ...weekly, end: { kind: "count", count: 4 } } });
    expect(nextTaskDue(weekly, "2026-10-14")!.due).toBe("2026-10-26"); // Monday two weeks on
    const monthly: Repeat = { freq: "monthly", interval: 1, weekdays: [], end: { kind: "never" } };
    expect(nextTaskDue(monthly, "2026-01-31")!.due).toBe("2026-02-28");
    expect(nextTaskDue({ ...monthly, end: { kind: "count", count: 1 } }, "2026-01-31")).toBeNull();
    expect(nextTaskDue({ ...monthly, end: { kind: "until", date: "2026-02-01" } }, "2026-01-31")).toBeNull();
  });
});

describe("day layout", () => {
  const event = (fields: Partial<EventItem>): EventItem => ({
    id: fields.title!, calendarId: "c", title: "", location: "", notes: "", allDay: false, start: "", end: "", recurring: false, pending: false, ...fields,
  });
  const task = (fields: Partial<TaskItem>): TaskItem => ({
    id: fields.title!, listId: "l", title: "", notes: "", due: null, time: null, done: false, completedAt: null, repeat: null, pending: false, ...fields,
  });

  it("orders tasks, then all-day, then timed events, and puts overdue tasks on today", () => {
    const at = (h: number) => new Date(2026, 9, 16, h).toISOString();
    const days = scheduleDays(
      [
        event({ title: "Lunch", start: at(12), end: at(13) }),
        event({ title: "Breakfast", start: at(8), end: at(9) }),
        event({ title: "Trip", allDay: true, start: "2026-10-15", end: "2026-10-18" }),
      ],
      [
        task({ title: "Today task", due: TODAY }),
        task({ title: "Late task", due: "2026-10-10" }),
        task({ title: "No date" }),
        task({ title: "Done early", due: "2026-10-20", done: true, completedAt: at(9) }),
        task({ title: "Tomorrow", due: "2026-10-17" }),
      ],
      "2026-10-15", "2026-10-20", TODAY,
    );
    const today = days.find((d) => d.date === TODAY)!;
    expect(today.tasks.map((t) => [t.title, t.overdue])).toEqual([["Late task", true], ["No date", false], ["Today task", false]]);
    expect(today.allDay.map((e) => e.title)).toEqual(["Trip"]);
    expect(today.timed.map((e) => e.title)).toEqual(["Breakfast", "Lunch"]);
    expect(days.filter((d) => d.allDay.length).map((d) => d.date)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(days.find((d) => d.date === "2026-10-20")!.tasks.map((t) => t.title)).toEqual(["Done early"]);
  });
});

// ---------- a pretend Google ----------

function fakeGoogle() {
  let next = 1;
  const etag = () => `"e${next++}"`;
  const events = new Map<string, GoogleEvent>(); // by id; all in calendar "me@example.com"
  const tasks = new Map<string, GoogleTask>();
  const calls: string[] = [];
  const find = <T>(map: Map<string, T>, id: string) => {
    const item = map.get(id);
    if (!item) throw new GoogleGoneError("gone");
    return item;
  };
  const api: ScheduleGoogle = {
    async calendars() {
      return [{ id: "me@example.com", name: "Me", primary: true }, { id: "family", name: "Family", primary: false }];
    },
    async eventInstances(calendarId) {
      return calendarId === "me@example.com" ? [...events.values()].filter((e) => !e.recurrence?.length) : [];
    },
    async eventSeries(calendarId) {
      return calendarId === "me@example.com" ? [...events.values()].filter((e) => e.recurrence?.length) : [];
    },
    async getEvent(_c, id) {
      return find(events, id);
    },
    async insertEvent(_c, event) {
      calls.push(`insertEvent ${event.summary} ${JSON.stringify(event.recurrence ?? [])}`);
      const created = { ...event, id: `ev${next}`, etag: etag() };
      events.set(created.id, created);
      return created;
    },
    async patchEvent(_c, id, changes) {
      calls.push(`patchEvent ${id} ${JSON.stringify(changes.recurrence ?? null)}`);
      const updated = { ...find(events, id), ...changes, etag: etag() };
      events.set(id, updated);
      return updated;
    },
    async deleteEvent(_c, id) {
      calls.push(`deleteEvent ${id}`);
      find(events, id);
      events.delete(id);
    },
    async taskLists() {
      return [{ id: "list1", title: "My Tasks" }];
    },
    async tasks() {
      return [...tasks.values()];
    },
    async getTask(_l, id) {
      return find(tasks, id);
    },
    async insertTask(_l, task) {
      calls.push(`insertTask ${task.title} ${task.due}`);
      const created = { ...task, id: `t${next}`, etag: etag() };
      tasks.set(created.id, created);
      return created;
    },
    async patchTask(_l, id, changes) {
      calls.push(`patchTask ${id} ${changes.status}`);
      const updated = { ...find(tasks, id), ...changes, etag: etag() };
      tasks.set(id, updated);
      return updated;
    },
    async deleteTask(_l, id) {
      calls.push(`deleteTask ${id}`);
      tasks.delete(id);
    },
  };
  /** Changes an event as if edited in Google itself. */
  const editInGoogle = (id: string, changes: GoogleEvent) => events.set(id, { ...events.get(id)!, ...changes, etag: etag() });
  return { api, events, tasks, calls, editInGoogle };
}

async function newDb(): Promise<Db> {
  const db = openNodeDb(":memory:");
  await migrate(db);
  return db;
}

const lunch: EventInput = {
  title: "Lunch", location: "Cafe", notes: "", date: TODAY, allDay: false, startTime: "12:00", endTime: "13:00", repeat: null,
};

describe("Schedule and Google", () => {
  it("shows only the main calendar at first and reads its events and tasks", async () => {
    const google = fakeGoogle();
    google.events.set("a", { id: "a", etag: '"x"', summary: "Dentist", start: { date: TODAY }, end: { date: "2026-10-17" } });
    google.tasks.set("t", { id: "t", etag: '"y"', title: "Call", status: "needsAction", due: `${TODAY}T00:00:00.000Z` });
    const db = await newDb();
    await syncSchedule(db, google.api);

    expect(await db.all("SELECT id, included FROM calendar ORDER BY id")).toEqual([
      { id: "family", included: 0 }, { id: "me@example.com", included: 1 },
    ]);
    const today = (await getSchedule(db, TODAY, TODAY, TODAY))[0];
    expect(today.allDay.map((e) => e.title)).toEqual(["Dentist"]);
    expect(today.tasks.map((t) => t.title)).toEqual(["Call"]);
  });

  it("sends a new event to Google and keeps its row", async () => {
    const google = fakeGoogle();
    const db = await newDb();
    await syncSchedule(db, google.api); // reads the calendars first
    const id = await saveEvent(db, lunch);
    expect((await getEvent(db, id))!.pending).toBe(true);

    await syncSchedule(db, google.api);
    expect(google.calls).toEqual(["insertEvent Lunch []"]); // [] here: the fake prints a missing recurrence as []
    expect(await hasQueuedChanges(db)).toBe(false);
    const stored = await db.all("SELECT id, title FROM calendar_event WHERE deleted = 0");
    expect(stored).toEqual([{ id, title: "Lunch" }]); // the same row, now linked to Google
  });

  it("keeps Google's version when the event changed there first", async () => {
    const google = fakeGoogle();
    const db = await newDb();
    await syncSchedule(db, google.api);
    const id = await saveEvent(db, lunch);
    await syncSchedule(db, google.api);
    const googleId = (await db.all("SELECT google_id FROM calendar_event WHERE id = ?", [id]))[0].google_id;

    await saveEvent(db, { ...lunch, id, title: "Lunch with Sam" });
    google.editInGoogle(googleId, { summary: "Lunch moved" });
    const alerts = await syncSchedule(db, google.api);

    expect(alerts[0].message).toMatch(/"Lunch with Sam" was changed in Google/);
    expect((await getEvent(db, id))!.title).toBe("Lunch moved");
  });

  it("splits a series for 'this and following' and moves it for 'all'", async () => {
    const google = fakeGoogle();
    const series = {
      id: "s", etag: '"s1"', summary: "Standup", recurrence: ["RRULE:FREQ=DAILY"],
      start: { dateTime: "2026-10-12T14:00:00.000Z" }, end: { dateTime: "2026-10-12T14:15:00.000Z" },
    };
    google.events.set("s", series);
    // The fake lists series separately; add the occurrence the Schedule shows.
    const db = await newDb();
    await syncSchedule(db, google.api);
    await db.run(
      `INSERT INTO calendar_event (id, updated_at, updated_by, deleted, seq, calendar_id, google_id, recurring_id, is_series, title, location, notes,
        all_day, start_at, end_at, time_zone, recurrence, original_start, etag)
       VALUES ('occ', '2026-01-01', 'x', 0, 0, 'me@example.com', 's_20261016', 's', 0, 'Standup', '', '', 0, ?, ?, NULL, NULL, ?, '"o1"')`,
      ["2026-10-16T14:00:00.000Z", "2026-10-16T14:15:00.000Z", "2026-10-16T14:00:00.000Z"],
    );
    const input: EventInput = { id: "occ", title: "Standup", location: "", notes: "", date: TODAY, allDay: false,
      startTime: "10:00", endTime: "10:15", repeat: { freq: "daily", interval: 1, weekdays: [], end: { kind: "never" } } };

    await saveEvent(db, input, "following");
    await syncSchedule(db, google.api);
    expect(google.calls).toEqual([
      'patchEvent s ["RRULE:FREQ=DAILY;UNTIL=20261016T135959Z"]',
      'insertEvent Standup ["RRULE:FREQ=DAILY"]',
    ]);

    google.calls.length = 0;
    await db.run("UPDATE calendar_event SET deleted = 0 WHERE id = 'occ'");
    // Moving this Friday's occurrence to Saturday moves the whole series a day.
    await saveEvent(db, { ...input, date: "2026-10-17" }, "all");
    await syncSchedule(db, google.api);
    expect(google.calls).toEqual(['patchEvent s ["RRULE:FREQ=DAILY"]']);
    expect(google.events.get("s")!.start.dateTime).toBe(new Date(2026, 9, 13, 10, 0).toISOString());
  });

  it("deletes the rest of a series by ending it", async () => {
    const google = fakeGoogle();
    google.events.set("s", { id: "s", etag: '"s1"', summary: "Gym", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=10"], start: { date: "2026-10-02" }, end: { date: "2026-10-03" } });
    const db = await newDb();
    await syncSchedule(db, google.api);
    await db.run(
      `INSERT INTO calendar_event (id, updated_at, updated_by, deleted, seq, calendar_id, google_id, recurring_id, is_series, title, location, notes,
        all_day, start_at, end_at, time_zone, recurrence, original_start, etag)
       VALUES ('occ', '2026-01-01', 'x', 0, 0, 'me@example.com', 's_20261016', 's', 0, 'Gym', '', '', 1, ?, ?, NULL, NULL, ?, '"o1"')`,
      [TODAY, "2026-10-17", TODAY],
    );
    await deleteEvent(db, "occ", "following");
    expect(await getEvent(db, "occ")).toBeNull();
    await syncSchedule(db, google.api);
    expect(google.calls).toEqual(['patchEvent s ["RRULE:FREQ=WEEKLY;UNTIL=20261015"]']);
  });

  it("completes a repeating task and makes the next one, keeping Lifeboard-only times", async () => {
    const google = fakeGoogle();
    const db = await newDb();
    await syncSchedule(db, google.api);
    const id = await saveTask(db, {
      title: "Water plants", notes: "", date: TODAY, time: "18:30",
      repeat: { freq: "weekly", interval: 1, weekdays: [], end: { kind: "never" } },
    });
    await syncSchedule(db, google.api);
    await setTaskDone(db, id, true);
    await setTaskDone(db, id, false);
    await setTaskDone(db, id, true); // ticking again must not make a second next task
    await syncSchedule(db, google.api);

    expect(google.calls.filter((c) => c.startsWith("insertTask"))).toEqual([
      `insertTask Water plants ${TODAY}T00:00:00.000Z`,
      "insertTask Water plants 2026-10-23T00:00:00.000Z",
    ]);
    const open = (await getSchedule(db, "2026-10-23", "2026-10-23", TODAY))[0].tasks;
    expect(open.map((t) => [t.title, t.time, t.repeat?.freq])).toEqual([["Water plants", "18:30", "weekly"]]);
    expect((await getTask(db, id))!.done).toBe(true);
  });

  it("leaves the queue for the desktop on a device not signed in to Google", async () => {
    const db = await newDb();
    await db.run(
      "INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)",
    );
    await saveTask(db, { title: "Buy milk", notes: "", date: null, time: null, repeat: null });
    expect(await syncSchedule(db)).toEqual([]);
    expect(await hasQueuedChanges(db)).toBe(true);
  });
});
