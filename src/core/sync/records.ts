// Synced records: rows that both devices keep and exchange during LAN sync.
//
// Every synced table has these columns besides its own:
//   id          TEXT PRIMARY KEY  a UUID, so both devices can create rows without clashing
//   updated_at  TEXT NOT NULL     when the row last changed (ISO 8601 UTC)
//   updated_by  TEXT NOT NULL     device_id of the device that made that change
//   deleted     INTEGER NOT NULL  1 = deleted; kept as a tombstone so the delete syncs too
//   seq         INTEGER NOT NULL  this device's change number, used to find what to send
// `syncColumns` gives the SQL for them. Features write synced rows only through saveRecord
// and deleteRecord so the bookkeeping is always right.
import { getDeviceId, getMeta, setMeta } from "../db/meta.ts";
import { get, utcNow, type Db, type Row } from "../db/types.ts";

/** Tables exchanged during sync. A feature adds its tables here when it creates them. */
export const SYNCED_TABLES: string[] = [
  "todo_list", "todo_item", "rule", "nutrition_day", "health_point",
  "calendar", "task_list", "calendar_event", "task", "schedule_change", "setting", "feeder_event", "fountain_refill", "maintenance_item",
];

/** Column definitions for a synced table's CREATE TABLE. */
export const syncColumns = `
  id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
`;

/** Takes the next local change number. */
export async function nextSeq(db: Db): Promise<number> {
  const seq = Number(await getMeta(db, "next_seq"));
  await setMeta(db, "next_seq", String(seq + 1));
  return seq;
}

/** The newest local change number handed out so far (0 if none). */
export async function currentSeq(db: Db): Promise<number> {
  return Number(await getMeta(db, "next_seq")) - 1;
}

/**
 * Inserts or updates a row of a synced table. `fields` are the table's own columns; give
 * `id` to update an existing row, leave it out to create one. Returns the row's id.
 */
export async function saveRecord(db: Db, table: string, fields: Row): Promise<string> {
  assertSynced(table);
  return db.transaction(async () => {
    const id: string = fields.id ?? crypto.randomUUID();
    const existing = await get(db, `SELECT updated_at FROM ${table} WHERE id = ?`, [id]);
    const row = {
      ...fields,
      id,
      updated_at: changeTime(existing?.updated_at),
      updated_by: await getDeviceId(db),
      deleted: fields.deleted ?? 0,
      seq: await nextSeq(db),
    };
    await upsert(db, table, row);
    return id;
  });
}

/** Marks a row deleted. It stays in the table as a tombstone so the delete reaches the other device. */
export async function deleteRecord(db: Db, table: string, id: string): Promise<void> {
  assertSynced(table);
  await db.transaction(async () => {
    const existing = await get(db, `SELECT updated_at FROM ${table} WHERE id = ?`, [id]);
    if (!existing) return;
    await db.run(`UPDATE ${table} SET deleted = 1, updated_at = ?, updated_by = ?, seq = ? WHERE id = ?`, [
      changeTime(existing.updated_at),
      await getDeviceId(db),
      await nextSeq(db),
      id,
    ]);
  });
}

/**
 * The time to stamp on a change. Normally now; but if this device's clock is behind the
 * row's last change (made on the other device), stamp just after it, so this newer edit
 * still wins when the devices compare.
 */
function changeTime(previous: string | undefined): string {
  const now = utcNow();
  if (!previous || now > previous) return now;
  return utcNow(new Date(new Date(previous).getTime() + 1));
}

/** True when `incoming` is a newer version of a row than `existing` (device id breaks ties). */
export function isNewer(incoming: Row, existing: Row | undefined): boolean {
  if (!existing) return true;
  if (incoming.updated_at !== existing.updated_at) return incoming.updated_at > existing.updated_at;
  return incoming.updated_by > existing.updated_by;
}

export function assertSynced(table: string): void {
  if (!SYNCED_TABLES.includes(table)) throw new Error(`Not a synced table: ${table}`);
}

/** INSERT OR REPLACE of a whole row. Column names come from our own code or are checked first (see sync.ts). */
export async function upsert(db: Db, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  await db.run(
    `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => row[column]),
  );
}
