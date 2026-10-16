import { describe, expect, it } from "vitest";
import { saveCredential } from "../src/core/credentials.ts";
import { HEALTH_SCOPES, SCHEDULE_SCOPES } from "../src/core/google/oauth.ts";
import { addDays, localDate } from "../src/core/dates.ts";
import { migrate } from "../src/core/db/schema.ts";
import { google, toHealthPoint } from "../src/core/google/integration.ts";
import { dailyHealth, replaceHealthPoints, saveNutritionDays, type HealthPoint } from "../src/core/health.ts";
import { stepsByDay, type StepPoint } from "../src/core/steps.ts";
import { runUpdate } from "../src/core/updates.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

async function newDb() {
  const db = openNodeDb(":memory:");
  await migrate(db);
  return db;
}

const RING = "com.gdjztech.ringconn";
const TREADMILL = "com.urevo.app";
const at = (time: string) => Date.parse(`2026-10-03T${time}:00Z`);
const step = (source: string, from: string, to: string, count: number): StepPoint => ({
  day: "2026-10-03", start: at(from), end: at(to), count, source,
});

describe("stepsByDay (ported from FitThing)", () => {
  it("uses the ring, ignores other sources", () => {
    const totals = stepsByDay([step(RING, "10:00", "10:30", 500), step("com.google.android.apps.fitness", "10:00", "10:30", 480)]);
    expect(totals.get("2026-10-03")).toBe(500);
  });

  it("replaces the ring's steps with the treadmill's while it runs, prorating a partly covered bucket", () => {
    const totals = stepsByDay([
      step(RING, "10:00", "10:30", 600), // half inside the session → keeps 300
      step(RING, "10:30", "11:00", 200), // fully inside → keeps 0
      step(TREADMILL, "10:15", "11:00", 4000),
    ]);
    expect(totals.get("2026-10-03")).toBe(300 + 4000);
  });

  it("counts a treadmill session uploaded twice once", () => {
    const totals = stepsByDay([step(TREADMILL, "09:00", "10:00", 5000), step(TREADMILL, "09:20", "10:20", 5000)]);
    expect(totals.get("2026-10-03")).toBe(5000);
  });
});

describe("toHealthPoint", () => {
  const civil = { date: { year: 2026, month: 10, day: 3 } };
  it("reads steps, weight and body fat points", () => {
    const steps = toHealthPoint("steps", {
      dataSource: { application: { packageName: RING } },
      steps: { interval: { startTime: "2026-10-03T14:00:00Z", endTime: "2026-10-03T14:30:00Z", civilStartTime: civil }, count: "321" },
    });
    expect(steps).toMatchObject({ day: "2026-10-03", value: 321, source: RING });
    const weight = toHealthPoint("weight", {
      name: "users/me/dataTypes/weight/dataPoints/1",
      weight: { sampleTime: { physicalTime: "2026-10-03T12:00:00Z", civilTime: civil }, weightGrams: 80000 },
    });
    expect(weight).toMatchObject({ id: "google-users/me/dataTypes/weight/dataPoints/1", value: 80000 });
    expect(toHealthPoint("body-fat", { name: "x", bodyFat: { sampleTime: { physicalTime: "t", civilTime: civil }, percentage: 21.5 } }))
      .toMatchObject({ value: 21.5 });
  });

  it("skips points missing fields", () => {
    expect(toHealthPoint("weight", { name: "x" })).toBeNull();
  });
});

describe("health storage and the daily summary", () => {
  const yesterday = addDays(localDate(), -1);
  const point = (id: string, type: HealthPoint["type"], value: number, source = RING): HealthPoint => ({
    id, type, day: yesterday, startTime: `${yesterday}T12:00:00Z`, endTime: `${yesterday}T12:30:00Z`, value, source,
  });

  it("combines nutrition, weight, body fat and steps per day", async () => {
    const db = await newDb();
    await saveNutritionDays(db, [{ date: yesterday, calories: 2000, proteinG: 150, carbsG: 200, fatG: 60 }]);
    await replaceHealthPoints(db, "weight", `${yesterday}T00:00:00Z`, `${localDate()}T00:00:00Z`, [
      point("w1", "weight", 80000), point("w2", "weight", 81000),
    ]);
    await replaceHealthPoints(db, "steps", `${yesterday}T00:00:00Z`, `${localDate()}T00:00:00Z`, [point("s1", "steps", 6000)]);
    const [day] = await dailyHealth(db, 2);
    expect(day).toMatchObject({ date: yesterday, calories: 2000, steps: 6000, bodyFatPercent: null });
    expect(day.weightLbs).toBeCloseTo(80500 * 0.00220462262185);
  });

  it("removes stored points that Google no longer returns for the same range", async () => {
    const db = await newDb();
    const range = [`${yesterday}T00:00:00Z`, `${localDate()}T00:00:00Z`] as const;
    await replaceHealthPoints(db, "weight", ...range, [point("w1", "weight", 80000), point("w2", "weight", 90000)]);
    await replaceHealthPoints(db, "weight", ...range, [point("w1", "weight", 80000)]);
    expect((await dailyHealth(db, 1))[0].weightLbs).toBeCloseTo(80000 * 0.00220462262185);
  });
});

describe("Google integration", () => {
  /** A pretend Google: token endpoint plus the Health API, with `refreshOk` deciding sign-in. */
  function fakeGoogle(refreshOk: boolean) {
    const requests: string[] = [];
    const tokenScopes: string[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.host === "oauth2.googleapis.com") {
        tokenScopes.push(new URLSearchParams(String(init?.body)).get("scope") ?? "");
        return refreshOk
          ? Response.json({ access_token: "token-1" })
          : Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
      }
      const type = url.pathname.split("/")[5];
      const civil = { date: { year: 2026, month: 10, day: 3 } };
      const points = type === "weight"
        ? [{ name: "w/1", weight: { sampleTime: { physicalTime: "2026-10-03T12:00:00Z", civilTime: civil }, weightGrams: 80000 } }]
        : [];
      return Response.json({ dataPoints: points });
    };
    return { fetch: fetchFn as typeof fetch, requests, tokenScopes };
  }

  async function withFetch(fake: typeof fetch, test: () => Promise<void>) {
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try {
      await test();
    } finally {
      globalThis.fetch = real;
    }
  }

  it("fetches steps, weight and body fat with a refreshed token", async () => {
    const site = fakeGoogle(true);
    await withFetch(site.fetch, async () => {
      const db = await newDb();
      await saveCredential(db, "google", { clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
      const result = await runUpdate(db, [google]);
      expect(result.connections[0]).toMatchObject({ name: "Google", status: "connected" });
      expect(site.requests.filter((p) => p.includes("dataPoints"))).toHaveLength(3);
      expect(await db.all("SELECT type, value FROM health_point")).toEqual([{ type: "weight", value: 80000 }]);
      // The Health API refuses tokens carrying other scopes, so each API gets its own token.
      expect(site.tokenScopes).toEqual([HEALTH_SCOPES.join(" "), SCHEDULE_SCOPES.join(" ")]);
    });
  });

  it("reports signed out when Google refuses the refresh token", async () => {
    await withFetch(fakeGoogle(false).fetch, async () => {
      const db = await newDb();
      await saveCredential(db, "google", { clientId: "id", clientSecret: "secret", refreshToken: "old" });
      const result = await runUpdate(db, [google]);
      expect(result.connections[0]).toMatchObject({ status: "signed_out" });
      expect(result.alerts[0].message).toMatch(/Google sign-in expired/);
    });
  });
});
