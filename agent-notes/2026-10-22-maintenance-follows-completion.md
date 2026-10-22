# Maintenance schedule follows completion

2026-10-22 · Claude (Opus 5.5) · the rule itself is in `docs/PLAN.md` under Maintenance.

## Design (`src/core/maintenance.ts`)
- **State on the synced item:** `waits_for_task` (the latest task made; the next due date waits
  for it), `shifted_from` + `shifted_repeat` (the moved schedule; null = the original one).
  Migration 22 sets `waits_for_task` for existing items from `last_generated`, so the rule
  applies from each item's latest task on.
- **The move is worked out lazily** from the waited-for task each time (`upcomingSeries`), and
  only stored when the next task is made. That is what makes "untick undoes the move" free.
  Google completed tasks stay readable (`showHidden`), so clearing them in Google doesn't
  look like a delete. Deleting a done task before the next one is made does count as skipped.
- **Done day** = local date of `completed_at` (UTC from Google or `setTaskDone`). Compared with
  the scheduled date (`last_generated`, also in the task id), not the task's due in Google.
- **A moved schedule counts from the done day, which is not itself due** (`fromIsDue: false`).
  Monthly/yearly dates are computed from the schedule's first date (`addMonths(from, n·k)`)
  instead of stepping, so the 31st comes back after a short month. Repeating Google-style
  tasks (`nextTaskDue` in `schedule/repeat.ts`) still step and drift (31 → 28 → 28); left alone,
  since the user's request was about maintenance.
- **Weekly:** the move starts from the done day (or the due date, if done early) and
  `nextDate` gives the next chosen weekday, jumping `interval` weeks after the week's last
  chosen day. Empty weekdays are pinned to the start date's weekday.
- If `last_generated` isn't a date in the current schedule (e.g. an item made by the old
  drifting monthly code after a short month), no move is made for that task.
