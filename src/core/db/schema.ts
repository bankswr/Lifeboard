// The database schema, versioned with SQLite's PRAGMA user_version (approach from FitApp).
// Both devices run the same migrations. Never edit a shipped migration; append a new one.
import type { Db } from "./types.ts";

/** SQL, or a function for migrations that also move data. */
export const MIGRATIONS: (string | ((db: Db) => Promise<void>))[] = [
  // 1: per-device settings. device_id identifies this install; LAN sync will use it to
  // record which device last changed a record.
  async (db) => {
    await db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await db.run("INSERT INTO meta (key, value) VALUES ('device_id', ?)", [crypto.randomUUID()]);
  },
  // 2: LAN sync bookkeeping (see core/sync/). next_seq numbers local changes; sync_peer holds
  // how far this device has sent to and received from each peer (the phone tracks the desktop).
  `
  INSERT INTO meta (key, value) VALUES ('next_seq', '1');
  CREATE TABLE sync_peer (
    peer_id TEXT PRIMARY KEY,
    sent_seq INTEGER NOT NULL DEFAULT 0,
    received_seq INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Brings the database up to SCHEMA_VERSION. Returns the version it started at (0 = new). */
export async function migrate(db: Db): Promise<number> {
  const start = Number((await db.all("PRAGMA user_version"))[0].user_version);
  if (start > SCHEMA_VERSION) {
    throw new Error(`This database is from a newer version of Lifeboard (schema ${start}). Update the app.`);
  }
  for (let version = start; version < SCHEMA_VERSION; version++) {
    await db.transaction(async () => {
      const migration = MIGRATIONS[version];
      if (typeof migration === "string") await db.exec(migration);
      else await migration(db);
      await db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return start;
}
