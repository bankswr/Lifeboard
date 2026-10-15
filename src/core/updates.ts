// Updating: asks every set-up integration (Litter-Robot, Google, ...) for fresh readings,
// records how each connection went, and runs the alert rules over the results.
// When updates run is up to each device: the desktop at start and every 4 hours, the phone
// on command or when opened more than 12 hours after the last update (docs/PLAN.md).
import { getMeta, setMeta } from "./db/meta.ts";
import { utcNow, type Db } from "./db/types.ts";
import type { ConnectionStatus, Reading } from "./readings.ts";
import { evaluateRules, type NewAlert } from "./rules.ts";

/** Thrown by an integration when its sign-in no longer works and the user must sign in again. */
export class SignedOutError extends Error {}

export interface Integration {
  /** Stable id, e.g. "whisker". */
  id: string;
  /** Shown to the user, e.g. "Whisker (Litter-Robot)". */
  name: string;
  /** False until the user has signed in on this device; not-set-up integrations are skipped. */
  isSetUp(db: Db): Promise<boolean>;
  /** Fetches fresh data, stores it, and returns readings for the alert rules. */
  update(db: Db): Promise<Reading[]>;
}

/** Integrations available on every device. Each one registers itself here as it's built. */
export const INTEGRATIONS: Integration[] = [];

export interface ConnectionInfo {
  id: string;
  name: string;
  status: ConnectionStatus;
  message: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
}

export interface UpdateResult {
  alerts: NewAlert[];
  connections: ConnectionInfo[];
}

/** Hours after which the phone updates on its own when opened. */
export const PHONE_UPDATE_AFTER_HOURS = 12;

export async function runUpdate(db: Db, integrations: Integration[] = INTEGRATIONS): Promise<UpdateResult> {
  const readings: Reading[] = [];
  for (const integration of integrations) {
    if (!(await integration.isSetUp(db))) continue;
    // Each integration on its own: one failing never stops the others.
    let status: ConnectionStatus = "connected";
    let message = "";
    try {
      readings.push(...(await integration.update(db)));
    } catch (error) {
      status = error instanceof SignedOutError ? "signed_out" : "error";
      message = (error as Error).message;
    }
    await recordConnection(db, integration, status, message);
    readings.push({ type: "connection", subject: integration.name, data: { status, message } });
  }
  await setMeta(db, "last_update_at", utcNow());
  return { alerts: await evaluateRules(db, readings), connections: await listConnections(db) };
}

async function recordConnection(db: Db, integration: Integration, status: ConnectionStatus, message: string) {
  const now = utcNow();
  await db.run(
    `INSERT INTO connection (id, name, status, message, last_checked_at, last_success_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = excluded.status, message = excluded.message,
       last_checked_at = excluded.last_checked_at,
       last_success_at = COALESCE(excluded.last_success_at, connection.last_success_at)`,
    [integration.id, integration.name, status, message || null, now, status === "connected" ? now : null],
  );
}

export async function listConnections(db: Db): Promise<ConnectionInfo[]> {
  const rows = await db.all("SELECT * FROM connection ORDER BY name");
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    message: row.message,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
  }));
}

export async function lastUpdateAt(db: Db): Promise<string | null> {
  return (await getMeta(db, "last_update_at")) ?? null;
}

/** True when the phone should update on opening: never updated, or not for 12 hours. */
export function isUpdateDue(lastUpdate: string | null, now = new Date()): boolean {
  if (!lastUpdate) return true;
  return now.getTime() - new Date(lastUpdate).getTime() > PHONE_UPDATE_AFTER_HOURS * 60 * 60 * 1000;
}
