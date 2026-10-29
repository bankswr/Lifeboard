// Cats (user, 2026-10-17): the Litter-Robot weighs each cat on every visit, and Whisker's pet
// profiles say which cat it was, but keep only about the last 7 days
// (agent-notes/2026-10-17-cat-weights.md). Each update stores the weigh-ins it hasn't seen,
// so the history grows from the day Lifeboard started reading them; there is no backfill.
// Every weigh-in counts as a visit. Two alerts, with thresholds in Settings → Litter-Robot:
// - Weight: the median of the last 7 days differs by the set % (default 5) from the median
//   of the 7 days that ended the set number of days earlier (default 14).
// - Visits: more visits today than the cat's limit. Cats differ a lot (Scout visits several
//   times as often as the others), so each cat has its own limit; until the user sets one,
//   it is worked out from the cat's own recent days.
import { addDays, localDate } from "../dates.ts";
import { get, type Db } from "../db/types.ts";
import { recordAlert, type NewAlert } from "../rules.ts";
import { median } from "../smartlife/food.ts";
import { saveRecord } from "../sync/records.ts";
import type { RawPet } from "./api.ts";

const DAY_MS = 86_400_000;
/** The "recent" weight is the median of this many days of weigh-ins. */
const WEIGHT_WINDOW_DAYS = 7;
/** Each weight window needs this many weigh-ins before it's compared. */
const MIN_WEIGH_INS = 3;
/** Days of history the automatic visit limit looks at, and how many it needs. */
const VISIT_HISTORY_DAYS = 14;
const MIN_VISIT_DAYS = 3;
/** Visits above a typical day before the automatic limit is passed. */
const AUTO_VISIT_MARGIN = 2;
/** Days of history for the Pets page's charts (its longest range). */
export const SHOWN_DAYS = 90;
/** Width of each bar in the time-of-day histogram, minutes. */
export const TIME_BIN_MINUTES = 30;

export interface CatSettings {
  weightChangePercent: number;
  weightCompareDays: number;
  /** Visits per day above which a cat raises an alert, by cat id; missing or null = automatic. */
  visitLimits: Record<string, number | null>;
}

export const DEFAULT_CAT_SETTINGS: CatSettings = { weightChangePercent: 5, weightCompareDays: 14, visitLimits: {} };

export interface CatDay {
  date: string;
  /** Median of the day's weigh-ins, lb; null on a day without any. */
  weight: number | null;
  visits: number;
  /** When each visit was, in minutes after the day's local midnight. */
  visitMinutes: number[];
}

export interface CatSummary {
  id: string;
  name: string;
  latestWeight: number | null;
  latestAt: string | null;
  /** Median of the last 7 days, lb. */
  recentWeight: number | null;
  /** % change from the earlier window; null until both windows have enough weigh-ins. */
  weightChange: number | null;
  /** How many days earlier the comparison window ends (setting). */
  weightCompareDays: number;
  todayVisits: number;
  /** The limit in use; null while there's too little history for an automatic one. */
  visitLimit: number | null;
  visitLimitIsAuto: boolean;
  /** Up to the last SHOWN_DAYS days, from the first stored weigh-in; oldest first. */
  days: CatDay[];
}

interface WeighIn {
  at: string;
  weight: number;
}

// ---------- storing what Whisker reports ----------

/** Saves each cat and any weigh-ins not stored yet. Ids are fixed, so both devices store the same rows. */
export async function saveCats(db: Db, pets: RawPet[]): Promise<void> {
  for (const pet of pets) {
    const stored = await get(db, "SELECT name FROM cat WHERE id = ? AND deleted = 0", [pet.petId]);
    if (stored?.name !== pet.name) await saveRecord(db, "cat", { id: pet.petId, name: pet.name });
    for (const entry of pet.weightHistory ?? []) {
      // Whisker's timestamps are UTC without a zone ("2026-10-17T13:19:20").
      const at = new Date(`${entry.timestamp}Z`).toISOString();
      const id = `${pet.petId}-${at}`;
      if (await get(db, "SELECT 1 FROM cat_weigh_in WHERE id = ?", [id])) continue;
      await saveRecord(db, "cat_weigh_in", { id, cat_id: pet.petId, at, weight_lbs: entry.weight });
    }
  }
}

// ---------- settings ----------

const SETTING_ID = "cat_alerts";

export async function getCatSettings(db: Db): Promise<CatSettings> {
  const row = await get(db, "SELECT value FROM setting WHERE id = ? AND deleted = 0", [SETTING_ID]);
  return row ? { ...DEFAULT_CAT_SETTINGS, ...JSON.parse(row.value) } : DEFAULT_CAT_SETTINGS;
}

export async function saveCatSettings(db: Db, settings: CatSettings): Promise<void> {
  if (!(settings.weightChangePercent > 0)) throw new Error("The weight change must be more than 0%.");
  if (!Number.isInteger(settings.weightCompareDays) || settings.weightCompareDays < WEIGHT_WINDOW_DAYS) {
    throw new Error(`Compare with at least ${WEIGHT_WINDOW_DAYS} days earlier, in whole days.`);
  }
  for (const limit of Object.values(settings.visitLimits)) {
    if (limit !== null && !(Number.isInteger(limit) && limit > 0)) throw new Error("Visit limits are whole numbers above 0, or blank for automatic.");
  }
  await saveRecord(db, "setting", { id: SETTING_ID, value: JSON.stringify(settings) });
}

// ---------- summaries ----------

export async function catSummaries(db: Db, now = new Date()): Promise<CatSummary[]> {
  const settings = await getCatSettings(db);
  const cats = await db.all("SELECT id, name FROM cat WHERE deleted = 0 ORDER BY name");
  const summaries: CatSummary[] = [];
  for (const cat of cats) {
    const weighIns: WeighIn[] = (
      await db.all("SELECT at, weight_lbs FROM cat_weigh_in WHERE cat_id = ? AND deleted = 0 ORDER BY at", [cat.id])
    ).map((row) => ({ at: row.at, weight: row.weight_lbs }));
    const today = localDate(now);
    const latest = weighIns.at(-1);
    const recent = weightWindow(weighIns, now, 0);
    const earlier = weightWindow(weighIns, now, settings.weightCompareDays);
    const userLimit = settings.visitLimits[cat.id] ?? null;
    summaries.push({
      id: cat.id,
      name: cat.name,
      latestWeight: latest?.weight ?? null,
      latestAt: latest?.at ?? null,
      recentWeight: recent,
      weightChange: recent !== null && earlier !== null ? ((recent - earlier) / earlier) * 100 : null,
      weightCompareDays: settings.weightCompareDays,
      todayVisits: weighIns.filter((w) => localDate(new Date(w.at)) === today).length,
      visitLimit: userLimit ?? automaticVisitLimit(weighIns, today),
      visitLimitIsAuto: userLimit === null,
      days: catDays(weighIns, today, latest ? weighIns[0].at : null),
    });
  }
  return summaries;
}

/** Median weight of the 7 days ending `daysAgo` days before now; null with too few weigh-ins. */
function weightWindow(weighIns: WeighIn[], now: Date, daysAgo: number): number | null {
  const end = now.getTime() - daysAgo * DAY_MS;
  const start = end - WEIGHT_WINDOW_DAYS * DAY_MS;
  const weights = weighIns.filter((w) => {
    const time = new Date(w.at).getTime();
    return time > start && time <= end;
  }).map((w) => w.weight);
  return weights.length >= MIN_WEIGH_INS ? median(weights) : null;
}

/** Visits per local day, for each day from `from` to `to` (inclusive), zero-filled. */
function visitsByDay(weighIns: WeighIn[], from: string, to: string): Map<string, WeighIn[]> {
  const days = new Map<string, WeighIn[]>();
  for (let date = from; date <= to; date = addDays(date, 1)) days.set(date, []);
  for (const weighIn of weighIns) days.get(localDate(new Date(weighIn.at)))?.push(weighIn);
  return days;
}

/** Days from the first stored weigh-in (at least a week, at most SHOWN_DAYS) to today. */
function catDays(weighIns: WeighIn[], today: string, firstAt: string | null): CatDay[] {
  const firstDay = firstAt ? localDate(new Date(firstAt)) : today;
  const from = [addDays(today, -(SHOWN_DAYS - 1)), [firstDay, addDays(today, -6)].sort()[0]].sort().at(-1)!;
  const days = visitsByDay(weighIns, from, today);
  return [...days].map(([date, entries]) => ({
    date,
    weight: median(entries.map((e) => e.weight)),
    visits: entries.length,
    visitMinutes: entries.map((e) => minutesAfterMidnight(new Date(e.at))),
  }));
}

function minutesAfterMidnight(time: Date): number {
  return time.getHours() * 60 + time.getMinutes();
}

/**
 * Visits in each TIME_BIN_MINUTES slot of the day, from midnight, over the last `lastDays` of
 * `days` (oldest first, as in CatSummary.days): the Pets page's time-of-day histogram.
 */
export function visitsByTimeOfDay(days: CatDay[], lastDays: number): number[] {
  const counts: number[] = new Array((24 * 60) / TIME_BIN_MINUTES).fill(0);
  for (const day of days.slice(-lastDays)) {
    for (const minutes of day.visitMinutes) counts[Math.floor(minutes / TIME_BIN_MINUTES)]++;
  }
  return counts;
}

/**
 * The cat's median visits per day over its recent full days, plus 2 (user, 2026-10-17: a
 * fixed margin stays tight for a cat that visits often, unlike a multiple); null with under
 * 3 days stored.
 * Days before the first stored weigh-in don't count: they're missing, not visit-free.
 */
export function automaticVisitLimit(weighIns: WeighIn[], today: string): number | null {
  if (weighIns.length === 0) return null;
  const firstDay = localDate(new Date(weighIns[0].at));
  const from = [addDays(today, -VISIT_HISTORY_DAYS), addDays(firstDay, 1)].sort().at(-1)!; // first day may be partial
  const yesterday = addDays(today, -1);
  if (from > yesterday) return null;
  const counts = [...visitsByDay(weighIns, from, yesterday).values()].map((entries) => entries.length);
  if (counts.length < MIN_VISIT_DAYS) return null;
  return Math.ceil(median(counts)! + AUTO_VISIT_MARGIN);
}

// ---------- alerts ----------

/**
 * At each update: alerts once when a cat's weight change reaches the set % (again only after
 * it has gone back under), and once per day when a cat's visits pass its limit.
 */
export async function checkCatAlerts(db: Db, now = new Date()): Promise<NewAlert[]> {
  const settings = await getCatSettings(db);
  const alerts: NewAlert[] = [];
  for (const cat of await catSummaries(db, now)) {
    const changed = cat.weightChange !== null && Math.abs(cat.weightChange) >= settings.weightChangePercent;
    if (await becameTrue(db, "cat-weight", cat.id, changed)) {
      const direction = cat.weightChange! < 0 ? "lost" : "gained";
      alerts.push(await recordAlert(db, cat.name,
        `${cat.name} has ${direction} ${Math.abs(cat.weightChange!).toFixed(1)}% over ${settings.weightCompareDays} days (now ≈ ${cat.recentWeight!.toFixed(1)} lb).`));
    }
    const tooMany = cat.visitLimit !== null && cat.todayVisits > cat.visitLimit;
    if (await becameTrue(db, "cat-visits", `${cat.id}:${localDate(now)}`, tooMany)) {
      alerts.push(await recordAlert(db, cat.name,
        `${cat.name} has used the litter box ${cat.todayVisits} times today (limit ${cat.visitLimit}).`));
    }
  }
  return alerts;
}

/** Records whether a condition holds and says whether it has just started to (edge-triggered). */
async function becameTrue(db: Db, ruleId: string, subject: string, holds: boolean): Promise<boolean> {
  const before = await get(db, "SELECT matched FROM rule_state WHERE rule_id = ? AND subject = ?", [ruleId, subject]);
  await db.run("INSERT OR REPLACE INTO rule_state (rule_id, subject, matched) VALUES (?, ?, ?)", [ruleId, subject, holds ? 1 : 0]);
  return holds && before?.matched !== 1;
}
