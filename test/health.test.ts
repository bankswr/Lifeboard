import { describe, expect, it } from "vitest";
import { api } from "../src/core/api.ts";
import { getCredential, saveCredential } from "../src/core/credentials.ts";
import { HEALTH_SCOPES, SCHEDULE_SCOPES } from "../src/core/google/oauth.ts";
import { addDays, localDate } from "../src/core/dates.ts";
import { migrate } from "../src/core/db/schema.ts";
import { google, healthDataReading, toHealthPoint } from "../src/core/google/integration.ts";
import { dailyHealth, healthCatchUpDay, replaceHealthPoints, saveNutritionDays, type HealthPoint } from "../src/core/health.ts";
import { RAW_KEEP_DAYS, summarizeDays, summarizeNewDays } from "../src/core/healthSummary.ts";
import { getHealthSettings, saveHealthSettings } from "../src/core/healthTargets.ts";
import { collectChanges } from "../src/core/sync/sync.ts";
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

  it("reads heart-rate samples and daily resting heart rate", () => {
    const sample = toHealthPoint("heart-rate", {
      dataSource: { application: { packageName: RING } },
      heartRate: { sampleTime: { physicalTime: "2026-10-03T23:50:00Z", civilTime: civil }, beatsPerMinute: "88" },
    });
    expect(sample).toMatchObject({ id: `google-heart-rate-${RING}-2026-10-03T23:50:00Z`, day: "2026-10-03", value: 88 });
    const resting = toHealthPoint("daily-resting-heart-rate", {
      dataSource: { application: { packageName: RING } },
      dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 4 }, beatsPerMinute: "70" },
    });
    expect(resting).toMatchObject({ day: "2026-10-04", startTime: "2026-10-04T00:00:00Z", value: 70 });
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
    await replaceHealthPoints(db, "heart-rate", `${yesterday}T00:00:00Z`, `${localDate()}T00:00:00Z`, [
      point("h1", "heart-rate", 60), point("h2", "heart-rate", 81),
    ]);
    await summarizeDays(db, yesterday, yesterday);
    const [day] = await dailyHealth(db, 2);
    expect(day).toMatchObject({ date: yesterday, calories: 2000, steps: 6000, bodyFatPercent: null, averageHeartRate: 71, restingHeartRate: null });
    expect(day.weightLbs).toBeCloseTo(80500 * 0.00220462262185);
  });

  it("keeps raw steps and heart rate on this device and syncs only the day's summary", async () => {
    const db = await newDb();
    const range = [`${yesterday}T00:00:00Z`, `${localDate()}T00:00:00Z`] as const;
    await replaceHealthPoints(db, "steps", ...range, [point("s1", "steps", 6000)]);
    await replaceHealthPoints(db, "heart-rate", ...range, [point("h1", "heart-rate", 70)]);
    await replaceHealthPoints(db, "weight", ...range, [point("w1", "weight", 80000)]);
    await summarizeNewDays(db); // the update's catch-up: a raw day without a summary
    const { changes } = await collectChanges(db, 0);
    expect(Object.keys(changes).sort()).toEqual(["health_day_summary", "health_point", "rule"]);
    expect(changes.health_point.map((row) => row.type)).toEqual(["weight"]);
    expect(changes.health_day_summary).toMatchObject([{ date: yesterday, steps: 6000, average_heart_rate: 70, workouts: "[]" }]);

    // Re-summarizing unchanged data doesn't create a new change to sync.
    const before = (await collectChanges(db, 0)).seq;
    await summarizeDays(db, yesterday, yesterday);
    expect((await collectChanges(db, 0)).seq).toBe(before);
  });

  it("drops raw data older than the retention but keeps those days' summaries", async () => {
    const db = await newDb();
    const old = addDays(localDate(), -(RAW_KEEP_DAYS + 1));
    await replaceHealthPoints(db, "steps", `${old}T00:00:00Z`, `${addDays(old, 1)}T00:00:00Z`, [
      { ...point("s-old", "steps", 4000), day: old, startTime: `${old}T12:00:00Z`, endTime: `${old}T12:30:00Z` },
    ]);
    await summarizeDays(db, old, old);
    await summarizeNewDays(db);
    expect(await db.all("SELECT id FROM raw_health_point")).toEqual([]);
    expect(await db.all("SELECT steps FROM health_day_summary")).toEqual([{ steps: 4000 }]);
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

  it("fetches steps, weight, body fat and heart rate with a refreshed token", async () => {
    const site = fakeGoogle(true);
    await withFetch(site.fetch, async () => {
      const db = await newDb();
      await saveCredential(db, "google", { clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
      const result = await runUpdate(db, [google]);
      expect(result.connections[0]).toMatchObject({ name: "Google", status: "connected" });
      // 90 days of history: one query per type, except heart rate (14 days at most per query),
      // then one each for the steps and heart-rate check that data is arriving.
      const queries = site.requests.filter((p) => p.includes("dataPoints"));
      expect(queries.filter((p) => p.includes("/heart-rate/"))).toHaveLength(7 + 1);
      expect(queries).toHaveLength(4 + 7 + 2);
      expect(await db.all("SELECT type, value FROM health_point")).toEqual([{ type: "weight", value: 80000 }]);
      // The Health API refuses tokens carrying other scopes, so each API gets its own token.
      expect(site.tokenScopes).toEqual([HEALTH_SCOPES.join(" "), SCHEDULE_SCOPES.join(" "), HEALTH_SCOPES.join(" ")]);
      // The history pull is remembered, so later updates only re-read recent days of stored types.
      expect((await getCredential<{ historyFrom: string }>(db, "google"))!.historyFrom).toBe(addDays(localDate(), -90));
    });
  });

  it("pulls health once a day but syncs the Schedule on every update", async () => {
    const site = fakeGoogle(true);
    await withFetch(site.fetch, async () => {
      const db = await newDb();
      await saveCredential(db, "google", { clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
      await runUpdate(db, [google]);
      site.requests.length = 0;
      site.tokenScopes.length = 0;
      await runUpdate(db, [google]);
      // Only the check that data is arriving, not a pull: no weight or body fat queries.
      expect(site.requests.filter((p) => p.includes("dataPoints")).map((p) => p.split("/")[5])).toEqual(["steps", "heart-rate"]);
      expect(site.tokenScopes).toEqual([SCHEDULE_SCOPES.join(" "), HEALTH_SCOPES.join(" ")]);
      expect((await getCredential<{ healthPulledOn: string }>(db, "google"))!.healthPulledOn).toBe(localDate());
    });
  });

  it("pulls health again the same day after a re-pull is asked for", async () => {
    const site = fakeGoogle(true);
    await withFetch(site.fetch, async () => {
      const db = await newDb();
      await saveCredential(db, "google", { clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
      await runUpdate(db, [google]);
      site.requests.length = 0;
      await api.repullHealth(db);
      expect(site.requests.filter((p) => p.includes("dataPoints")).length).toBeGreaterThan(0);
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

  describe("a stalled source", () => {
    const today = localDate();
    const raw = (id: string, type: "steps" | "heart-rate", source: string, day: string, endTime: string) =>
      ({ id, type, day, startTime: endTime, endTime, value: 1, source });
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

    /** A database signed in to Google whose health pull is done for today. */
    async function pulledDb() {
      const db = await newDb();
      await saveCredential(db, "google", {
        clientId: "id", clientSecret: "secret", refreshToken: "refresh", healthPulledOn: today, historyFrom: addDays(today, -90),
      });
      return db;
    }

    it("alerts once when it goes silent, and can again after it recovers", async () => {
      const site = fakeGoogle(true);
      await withFetch(site.fetch, async () => {
        const db = await pulledDb();
        const store = (hours: number) => replaceHealthPoints(db, "heart-rate", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z",
          [raw("hr", "heart-rate", RING, today, hoursAgo(hours))]);

        await store(1);
        expect((await runUpdate(db, [google])).alerts).toEqual([]);

        await store(20);
        const { alerts } = await runUpdate(db, [google]);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].message).toBe("Ring heart rate: nothing new in Google Health for 20 hours. Check that it's still syncing.");
        expect((await runUpdate(db, [google])).alerts).toEqual([]);

        await store(1);
        expect((await runUpdate(db, [google])).alerts).toEqual([]);
        await store(20);
        expect((await runUpdate(db, [google])).alerts).toHaveLength(1);
      });
    });

    it("follows the setting for how long is too long", async () => {
      const site = fakeGoogle(true);
      await withFetch(site.fetch, async () => {
        const db = await pulledDb();
        await replaceHealthPoints(db, "heart-rate", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z",
          [raw("hr", "heart-rate", RING, today, hoursAgo(20))]);
        await saveHealthSettings(db, { ...(await getHealthSettings(db)), healthDataStaleHours: 48 });
        expect((await runUpdate(db, [google])).alerts).toEqual([]);
      });
    });

    it("says nothing about a source that has never reported", async () => {
      const site = fakeGoogle(true);
      await withFetch(site.fetch, async () => {
        const db = await pulledDb();
        expect((await runUpdate(db, [google])).alerts).toEqual([]);
      });
    });

    it("keeps the connection healthy when the check itself fails", async () => {
      const site = fakeGoogle(true);
      const failing = (async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("dataPoints") ? new Response("busy", { status: 503 }) : site.fetch(input, init)) as typeof fetch;
      await withFetch(failing, async () => {
        const db = await pulledDb();
        const result = await runUpdate(db, [google]);
        expect(result.connections[0]).toMatchObject({ status: "connected" });
        expect(result.alerts).toEqual([]);
      });
    });

    it("judges age from the newest point and rounds to hours", () => {
      const now = new Date("2026-11-02T12:00:00Z");
      const reading = (hours: number) => healthDataReading("Phone steps", ["2026-10-01T00:00:00Z", new Date(now.getTime() - hours * 3_600_000).toISOString()], 18, now);
      expect(reading(18).data).toEqual({ stale: false, hoursSinceData: 18 });
      expect(reading(18.6).data).toEqual({ stale: true, hoursSinceData: 19 });
      expect(reading(-1).data).toEqual({ stale: false, hoursSinceData: 0 });
    });

    it("fetches far enough back for the source furthest behind", async () => {
      const db = await newDb();
      const store = (points: ReturnType<typeof raw>[]) => replaceHealthPoints(db, "steps", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", points);
      const at = (day: string) => `${day}T12:00:00Z`;
      const phoneDay = addDays(today, -1);
      const ringDay = addDays(today, -6);
      await store([raw("p", "steps", "com.google.android.apps.fitness", phoneDay, at(phoneDay)), raw("r", "steps", RING, ringDay, at(ringDay))]);
      expect(await healthCatchUpDay(db, "steps", today)).toBe(ringDay);

      // A source that's been silent over a month is taken as retired and no longer holds it back.
      const oldDay = addDays(today, -31);
      await store([raw("p", "steps", "com.google.android.apps.fitness", phoneDay, at(phoneDay)), raw("o", "steps", RING, oldDay, at(oldDay))]);
      expect(await healthCatchUpDay(db, "steps", today)).toBe(phoneDay);

      await store([raw("o", "steps", RING, oldDay, at(oldDay))]);
      expect(await healthCatchUpDay(db, "steps", today)).toBe(oldDay);
      await store([]);
      expect(await healthCatchUpDay(db, "steps", today)).toBeNull();
    });
  });
});
