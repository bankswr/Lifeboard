// Updating: asks every set-up integration (Litter-Robot, Google, ...) for fresh readings,
// records how each connection went, and runs the alert rules over the results.
// When updates run is up to each device: the desktop at start and every hour, the phone
// on command or when first opened each day (docs/PLAN.md).
import { localDate } from "./dates.ts";
import { getMeta, setMeta } from "./db/meta.ts";
import { utcNow, type Db } from "./db/types.ts";
import { SignedOutError, type Integration } from "./integration.ts";
import { INTEGRATIONS } from "./integrations.ts";
import type { ConnectionStatus, Reading } from "./readings.ts";
import { checkFountainAlarm } from "./fountain.ts";
import { summarizeNewDays } from "./healthSummary.ts";
import { checkHealth } from "./healthTargets.ts";
import { generateMaintenanceTasks } from "./maintenance.ts";
import { evaluateRules, type NewAlert } from "./rules.ts";

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

export async function runUpdate(db: Db, integrations: Integration[] = INTEGRATIONS): Promise<UpdateResult> {
  // Before the integrations, so the Google one sends the new maintenance tasks in this run.
  const maintenance = await generateMaintenanceTasks(db);
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
  // The water fountain has no connection; its estimate only needs checking against the time.
  const fountainAlerts = await checkFountainAlarm(db);
  // After the pulls, so new health data is summarized, reviewed and used for today's targets.
  await summarizeNewDays(db);
  const healthAlerts = await checkHealth(db);
  await setMeta(db, "last_update_at", utcNow());
  return {
    alerts: [...(await evaluateRules(db, readings)), ...fountainAlerts, ...healthAlerts, ...maintenance.alerts],
    connections: await listConnections(db),
  };
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

/** True when the phone should update on opening: never updated, or not yet today (local time). */
export function isUpdateDue(lastUpdate: string | null, now = new Date()): boolean {
  if (!lastUpdate) return true;
  return localDate(new Date(lastUpdate)) !== localDate(now);
}
