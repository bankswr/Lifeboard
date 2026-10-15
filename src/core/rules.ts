// Alert rules, IFTTT-style: "when <reading type> comes in, if <conditions>, then notify
// <message>". A rule alerts when its conditions *become* true for a subject, not on every
// update while they stay true; once they stop being true it can alert again later.
// Rules are synced between devices; whether a rule currently matches is kept per device.
import { get, utcNow, type Db } from "./db/types.ts";
import { readingType, type FieldValue, type Reading } from "./readings.ts";
import { deleteRecord, nextSeq, saveRecord, upsert } from "./sync/records.ts";

export const OPERATORS = {
  equals: "is",
  not_equals: "is not",
  greater: "is more than",
  less: "is less than",
} as const;
export type Operator = keyof typeof OPERATORS;

export interface Condition {
  field: string;
  operator: Operator;
  value: FieldValue;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  readingType: string;
  /** All must hold. An empty list always holds. */
  conditions: Condition[];
  /** Notification text. {subject} and {<field>} are replaced with the reading's values. */
  message: string;
}

export interface NewAlert {
  ruleId: string;
  subject: string;
  message: string;
}

// ---------- default rules ----------

// Default rules have fixed ids and timestamps so the copies both devices create are the
// same row: sync sees neither as newer and they never duplicate.
const DEFAULT_RULES: Rule[] = [
  {
    id: "default-connection-problem",
    name: "Sign-in or connection problem",
    enabled: true,
    readingType: "connection",
    conditions: [{ field: "status", operator: "not_equals", value: "connected" }],
    message: "{subject}: {status}. {message}",
  },
];

export async function insertDefaultRules(db: Db): Promise<void> {
  for (const rule of DEFAULT_RULES) {
    await upsert(db, "rule", {
      ...toRow(rule),
      updated_at: "2026-01-01T00:00:00.000Z",
      updated_by: "default",
      deleted: 0,
      seq: await nextSeq(db),
    });
  }
}

// ---------- reading and editing rules ----------

export async function listRules(db: Db): Promise<Rule[]> {
  const rows = await db.all("SELECT * FROM rule WHERE deleted = 0 ORDER BY name");
  return rows.map(fromRow);
}

export async function getRule(db: Db, id: string): Promise<Rule | undefined> {
  const row = await get(db, "SELECT * FROM rule WHERE id = ? AND deleted = 0", [id]);
  return row && fromRow(row);
}

/** Creates (no id) or updates a rule. Returns its id. */
export async function saveRule(db: Db, rule: Omit<Rule, "id"> & { id?: string }): Promise<string> {
  const type = readingType(rule.readingType);
  if (!type) throw new Error("Choose what the rule watches.");
  if (!rule.name.trim()) throw new Error("Give the rule a name.");
  if (!rule.message.trim()) throw new Error("Write the notification message.");
  for (const condition of rule.conditions) {
    const field = type.fields.find((f) => f.name === condition.field);
    if (!field) throw new Error(`Unknown field: ${condition.field}`);
    if (!(condition.operator in OPERATORS)) throw new Error(`Unknown comparison: ${condition.operator}`);
    if (field.type === "number" && typeof condition.value !== "number") throw new Error(`${field.label} needs a number.`);
  }
  return saveRecord(db, "rule", toRow({ ...rule, id: rule.id ?? crypto.randomUUID(), name: rule.name.trim(), message: rule.message.trim() }));
}

export async function deleteRule(db: Db, id: string): Promise<void> {
  await deleteRecord(db, "rule", id);
  await db.run("DELETE FROM rule_state WHERE rule_id = ?", [id]);
}

function toRow(rule: Rule) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled ? 1 : 0,
    reading_type: rule.readingType,
    conditions: JSON.stringify(rule.conditions),
    message: rule.message,
  };
}

function fromRow(row: Record<string, any>): Rule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    readingType: row.reading_type,
    conditions: JSON.parse(row.conditions),
    message: row.message,
  };
}

// ---------- evaluating ----------

export function conditionHolds(condition: Condition, data: Reading["data"]): boolean {
  const actual = data[condition.field];
  if (actual === undefined) return false;
  switch (condition.operator) {
    case "equals":
      return String(actual) === String(condition.value);
    case "not_equals":
      return String(actual) !== String(condition.value);
    case "greater":
      return Number(actual) > Number(condition.value);
    case "less":
      return Number(actual) < Number(condition.value);
  }
}

/** "{subject} is {status}" → "Whisker is signed_out". Unknown names are left as written. */
export function fillMessage(template: string, reading: Reading): string {
  const values: Record<string, FieldValue> = { subject: reading.subject, ...reading.data };
  return template.replace(/\{(\w+)\}/g, (text, name: string) => (name in values ? String(values[name]) : text));
}

/**
 * Checks every enabled rule against new readings, records which rules now match, and saves
 * and returns an alert for each rule whose conditions just became true.
 */
export async function evaluateRules(db: Db, readings: Reading[]): Promise<NewAlert[]> {
  const rules = (await listRules(db)).filter((rule) => rule.enabled);
  const alerts: NewAlert[] = [];
  await db.transaction(async () => {
    for (const reading of readings) {
      for (const rule of rules.filter((r) => r.readingType === reading.type)) {
        const matches = rule.conditions.every((condition) => conditionHolds(condition, reading.data));
        const before = await get(db, "SELECT matched FROM rule_state WHERE rule_id = ? AND subject = ?", [rule.id, reading.subject]);
        await db.run(
          "INSERT OR REPLACE INTO rule_state (rule_id, subject, matched) VALUES (?, ?, ?)",
          [rule.id, reading.subject, matches ? 1 : 0],
        );
        if (matches && before?.matched !== 1) {
          const alert = { ruleId: rule.id, subject: reading.subject, message: fillMessage(rule.message, reading) };
          await db.run("INSERT INTO alert (created_at, rule_id, subject, message) VALUES (?, ?, ?, ?)", [
            utcNow(), alert.ruleId, alert.subject, alert.message,
          ]);
          alerts.push(alert);
        }
      }
    }
  });
  return alerts;
}

export interface AlertEntry {
  createdAt: string;
  subject: string;
  message: string;
}

export async function recentAlerts(db: Db, limit = 20): Promise<AlertEntry[]> {
  const rows = await db.all("SELECT created_at, subject, message FROM alert ORDER BY id DESC LIMIT ?", [limit]);
  return rows.map((row) => ({ createdAt: row.created_at, subject: row.subject, message: row.message }));
}
