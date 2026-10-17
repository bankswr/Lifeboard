import { describe, expect, it } from "vitest";
import { getCredential } from "../src/core/credentials.ts";
import { migrate } from "../src/core/db/schema.ts";
import { listDeviceStatuses } from "../src/core/devices.ts";
import { listRules, saveRule } from "../src/core/rules.ts";
import { runUpdate } from "../src/core/updates.ts";
import { WhiskerSignInError, type RawPet, type RawRobot, type WhiskerApi } from "../src/core/whisker/api.ts";
import { catSummaries, checkCatAlerts, saveCatSettings, saveCats, DEFAULT_CAT_SETTINGS } from "../src/core/whisker/cats.ts";
import { makeWhiskerIntegration } from "../src/core/whisker/integration.ts";
import { checkLitterAlarms, DEFAULT_LITTER_SETTINGS, drawerState, litterState, saveLitterSettings } from "../src/core/whisker/levels.ts";
import { estimateLitter, litterEstimates, recordLitterLevels } from "../src/core/whisker/estimates.ts";
import { litterRobotStatus } from "../src/core/whisker/status.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

const READY: RawRobot = {
  name: "Litter-Robot", serial: "LR4C000001", isOnline: true, unitPowerStatus: "ON", robotStatus: "ROBOT_IDLE",
  robotCycleState: "CYCLE_STATE_IDLE", displayCode: "DC_MODE_IDLE", DFILevelPercent: 40, isDFIFull: false,
  litterLevelPercentage: 0.9, catWeight: 11.2, isLaserDirty: false, lastSeen: "2026-10-15T12:00:00Z",
};

describe("litterRobotStatus (pylitterbot's rules)", () => {
  it("reads levels and a ready robot", () => {
    expect(litterRobotStatus(READY)).toMatchObject({ status: "Ready", drawerLevel: 40, litterLevel: 90, online: true });
  });
  it("puts offline, off and drawer full ahead of the robot's own status", () => {
    expect(litterRobotStatus({ ...READY, isOnline: false }).status).toBe("Offline");
    expect(litterRobotStatus({ ...READY, unitPowerStatus: "OFF" }).status).toBe("Off");
    expect(litterRobotStatus({ ...READY, isDFIFull: true }).status).toBe("Drawer full");
    expect(litterRobotStatus({ ...READY, robotCycleState: "CYCLE_STATE_PAUSE" }).status).toBe("Paused");
    expect(litterRobotStatus({ ...READY, robotStatus: "ROBOT_CLEAN" }).status).toBe("Cleaning");
  });
});

/** A pretend Whisker account. */
function fakeWhisker(options: { password: string; refreshWorks: boolean; robot: () => RawRobot; pets?: RawPet[] }) {
  const calls: string[] = [];
  const api: WhiskerApi = {
    async signIn(_email, password) {
      calls.push("signIn");
      if (password !== options.password) throw new WhiskerSignInError("Whisker didn't accept the email and password.");
      return { idToken: "id-1", refreshToken: "refresh-1" };
    },
    async refresh() {
      calls.push("refresh");
      if (!options.refreshWorks) throw new Error("Refresh Token has expired");
      return "id-2";
    },
    async robots() {
      return [options.robot()];
    },
    async pets() {
      return options.pets ?? [];
    },
  };
  return { api, calls };
}

async function newDb() {
  const db = openNodeDb(":memory:");
  await migrate(db);
  return db;
}

describe("Whisker integration", () => {
  it("stores the robot's status and alerts once when the drawer fills", async () => {
    let drawerFull = false;
    const site = fakeWhisker({ password: "pw", refreshWorks: true, robot: () => ({ ...READY, isDFIFull: drawerFull }) });
    const whisker = makeWhiskerIntegration(site.api);
    const db = await newDb();
    await whisker.signIn!(db, "me@example.com", "pw");

    expect((await runUpdate(db, [whisker])).alerts).toEqual([]);
    expect((await listDeviceStatuses(db))[0]).toMatchObject({ kind: "litter_robot", data: { status: "Ready" } });

    drawerFull = true;
    const full = await runUpdate(db, [whisker]);
    expect(full.alerts.map((a) => a.message)).toEqual(["Litter-Robot: the waste drawer is full."]);
    expect((await runUpdate(db, [whisker])).alerts).toEqual([]); // still full: no repeat
  });

  it("signs in again with the saved password when the refresh token expires", async () => {
    const site = fakeWhisker({ password: "pw", refreshWorks: false, robot: () => READY });
    const whisker = makeWhiskerIntegration(site.api);
    const db = await newDb();
    await whisker.signIn!(db, "me@example.com", "pw");
    const result = await runUpdate(db, [whisker]);
    expect(result.connections[0].status).toBe("connected");
    expect(site.calls).toEqual(["signIn", "refresh", "signIn"]);
    expect((await getCredential<{ refreshToken: string }>(db, "whisker"))!.refreshToken).toBe("refresh-1");
  });

  it("alerts 'signed out' when the saved password no longer works", async () => {
    const site = fakeWhisker({ password: "pw", refreshWorks: true, robot: () => READY });
    const whisker = makeWhiskerIntegration(site.api);
    const db = await newDb();
    await whisker.signIn!(db, "me@example.com", "pw");
    const broken = makeWhiskerIntegration(fakeWhisker({ password: "changed", refreshWorks: false, robot: () => READY }).api);
    const result = await runUpdate(db, [broken]);
    expect(result.connections[0].status).toBe("signed_out");
    expect(result.alerts[0].message).toMatch(/Whisker \(Litter-Robot\): signed_out/);
  });

  it("lets the user write a custom Litter-Robot rule", async () => {
    const site = fakeWhisker({ password: "pw", refreshWorks: true, robot: () => ({ ...READY, DFILevelPercent: 85 }) });
    const whisker = makeWhiskerIntegration(site.api);
    const db = await newDb();
    await whisker.signIn!(db, "me@example.com", "pw");
    await saveRule(db, {
      name: "Drawer nearly full", enabled: true, readingType: "litter_robot",
      conditions: [{ field: "drawerLevel", operator: "greater", value: 80 }], message: "{subject} drawer at {drawerLevel}%",
    });
    expect((await runUpdate(db, [whisker])).alerts.map((a) => a.message)).toContain("Litter-Robot drawer at 85%");
  });

  it("adds the Litter-Robot default rules", async () => {
    const names = (await listRules(await newDb())).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Litter-Robot drawer full", "Litter-Robot offline", "Litter-Robot litter low"]));
  });
});

describe("litter levels", () => {
  const robot = (drawerLevel: number, litterLevel: number) => ({ ...litterRobotStatus(READY), drawerLevel, litterLevel });

  it("turns levels yellow and red at the set thresholds", async () => {
    const settings = { ...DEFAULT_LITTER_SETTINGS, drawerWarning: 60, drawerAlarm: 85 };
    expect([50, 60, 85].map((level) => drawerState(robot(level, 90), settings))).toEqual(["ok", "warning", "alarm"]);
    expect([50, 40, 20].map((level) => litterState(robot(10, level), settings))).toEqual(["ok", "warning", "alarm"]);
    await expect(saveLitterSettings(await newDb(), { ...settings, drawerWarning: 90 })).rejects.toThrow(/below its alarm/);
  });

  it("adds one clean-up task and alert when a level reaches alarm, if enabled", async () => {
    const db = await newDb();
    await db.run("INSERT INTO task_list (id, updated_at, updated_by, deleted, seq, title, position) VALUES ('list1', '2026-01-01', 'x', 0, 0, 'My Tasks', 0)");
    expect(await checkLitterAlarms(db, [robot(95, 90)], "2026-10-16")).toEqual([]); // not enabled

    await saveLitterSettings(db, { ...DEFAULT_LITTER_SETTINGS, cleanTaskAtAlarm: true });
    await checkLitterAlarms(db, [robot(40, 90)], "2026-10-16");
    const alerts = await checkLitterAlarms(db, [robot(95, 90)], "2026-10-16");
    expect(alerts.map((a) => a.message)).toEqual(["Litter-Robot: drawer 95% full. Added “Clean the litter box” to today."]);
    expect(await checkLitterAlarms(db, [robot(97, 90)], "2026-10-16")).toEqual([]); // still in alarm: no repeat
    expect(await db.all("SELECT id, title, due FROM task")).toEqual([
      { id: "auto-litter-LR4C000001-2026-10-16", title: "Clean the litter box", due: "2026-10-16" },
    ]);
  });
});

describe("cats", () => {
  // Local times, so day boundaries don't depend on the machine's time zone.
  const now = new Date(2026, 9, 17, 20, 0);
  /** Whisker's UTC timestamp without a zone, for a local time `daysAgo` days before `now`. */
  const stamp = (daysAgo: number, hour = 12) =>
    new Date(2026, 9, 17 - daysAgo, hour).toISOString().slice(0, 19);
  const pet = (entries: [number, number, number?][]): RawPet => ({
    petId: "pet-1", name: "Scout",
    weightHistory: entries.map(([daysAgo, weight, hour]) => ({ weight, timestamp: stamp(daysAgo, hour) })),
  });

  it("stores each cat and new weigh-ins once, from either device", async () => {
    const db = await newDb();
    await saveCats(db, [pet([[1, 7.7], [0, 7.8]])]);
    await saveCats(db, [pet([[1, 7.7], [0, 7.8]])]); // the same 7-day list again
    expect(await db.all("SELECT name FROM cat")).toEqual([{ name: "Scout" }]);
    expect(await db.all("SELECT weight_lbs FROM cat_weigh_in ORDER BY at")).toEqual([{ weight_lbs: 7.7 }, { weight_lbs: 7.8 }]);
  });

  it("alerts once when the weight changes by the set percentage", async () => {
    const db = await newDb();
    const earlier: [number, number][] = [15, 16, 17, 18].map((d) => [d, 10]);
    await saveCats(db, [pet([...earlier, [1, 9.6], [2, 9.6], [3, 9.6]])]); // −4%
    expect(await checkCatAlerts(db, now)).toEqual([]);
    // Five more at another hour (new weigh-ins): the 7-day median drops to 9.0, −10%.
    await saveCats(db, [pet([0, 1, 2, 3, 4].map((d) => [d, 9.0, 8]))]);
    const alerts = await checkCatAlerts(db, now);
    expect(alerts.map((a) => a.message)).toEqual(["Scout has lost 10.0% over 14 days (now ≈ 9.0 lb)."]);
    expect(await checkCatAlerts(db, now)).toEqual([]); // no repeat while it stays changed
  });

  it("works out a visit limit from the cat's own days and alerts once a day above it", async () => {
    const db = await newDb();
    // 2 visits a day for 5 full days (the first stored day is partial and left out).
    const history: [number, number, number][] = [6, 5, 4, 3, 2, 1].flatMap((d) => [[d, 8, 9], [d, 8, 15]] as [number, number, number][]);
    await saveCats(db, [pet(history)]);
    const [cat] = await catSummaries(db, now);
    expect(cat).toMatchObject({ visitLimit: 4, visitLimitIsAuto: true }); // 2 a day + 2

    await saveCats(db, [pet([8, 9, 10, 11, 12, 13].map((hour) => [0, 8, hour]))]);
    expect((await checkCatAlerts(db, now)).map((a) => a.message)).toEqual(["Scout has used the litter box 6 times today (limit 4)."]);
    expect(await checkCatAlerts(db, now)).toEqual([]);

    await saveCatSettings(db, { ...DEFAULT_CAT_SETTINGS, visitLimits: { "pet-1": 10 } });
    expect((await catSummaries(db, now))[0]).toMatchObject({ visitLimit: 10, visitLimitIsAuto: false });
    await expect(saveCatSettings(db, { ...DEFAULT_CAT_SETTINGS, visitLimits: { "pet-1": 2.5 } })).rejects.toThrow(/whole numbers/);
  });

  it("reads the cats at each update", async () => {
    const site = fakeWhisker({ password: "pw", refreshWorks: true, robot: () => READY, pets: [pet([[0, 7.8]])] });
    const whisker = makeWhiskerIntegration(site.api);
    const db = await newDb();
    await whisker.signIn!(db, "me@example.com", "pw");
    await runUpdate(db, [whisker]);
    expect(await db.all("SELECT cat_id, weight_lbs FROM cat_weigh_in")).toEqual([{ cat_id: "pet-1", weight_lbs: 7.8 }]);
  });
});

describe("Litter-Robot estimates", () => {
  const start = Date.parse("2026-10-10T00:00:00Z");
  /** A reading `hours` after the start. */
  const reading = (hours: number, drawer: number, litter: number) => ({ at: new Date(start + hours * 3_600_000).toISOString(), drawer, litter });

  it("projects the drawer's rise since it was emptied to the alarm level", () => {
    // Full drawer, emptied at hour 10, then +10 points a day.
    const readings = [reading(0, 80, 60), reading(5, 85, 60), reading(10, 5, 60), reading(34, 15, 60), reading(58, 25, 60)];
    const { drawer } = estimateLitter("LR", readings, DEFAULT_LITTER_SETTINGS);
    expect(drawer.ratePerDay).toBeCloseTo(10);
    // From 25% at hour 58, 65 more points at 10 a day = 6.5 days.
    expect(drawer.at).toBe(new Date(start + (58 + 6.5 * 24) * 3_600_000).toISOString());
  });

  it("projects the litter's fall since it was refilled, and says when a level is already there", () => {
    const readings = [reading(0, 10, 30), reading(1, 10, 90), reading(25, 10, 80), reading(49, 10, 70)];
    const { litter } = estimateLitter("LR", readings, DEFAULT_LITTER_SETTINGS);
    expect(litter.ratePerDay).toBeCloseTo(10);
    expect(litter.at).toBe(new Date(start + (49 + 5 * 24) * 3_600_000).toISOString()); // 70 → 20 at 10 a day
    expect(estimateLitter("LR", [reading(0, 95, 50)], DEFAULT_LITTER_SETTINGS).drawer).toMatchObject({ reached: true, at: null });
  });

  it("waits for enough history and a real rate before estimating", () => {
    const flat = [reading(0, 20, 50), reading(24, 20, 50)];
    expect(estimateLitter("LR", flat, DEFAULT_LITTER_SETTINGS).drawer.at).toBeNull();
    const short = [reading(0, 20, 50), reading(2, 30, 50)];
    expect(estimateLitter("LR", short, DEFAULT_LITTER_SETTINGS).drawer.at).toBeNull();
  });

  it("records readings at most every half hour per robot", async () => {
    const db = await newDb();
    const robot = litterRobotStatus(READY);
    const t = new Date("2026-10-10T00:00:00Z");
    await recordLitterLevels(db, [robot], t);
    await recordLitterLevels(db, [robot], new Date(t.getTime() + 10 * 60_000));
    await recordLitterLevels(db, [{ ...robot, drawerLevel: 60 }], new Date(t.getTime() + 7 * 3_600_000));
    expect(await db.all("SELECT drawer FROM litter_level ORDER BY at")).toEqual([{ drawer: 40 }, { drawer: 60 }]);
    const estimates = await litterEstimates(db);
    expect(estimates[robot.serial].drawer.ratePerDay).toBeCloseTo(20 / 7 * 24);
  });
});
