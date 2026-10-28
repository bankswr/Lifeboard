# Maintenance: active period and weather

2026-10-28 · Claude (Opus 5.5) · the rules themselves are in `docs/PLAN.md` under Maintenance → Advanced settings.

## Active period (`src/core/maintenance.ts`)
- `active_window` column (migration 23): `{from, to}` as "MM-DD"; `from > to` wraps the new year.
- Applied inside `occurrences()`, so every caller (due dates, "after N times", follows-completion)
  sees the same series: a date outside the window restarts the series at the next opening
  (`restartDate`: weekly → first chosen weekday on/after it). Feb 29 is refused as either end.
- Changing the window starts the schedule over, like changing the repeat.

## Weather
- `src/core/weather.ts`: Open-Meteo forecast (16 days + 7 past days for lag), °F and inches,
  stored as the synced `setting` row `weather_forecast`; location is the synced setting
  `weather_location`. It is an `Integration` with `signInMethod: "location"` and its own
  `signOut` (removes the location on both devices), so Connections shows its status. Both
  devices fetch at their updates; a forecast over 24 h old is ignored (`currentForecast`).
- `src/core/maintenanceWeather.ts` (pure): conditions, lead/lag, `weatherMove`. "Only" is
  treated as "avoid when it doesn't hold", with the same lead/lag. Missing values rule nothing out.
- `planNext` in maintenance.ts: the scheduled date `due` (latest missed, else next) and the
  day `on` to make the task. Bounds: today, the day after the last scheduled date (and after a
  skipped-through date), the window's end, the forecast's end.
- **Task id stays `maint-<item>-<scheduled date>`**, task `due` is the moved day. So a phone
  and desktop with different forecasts can't make two tasks; `last_generated` stays the
  scheduled date, which keeps follows-completion working.
- Weekly "back to the usual weekdays": `LastTask` now carries the task's `due`; a weekly
  task done by its moved day returns the current series with `skipThrough` = the moved day.
  Non-weekly items done on the moved day follow completion from it (agreed with the user).
- No fitting day: no task, alert once per hold (`rule_state` 'maintenance-weather', per
  device). When the window ends within the forecast, the date is dropped (`last_generated`
  set, `waits_for_task` null) with an alert. `generateMaintenanceTasks` now returns
  `{added, alerts}`; `runUpdate` delivers the alerts.

## Verified
- Unit tests: `test/maintenance.test.ts` (window), `test/maintenanceWeather.test.ts`.
- Desktop UI via Playwright on a throwaway server (`LIFEBOARD_DATA_DIR`, port 5199):
  location search/pick, form rows add/remove, save + reopen, list text. Gotcha: a lit
  `.value` on a `<select>` whose options are a nested `map` is set before the options
  exist; the options also need `?selected`.
- Not verified: an alert on a real update (the throwaway DB had no Google task list).
