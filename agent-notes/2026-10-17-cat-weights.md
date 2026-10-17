# Cat weights from the Litter-Robot: what Whisker exposes

2026-10-17, agent (Claude). Investigation for the phase 4 "cat weight" item in docs/PLAN.md.
Probed the user's real account with read-only GraphQL queries (no commands sent).

## Findings
- **Per-cat weigh-ins exist.** Pet profile API `https://pet-profile.iothings.site/graphql/`
  (same Cognito ID token as LR4): `getPetsByUser(userId)` returns each pet with `weight`
  (Whisker's estimate), `lastWeightReading`, `weightIdFeatureEnabled` (true for all three
  cats) and `weightHistory { weight timestamp }`. `getWeightHistoryByPetId(petId, limit)`
  returns the same list. Field names from pylitterbot `pet.py`.
- **Per-cat history is short:** only about the last 7 days (2026-10-11 to 10-17), whatever
  `limit` is. To keep a trend, Lifeboard must store the weigh-ins itself; an update at least
  every few days never misses any (desktop updates hourly).
- **The robot's activity log goes back much further, but without the cat.**
  `getLitterRobot4Activity(serial, startTimestamp, endTimestamp, limit, consumer: "app")`
  entries with `value: "catWeight"` carry the weight in `actionValue` (lb). Data back to at
  least 2025-10 (none in a window ending 2024-11). Without `startTimestamp` the API returns
  only about 6 days. Timestamps are `"YYYY-MM-DD HH:MM:SS"` UTC (with nanoseconds in
  responses); pet history timestamps are ISO without a zone.
- **Attribution:** since 2026-10-11 the robot logged 114 weigh-ins and the pet histories
  hold 113, so nearly every visit is assigned to a cat.
- **The cats are far apart in weight** (Scout ≈ 7.7 lb, Big O ≈ 9.3, Norm ≈ 12.8), so older
  robot weigh-ins could be assigned to a cat by weight with little ambiguity. Rare outliers
  exist (one reading at 6.x, one at 8.x in the week).
- Visits per cat in that week: Scout 79, Big O 19, Norm 15.

## Probe scripts
Throwaway, in the session scratchpad (not kept): read the saved Whisker credential from
`data/lifeboard.db` read-only, refreshed the ID token with `cognitoWhiskerApi.refresh`, and
ran the queries above.

## Built (2026-10-17, user decisions)
- No backfill from the robot's log (user: Scout and Big O used to weigh about the same).
- `core/whisker/cats.ts`: synced `cat` and `cat_weigh_in` tables (migration 17); weigh-in id
  `<petId>-<ISO time>` so both devices store the same rows; existing ids are skipped, not
  re-saved (no sync churn). Every weigh-in counts as a visit.
- Alerts (Settings → Litter-Robot, synced setting `cat_alerts`): weight = median of the last
  7 days vs the 7 days ending `weightCompareDays` (default 14) earlier, each needing ≥3
  weigh-ins, alert at ≥ `weightChangePercent` (default 5) either way, edge-triggered. Visits =
  today's count above the cat's limit, once per cat per day. Automatic limit (blank setting):
  max(2 × median, median + 3) visits/day over up to 14 full days, ≥3 days needed; the first
  stored day is skipped as partial. With the real data: Big O 5, Norm 5, Scout 24.
- Pets page: a card per cat with uPlot charts (`app/ui/chart.ts`, first use of uPlot; the
  Health page graphs can reuse it): day's median weight and visits per day, from the first
  stored day (at least a week, at most 30 days). Colors: dark-surface reference categorical
  slots in name order, first three validated against `--surface` (#1e293b); never reused.
