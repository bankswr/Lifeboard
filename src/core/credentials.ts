// Saved sign-ins, one per integration, kept on this device only: the credential table is
// never synced, so each device signs in on its own (user decision, docs/PLAN.md).
import { get, type Db } from "./db/types.ts";

export async function getCredential<T>(db: Db, integrationId: string): Promise<T | undefined> {
  const row = await get(db, "SELECT data FROM credential WHERE id = ?", [integrationId]);
  return row ? (JSON.parse(row.data) as T) : undefined;
}

export async function saveCredential<T>(db: Db, integrationId: string, data: T): Promise<void> {
  await db.run("INSERT OR REPLACE INTO credential (id, data) VALUES (?, ?)", [integrationId, JSON.stringify(data)]);
}

export async function deleteCredential(db: Db, integrationId: string): Promise<void> {
  await db.run("DELETE FROM credential WHERE id = ?", [integrationId]);
}
