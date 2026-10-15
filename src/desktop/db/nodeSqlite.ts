// Db over Node's built-in SQLite (node:sqlite). Used by the desktop server and by tests.
// Pass ":memory:" for a throwaway database.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Db, Params, Row } from "../../core/db/types.ts";

export function openNodeDb(path: string): Db {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON;");
  let inTransaction = false;

  return {
    async all(sql: string, params: Params = []): Promise<Row[]> {
      return database.prepare(sql).all(...(params as SQLInputValue[])) as Row[];
    },

    async run(sql: string, params: Params = []) {
      const result = database.prepare(sql).run(...(params as SQLInputValue[]));
      return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
    },

    async exec(sql: string) {
      database.exec(sql);
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (inTransaction) return fn(); // join the outer transaction
      database.exec("BEGIN");
      inTransaction = true;
      try {
        const result = await fn();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };
}
