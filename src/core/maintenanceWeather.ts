// Weather rules for maintenance items (user, 2026-10-28), e.g. mowing "not when the chance of
// rain is over 30%, or the day after". Pure: given the forecast, finds the day an item's due
// date moves to. The rules (agreed in docs/PLAN.md):
// - Each condition compares one daily measure with a value. "avoid": a matching day is ruled
//   out; "only": a day that doesn't match is ruled out. Any one ruling a day out is enough.
// - Lead/lag: a day that rules a day out also rules out `lead` days before it and `lag` days
//   after it.
// - A day without a value for the measure (past the forecast, or no data) rules nothing out.
// - A ruled-out due date moves to the nearest day that fits, earlier winning ties (sooner
//   forecasts are more reliable), within `earliest`..`latest` and inside the forecast.
import { addDays } from "./dates.ts";
import { mondayFirstWeekday } from "./schedule/repeat.ts";
import type { WeatherDay } from "./weather.ts";

export const WEATHER_MEASURES = {
  highF: { label: "High temperature", short: "high", unit: "°F" },
  lowF: { label: "Low temperature", short: "low", unit: "°F" },
  humidity: { label: "Humidity", short: "humidity", unit: "%" },
  rainChance: { label: "Chance of rain", short: "rain", unit: "%" },
  rainIn: { label: "Rain amount", short: "rain", unit: " in" },
} as const;

export type WeatherMeasure = keyof typeof WEATHER_MEASURES;

export interface WeatherCondition {
  kind: "avoid" | "only";
  measure: WeatherMeasure;
  op: ">" | "<";
  value: number;
  /** Days before a ruling day that are ruled out too. */
  lead: number;
  /** Days after a ruling day that are ruled out too. */
  lag: number;
}

/** The day a due date moves to, or null if none fits; `reason` says why the due date was ruled out. */
export interface WeatherMove {
  date: string | null;
  reason: string | null;
}

export function conditionMatches(condition: WeatherCondition, day: WeatherDay): boolean | null {
  const value = day[condition.measure];
  if (value === null || value === undefined) return null;
  return condition.op === ">" ? value > condition.value : value < condition.value;
}

/** Why `date` is ruled out (e.g. "rain 60% on Fri"), or null if it fits. */
export function ruledOutBecause(date: string, conditions: WeatherCondition[], days: Map<string, WeatherDay>): string | null {
  for (const condition of conditions) {
    // A day `source` rules out source − lead … source + lag, so these are the ones that can reach `date`.
    for (let offset = -condition.lag; offset <= condition.lead; offset++) {
      const source = addDays(date, offset);
      const day = days.get(source);
      const matches = day ? conditionMatches(condition, day) : null;
      if (matches === null) continue;
      if (matches === (condition.kind === "avoid")) return describe(condition, day!, source === date ? null : source);
    }
  }
  return null;
}

/** "rain 60%", "high 34°F on Fri". */
function describe(condition: WeatherCondition, day: WeatherDay, otherDay: string | null): string {
  const measure = WEATHER_MEASURES[condition.measure];
  const value = day[condition.measure]!;
  // Inches of rain need decimals; whole °F and % read better.
  const shown = condition.measure === "rainIn" ? value.toFixed(2) : String(Math.round(value));
  const text = `${measure.short} ${shown}${measure.unit}`;
  return otherDay ? `${text} on ${weekdayName(otherDay)}` : text;
}

/**
 * Where `due` moves to: itself if it fits (or lies past the forecast, which can't judge it
 * yet), else the nearest fitting day in `earliest`..`latest` (and the forecast), earlier first.
 */
export function weatherMove(
  due: string, conditions: WeatherCondition[], forecast: WeatherDay[], earliest: string, latest: string | null,
): WeatherMove {
  if (conditions.length === 0 || forecast.length === 0) return { date: due, reason: null };
  const lastForecastDay = forecast[forecast.length - 1].date;
  if (due > lastForecastDay) return { date: due, reason: null };
  const days = new Map(forecast.map((day) => [day.date, day]));
  const last = latest && latest < lastForecastDay ? latest : lastForecastDay;
  const reason = ruledOutBecause(due, conditions, days);
  if (reason === null && due >= earliest) return { date: due, reason: null };
  const fits = (date: string) => date >= earliest && date <= last && ruledOutBecause(date, conditions, days) === null;
  for (let distance = 1; ; distance++) {
    const before = addDays(due, -distance);
    const after = addDays(due, distance);
    if (fits(before)) return { date: before, reason };
    if (fits(after)) return { date: after, reason };
    if (before < earliest && after > last) return { date: null, reason: reason ?? "no day fits" };
  }
}

export function weekdayName(date: string): string {
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][mondayFirstWeekday(date)];
}

export function validConditions(conditions: WeatherCondition[]): string | null {
  for (const condition of conditions) {
    if (!(condition.measure in WEATHER_MEASURES)) return "Choose what each weather condition measures.";
    if (!Number.isFinite(condition.value)) return "Give each weather condition a number.";
    if (![condition.lead, condition.lag].every((days) => Number.isInteger(days) && days >= 0 && days <= 7)) {
      return "Days before and after must be 0 to 7.";
    }
  }
  return null;
}
