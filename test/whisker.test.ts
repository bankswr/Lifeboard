import { describe, expect, it } from "vitest";
import { getCredential } from "../src/core/credentials.ts";
import { migrate } from "../src/core/db/schema.ts";
import { listDeviceStatuses } from "../src/core/devices.ts";
import { listRules, saveRule } from "../src/core/rules.ts";
import { runUpdate } from "../src/core/updates.ts";
import { WhiskerSignInError, type RawRobot, type WhiskerApi } from "../src/core/whisker/api.ts";
import { makeWhiskerIntegration } from "../src/core/whisker/integration.ts";
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
function fakeWhisker(options: { password: string; refreshWorks: boolean; robot: () => RawRobot }) {
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
