// Readings: what an update learns about one thing, e.g. "Whisker sign-in: signed out" or
// "Litter-Robot: drawer 85% full". Every update produces a fresh reading for each thing it
// checks; alert rules (rules.ts) look at them. Each kind of reading is described here so the
// rule editor can offer its fields.

export type FieldValue = string | number | boolean;

export interface Reading {
  /** Which kind of reading (a READING_TYPES id). */
  type: string;
  /** The thing it's about, e.g. a connection or device name. Alerts are tracked per subject. */
  subject: string;
  data: Record<string, FieldValue>;
}

export interface ReadingField {
  name: string;
  label: string;
  type: "text" | "number" | "boolean";
  /** For text fields with a fixed set of values: the values, for the rule editor. */
  options?: string[];
}

export interface ReadingType {
  id: string;
  label: string;
  fields: ReadingField[];
}

export const CONNECTION_STATUSES = ["connected", "signed_out", "error"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const READING_TYPES: ReadingType[] = [
  {
    id: "connection",
    label: "Connection checked",
    fields: [
      { name: "status", label: "Status", type: "text", options: [...CONNECTION_STATUSES] },
      { name: "message", label: "Problem", type: "text" },
    ],
  },
];

export function readingType(id: string): ReadingType | undefined {
  return READING_TYPES.find((type) => type.id === id);
}
