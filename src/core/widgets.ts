// Android home-screen widgets (docs/PLAN.md phase 8): the snapshot they show. The widgets
// themselves (android/.../widgets/) only draw rows from this snapshot; every decision about
// what a row says lives here, in TypeScript, so no health, pet or list logic is in Java.
// The app rebuilds the snapshot whenever it runs (open, update, sync, edits) and hands it
// over through capacitor-widget-bridge (src/app/widgets.ts).
// Times are given as fixed points ("Tue 3:00 PM"), not countdowns, so a widget stays right
// between updates (the phone does no background polling).
import { addDays, localDate } from "./dates.ts";
import type { Db } from "./db/types.ts";
import { listDeviceStatuses, type DeviceStatus } from "./devices.ts";
import type { Targets } from "./energy.ts";
import { estimateFountain, FOUNTAIN_NAME, type FountainEstimate } from "./fountain.ts";
import { analyzeHealth } from "./healthTargets.ts";
import { recentAlerts, type AlertEntry } from "./rules.ts";
import { getSchedule, type ScheduleDay } from "./schedule/store.ts";
import type { FeederStatus } from "./smartlife/feeder.ts";
import { estimateAllFood, type FoodEstimate } from "./smartlife/food.ts";
import { getAllTodoLists, type TodoListDetail } from "./todos.ts";
import { litterEstimates, type LitterEstimate } from "./whisker/estimates.ts";
import type { LitterRobotStatus } from "./whisker/status.ts";

const DAY_MS = 86_400_000;
/** Days after today that the Calendar widget's "Upcoming" section covers. */
const UPCOMING_DAYS = 7;
const MAX_ALERTS = 20;

/** How a row is drawn; the widget maps each to a color from the app's theme. */
export type RowStyle = "header" | "normal" | "muted" | "warning" | "alarm" | "good";

export interface WidgetRow {
  /** Main text, left. */
  title: string;
  /** Smaller second line under the title. */
  sub?: string;
  /** Right-aligned text (a number, a time). */
  value?: string;
  style: RowStyle;
  /** Lists widget: the to-do item this row ticks, and whether it's ticked. */
  itemId?: string;
  done?: boolean;
  /** App page a tap opens ("health", "lists", ...); the widget's own link when absent. */
  link?: string;
}

export interface WidgetContent {
  title: string;
  /** App page the widget's header opens. */
  link: string;
  rows: WidgetRow[];
  /** Shown when there are no rows. */
  empty: string;
}

export interface WidgetSnapshot {
  takenAt: string;
  /** "as of Oct 17, 9:56 AM": when the data was taken, shown on every widget. */
  takenLabel: string;
  health: WidgetContent;
  calendar: WidgetContent;
  alerts: WidgetContent;
  pets: WidgetContent;
  /** One per to-do list; each Lists widget shows the one chosen when it was placed. */
  lists: (WidgetContent & { id: string })[];
}

// ---------- formatting ----------

/** "Tue 3:00 PM", or "today 3:00 PM" / "tomorrow 3:00 PM" when close. */
export function whenLabel(at: Date, now: Date, locale?: string): string {
  const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const day = localDate(at);
  if (day === localDate(now)) return `today ${time}`;
  if (day === addDays(localDate(now), 1)) return `tomorrow ${time}`;
  if (at.getTime() - now.getTime() < 6 * DAY_MS) return `${at.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  return `${at.toLocaleDateString(locale, { month: "short", day: "numeric" })} ${time}`;
}

function timeLabel(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

function dayLabel(date: string, locale?: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });
}

/** "9:00 AM" from a task's "HH:MM". */
function taskTimeLabel(time: string, locale?: string): string {
  const [hour, minute] = time.split(":").map(Number);
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

// ---------- the widgets ----------

export function healthWidget(targets: Targets | null): WidgetContent {
  const rows: WidgetRow[] = targets
    ? [
        { title: "Calories", value: `${targets.calories.toLocaleString("en-US")} kcal`, style: "normal" },
        { title: "Protein", value: `${targets.proteinG} g`, style: "normal" },
        { title: "Carbs", value: `${targets.carbsG} g`, style: "normal" },
        { title: "Fat", value: `${targets.fatG} g`, style: "normal" },
        ...targets.warnings.map((warning): WidgetRow => ({ title: warning, style: "warning" })),
      ]
    : [];
  return { title: "Today's targets", link: "health", rows, empty: "No targets yet: health data is still coming in." };
}

/**
 * Today: open tasks (overdue first, as on the Schedule), then all-day and timed events.
 * Upcoming: events of the next days, no tasks (tasks work as reminders at their time).
 */
export function calendarWidget(days: ScheduleDay[], today: string, locale?: string): WidgetContent {
  const rows: WidgetRow[] = [];
  const todayDay = days.find((day) => day.date === today);
  if (todayDay) {
    rows.push({ title: `Today · ${dayLabel(today, locale)}`, style: "header" });
    for (const task of todayDay.tasks.filter((t) => !t.done)) {
      rows.push({
        title: task.title,
        sub: task.overdue && task.due ? `Overdue · was due ${dayLabel(task.due, locale)}` : undefined,
        value: task.time ? taskTimeLabel(task.time, locale) : undefined,
        style: task.overdue ? "alarm" : "normal",
      });
    }
    for (const event of todayDay.allDay) rows.push({ title: event.title, value: "All day", style: "normal" });
    for (const event of todayDay.timed) rows.push({ title: event.title, value: timeLabel(event.start, locale), style: "normal" });
    if (rows.length === 1) rows.push({ title: "Nothing open today", style: "muted" });
  }
  const upcoming = days.filter((day) => day.date > today);
  const upcomingRows: WidgetRow[] = [];
  for (const day of upcoming) {
    const label = new Date(`${day.date}T12:00:00`).toLocaleDateString(locale, { weekday: "short" });
    // A multi-day all-day event is listed once, on its first day in the range.
    for (const event of day.allDay.filter((e) => e.start === day.date || day === upcoming[0])) {
      upcomingRows.push({ title: event.title, value: `${label} · all day`, style: "normal" });
    }
    for (const event of day.timed) upcomingRows.push({ title: event.title, value: `${label} ${timeLabel(event.start, locale)}`, style: "normal" });
  }
  if (upcomingRows.length > 0) rows.push({ title: "Upcoming", style: "header" }, ...upcomingRows);
  return { title: "Calendar", link: "schedule", rows, empty: "Nothing scheduled." };
}

export function alertsWidget(alerts: AlertEntry[], now: Date, locale?: string): WidgetContent {
  return {
    title: "Alerts",
    link: "monitor",
    rows: alerts.slice(0, MAX_ALERTS).map((alert) => ({
      title: alert.message,
      sub: `${alert.subject} · ${whenLabel(new Date(alert.createdAt), now, locale)}`,
      style: "alarm",
    })),
    empty: "No alerts.",
  };
}

export interface PetInputs {
  devices: DeviceStatus[];
  litter: Record<string, LitterEstimate>;
  food: Record<string, FoodEstimate>;
  fountain: FountainEstimate;
}

/** When each device needs attention, as a time; red once it's due, yellow at its warning level. */
export function petsWidget(inputs: PetInputs, now: Date, locale?: string): WidgetContent {
  const rows: WidgetRow[] = [];
  const at = (iso: string) => whenLabel(new Date(iso), now, locale);
  for (const device of inputs.devices.filter((d) => d.kind === "litter_robot")) {
    const robot = device.data as LitterRobotStatus;
    const estimate = inputs.litter[robot.serial];
    rows.push({ title: robot.name, value: robot.status, style: "header" });
    rows.push(levelRow("Drawer full", robot.drawerFull || estimate?.drawer.reached, estimate?.drawer.at ?? null, at));
    rows.push(levelRow("Litter low", estimate?.litter.reached ?? false, estimate?.litter.at ?? null, at));
  }
  const feeders = inputs.devices.filter((d) => d.kind === "feeder");
  if (feeders.length > 0) rows.push({ title: "Feeders", style: "header" });
  for (const device of feeders) {
    const feeder = device.data as FeederStatus;
    const estimate = inputs.food[feeder.id];
    rows.push(daysLeftRow(`${feeder.name}: food out`, estimate?.daysLeft ?? null, estimate?.state ?? "ok", now, at));
  }
  rows.push({ title: FOUNTAIN_NAME, style: "header" });
  rows.push(daysLeftRow("Water out", inputs.fountain.daysLeft, inputs.fountain.state, now, at));
  return { title: "Pets", link: "pets", rows, empty: "No devices yet." };
}

function levelRow(label: string, reached: boolean | undefined, when: string | null, at: (iso: string) => string): WidgetRow {
  if (reached) return { title: label, value: "now", style: "alarm" };
  return { title: label, value: when ? `≈ ${at(when)}` : "learning", style: when ? "normal" : "muted" };
}

function daysLeftRow(label: string, daysLeft: number | null, state: string, now: Date, at: (iso: string) => string): WidgetRow {
  if (daysLeft === null) return { title: label, value: "learning", style: "muted" };
  const when = new Date(now.getTime() + daysLeft * DAY_MS).toISOString();
  return { title: label, value: daysLeft <= 0 ? "now" : `≈ ${at(when)}`, style: state === "alarm" ? "alarm" : state === "warning" ? "warning" : "normal" };
}

/** To-do lists only: prototype lists' checkboxes pick items to copy, which a widget can't do. */
export function listWidgets(lists: TodoListDetail[]): (WidgetContent & { id: string })[] {
  return lists
    .filter((list) => list.kind === "todo")
    .map((list) => ({
      id: list.id,
      title: list.name,
      link: "lists",
      rows: [...list.open, ...list.done].map((item) => ({ title: item.text, style: "normal" as const, itemId: item.id, done: item.done })),
      empty: "Nothing on this list.",
    }));
}

// ---------- gathering ----------

export async function widgetSnapshot(db: Db, now = new Date()): Promise<WidgetSnapshot> {
  const today = localDate(now);
  const [analysis, days, alerts, devices, litter, food, fountain, lists] = await Promise.all([
    analyzeHealth(db, today),
    getSchedule(db, today, addDays(today, UPCOMING_DAYS), today),
    recentAlerts(db, MAX_ALERTS),
    listDeviceStatuses(db),
    litterEstimates(db),
    estimateAllFood(db, now),
    estimateFountain(db, now),
    getAllTodoLists(db),
  ]);
  return {
    takenAt: now.toISOString(),
    takenLabel: `as of ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
    health: healthWidget(analysis.targets),
    calendar: calendarWidget(days, today),
    alerts: alertsWidget(alerts, now),
    pets: petsWidget({ devices, litter, food, fountain }, now),
    lists: listWidgets(lists),
  };
}
