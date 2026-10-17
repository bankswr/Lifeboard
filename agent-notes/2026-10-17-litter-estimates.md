# Litter-Robot time estimates

2026-10-17, agent (Claude, Lane A of the build batch). docs/PLAN.md phase 8 "Litter-Robot
estimates (new)". Built and unit-tested; shown on a copy of the real database (sign-ins
removed) with synthetic readings, since no level history existed yet.

## What exists
- `core/whisker/estimates.ts`: `recordLitterLevels` (called by the Whisker integration after
  each read), `litterEstimates(db)` → `{ [serial]: { drawer, litter } }`, each
  `{ at, ratePerDay, reached }`. `getStatus` returns it as `litterEstimates`; the Pets and
  Monitor Litter-Robot cards show "Drawer reaches 80% ≈ Mon, Oct 19, 1:42 PM".
  A widget snapshot can call `litterEstimates` directly.
- Table `litter_level` (migration 18), **synced**: the phone polls Whisker at most daily (and
  may not be signed in), so it estimates from the desktop's hourly readings. Cost: ~24 small
  rows a day. Readings closer than 30 minutes to the previous one for that robot are skipped
  (both devices updating). No pruning yet; old rows are harmless (only readings since the
  last reset are used).

## Decisions not obvious from the code
- **Reset detection:** the drawer's history restarts after a drop of ≥15 points between
  readings (emptied), the litter's after a rise of ≥10 points (refilled). Values are guesses
  sized for hourly readings; adjust if real data shows false resets.
- **Rate:** least-squares slope of the readings since the reset, projected from the latest
  reading to the alarm level from Settings → Litter-Robot. Needs ≥6 hours of readings and a
  rate of at least 0.5 points/day, otherwise "estimate learning".
- **Time, not countdown**, so a widget showing it stays right between updates (plan).
