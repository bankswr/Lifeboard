# Daily health summaries; raw steps and heart rate stay local

2026-10-17, agent (Claude). User decision after the first phone sync crawled (~42,600 rows,
nearly all raw steps and 10-minute heart-rate samples, saved one by one on the phone).

## What changed
- Migration 19: `raw_health_point` (plain, **not synced**) holds steps and heart-rate samples;
  existing rows moved there from `health_point` on both devices (no tombstones needed).
  `health_point` keeps weight, body fat and daily resting heart rate (synced; weigh-ins are
  reviewed one by one, so they stay individual).
- `core/healthSummary.ts`: `health_day_summary` (synced, id `day-<date>`): steps (ring +
  treadmill rules, `stepsByDay`), average heart rate, and the day's workouts as JSON.
  Saved only when changed (no sync churn).
  - `summarizeDays` runs after each Google health pull for the pulled range;
    `summarizeNewDays` at each update fills raw days without a summary and prunes raw data
    older than `RAW_KEEP_DAYS` (90, = the history pull); `resummarizeAll` runs when Health
    settings are saved (workout thresholds), via `api.saveHealthSettings`.
  - Days without raw data are never summarized (phone, or past retention): they keep the
    summary made where the raw data was.
- Readers switched: `healthDays` (steps, average HR) and `loadWorkouts` read summaries.

## Verified (copy of the real database, sign-ins removed)
- Migration 18 → 19; 90 days summarized in ~0.4 s; 49 days with workouts.
- Today's targets identical to those the old code saved (2,345 kcal, 178/248/71 g).
- A first phone sync now carries 930 rows instead of ~42,600.
- Trade-off accepted by the user: changed workout thresholds re-check only days that still
  have raw data (90 days on the desktop).
