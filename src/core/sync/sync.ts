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
import { currentSeq, isNewer, nextSeq, SYNCED_TABLES, upsert } from "./records.ts";

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

/** Keeps each incoming row that is newer than this device's copy. Returns how many were kept. */
export async function applyChanges(db: Db, changes: Changes): Promise<number> {
  return db.transaction(async () => {
    let applied = 0;
    for (const [table, rows] of Object.entries(changes)) {
      // Table and column names from the other device go into SQL, so only known ones pass.
      if (!SYNCED_TABLES.includes(table)) throw new Error(`Sync: unknown table ${table}`);
      const columns = await tableColumns(db, table);
      for (const row of rows) {
        const unknown = Object.keys(row).filter((column) => !columns.has(column) || column === "seq");
        if (unknown.length) throw new Error(`Sync: unknown columns in ${table}: ${unknown.join(", ")}`);
        const existing = await get(db, `SELECT updated_at, updated_by FROM ${table} WHERE id = ?`, [row.id]);
        if (!isNewer(row, existing)) continue;
        await upsert(db, table, { ...row, seq: await nextSeq(db) });
        applied++;
      }
    }
    return applied;
  });
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

