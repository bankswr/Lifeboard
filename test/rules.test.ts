import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import { checkFountainAlarm, estimateFountain, fountainFillDays, refillFountain, saveFountainSettings } from "../src/core/fountain.ts";
import type { Db } from "../src/core/db/types.ts";
import type { Reading } from "../src/core/readings.ts";
import { dismissAlert, dismissAllAlerts, evaluateRules, fillMessage, listRules, recentAlerts, recordAlert, saveRule } from "../src/core/rules.ts";
import { answerSync, syncWithDesktop } from "../src/core/sync/sync.ts";
import { SignedOutError, type Integration } from "../src/core/integration.ts";
import { isUpdateDue, listConnections, runUpdate } from "../src/core/updates.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

async function newDb() {
  const db = openNodeDb(":memory:");
  await migrate(db);
  return db;
}

/** A pretend integration whose next update does whatever `behave` says. */
function fakeIntegration(behave: () => Reading[]): Integration {
  return { id: "fake", name: "Fake service", signInMethod: "password", isSetUp: async () => true, update: async () => behave() };
}

describe("updates and the default sign-in rule", () => {
  it("alerts once when a sign-in is lost, and again only after it recovered and was lost again", async () => {
    const db = await newDb();
    let signedIn = true;
    const service = fakeIntegration(() => {
      if (!signedIn) throw new SignedOutError("Sign in again.");
      return [];
    });

    expect((await runUpdate(db, [service])).alerts).toEqual([]);
    signedIn = false;
    const lost = await runUpdate(db, [service]);
    expect(lost.alerts.map((a) => a.message)).toEqual(["Fake service: signed_out. Sign in again."]);
    expect(lost.connections[0]).toMatchObject({ status: "signed_out", message: "Sign in again." });
    expect((await runUpdate(db, [service])).alerts).toEqual([]); // still signed out: no repeat

    signedIn = true;
    await runUpdate(db, [service]);
    signedIn = false;
    expect((await runUpdate(db, [service])).alerts).toHaveLength(1);
    expect(await recentAlerts(db)).toHaveLength(2);
  });

  it("treats other failures as errors and keeps the last success time", async () => {
    const db = await newDb();
    let fail = false;
    const service = fakeIntegration(() => {
      if (fail) throw new Error("Server said 500");
      return [];
    });
    await runUpdate(db, [service]);
    const okAt = (await listConnections(db))[0].lastSuccessAt;
    fail = true;
    const result = await runUpdate(db, [service]);
    expect(result.connections[0]).toMatchObject({ status: "error", lastSuccessAt: okAt });
    expect(result.alerts[0].message).toBe("Fake service: error. Server said 500");
  });

  it("skips integrations that aren't set up", async () => {
    const db = await newDb();
    const service = { ...fakeIntegration(() => []), isSetUp: async () => false };
    expect((await runUpdate(db, [service])).connections).toEqual([]);
  });
});

describe("custom rules", () => {
  async function drawerRule(db: Db) {
    return saveRule(db, {
      name: "Drawer nearly full",
      enabled: true,
      readingType: "connection", // any known type works for testing the engine
      conditions: [{ field: "status", operator: "equals", value: "connected" }],
      message: "{subject} is fine",
    });
  }

  it("needs every condition to hold", async () => {
    const db = await newDb();
    await saveRule(db, {
      name: "Two conditions",
      enabled: true,
      readingType: "connection",
      conditions: [
        { field: "status", operator: "equals", value: "error" },
        { field: "message", operator: "equals", value: "timeout" },
      ],
      message: "{subject} timed out",
    });
    const reading = (message: string): Reading => ({ type: "connection", subject: "A", data: { status: "error", message } });
    const alerts = await evaluateRules(db, [reading("other")]);
    expect(alerts.filter((a) => a.message === "A timed out")).toEqual([]);
    expect((await evaluateRules(db, [reading("timeout")])).map((a) => a.message)).toContain("A timed out");
  });

  it("does not alert for disabled rules", async () => {
    const db = await newDb();
    const id = await drawerRule(db);
    const rule = (await listRules(db)).find((r) => r.id === id)!;
    await saveRule(db, { ...rule, enabled: false });
    const alerts = await evaluateRules(db, [{ type: "connection", subject: "A", data: { status: "connected" } }]);
    expect(alerts).toEqual([]);
  });

  it("rejects rules it can't evaluate", async () => {
    const db = await newDb();
    const base = { name: "x", enabled: true, readingType: "connection", conditions: [], message: "m" };
    await expect(saveRule(db, { ...base, readingType: "nope" })).rejects.toThrow(/watches/);
    await expect(saveRule(db, { ...base, name: " " })).rejects.toThrow(/name/);
    await expect(
      saveRule(db, { ...base, conditions: [{ field: "colour", operator: "equals", value: "red" }] }),
    ).rejects.toThrow(/Unknown field/);
  });

  it("compares numbers as numbers", async () => {
    const { conditionHolds } = await import("../src/core/rules.ts");
    expect(conditionHolds({ field: "level", operator: "greater", value: 80 }, { level: 85 })).toBe(true);
    expect(conditionHolds({ field: "level", operator: "greater", value: 80 }, { level: "9" })).toBe(false);
    expect(conditionHolds({ field: "missing", operator: "not_equals", value: 1 }, {})).toBe(false);
  });

  it("fills message placeholders and leaves unknown ones", () => {
    const reading: Reading = { type: "x", subject: "Litter-Robot", data: { level: 85 } };
    expect(fillMessage("{subject}: {level}% {nope}", reading)).toBe("Litter-Robot: 85% {nope}");
  });

  it("syncs rules, and the default rule doesn't duplicate", async () => {
    const [phone, desktop] = [await newDb(), await newDb()];
    await drawerRule(phone);
    await syncWithDesktop(phone, (request) => answerSync(desktop, request));
    await syncWithDesktop(phone, (request) => answerSync(desktop, request));
    const desktopRules = await listRules(desktop);
    expect(desktopRules.map((r) => r.name)).toContain("Drawer nearly full");
    expect(new Set(desktopRules.map((r) => r.name)).size).toBe(desktopRules.length); // no duplicates
    expect(await listRules(phone)).toEqual(desktopRules);
  });
});

describe("isUpdateDue", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it("is due when never updated or more than 12 hours ago", () => {
    expect(isUpdateDue(null, now)).toBe(true);
    expect(isUpdateDue("2026-10-14T23:59:00Z", now)).toBe(true);
    expect(isUpdateDue("2026-10-15T01:00:00Z", now)).toBe(false);
  });
});

describe("dismissing alerts", () => {
  it("hides dismissed alerts from the recent list", async () => {
    const db = openNodeDb(":memory:");
    await migrate(db);
    await recordAlert(db, "Schedule", "first");
    await recordAlert(db, "Schedule", "second");
    await recordAlert(db, "Schedule", "third");
    const [third] = await recentAlerts(db);
    await dismissAlert(db, third.id);
    expect((await recentAlerts(db)).map((a) => a.message)).toEqual(["second", "first"]);
    await dismissAllAlerts(db);
    expect(await recentAlerts(db)).toEqual([]);
  });
});

describe("water fountain", () => {
  const day = (n: number, hour = 9) => new Date(2026, 9, n, hour);

  it("learns how long a fill lasts from refills, the first being only a starting point", async () => {
    const db = openNodeDb(":memory:");
    await migrate(db);
    await refillFountain(db, day(16));
    expect(await estimateFountain(db, day(17))).toMatchObject({ lastRefill: day(16).toISOString(), fillDays: null, percentLeft: null });

    await refillFountain(db, day(20)); // 4 days
    await refillFountain(db, day(20, 10)); // double press: ignored
    await refillFountain(db, day(26)); // 6 days (from the double press, ~5.96)
    expect(Math.round((await fountainFillDays(db))! * 10) / 10).toBe(5);
    const estimate = await estimateFountain(db, day(30));
    expect(estimate.state).toBe("alarm");
    expect(estimate.daysLeft).toBeCloseTo(1, 1);
  });

  it("adds one refill task and alert at alarm when enabled", async () => {
    const db = openNodeDb(":memory:");
    await migrate(db);
    await db.run("INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)");
    await saveFountainSettings(db, { warningDays: 2, alarmDays: 1, refillTaskAtAlarm: true });
    await refillFountain(db, day(1));
    await refillFountain(db, day(5)); // a fill lasts 4 days
    expect(await checkFountainAlarm(db, day(7))).toEqual([]); // 2 days left: warning only
    expect((await checkFountainAlarm(db, day(8, 12))).map((a) => a.message)).toEqual([
      "Water fountain: about 0.9 days of water left. Added “Refill the water fountain” to today.",
    ]);
    expect(await checkFountainAlarm(db, day(8, 13))).toEqual([]);
    expect((await db.all("SELECT id FROM task")).map((t) => t.id)).toEqual(["auto-fountain-2026-10-08"]);
  });
});
