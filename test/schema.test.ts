import { describe, expect, it } from "vitest";
import { api } from "../src/core/api.ts";
import { migrate, SCHEMA_VERSION } from "../src/core/db/schema.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

describe("migrate", () => {
  it("brings a new database to the current version and gives it a device id", async () => {
    const db = openNodeDb(":memory:");
    expect(await migrate(db)).toBe(0);
    const info = await api.getAppInfo(db);
    expect(info.schemaVersion).toBe(SCHEMA_VERSION);
    expect(info.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does nothing to an up-to-date database and keeps its device id", async () => {
    const db = openNodeDb(":memory:");
    await migrate(db);
    const before = await api.getAppInfo(db);
    expect(await migrate(db)).toBe(SCHEMA_VERSION);
    expect(await api.getAppInfo(db)).toEqual(before);
  });

  it("refuses a database from a newer version", async () => {
    const db = openNodeDb(":memory:");
    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    await expect(migrate(db)).rejects.toThrow(/newer version/);
  });
});

describe("transaction", () => {
  it("rolls back every write when the function throws", async () => {
    const db = openNodeDb(":memory:");
    await db.exec("CREATE TABLE t (x INTEGER)");
    await expect(
      db.transaction(async () => {
        await db.run("INSERT INTO t VALUES (1)");
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect(await db.all("SELECT * FROM t")).toEqual([]);
  });
});
