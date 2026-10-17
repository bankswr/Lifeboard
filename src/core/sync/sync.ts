// LAN sync between the phone and the desktop. The phone starts every exchange; the desktop
// answers (src/desktop/server.ts, POST /sync). One exchange:
//   1. The phone sends every row it changed since its last sync with this desktop.
//   2. The desktop keeps the incoming rows that are newer than its own (newest edit wins,
//      see isNewer), then replies with every row it changed since the phone last heard.
//   3. The phone keeps the replied rows that are newer than its own.
// "Changed since" is tracked with each device's own change numbers (seq), never clocks, so
// nothing is missed when the two clocks disagree. Rows can come back to the device that sent
// them; they are then not newer, so they are ignored and the echo stops there.
import { getDeviceId, getMeta, setMeta } from "../db/meta.ts";
import { get, utcNow, type Db, type Row } from "../db/types.ts";
import { currentSeq, isNewer, SYNCED_TABLES } from "./records.ts";

/** Rows per table name. Rows carry every column except seq, which is local to each device. */
export type Changes = Record<string, Row[]>;

export interface SyncRequest {
  deviceId: string;
  /** The desktop's seq the phone has already received up to. */
  since: number;
  changes: Changes;
}

export interface SyncResponse {
  deviceId: string;
  /** The desktop's newest seq included in this reply. */
  seq: number;
  changes: Changes;
}

export interface SyncSummary {
  sent: number;
  received: number;
}

/** Every row changed on this device after `sinceSeq`, and the newest seq included. */
export async function collectChanges(db: Db, sinceSeq: number): Promise<{ changes: Changes; seq: number }> {
  return db.transaction(async () => {
    const changes: Changes = {};
    for (const table of SYNCED_TABLES) {
      const rows = await db.all(`SELECT * FROM ${table} WHERE seq > ? ORDER BY seq`, [sinceSeq]);
      if (rows.length) changes[table] = rows.map(({ seq, ...row }) => row);
    }
    return { changes, seq: await currentSeq(db) };
  });
}

/**
 * SQL parameters per statement. SQLite's limit is 999 on older builds (some Android
 * versions), so batches stay under it.
 */
const MAX_PARAMS = 900;

/**
 * Keeps each incoming row that is newer than this device's copy. Returns how many were kept.
 * On the phone every statement is a round trip to native SQLite, so the work is batched:
 * one lookup and a few multi-row writes per table, and one change-number update overall
 * (a first sync of ~1,000 rows went from ~4,000 round trips to a few dozen).
 */
export async function applyChanges(db: Db, changes: Changes): Promise<number> {
  return db.transaction(async () => {
    let seq = Number(await getMeta(db, "next_seq"));
    let applied = 0;
    for (const [table, rows] of Object.entries(changes)) {
      // Table and column names from the other device go into SQL, so only known ones pass.
      if (!SYNCED_TABLES.includes(table)) throw new Error(`Sync: unknown table ${table}`);
      const columns = await tableColumns(db, table);
      for (const row of rows) {
        const unknown = Object.keys(row).filter((column) => !columns.has(column) || column === "seq");
        if (unknown.length) throw new Error(`Sync: unknown columns in ${table}: ${unknown.join(", ")}`);
      }
      const existing = await existingVersions(db, table, rows.map((row) => row.id));
      const newer = rows.filter((row) => isNewer(row, existing.get(row.id)));
      await upsertMany(db, table, newer.map((row) => ({ ...row, seq: seq++ })));
      applied += newer.length;
    }
    await setMeta(db, "next_seq", String(seq));
    return applied;
  });
}

/** This device's updated_at and updated_by for each of `ids` it has, by id. */
async function existingVersions(db: Db, table: string, ids: string[]): Promise<Map<string, Row>> {
  const versions = new Map<string, Row>();
  for (const batch of chunks(ids, MAX_PARAMS)) {
    const rows = await db.all(
      `SELECT id, updated_at, updated_by FROM ${table} WHERE id IN (${batch.map(() => "?").join(", ")})`,
      batch,
    );
    for (const row of rows) versions.set(row.id, row);
  }
  return versions;
}

/** upsert (records.ts) of many rows, several per statement. Rows with the same columns share a statement. */
async function upsertMany(db: Db, table: string, rows: Row[]): Promise<void> {
  const byColumns = new Map<string, Row[]>();
  for (const row of rows) {
    const key = Object.keys(row).join(",");
    byColumns.set(key, [...(byColumns.get(key) ?? []), row]);
  }
  for (const [key, group] of byColumns) {
    const columns = key.split(",");
    const placeholders = `(${columns.map(() => "?").join(", ")})`;
    for (const batch of chunks(group, Math.max(1, Math.floor(MAX_PARAMS / columns.length)))) {
      await db.run(
        `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES ${batch.map(() => placeholders).join(", ")}`,
        batch.flatMap((row) => columns.map((column) => row[column])),
      );
    }
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function tableColumns(db: Db, table: string): Promise<Set<string>> {
  const rows = await db.all(`SELECT name FROM pragma_table_info(?)`, [table]);
  return new Set(rows.map((row) => row.name));
}

/** Desktop side of one exchange. */
export async function answerSync(db: Db, request: SyncRequest): Promise<SyncResponse> {
  await applyChanges(db, request.changes);
  const { changes, seq } = await collectChanges(db, request.since);
  return { deviceId: await getDeviceId(db), seq, changes };
}

/**
 * Phone side of one exchange. `send` delivers the request to the desktop and returns its
 * reply. If the reply comes from a different desktop than last time (another computer, or
 * a reset database), the exchange is repeated from the start so nothing is skipped.
 */
export async function syncWithDesktop(db: Db, send: (request: SyncRequest) => Promise<SyncResponse>): Promise<SyncSummary> {
  const knownPeer = await getMeta(db, "sync_peer_id");
  const state = knownPeer ? await get(db, "SELECT * FROM sync_peer WHERE peer_id = ?", [knownPeer]) : undefined;
  let sentSeq = state?.sent_seq ?? 0;
  let receivedSeq = state?.received_seq ?? 0;

  let outgoing = await collectChanges(db, sentSeq);
  let response = await send({ deviceId: await getDeviceId(db), since: receivedSeq, changes: outgoing.changes });
  if (knownPeer && response.deviceId !== knownPeer) {
    outgoing = await collectChanges(db, 0);
    response = await send({ deviceId: await getDeviceId(db), since: 0, changes: outgoing.changes });
  }
  const received = await applyChanges(db, response.changes);

  await db.run(
    `INSERT INTO sync_peer (peer_id, sent_seq, received_seq, last_synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (peer_id) DO UPDATE SET sent_seq = excluded.sent_seq,
       received_seq = excluded.received_seq, last_synced_at = excluded.last_synced_at`,
    [response.deviceId, outgoing.seq, response.seq, utcNow()],
  );
  await setMeta(db, "sync_peer_id", response.deviceId);
  return { sent: countRows(outgoing.changes), received };
}

function countRows(changes: Changes): number {
  return Object.values(changes).reduce((total, rows) => total + rows.length, 0);
}

