import { describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import type { Db } from "../src/core/db/types.ts";
import type { Reading } from "../src/core/readings.ts";
import { evaluateRules, fillMessage, listRules, recentAlerts, saveRule } from "../src/core/rules.ts";
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
    expect((await listRules(desktop)).map((r) => r.name)).toEqual(["Drawer nearly full", "Sign-in or connection problem"]);
    expect(await listRules(phone)).toEqual(await listRules(desktop));
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
