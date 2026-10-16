// Turns a Smart Life pet feeder (Tuya category "cwwsq", e.g. the Petory F01W) into the
// readable status Lifeboard shows and alerts on. The F01W reports no food level or faults;
// what it does report is listed in agent-notes/2026-10-16-smartlife-feeders.md.
import type { RawDevice } from "./api.ts";

export const FEEDER_CATEGORY = "cwwsq";
export const FEED_STATES = ["standby", "feeding", "done"];

export interface Meal {
  /** Days it runs, Monday first. */
  days: boolean[];
  hour: number;
  minute: number;
  portions: number;
  enabled: boolean;
}

export interface FeederStatus {
  id: string;
  name: string;
  online: boolean;
  /** "standby", "feeding" or "done". */
  feedState: string;
  /** Portions the last feed dispensed. The feeder doesn't say when that was. */
  lastFeedPortions: number;
  meals: Meal[];
}

export function feederStatus(device: RawDevice): FeederStatus {
  const values = Object.fromEntries((device.status ?? []).map((s: { code: string; value: unknown }) => [s.code, s.value]));
  return {
    id: device.id,
    name: device.name,
    online: Boolean(device.online),
    feedState: String(values.feed_state ?? "unknown"),
    lastFeedPortions: Number(values.feed_report ?? 0),
    meals: typeof values.meal_plan === "string" ? decodeMealPlan(values.meal_plan) : [],
  };
}

/**
 * The feeder's schedule: base64 of 5 bytes per meal (weekday bits, hour, minute, portions,
 * enabled). The weekday bit order is assumed Monday = lowest bit; the user's schedule runs
 * every day, so this hasn't been checked against a partial week.
 */
export function decodeMealPlan(base64: string): Meal[] {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const meals: Meal[] = [];
  for (let i = 0; i + 5 <= bytes.length; i += 5) {
    const [dayBits, hour, minute, portions, enabled] = bytes.subarray(i, i + 5);
    meals.push({
      days: Array.from({ length: 7 }, (_, day) => Boolean(dayBits & (1 << day))),
      hour,
      minute,
      portions,
      enabled: enabled === 1,
    });
  }
  return meals;
}

/** The next enabled meal after `now` (local time), within the coming week; null if none. */
export function nextMeal(meals: Meal[], now = new Date()): { at: Date; portions: number } | null {
  let best: { at: Date; portions: number } | null = null;
  for (const meal of meals) {
    if (!meal.enabled) continue;
    for (let ahead = 0; ahead <= 7; ahead++) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, meal.hour, meal.minute);
      const mondayFirstDay = (at.getDay() + 6) % 7;
      if (at > now && meal.days[mondayFirstDay]) {
        if (!best || at < best.at) best = { at, portions: meal.portions };
        break;
      }
    }
  }
  return best;
}
