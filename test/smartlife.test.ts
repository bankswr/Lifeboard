import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getCredential } from "../src/core/credentials.ts";
import { migrate } from "../src/core/db/schema.ts";
import { listDeviceStatuses, saveDeviceStatus } from "../src/core/devices.ts";
import { listRules } from "../src/core/rules.ts";
import {
  decrypt, encrypt, requestSecret, requestSignature, SmartLifeSignInError, type RawDevice, type SmartLifeApi, type SmartLifeTokens,
} from "../src/core/smartlife/api.ts";
import { decodeMealPlan, feederStatus, nextMeal } from "../src/core/smartlife/feeder.ts";
import {
  checkFeederAlarms, estimateAllFood, estimateFood, hopperCapacity, listRefills, markAllRefilled, markRefilled, median,
  noteRanDry, portionsPerDay, saveFeederSettings, scheduledPortions,
} from "../src/core/smartlife/food.ts";
import { makeSmartLifeIntegration } from "../src/core/smartlife/integration.ts";
import { runUpdate } from "../src/core/updates.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

// The user's real schedule (read 2026-10-16): 1 portion at 01:00, 07:00, 13:00, 19:00 daily.
const MEAL_PLAN = "fwEAAQF/BwABAX8NAAEBfxMAAQE=";

function feeder(overrides: { online?: boolean; feedReport?: number } = {}): RawDevice {
  return {
    id: "feeder1", name: "Dining Room", category: "cwwsq", online: overrides.online ?? true,
    status: [
      { code: "meal_plan", value: MEAL_PLAN },
      { code: "feed_state", value: "standby" },
      { code: "feed_report", value: overrides.feedReport ?? 1 },
    ],
  };
}

describe("feeder status", () => {
  it("decodes the meal plan", () => {
    const meals = decodeMealPlan(MEAL_PLAN);
    expect(meals.map((m) => [m.hour, m.minute, m.portions, m.enabled])).toEqual([
      [1, 0, 1, true], [7, 0, 1, true], [13, 0, 1, true], [19, 0, 1, true],
    ]);
    expect(meals[0].days).toEqual([true, true, true, true, true, true, true]);
  });

  it("finds the next meal, rolling over to tomorrow", () => {
    const meals = decodeMealPlan(MEAL_PLAN);
    expect(nextMeal(meals, new Date(2026, 9, 16, 8, 30))!.at).toEqual(new Date(2026, 9, 16, 13, 0));
    expect(nextMeal(meals, new Date(2026, 9, 16, 20, 0))!.at).toEqual(new Date(2026, 9, 17, 1, 0));
    expect(nextMeal(meals.map((m) => ({ ...m, enabled: false })), new Date())).toBeNull();
  });

  it("reads the device's values", () => {
    expect(feederStatus(feeder({ feedReport: 2 }))).toMatchObject({ name: "Dining Room", online: true, feedState: "standby", lastFeedPortions: 2 });
  });
});

describe("Smart Life request crypto (tuya-device-sharing-sdk)", () => {
  it("derives the key and signature as the SDK does", () => {
    const requestId = "0b8e4f9a-1111-4222-8333-944455556666";
    const hashKey = createHash("md5").update(requestId + "refresh-token").digest("hex");
    expect(requestSecret(requestId, hashKey)).toBe(createHmac("sha256", requestId).update(hashKey).digest("hex").slice(0, 16));

    const headers = { "X-appKey": "app", "X-requestId": requestId, "X-sid": "", "X-time": "1", "X-token": "tok" };
    const expected = createHmac("sha256", hashKey).update(`X-appKey=app||X-requestId=${requestId}||X-time=1||X-token=tokENC`).digest("hex");
    expect(requestSignature(hashKey, headers, "ENC")).toBe(expected);
  });

  it("decrypts what it encrypts", () => {
    expect(decrypt(encrypt('{"homeId":"1"}', "0123456789abcdef"), "0123456789abcdef")).toBe('{"homeId":"1"}');
  });
});

const FRESH: SmartLifeTokens = { endpoint: "https://api", accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 3600_000 };

/** A pretend Smart Life account; the QR code counts as scanned on the second check. */
function fakeSmartLife(options: { tokens?: SmartLifeTokens; refreshWorks?: boolean; devices: () => RawDevice[] }) {
  const calls: string[] = [];
  let checks = 0;
  const api: SmartLifeApi = {
    async startQrSignIn(userCode) {
      calls.push(`start ${userCode}`);
      return "qr-token";
    },
    async qrSignInResult() {
      return ++checks >= 2 ? (options.tokens ?? FRESH) : null;
    },
    async refresh() {
      calls.push("refresh");
      if (options.refreshWorks === false) throw new SmartLifeSignInError("Smart Life ended the sign-in.");
      return { ...FRESH, accessToken: "a2", refreshToken: "r2" };
    },
    async devices() {
      return options.devices();
    },
  };
  return { api, calls };
}

async function signedIn(site: ReturnType<typeof fakeSmartLife>) {
  const db = openNodeDb(":memory:");
  await migrate(db);
  const smartlife = makeSmartLifeIntegration(site.api);
  expect(await smartlife.startQrSignIn!(db, " CODE1 ")).toBe("tuyaSmart--qrLogin?token=qr-token");
  expect(await smartlife.finishQrSignIn!(db)).toBe(false);
  expect(await smartlife.finishQrSignIn!(db)).toBe(true);
  return { db, smartlife };
}

describe("Smart Life integration", () => {
  it("signs in by QR code and stores the feeders' status, skipping other devices", async () => {
    const site = fakeSmartLife({ devices: () => [feeder(), { id: "plug", name: "Lamp", category: "cz", status: [] }] });
    const { db, smartlife } = await signedIn(site);
    expect(site.calls).toEqual(["start CODE1"]);
    expect(await smartlife.isSetUp(db)).toBe(true);

    const result = await runUpdate(db, [smartlife]);
    expect(result.connections[0].status).toBe("connected");
    expect(result.alerts).toEqual([]);
    const devices = await listDeviceStatuses(db);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ kind: "feeder", name: "Dining Room", data: { lastFeedPortions: 1 } });
  });

  it("alerts once when a feed dispenses nothing, and when a feeder goes offline", async () => {
    let device = feeder();
    const site = fakeSmartLife({ devices: () => [device] });
    const { db, smartlife } = await signedIn(site);
    await runUpdate(db, [smartlife]);

    device = feeder({ feedReport: 0 });
    expect((await runUpdate(db, [smartlife])).alerts.map((a) => a.message)).toEqual([
      "Dining Room feeder: the last meal dispensed nothing. It may be empty or jammed.",
    ]);
    expect((await runUpdate(db, [smartlife])).alerts).toEqual([]); // still 0: no repeat

    device = feeder({ online: false });
    expect((await runUpdate(db, [smartlife])).alerts.map((a) => a.message)).toEqual(["Dining Room feeder is offline."]);
  });

  it("refreshes an expiring access token and saves the new one", async () => {
    const site = fakeSmartLife({ tokens: { ...FRESH, expiresAt: Date.now() + 30_000 }, devices: () => [feeder()] });
    const { db, smartlife } = await signedIn(site);
    await runUpdate(db, [smartlife]);
    expect(site.calls).toContain("refresh");
    expect((await getCredential<{ tokens: SmartLifeTokens }>(db, "smartlife"))!.tokens.refreshToken).toBe("r2");
  });

  it("alerts 'signed out' when Smart Life ends the sign-in", async () => {
    const site = fakeSmartLife({ tokens: { ...FRESH, expiresAt: 0 }, refreshWorks: false, devices: () => [feeder()] });
    const { db, smartlife } = await signedIn(site);
    const result = await runUpdate(db, [smartlife]);
    expect(result.connections[0].status).toBe("signed_out");
    expect(result.alerts[0].message).toMatch(/Smart Life \(feeders\): signed_out/);
  });

  it("adds the feeder default rules", async () => {
    const db = openNodeDb(":memory:");
    await migrate(db);
    const names = (await listRules(db)).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Feeder offline", "Feeder dispensed nothing"]));
  });
});

describe("feeder food estimate", () => {
  const meals = decodeMealPlan(MEAL_PLAN); // 4 portions a day at 01:00, 07:00, 13:00, 19:00
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 30);

  async function withFeeders(...ids: string[]) {
    const db = openNodeDb(":memory:");
    await migrate(db);
    for (const id of ids) await saveDeviceStatus(db, `feeder-${id}`, "feeder", id, { ...feederStatus({ ...feeder(), id, name: id }) });
    return db;
  }

  it("counts the schedule's portions between two times", () => {
    expect(scheduledPortions(meals, at(16, 8), at(16, 20))).toBe(2); // 13:00 and 19:00
    expect(scheduledPortions(meals, at(16, 8), at(18, 8))).toBe(8);
    expect(portionsPerDay(meals)).toBe(4);
    expect(median([30, 10, 20, 40])).toBe(25);
  });

  it("learns the hopper size from refills: first one is only a starting point", async () => {
    const db = await withFeeders("A", "B");
    await markAllRefilled(db, at(16, 9)); // the user's first fill: no samples
    expect(await hopperCapacity(db)).toBeNull();
    expect((await estimateAllFood(db, at(17, 9))).A).toMatchObject({ lastRefill: at(16, 9).toISOString(), percentLeft: null });

    await markRefilled(db, "A", at(26, 9)); // 10 days × 4 = 40 portions
    await markRefilled(db, "B", at(28, 9)); // 48 portions
    await markRefilled(db, "A", at(27, 9)); // a double press the next day: 4 portions
    expect((await listRefills(db)).map((r) => r.portions)).toEqual([48, 4, 40, null, null]);
    expect(await hopperCapacity(db)).toBe(40); // median of 40, 4, 48

    const estimate = (await estimateAllFood(db, at(28, 9))).B;
    expect(estimate).toMatchObject({ portionsLeft: 40, percentLeft: 100, daysLeft: 10, state: "ok" });
  });

  it("stops counting at the first empty feed and flags the low level", async () => {
    const db = await withFeeders("A");
    await saveFeederSettings(db, { warningDays: 3, alarmDays: 1, refillTaskAtAlarm: true });
    await db.run("INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)");
    await markRefilled(db, "A", at(1, 9));
    await markRefilled(db, "A", at(6, 9)); // 20 portions: capacity 20
    const fed = feederStatus({ ...feeder(), id: "A", name: "A" });

    expect((await estimateFood(db, fed, at(9, 9))).state).toBe("warning"); // 8 left = 2 days
    const alerts = await checkFeederAlarms(db, [fed], at(10, 9)); // 4 left = 1 day
    expect(alerts.map((a) => a.message)).toEqual(["Feeders running low: A (about 1.0 days left). Added “Refill the feeders” to today."]);
    expect(await checkFeederAlarms(db, [fed], at(10, 10))).toEqual([]); // no repeat

    await noteRanDry(db, [{ ...fed, lastFeedPortions: 0 }], at(10, 20));
    expect((await estimateFood(db, fed, at(10, 21))).portionsLeft).toBe(0);
    await markRefilled(db, "A", at(12, 9)); // counted only up to the run-dry sighting
    expect((await listRefills(db))[0].portions).toBe(18);
  });
});
