// Db over the Capacitor SQLite plugin: a native SQLite file on the phone. Adapted from FitApp,
// minus its browser storage path; in a desktop browser the data lives on the desktop server.
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { Db, Params, Row } from "../../core/db/types.ts";

const DB_NAME = "lifeboard";

export async function openCapacitorDb(): Promise<Db> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const conn = await sqlite.createConnection(DB_NAME, false, "no-encryption", 1, false);
  await conn.open();
  await conn.execute("PRAGMA foreign_keys = ON;", false);
  return new CapacitorDb(conn);
}

class CapacitorDb implements Db {
  private conn: SQLiteDBConnection;
  private inTransaction = false;

  constructor(conn: SQLiteDBConnection) {
    this.conn = conn;
  }

  async all(sql: string, params: Params = []): Promise<Row[]> {
    return (await this.conn.query(sql, params)).values ?? [];
  }

  async run(sql: string, params: Params = []) {
    // transaction=false: we manage transactions ourselves (see transaction()).
    const result = await this.conn.run(sql, params, false);
    return { changes: result.changes?.changes ?? 0, lastId: result.changes?.lastId ?? 0 };
  }

  async exec(sql: string) {
    await this.conn.execute(sql, false);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(); // join the outer transaction
    await this.conn.beginTransaction();
    this.inTransaction = true;
    try {
      const result = await fn();
      await this.conn.commitTransaction();
      return result;
    } catch (error) {
      await this.conn.rollbackTransaction();
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
}
