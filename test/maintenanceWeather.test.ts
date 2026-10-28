import { describe, expect, it } from "vitest";
import { addDays } from "../src/core/dates.ts";
import { migrate } from "../src/core/db/schema.ts";
import { generateMaintenanceTasks, listMaintenance, saveMaintenance, type MaintenanceInput } from "../src/core/maintenance.ts";
import { weatherMove, type WeatherCondition } from "../src/core/maintenanceWeather.ts";
import type { Repeat } from "../src/core/schedule/repeat.ts";
import { saveForecast, type WeatherDay } from "../src/core/weather.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

/** A forecast from `first`, one day per chance of rain, 60°F highs. */
function forecast(first: string, rainChances: (number | null)[]): WeatherDay[] {
  return rainChances.map((rainChance, index) => ({
    date: addDays(first, index), highF: 60, lowF: 40, humidity: 70, rainChance, rainIn: 0,
  }));
}

const noRain: WeatherCondition = { kind: "avoid", measure: "rainChance", op: ">", value: 30, lead: 0, lag: 0 };

describe("weather moves", () => {
  // 2026-10-26 is a Monday; index 5 is Sat Oct 31.
  const week = (chances: (number | null)[]) => forecast("2026-10-26", chances);

  it("keeps a day that fits and moves one that doesn't to the nearest, earlier on a tie", () => {
    expect(weatherMove("2026-10-31", [noRain], week([0, 0, 0, 0, 0, 0, 0]), "2026-10-26", null)).toEqual({ date: "2026-10-31", reason: null });
    expect(weatherMove("2026-10-31", [noRain], week([0, 0, 0, 0, 0, 60, 0]), "2026-10-26", null)).toEqual({ date: "2026-10-30", reason: "rain 60%" });
    expect(weatherMove("2026-10-31", [noRain], week([0, 0, 0, 0, 50, 60, 0]), "2026-10-26", null).date).toBe("2026-11-01");
  });

  it("rules out days after (lag) and before (lead) a ruling day", () => {
    const dayAfterToo = { ...noRain, lag: 1 };
    // Rain Fri: Fri and Sat out; Sun is nearer than Thu.
    expect(weatherMove("2026-10-31", [dayAfterToo], week([0, 0, 0, 0, 60, 0, 0]), "2026-10-26", null))
      .toEqual({ date: "2026-11-01", reason: "rain 60% on Fri" });
    const dayBeforeToo = { ...noRain, lead: 1 };
    expect(weatherMove("2026-10-31", [dayBeforeToo], week([0, 0, 0, 0, 0, 0, 60]), "2026-10-26", null).date).toBe("2026-10-30");
  });

  it("rules out days that don't meet an \"only\" condition", () => {
    const warm: WeatherCondition = { kind: "only", measure: "highF", op: ">", value: 50, lead: 0, lag: 0 };
    const days = week([0, 0, 0, 0, 0, 0, 0]).map((day) => (day.date === "2026-10-31" ? { ...day, highF: 45 } : day));
    expect(weatherMove("2026-10-31", [warm], days, "2026-10-26", null)).toEqual({ date: "2026-10-30", reason: "high 45°F" });
  });

  it("stays within its bounds and the forecast", () => {
    // Not before `earliest` (today), so a rainy today moves on to tomorrow.
    expect(weatherMove("2026-10-26", [noRain], week([60, 0, 0]), "2026-10-26", null).date).toBe("2026-10-27");
    // Not after `latest` (the end of the active window).
    expect(weatherMove("2026-10-30", [noRain], week([60, 60, 60, 60, 60, 0, 0]), "2026-10-26", "2026-10-30")).toEqual({ date: null, reason: "rain 60%" });
    // Past the forecast: can't be judged yet, so it keeps its date.
    expect(weatherMove("2026-11-20", [noRain], week([60]), "2026-10-26", null).date).toBe("2026-11-20");
    // Nothing fits in the forecast.
    expect(weatherMove("2026-10-28", [noRain], week([60, 60, 60, 60]), "2026-10-26", null).date).toBeNull();
  });

  it("lets a day without a value through", () => {
    expect(weatherMove("2026-10-31", [{ ...noRain, lag: 1 }], week([0, 0, 0, 0, null, null, 0]), "2026-10-26", null).date).toBe("2026-10-31");
  });
});

describe("maintenance with weather", () => {
  const weekly: Repeat = { freq: "weekly", interval: 1, weekdays: [5], end: { kind: "never" } }; // Sat
  const mow: MaintenanceInput = { name: "Mow", notes: "", startDate: "2026-10-31", time: null, repeat: weekly, activeWindow: null, weather: [noRain] };

  async function newDb() {
    const db = openNodeDb(":memory:");
    await migrate(db);
    await db.run("INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)");
    return db;
  }

  /** Saves a fresh forecast starting Mon Oct 26 (16 days). */
  async function setForecast(db: Awaited<ReturnType<typeof newDb>>, chances: number[], fetchedAt = new Date()) {
    const days = forecast("2026-10-26", [...chances, ...Array(16 - chances.length).fill(0)]);
    await saveForecast(db, { fetchedAt: fetchedAt.toISOString(), days });
  }

  it("makes the task early on the moved day, with the scheduled date's id and the reason", async () => {
    const db = await newDb();
    await setForecast(db, [0, 0, 0, 0, 0, 70, 0]); // rain Sat
    const id = await saveMaintenance(db, mow, "2026-10-26");
    expect((await listMaintenance(db, "2026-10-26"))[0]).toMatchObject({
      nextDue: "2026-10-30", weatherPlan: { movedFrom: "2026-10-31", reason: "rain 70%", noDay: false },
    });
    expect((await generateMaintenanceTasks(db, "2026-10-29")).added).toBe(0);
    expect((await generateMaintenanceTasks(db, "2026-10-30")).added).toBe(1);
    const [task] = await db.all("SELECT id, due, notes FROM task");
    expect(task).toEqual({ id: `maint-${id}-2026-10-31`, due: "2026-10-30", notes: "Moved from Sat Oct 31: rain 70%.\n(Maintenance item from Lifeboard)" });

    // Done on its moved day: back to Saturdays.
    await db.run("UPDATE task SET done = 1, completed_at = ?", [new Date(2026, 9, 30, 12).toISOString()]);
    expect((await listMaintenance(db, "2026-10-30"))[0].nextDue).toBe("2026-11-07");
  });

  it("follows the newest forecast until the task is made", async () => {
    const db = await newDb();
    await setForecast(db, [0, 0, 0, 0, 0, 70, 0]);
    await saveMaintenance(db, mow, "2026-10-26");
    await setForecast(db, [0, 0, 0, 0, 0, 0, 0]); // the rain went away
    expect((await listMaintenance(db, "2026-10-26"))[0]).toMatchObject({ nextDue: "2026-10-31", weatherPlan: { movedFrom: null } });
  });

  it("skips a weekly date the weather moved it past", async () => {
    const db = await newDb();
    // Rain every day from Fri Oct 30 to Sat Nov 7 except Sun Nov 8.
    await setForecast(db, [0, 0, 0, 0, 70, 70, 70, 70, 70, 70, 70, 70, 70, 0]);
    await saveMaintenance(db, { ...mow, startDate: "2026-10-31" }, "2026-10-31");
    expect((await generateMaintenanceTasks(db, "2026-11-07")).added).toBe(0);
    expect((await generateMaintenanceTasks(db, "2026-11-08")).added).toBe(1);
    expect((await db.all("SELECT id, due FROM task"))[0].due).toBe("2026-11-08");
    await db.run("UPDATE task SET done = 1, completed_at = ?", [new Date(2026, 10, 8, 12).toISOString()]);
    expect((await listMaintenance(db, "2026-11-08"))[0].nextDue).toBe("2026-11-14");
  });

  it("waits and alerts once when no day fits, then makes the task when one does", async () => {
    const db = await newDb();
    await setForecast(db, Array(16).fill(70));
    await saveMaintenance(db, mow, "2026-10-26");
    const first = await generateMaintenanceTasks(db, "2026-10-31");
    expect(first.added).toBe(0);
    expect(first.alerts.map((alert) => alert.message)).toEqual([expect.stringContaining("Mow: waiting for suitable weather (rain 70%)")]);
    expect((await generateMaintenanceTasks(db, "2026-10-31")).alerts).toEqual([]); // once
    expect((await listMaintenance(db, "2026-10-31"))[0].weatherPlan).toMatchObject({ noDay: true });

    await setForecast(db, [70, 70, 70, 70, 70, 70, 0]); // Sun Nov 1 clears
    expect((await generateMaintenanceTasks(db, "2026-11-01")).added).toBe(1);
  });

  it("drops a date when no day fits before the active period ends", async () => {
    const db = await newDb();
    await setForecast(db, Array(16).fill(70));
    await saveMaintenance(db, { ...mow, activeWindow: { from: "10-01", to: "11-02" } }, "2026-10-26");
    const result = await generateMaintenanceTasks(db, "2026-10-31");
    expect(result.added).toBe(0);
    expect(result.alerts.map((alert) => alert.message)).toEqual([expect.stringContaining("Mow: skipped until its active period comes round again")]);
    expect((await listMaintenance(db, "2026-10-31"))[0].nextDue).toBe("2027-10-02"); // next year's first Saturday
  });

  it("keeps the usual date when the forecast is stale", async () => {
    const db = await newDb();
    await setForecast(db, [0, 0, 0, 0, 0, 70, 0], new Date(Date.now() - 2 * 86_400_000));
    await saveMaintenance(db, mow, "2026-10-26");
    expect((await listMaintenance(db, "2026-10-26"))[0]).toMatchObject({ nextDue: "2026-10-31", weatherPlan: null });
  });
});
