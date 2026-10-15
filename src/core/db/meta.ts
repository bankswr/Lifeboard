// Small per-device key/value settings in the meta table.
import { get, type Db } from "./types.ts";

export async function getMeta(db: Db, key: string): Promise<string | undefined> {
  return (await get(db, "SELECT value FROM meta WHERE key = ?", [key]))?.value;
}

export async function setMeta(db: Db, key: string, value: string): Promise<void> {
  await db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export async function getDeviceId(db: Db): Promise<string> {
  return (await getMeta(db, "device_id"))!;
}
