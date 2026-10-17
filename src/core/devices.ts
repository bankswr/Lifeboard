// The latest status of each device an integration reads (Litter-Robots, feeders),
// for the Hub and Pets screens. Synced (user, 2026-10-17): the phone shows the desktop's hourly
// readings without its own sign-ins; whichever device read a device last wins.
import { utcNow, type Db } from "./db/types.ts";
import { saveRecord } from "./sync/records.ts";

export interface DeviceStatus<T = Record<string, any>> {
  id: string;
  kind: string;
  name: string;
  data: T;
  /** When the status was read (by either device). */
  updatedAt: string;
}

export async function saveDeviceStatus(db: Db, id: string, kind: string, name: string, data: object): Promise<void> {
  await saveRecord(db, "device_status", { id, kind, name, data: JSON.stringify(data), checked_at: utcNow() });
}

export async function listDeviceStatuses(db: Db): Promise<DeviceStatus[]> {
  // Litter-Robots before feeders (user, 2026-10-16), then by name.
  const rows = await db.all("SELECT * FROM device_status WHERE deleted = 0 ORDER BY CASE kind WHEN 'litter_robot' THEN 0 ELSE 1 END, name");
  return rows.map((row) => ({ id: row.id, kind: row.kind, name: row.name, data: JSON.parse(row.data), updatedAt: row.checked_at }));
}
