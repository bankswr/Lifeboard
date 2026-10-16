// The latest status of each device an integration reads (Litter-Robots, feeders),
// for the Home screen. Per device and not synced: each device shows what it last fetched.
import { utcNow, type Db } from "./db/types.ts";

export interface DeviceStatus<T = Record<string, any>> {
  id: string;
  kind: string;
  name: string;
  data: T;
  updatedAt: string;
}

export async function saveDeviceStatus(db: Db, id: string, kind: string, name: string, data: object): Promise<void> {
  await db.run("INSERT OR REPLACE INTO device_status (id, kind, name, data, updated_at) VALUES (?, ?, ?, ?, ?)", [
    id, kind, name, JSON.stringify(data), utcNow(),
  ]);
}

export async function listDeviceStatuses(db: Db): Promise<DeviceStatus[]> {
  const rows = await db.all("SELECT * FROM device_status ORDER BY kind, name");
  return rows.map((row) => ({ id: row.id, kind: row.kind, name: row.name, data: JSON.parse(row.data), updatedAt: row.updated_at }));
}
