// The database schema, versioned with SQLite's PRAGMA user_version (approach from FitApp).
// Both devices run the same migrations. Never edit a shipped migration; append a new one.
import { insertDefaultRules } from "../rules.ts";
import { saveRecord, syncColumns } from "../sync/records.ts";
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
  // 3: generic to-do lists (core/todos.ts). Synced between Lifeboard's devices only.
  `
  CREATE TABLE todo_list (
    ${syncColumns},
    name TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE TABLE todo_item (
    ${syncColumns},
    list_id TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL
  );
  CREATE INDEX todo_item_list ON todo_item (list_id);
  `,
  // 4: connections, alert rules and alerts (core/connections.ts, core/rules.ts, core/updates.ts).
  // Rules sync between devices; everything else is per device (each device signs in and
  // alerts on its own).
  async (db) => {
    await db.exec(`
      CREATE TABLE connection (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        last_checked_at TEXT,
        last_success_at TEXT
      );
      CREATE TABLE rule (
        ${syncColumns},
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        reading_type TEXT NOT NULL,
        conditions TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE TABLE rule_state (
        rule_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        matched INTEGER NOT NULL,
        PRIMARY KEY (rule_id, subject)
      );
      CREATE TABLE alert (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        message TEXT NOT NULL
      );
    `);
    await insertDefaultRules(db);
  },
  // 5: saved sign-ins (per device, never synced; core/credentials.ts) and daily nutrition
  // from Cronometer (synced; core/health.ts).
  `
  CREATE TABLE credential (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE nutrition_day (
    ${syncColumns},
    date TEXT NOT NULL,
    calories REAL,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL
  );
  CREATE INDEX nutrition_day_date ON nutrition_day (date);
  `,
  // 6: measurements from Google Health (steps, weight, body fat), synced (core/health.ts).
  `
  CREATE TABLE health_point (
    ${syncColumns},
    type TEXT NOT NULL,
    day TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    value REAL NOT NULL,
    source TEXT NOT NULL
  );
  CREATE INDEX health_point_type_day ON health_point (type, day);
  `,
  // 7: latest status of each pet device (per device, core/devices.ts), and the Litter-Robot
  // default alert rules.
  async (db) => {
    await db.exec(`
      CREATE TABLE device_status (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    await insertDefaultRules(db);
  },
  // 8: the feeder default alert rules (Smart Life).
  insertDefaultRules,
  // 9: Schedule (core/schedule/): Google calendars, task lists, events and tasks, plus the
  // queue of changes waiting to go to Google. All synced, so the phone (which has no
  // Google sign-in) sees them and its edits reach the desktop, which sends them on.
  `
  CREATE TABLE calendar (
    ${syncColumns},
    name TEXT NOT NULL,
    is_primary INTEGER NOT NULL,
    included INTEGER NOT NULL
  );
  CREATE TABLE task_list (
    ${syncColumns},
    title TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE TABLE calendar_event (
    ${syncColumns},
    calendar_id TEXT NOT NULL,
    google_id TEXT,
    recurring_id TEXT,
    is_series INTEGER NOT NULL,
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    notes TEXT NOT NULL,
    all_day INTEGER NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    time_zone TEXT,
    recurrence TEXT,
    original_start TEXT,
    etag TEXT
  );
  CREATE INDEX calendar_event_start ON calendar_event (start_at);
  CREATE INDEX calendar_event_google ON calendar_event (calendar_id, google_id);
  CREATE TABLE task (
    ${syncColumns},
    list_id TEXT NOT NULL,
    google_id TEXT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL,
    due TEXT,
    time TEXT,
    done INTEGER NOT NULL,
    completed_at TEXT,
    repeat TEXT,
    etag TEXT
  );
  CREATE INDEX task_google ON task (list_id, google_id);
  CREATE TABLE schedule_change (
    ${syncColumns},
    created_at TEXT NOT NULL,
    op TEXT NOT NULL
  );
  `,
  // 10: alerts can be dismissed from Monitor.
  "ALTER TABLE alert ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;",
  // 11: settings both devices share (synced), as JSON per setting id; first user: the
  // Litter-Robot level thresholds (core/whisker/levels.ts).
  `
  CREATE TABLE setting (
    ${syncColumns},
    value TEXT NOT NULL
  );
  `,
  // 12: feeder refills and run-dry sightings, for the food estimate (core/smartlife/food.ts).
  `
  CREATE TABLE feeder_event (
    ${syncColumns},
    feeder_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    portions REAL
  );
  CREATE INDEX feeder_event_feeder ON feeder_event (feeder_id, kind, at);
  `,
  // 13: water fountain refills (no connection; core/fountain.ts). `days` is the time since
  // the previous refill, null for the first.
  `
  CREATE TABLE fountain_refill (
    ${syncColumns},
    at TEXT NOT NULL,
    days REAL
  );
  `,
  // 14: maintenance items (core/maintenance.ts): repeating chores that each make a task on
  // the day they come due.
  `
  CREATE TABLE maintenance_item (
    ${syncColumns},
    name TEXT NOT NULL,
    notes TEXT NOT NULL,
    start_date TEXT NOT NULL,
    time TEXT,
    repeat TEXT,
    last_generated TEXT
  );
  `,
  // 15: two kinds of list (core/todos.ts): "todo" (existing lists) and "prototype".
  "ALTER TABLE todo_list ADD COLUMN kind TEXT NOT NULL DEFAULT 'todo';",
  // 16: health analysis (core/healthReview.ts, core/healthTargets.ts): the user's verdicts on
  // flagged days and entries (id "<date>-<kind>"), and each day's saved targets as JSON.
  `
  CREATE TABLE health_review (
    ${syncColumns},
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    verdict TEXT NOT NULL
  );
  CREATE TABLE health_target (
    ${syncColumns},
    date TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX health_target_date ON health_target (date);
  `,
  // 17: cats and their Litter-Robot weigh-ins (core/whisker/cats.ts). Weigh-in ids are
  // "<pet id>-<time>", so both devices store the same rows.
  `
  CREATE TABLE cat (
    ${syncColumns},
    name TEXT NOT NULL
  );
  CREATE TABLE cat_weigh_in (
    ${syncColumns},
    cat_id TEXT NOT NULL,
    at TEXT NOT NULL,
    weight_lbs REAL NOT NULL
  );
  CREATE INDEX cat_weigh_in_cat ON cat_weigh_in (cat_id, at);
  `,
  // 18: Litter-Robot drawer and litter levels at each update, for the time estimates
  // (core/whisker/estimates.ts). Synced, so the phone can estimate from the desktop's readings.
  `
  CREATE TABLE litter_level (
    ${syncColumns},
    serial TEXT NOT NULL,
    at TEXT NOT NULL,
    drawer REAL NOT NULL,
    litter REAL NOT NULL
  );
  CREATE INDEX litter_level_serial ON litter_level (serial, at);
  `,
  // 19: raw steps and heart rate stay on the device that pulled them (user, 2026-10-17): ~40,000
  // rows that made a first phone sync take many minutes. They move to raw_health_point (not
  // synced; pruned after RAW_KEEP_DAYS, core/healthSummary.ts), and each day's results (steps,
  // average heart rate, detected workouts) sync instead, one row per day. Both devices run
  // this, so removing the rows from health_point needs no tombstones.
  `
  CREATE TABLE raw_health_point (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    day TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    value REAL NOT NULL,
    source TEXT NOT NULL
  );
  CREATE INDEX raw_health_point_type_day ON raw_health_point (type, day);
  INSERT INTO raw_health_point (id, type, day, start_time, end_time, value, source)
    SELECT id, type, day, start_time, end_time, value, source FROM health_point
    WHERE type IN ('steps', 'heart-rate') AND deleted = 0;
  DELETE FROM health_point WHERE type IN ('steps', 'heart-rate');
  CREATE TABLE health_day_summary (
    ${syncColumns},
    date TEXT NOT NULL,
    steps REAL,
    average_heart_rate REAL,
    workouts TEXT NOT NULL
  );
  CREATE INDEX health_day_summary_date ON health_day_summary (date);
  `,
  // 20: device status is synced (user, 2026-10-17), so the phone shows the desktop's hourly
  // readings without signing in to Whisker or Smart Life itself. checked_at is when the
  // status was read; the newest reading wins, whichever device made it.
  async (db) => {
    const rows = await db.all("SELECT * FROM device_status");
    await db.exec(`
      DROP TABLE device_status;
      CREATE TABLE device_status (
        ${syncColumns},
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
    `);
    for (const row of rows) {
      await saveRecord(db, "device_status", { id: row.id, kind: row.kind, name: row.name, data: row.data, checked_at: row.updated_at });
    }
  },
  // 21: LitterHopper estimate (core/whisker/hopper.ts): dispenses read from the activity log
  // (id "<serial>-dispense-<time>", so both devices store the same rows) and the user's
  // refills, whose `dispenses` is the count since the previous refill (null for the first).
  `
  CREATE TABLE litter_hopper_event (
    ${syncColumns},
    serial TEXT NOT NULL,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    dispenses REAL
  );
  CREATE INDEX litter_hopper_event_serial ON litter_hopper_event (serial, kind, at);
  `,
  // 22: maintenance schedules move when a task is done off its date (core/maintenance.ts).
  // waits_for_task is the latest task made, which the next due date waits for; existing items
  // wait for their latest task, so the rule applies from it on (user, 2026-10-22).
  // shifted_from/shifted_repeat are the moved schedule; null while it's the original one.
  `
  ALTER TABLE maintenance_item ADD COLUMN waits_for_task TEXT;
  ALTER TABLE maintenance_item ADD COLUMN shifted_from TEXT;
  ALTER TABLE maintenance_item ADD COLUMN shifted_repeat TEXT;
  UPDATE maintenance_item SET waits_for_task = 'maint-' || id || '-' || last_generated WHERE last_generated IS NOT NULL;
  `,
  // 23: maintenance items active only part of the year (core/maintenance.ts): {from, to} as
  // "MM-DD" JSON; null = all year.
  "ALTER TABLE maintenance_item ADD COLUMN active_window TEXT;",
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
