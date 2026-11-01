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
- **Weight and body fat** were two graphs at first (the dataviz rules forbid dual axes);
  since 2026-10-20 they share one graph with two axes at the user's request (see below). Each has the 7-day average line and raw dots; pending readings are yellow dots
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

## Trend projections, lean and fat mass graphs (2026-10-20)
- User asked for each body graph's trend carried a week past the last data point, and for
  lean mass and fat mass graphs (they move differently from body fat %).
- `healthPage` returns `trends` (weight, body fat, lean, fat): the least-squares slope of the
  fresh (not carried) 7-day averages over the fit window (`windowDays`) ending at the last
  reading, the same fit as the targets' weight trend, so the weight graph's "+x lb/week"
  matches the Body composition card. The line starts where the 7-day average line ends (today: the average covers the days before, so it runs a day past the last reading) at its value, so the two don't fork (user, 2026-10-20)
  and runs `TREND_DAYS` (7) on. Null with fewer fresh averages than `minimumDays`.
- Lean = weight average × (1 − body fat average), fat = weight average × body fat average
  (product of averages, as `splitTrend` does); their fit ends at the last weight or body
  fat reading.
- Only the body graphs get the extra future dates (their `visibleDays` grows by the same
  count); the other graphs end today.
- The trend uses the full fit window, not the shown range, so in the 2-week view it can
  point the other way from the last few days (seen on real data: lean mass).

## One graph at a time, dual axes, data-fit y ranges (2026-10-20, user's layout)
- The Graphs card has a selector (a `<select>`: six choices don't fit a segmented switch at
  phone width) and shows one 320 px graph: weight + body fat, lean + fat mass (each pair on
  two y axes, the second measure on the right, blue/orange), intake and burn, the three
  macros with dashed targets in the same colors, the macros minus their targets on one axis,
  resting heart rate. The shared cursor (`syncKey`) is no longer used here.
- `chart.ts`: `SeriesSpec.axis: "right"` puts a series on a second scale (`y2`, right axis,
  no grid of its own so the grid lines don't clash); `leftLabel`/`rightLabel`, `height`,
  `rightDecimals`; `yRange: "data"` is exactly the lowest to highest shown value on each
  axis (user), trends included. uPlot computes those from the visible x window only. Dots
  at the very top or bottom are half clipped as a result.
- The macro delta graph is lines, not bars (three series' bars would crowd), with a dashed
  zero "On target" line, which also keeps zero inside the data-fit range.
- Deviation lines (user, 2026-10-20): on the weight + body fat graph each reading has a
  faint (alpha 0.5) vertical line to its 7-day average on the same day, to show the spread.
  `SeriesSpec.deviationTo` names the line by label; `chart.ts` draws them in uPlot's
  `drawAxes` hook so they sit under the series. "Fit line" was read as the 7-day average:
  the dashed trend covers only days after the readings.

## Steps graph, legend lines, default legend day (2026-10-26, user)
- "Steps" in the graph selector: measured steps as bars up to yesterday (today is partial; the
  user tracks it in another app), typical-day fill-ins left out (no bar), dashed 10,000 line.
- `chart.ts` legend: `SeriesSpec.group` names a category (default: its own label). When any
  category has more than one series, `groupLegend` turns uPlot's legend into a CSS grid
  (`auto-fill` 170 px columns) and starts each category on column 1, so matching entries line
  up and a long category wraps in the same columns. A chart whose categories all have one entry
  (intake/burn, macros vs target) keeps uPlot's single wrapping line (user).
- Default day: a `setLegend` hook re-sets the legend to the last value of the first "points"
  series (raw readings), else the first series, whenever no day is hovered. Readings first
  because the body graphs' 7-day average runs a day past the last weigh-in, which left the
  readings blank.
- The range switch (`RANGES`, `rangePicker`) moved to `chart.ts`, shared with the Pets cats card.
- Checked with Playwright (scratch install of playwright-core, the cached chromium-1243) at 420
  and 1000 px against the real desktop server.
- 2026-10-29: charts respond to touch (user: tapping a chart on the phone showed nothing).
  `followTouch` in `chart.ts` moves uPlot's cursor on touchstart/touchmove (with sync, so the
  Health page's shared cursor follows); `.u-over` has `touch-action: pan-y` so vertical drags
  still scroll the page. Checked in headless Chrome with CDP `Input.dispatchTouchEvent`: the
  readout follows the finger and stays after it lifts; tapping another chart clears it, as on
  desktop. The emulator has no chart data, so it wasn't checked there.

## FFMI graph (2026-11-01, user)
- "FFMI" in the graph selector: fat-free mass index and adjusted FFMI on one axis (kg/m²), each
  with its 7-day-average line and trend. Written by the user; tests added in
  `test/healthTargets.test.ts` ("FFMI (72 in tall)").
- FFMI = lean mass (from the 7-day averages, as for lean mass) ÷ 2.2 lb/kg ÷ height². Height is
  hard-coded at 72 in for now; a Health setting would be needed for anyone else.
- Adjusted = FFMI + 6.1 × (1.8 − height m), the Kouri et al. (1995) coefficient. Most online
  calculators use 6.3; at 72 in the difference is about 0.005.
- The adjusted trend must be fitted on `adFfmiOn`, not `ffmiOn`: the slope is the same (constant
  offset) but the line would start ~0.18 below its average line. A test checks the start points.
