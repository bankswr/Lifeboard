# Health page: graphs, tables, explanations, workouts, typical-day steps

2026-10-17, agent (Claude, Lane A of the build batch). docs/PLAN.md phase 7a "Later, with the
Health page work" plus the same day's decisions (workouts, typical day). Built, unit-tested,
and checked in Chromium at phone width (420 px) on a copy of the real database with sign-ins
removed (port 5181).

## Where things are
- `core/workouts.ts`: `detectWorkouts` (pure) and `workoutEnergy`. Settings live in Health
  settings (`workoutHeartRateAbove` 30, `workoutMinMinutes` 30, `workoutMaxStepsPerHour`
  3000, `workoutMets` 3.5), edited under Settings → Health.
- `core/energy.ts`: `fillMissingSteps` (typical day), workout energy in the fit
  (`EnergyDay.workoutKcal`), `median` (moved here from `smartlife/food.ts`, which re-exports
  it), and new `Targets` fields for the explanations (`averageIntake`, `storedPerDay`,
  `averageStepKcal`, `averageWorkoutKcal`, `previousDayStepsEstimated`; absent from targets
  saved before 2026-10-17). `checkIntake` now takes only the four fields it uses.
- `core/healthTargets.ts`: `prepareDays` (review + typical day + workout energy), used by
  `analyzeHealth` and the page; `loadWorkouts`.
- `core/healthPage.ts`: `healthPage(db)` → `{ analysis, days (90, oldest first, ending
  today), workouts }`; API `getHealthPage`.
- `app/ui/chart.ts`: now multi-series (`ChartSpec.series`), `visibleDays` (shared range),
  `syncKey` (shared cursor), `yRange` zero / span / symmetric, `counts` for whole-number
  ticks. The Pets cat charts use the same spec.
- `app/ui/views/health.ts`: the page. View state (range, macro view, table tab, rows shown)
  is module state; the page data is cached and refetched only on a new visit or after a
  verdict, so switching tabs or range doesn't reload ~1 s of analysis.

## Decisions not obvious from the code
- **Workout detection uses the ring's steps** (the primary step source, minus treadmill
  time) for the pace check, not the phone's (`com.google.android.apps.fitness`) used in the
  investigation. On the copy: ~4.5 workouts a week over 13 weeks, mostly 6–8 AM (the
  investigation's 3.6/week used phone steps). Thresholds are settings if it's too eager.
- **A workout overlapping any treadmill record is skipped** (walks count by their steps).
- **Workout energy uses the latest valid weigh-in** on or before the workout's day (raw,
  not the 7-day average) in the fit; the page's workout list uses the 7-day average. The
  difference is a few kcal.
- **Targets unchanged on average:** workout energy only moves part of the fitted "besides
  steps" multiple to workout days (tested).
- **Typical day:** median of the measured steps in the 14 days before; needs ≥3 such days;
  filled days don't feed later fills. Applied to the cleaned days only (the high-steps flag
  sees the raw data).
- **Past targets** for days without a saved row are worked out with current settings and
  current verdicts, and marked "*" in the table. The goal used to judge a past day's
  calories is the one saved with its targets, else today's setting.
- **Weight and body fat are two graphs, not one with two axes** (the dataviz rules forbid
  dual axes). Each has the 7-day average line and raw dots; pending readings are yellow dots
  and rejected ones red rings, shown only when there are any (legend entries carry the
  label, so state isn't color alone).
- **Burn lines** on the energy graph are each morning's estimate of the average daily burn
  (window ending the day before), one per model; the split line is shown only where its fit
  succeeded.
- **Colors:** blue/orange/aqua (reference dark slots 1–3, validated all-pairs on #1e293b);
  the review status colors are the app's --warning/--danger (fail the categorical lightness
  band by design: they're status colors with labels). Targets are a muted dashed line.
- **y-axis labels** use uPlot's own formatter (decimals follow the tick step); a custom
  one-decimal formatter mislabeled 9.25 as 9.3. Axis `space` is 22 px: the plots are short.
