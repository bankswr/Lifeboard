// Repeat rules for events and tasks, as the form offers them: daily, weekly on chosen days,
// monthly (same day of the month) or yearly, every N, ending never, on a date, or after N
// times. Events store them in Google as RFC 5545 RRULE lines; tasks keep them in Lifeboard
// (the Tasks API has no recurrence) and use nextTaskDue to make the next occurrence.
// A Google rule the form can't show (e.g. "2nd Tuesday monthly") is kept as `custom` and
// written back unchanged unless the user picks a new repeat.
import { addDays } from "../dates.ts";

export type Frequency = "daily" | "weekly" | "monthly" | "yearly";

export type RepeatEnd = { kind: "never" } | { kind: "until"; date: string } | { kind: "count"; count: number };

export interface Repeat {
  freq: Frequency;
  /** Every `interval` days/weeks/months/years. */
  interval: number;
  /** Weekly only: 0 = Monday … 6 = Sunday. Empty means the start date's weekday. */
  weekdays: number[];
  end: RepeatEnd;
  /** The original RRULE when the form can't represent it; written back as is. */
  custom?: string;
}

const FREQ_NAMES: Record<Frequency, string> = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };
const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/**
 * The RRULE line for a repeat. `allDay` decides the UNTIL format: a date for all-day events,
 * otherwise the end of that local day in UTC (RFC 5545 requires UTC there).
 */
export function toRRule(repeat: Repeat, allDay: boolean): string {
  if (repeat.custom) return repeat.custom;
  const parts = [`FREQ=${FREQ_NAMES[repeat.freq]}`];
  if (repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`);
  if (repeat.freq === "weekly" && repeat.weekdays.length > 0) {
    parts.push(`BYDAY=${[...repeat.weekdays].sort().map((day) => DAY_CODES[day]).join(",")}`);
  }
  if (repeat.end.kind === "until") parts.push(`UNTIL=${untilValue(repeat.end.date, allDay)}`);
  if (repeat.end.kind === "count") parts.push(`COUNT=${repeat.end.count}`);
  return `RRULE:${parts.join(";")}`;
}

function untilValue(date: string, allDay: boolean): string {
  if (allDay) return date.replace(/-/g, "");
  const [y, m, d] = date.split("-").map(Number);
  return utcStamp(new Date(y, m - 1, d, 23, 59, 59));
}

/** A Date as an RRULE UTC time, e.g. 20261016T045959Z. */
export function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Reads an event's recurrence lines; null when there is no RRULE. */
export function fromRecurrence(lines: string[]): Repeat | null {
  const rule = lines.find((line) => line.startsWith("RRULE:"));
  if (!rule) return null;
  const fields = new Map(
    rule.slice("RRULE:".length).split(";").map((part) => part.split("=") as [string, string]),
  );
  const custom: Repeat = { freq: "daily", interval: 1, weekdays: [], end: { kind: "never" }, custom: rule };
  const freq = (Object.keys(FREQ_NAMES) as Frequency[]).find((f) => FREQ_NAMES[f] === fields.get("FREQ"));
  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "UNTIL", "COUNT", "WKST"]);
  if (!freq || [...fields.keys()].some((key) => !known.has(key))) return custom;

  let weekdays: number[] = [];
  if (fields.has("BYDAY")) {
    if (freq !== "weekly") return custom; // e.g. monthly on the 2nd Tuesday
    weekdays = fields.get("BYDAY")!.split(",").map((code) => DAY_CODES.indexOf(code));
    if (weekdays.some((day) => day < 0)) return custom;
  }
  let end: RepeatEnd = { kind: "never" };
  if (fields.has("COUNT")) end = { kind: "count", count: Number(fields.get("COUNT")) };
  if (fields.has("UNTIL")) end = { kind: "until", date: untilDate(fields.get("UNTIL")!) };
  return { freq, interval: Number(fields.get("INTERVAL") ?? 1), weekdays, end };
}

/** UNTIL → local date: a plain date as is, a UTC time converted to this device's date. */
function untilDate(value: string): string {
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (value.length === 8) return date;
  const utc = new Date(`${date}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
  return `${utc.getFullYear()}-${String(utc.getMonth() + 1).padStart(2, "0")}-${String(utc.getDate()).padStart(2, "0")}`;
}

/**
 * The series' RRULE cut off so its last occurrence is before `beforeStart` (used for "this
 * and following" edits): any COUNT or UNTIL is replaced by an UNTIL just before that start.
 * Other recurrence lines (EXDATE, ...) are kept.
 */
export function endRecurrenceBefore(lines: string[], beforeStart: string, allDay: boolean): string[] {
  const until = allDay ? addDays(beforeStart, -1).replace(/-/g, "") : utcStamp(new Date(new Date(beforeStart).getTime() - 1000));
  return lines.map((line) => {
    if (!line.startsWith("RRULE:")) return line;
    const kept = line.slice("RRULE:".length).split(";").filter((part) => !/^(COUNT|UNTIL)=/.test(part));
    return `RRULE:${[...kept, `UNTIL=${until}`].join(";")}`;
  });
}

/**
 * For a repeating task: the next due date after `due` and the repeat to carry forward (a
 * COUNT end counts down). Null when the repeat has ended.
 */
export function nextTaskDue(repeat: Repeat, due: string): { due: string; repeat: Repeat } | null {
  if (repeat.end.kind === "count" && repeat.end.count <= 1) return null;
  const next = nextDate(repeat, due);
  if (repeat.end.kind === "until" && next > repeat.end.date) return null;
  const end: RepeatEnd = repeat.end.kind === "count" ? { kind: "count", count: repeat.end.count - 1 } : repeat.end;
  return { due: next, repeat: { ...repeat, end } };
}

/** The occurrence after `due`, ignoring the end. Monthly and yearly steps clamp to short months. */
export function nextDate(repeat: Repeat, due: string): string {
  switch (repeat.freq) {
    case "daily":
      return addDays(due, repeat.interval);
    case "weekly": {
      const weekday = mondayFirstWeekday(due);
      const days = repeat.weekdays.length > 0 ? [...repeat.weekdays].sort() : [weekday];
      const laterThisWeek = days.find((day) => day > weekday);
      if (laterThisWeek !== undefined) return addDays(due, laterThisWeek - weekday);
      // First chosen day of the week `interval` weeks on.
      return addDays(due, 7 * repeat.interval - weekday + days[0]);
    }
    case "monthly":
      return addMonths(due, repeat.interval);
    case "yearly":
      return addMonths(due, 12 * repeat.interval);
  }
}

/** 0 = Monday … 6 = Sunday. */
export function mondayFirstWeekday(isoDate: string): number {
  return (new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Same day `months` later, clamped to the month's last day (Jan 31 + 1 → Feb 28). */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** "Every 2 weeks on Mon, Wed, until Dec 1" style text for the schedule and form. */
export function describeRepeat(repeat: Repeat): string {
  if (repeat.custom) return "Custom repeat (set in Google)";
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[repeat.freq];
  let text = repeat.interval === 1 ? `Every ${unit}` : `Every ${repeat.interval} ${unit}s`;
  if (repeat.freq === "weekly" && repeat.weekdays.length > 0) {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    text += ` on ${[...repeat.weekdays].sort().map((day) => names[day]).join(", ")}`;
  }
  if (repeat.end.kind === "until") text += `, until ${repeat.end.date}`;
  if (repeat.end.kind === "count") text += `, ${repeat.end.count} times`;
  return text;
}
