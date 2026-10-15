import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/core/db/schema.ts";
import type { Db } from "../src/core/db/types.ts";
import { deleteRecord, saveRecord, SYNCED_TABLES, syncColumns } from "../src/core/sync/records.ts";
import { answerSync, applyChanges, syncWithDesktop } from "../src/core/sync/sync.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

// A throwaway synced table, only for these tests.
const TABLE = "test_item";
beforeAll(() => {
  SYNCED_TABLES.push(TABLE);
});

async function newDevice(): Promise<Db> {
  const db = openNodeDb(":memory:");
  await migrate(db);
  await db.exec(`CREATE TABLE ${TABLE} (${syncColumns}, name TEXT)`);
  return db;
}

/** Phone syncs with desktop directly, as if over the network (JSON round trip included). */
function syncPhone(phone: Db, desktop: Db) {
  return syncWithDesktop(phone, async (request) =>
    JSON.parse(JSON.stringify(await answerSync(desktop, JSON.parse(JSON.stringify(request))))),
  );
}

async function names(db: Db) {
  return (await db.all(`SELECT name, deleted FROM ${TABLE} ORDER BY name`)).map((row) => `${row.name}${row.deleted ? " (deleted)" : ""}`);
}

describe("sync", () => {
  it("copies new rows both ways", async () => {
    const [phone, desktop] = [await newDevice(), await newDevice()];
    await saveRecord(phone, TABLE, { name: "from phone" });
    await saveRecord(desktop, TABLE, { name: "from desktop" });

    expect(await syncPhone(phone, desktop)).toEqual({ sent: 1, received: 1 });
    expect(await names(phone)).toEqual(["from desktop", "from phone"]);
    expect(await names(desktop)).toEqual(["from desktop", "from phone"]);
  });

  it("settles: once nothing changes, nothing is exchanged", async () => {
    const [phone, desktop] = [await newDevice(), await newDevice()];
    await saveRecord(desktop, TABLE, { name: "a" });
    await syncPhone(phone, desktop);
    await syncPhone(phone, desktop); // the phone echoes back what it received; ignored
    expect(await syncPhone(phone, desktop)).toEqual({ sent: 0, received: 0 });
  });

  it("keeps the newer edit when both devices changed the same row", async () => {
    const [phone, desktop] = [await newDevice(), await newDevice()];
    const id = await saveRecord(phone, TABLE, { name: "original" });
    await syncPhone(phone, desktop);

    await saveRecord(desktop, TABLE, { id, name: "desktop edit" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveRecord(phone, TABLE, { id, name: "phone edit (newer)" });
    await syncPhone(phone, desktop);

    expect(await names(phone)).toEqual(["phone edit (newer)"]);
    expect(await names(desktop)).toEqual(["phone edit (newer)"]);
  });

  it("syncs deletes as tombstones", async () => {
    const [phone, desktop] = [await newDevice(), await newDevice()];
    const id = await saveRecord(desktop, TABLE, { name: "gone soon" });
    await syncPhone(phone, desktop);
    await deleteRecord(phone, TABLE, id);
    await syncPhone(phone, desktop);
    expect(await names(desktop)).toEqual(["gone soon (deleted)"]);
  });

  it("starts over when it reaches a different desktop", async () => {
    const [phone, desktop] = [await newDevice(), await newDevice()];
    await saveRecord(phone, TABLE, { name: "phone row" });
    await syncPhone(phone, desktop);

    const newDesktop = await newDevice();
    await syncPhone(phone, newDesktop);
    expect(await names(newDesktop)).toEqual(["phone row"]);
  });

  it("rejects unknown tables and columns from the other device", async () => {
    const db = await newDevice();
    await expect(applyChanges(db, { meta: [{ id: "x" }] })).rejects.toThrow(/unknown table/);
    await expect(applyChanges(db, { [TABLE]: [{ id: "x", "name) VALUES (1); --": 1 }] })).rejects.toThrow(/unknown columns/);
  });
});

describe("saveRecord", () => {
  it("stamps an edit after the row's last change even if this clock is behind", async () => {
    const db = await newDevice();
    const id = await saveRecord(db, TABLE, { name: "x" });
    const future = "2999-01-01T00:00:00.000Z";
    await db.run(`UPDATE ${TABLE} SET updated_at = ? WHERE id = ?`, [future, id]);
    await saveRecord(db, TABLE, { id, name: "y" });
    const row = (await db.all(`SELECT updated_at FROM ${TABLE}`))[0];
    expect(row.updated_at > future).toBe(true);
  });

  it("refuses tables that are not synced", async () => {
    const db = await newDevice();
    await expect(saveRecord(db, "meta", { key: "a" })).rejects.toThrow(/Not a synced table/);
  });
});
