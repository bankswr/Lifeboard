# Task reminders (phone notifications)

2026-10-17, agent (Claude), Lane B of the build batch. Plan: docs/PLAN.md phase 5,
"Reminders, planned 2026-10-17". Verified on the `fitapp_test` emulator (Android 16).

## How it works
- `core/reminders.ts` (pure, tested in `test/reminders.test.ts`): `upcomingReminders` lists
  open tasks with a date and a Lifeboard time still ahead, within 14 days, at that local
  time. No late reminders: a time that has passed is skipped. `snoozeReminder` stores
  "task → now + 10 min" in the meta table (`reminder_snoozes`, per device, not synced); a
  snooze replaces the task's own time and expired snoozes are dropped on the next snooze.
  Notification ids are a hash of the task id in 1,000,000,000–2,147,483,647, so they never
  clash with alert notifications (ids < 1,000,000, `src/app/notify.ts`) and rescheduling
  replaces rather than duplicates.
- `src/app/reminders.ts`: only Capacitor calls. `rescheduleReminders` cancels every pending
  notification marked `extra.kind = "task-reminder"` and schedules the current list. Runs
  at start (after sync and update), after each phone sync (`sync.ts`), and after phone
  calls that can change tasks (`CHANGES_TASKS` in `main.ts`, through the new
  `setAfterPhoneCall` hook in `backend.ts`). Done → `setTaskDone` (normal core path, so the
  change queues for Google and syncs); Snooze → `snoozeReminder`; a tap opens the Schedule.
- No migration.

## Decisions
- **Exact alarms are not requested automatically.** The plugin (8.3.1), when asked for an
  exact notification without "Alarms & reminders" access, opens that settings screen on
  every `schedule()` call. Recent Android denies it by default. So the app checks first and
  falls back to inexact timing; Settings (phone) has a "Task reminders" card with
  "Allow exact timing". Measured inexact delay on the emulator: 44 s and 19 s late, but
  Android's window allowed up to 7.5 min for the snoozed one (app standby).
- Snooze reminders say "Task reminder (snoozed)".

## Verified on the emulator
- A task made through the Schedule form at 09:50 → pending notification (id from the hash);
  app sent Home and its process killed (`am kill`; not force-stop, which cancels alarms) →
  notification posted 09:50:44 with Done / Snooze 10 min.
- Snooze from the notification (app not running) → Android launched the app, the snooze was
  stored (10:01:03) and rescheduled, the shown notification cleared. Killed again →
  re-posted 10:01:22 as "(snoozed)".
- Done from the notification → task done (completed_at set), `task.patch` queued, no pending
  reminders left.

## Gotchas found
- **Emulator sync settings pointed at the user's real desktop** (192.168.86.249:5180, saved
  2026-10-15). Its last sync was 10-15, so nothing went across today; Lane B cleared
  `desktop_address` / `sync_key` on the emulator so emulator test tasks can't reach the
  desktop (and from there Google Tasks). Re-enter them only on purpose.
- **Pre-existing:** delivering alerts on the phone asks for notification permission inside
  the phone's database queue (`updateNow` → `deliverAlerts` → `requestPermissions`), so on
  a first run every screen waits until the permission dialog is answered. Not changed here.
- The emulator has a seeded task list `test-list` ("Test list (emulator only)") and test
  tasks; that list never came from Google.
- `adb shell dumpsys notification` contains the word "snoozed" on its own (Android's snooze
  section); match the notification text exactly.
