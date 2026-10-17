# Lifeboard plan

Status: **draft**, 2026-10-15. Open questions at the bottom must be answered before
the phases they block start.

This file defines the project's scope. Work that falls outside it needs the user's
agreement first. Once agreed, it gets added here before it is built.

## Goal

A personal dashboard for organizing daily life, available in two places:

- **Desktop:** a web app served from this computer and opened in a browser.
- **Android phone:** an installed app that works away from home.

Each one runs the full app on its own, including pulling data from outside services.
When both are on the same network, they sync data with each other.

## v1 scope

| Module | What it does |
|---|---|
| Health | Get the data: daily calories, macros (protein/carbs/fat), weight, body fat, steps, pulled from Google Health and Cronometer (FitThing's logic, ported). Refinements (gap-fill, deltas, charts) are planned separately once the pipeline works. |
| Tasks & reminders | To-dos with due dates, recurring tasks, reminders. Editable; two-way sync with Google Tasks. Repeat rules live in Lifeboard, which creates each occurrence as a plain Google task (the Tasks API doesn't expose recurrence). |
| To-do lists | Generic checklists, kept in multiple separate lists. No external service; they only sync between Lifeboard's own devices. |
| Calendar | Events and appointments. Editable; two-way sync with Google Calendar. |
| Pets | Whisker Litter-Robot and Petory feeders: **read-only** status plus reliable notifications; feeder food and the (unconnected) water fountain are estimated from the user's "Refill" presses. Lifeboard never sends commands to the devices. **High priority.** |
| Connections | Every external sign-in reports its status. A lost sign-in raises an alert; it never fails silently. |
| Rules | User-defined IFTTT-style rules: *when* (an event from any module) *if* (conditions) *then* (actions). v1 has one action type: notify. Built-in alerts such as "signed out" are default rules the user can edit. |

**Stretch goal, after v1:** Finances (spending from bank CSV exports).

**Out of scope:** iPhone, a cloud server or relay, syncing over the internet,
multiple users, and syncing app code between devices (app updates are installed by
hand).

## Architecture

### One TypeScript codebase

This is the same approach as `../FitApp`. The phone has to pull external data itself,
so the shared logic must run on Android. TypeScript works on both the phone and the
desktop. FitThing's Python can't run on the phone, so the parts of it we use get
ported to TypeScript. That port is the main cost of this choice.

```
core/      Domain logic shared by both devices: data model, integrations
           (Google, Cronometer, pet devices), notification rules, sync
app/       UI (Vite + lit-html, as in FitApp), built into static files
desktop/   Small Node server: runs core on a schedule, keeps the desktop
           database, serves the UI, and is the phone's sync peer on the LAN
android/   Capacitor wrapper: runs core on the phone with native HTTP and
           background polling
```

The desktop runs a local server instead of doing everything in the browser for three
reasons:

- **Cross-site blocking:** browsers block cross-site requests (CORS) to services such
  as Cronometer and Whisker. Node and Capacitor's native HTTP are not blocked.
- **Background work:** polling and notifications have to keep running when no browser
  tab is open.
- **Sync peer:** it gives the phone something on the LAN to sync with.

### Data and sync

- **Storage:** SQLite on both devices. Reuse FitApp's schema, migration and adapter
  code.
- **Record fields:** every synced record has a UUID, an `updated_at`, the ID of the
  device that last changed it, and a `deleted` flag. Deletes become tombstones so
  that a delete syncs too.
- **Sync rule:** data only, both directions, with the newer edit winning for each
  record. The device ID breaks ties.
- **Finding the desktop:** the phone is given the desktop's LAN address in settings
  and syncs whenever it can reach it, both on demand and periodically. Automatic
  discovery (mDNS) is unreliable on Android and is left out of v1.
- **Clock skew:** "newer wins" relies on the device clocks agreeing, which is fine
  for normal phone and PC clocks. This is recorded as a known limit.

### Updating and notifications

- **Phone:** there is no background polling. Data updates on command, or when the
  app is first opened each day.
- **Desktop:** the server polls when it starts, then every hour while it keeps
  running, and notifies on the desktop. It doesn't need to monitor continuously.
- **Health pulls (user, 2026-10-17):** Cronometer and Google Health are pulled at most
  once per calendar day on each device, at its first update that day. The analysis uses
  only days before today, so later pulls the same day would change nothing it shows. The
  rest of Google (Calendar, Tasks) syncs on every update. After fixing an entry, the user
  can pull again with **Re-pull health data** under Settings → Health.
- **Shared rules:** the rules engine lives in `core/`, and rules sync like other
  data. Each alert has a dedupe key, so an alert is not repeated across polls or
  across devices after a sync.
- **Sign-in failures:** any failed sign-in or expired token turns into a
  "connection lost" event, which goes through the rules (alerting by default). The
  user's main complaint is being signed out silently and then getting no
  notifications.

## Reuse map

| Need | Source |
|---|---|
| Project skeleton, Vite/TS/Capacitor setup, SQLite adapters, local notifications, APK signing | `../FitApp/mobile` |
| Google Health client, Cronometer login and parsing, daily aggregation, dashboard charts | `../FitThing`, ported to TS; read its `agent-notes/` first |
| Litter-Robot (Whisker) API | `pylitterbot` (unofficial Python library used by Home Assistant) as the reference; check npm for an existing TS client first |
| Petory feeders | Tuya white-label hardware, now paired to the Smart Life app. Tuya's `tuya-device-sharing-sdk` (MIT, Home Assistant's QR sign-in), ported to TS |
| Calendar / tasks | Google Calendar API and Google Tasks API (same OAuth as Google Health) |

## Phases

Each phase ends with tests passing and an agent note. Before each feature phase
starts, its plan is reviewed with the user and adjusted. The plan below is the
current intent, not a commitment to details.

0. ✅ **Scaffold.** Copy the FitApp skeleton and set up the `core/` / `app/` /
   `desktop/` / `android/` layout. Get an empty app running on desktop and on the
   phone.
1. ✅ **Pet API spike.** Prove we can sign in to and read the Litter-Robot and the
   Petory feeders from Node and from the phone. This is the riskiest dependency:
   the APIs are unofficial and may change, and the Petory API is still unknown.
   (Superseded, user 2026-10-17: phase 4 built and live-verified both integrations.)
2. ✅ **Data model and LAN sync.** Build both, tested with a throwaway record type.
   - **Later (user, 2026-10-17; not started):** pair the phone by scanning the desktop's sync
     key with the phone's camera (a QR code), instead of typing it.
   - **Device status is synced (user, 2026-10-17):** the phone shows the desktop's hourly
     Litter-Robot and feeder readings without signing in to Whisker or Smart Life itself.
   - **Later (user, 2026-10-17; on hold):** phone sign-ins to Whisker, Smart Life and
     Cronometer failed (Whisker/Smart Life: host lookup failed on the phone, likely Private DNS
     or an ad-blocker; Cronometer: no session cookie after the login form). Not needed while
     the desktop syncs; revisit if the phone should read devices away from home.
3. ✅ **Connections and rules engine** (built 2026-10-15, accepted by the user 2026-10-17). Sign-in status for every integration, the
   events/conditions/actions model, and default "connection lost" alerts.
4. **Pets module.** Status dashboard, events, and default rules.
   (Litter-Robot 4 built 2026-10-15; live-verified 2026-10-16 (status and levels on Monitor);
   Petory feeders built 2026-10-16 via Smart Life (the user moved them from the Petory app);
   live-verified 2026-10-16.)
   - **Later (user, 2026-10-16; not started):** investigate the cat weight readings the
     Litter-Robot takes, for the Pets screen. Only the latest `catWeight` is read so far.
     First check whether Whisker keeps a weight per visit or per pet (pylitterbot's pet
     profiles appear to hold a weight history); if so, a weight trend per cat.
     **Investigated 2026-10-17** (agent-notes/2026-10-17-cat-weights.md): per-cat weigh-ins
     are available, but Whisker keeps only about 7 days of them; the robot's own log keeps
     every weigh-in for a year or more, without saying which cat.
     **Agreed 2026-10-17 (user):** store each cat's weigh-ins at every update, from now on
     (no backfill from the robot's log: Scout and Big O used to weigh about the same, so
     old readings can't be told apart by weight). On the Pets page, per cat: weight over
     time and visits per day. Alerts, with thresholds in Settings: a weight change of 5%
     or more (default) between recent weigh-ins and those two weeks earlier; and more
     visits in a day than a per-cat limit (cats differ: Scout visits far more often).
     Built 2026-10-17; live-verified the same day (113 weigh-ins stored for three cats).
5. **Tasks & reminders**, with Google Tasks sync, plus the generic to-do lists
   (to-do lists ✅ built 2026-10-15, accepted by the user 2026-10-17). Tasks built 2026-10-16
   together with phase 6 as the Schedule page; reminders deferred (user), the only part left.
   **Reminders, planned 2026-10-17 (user); built 2026-10-17 and verified on the emulator
   (agent-notes/2026-10-17-task-reminders.md):**
   - **What:** tasks that have a (Lifeboard-only) time, not done. Not calendar events
     (Google Calendar already notifies), no morning summary, nothing for date-only tasks.
   - **Where:** the phone only, as notifications scheduled in advance with Android's local
     notifications, so they arrive with the app closed. Lifeboard reschedules them each time
     the phone opens, updates or syncs; a task added or changed on the desktop gets its
     reminder once the phone next syncs.
   - **When:** at the task's time, no lead time.
   - **Buttons:** Done (marks the task done; it reaches Google through the desktop at the
     next sync) and Snooze (10 minutes). Android opens the app briefly to run a button.
   - **Decided 2026-10-17 (user):** exact timing is a one-time "Allow exact timing" button in
     Settings; reminders missed since the app last ran (up to 48 h; phone off, task synced
     late, or swiped away without Done) are shown once when it next runs; signing out of
     Google on the phone also withdraws Android's grant.
   - **Timing (built):** exact to the minute only with Android's "Alarms & reminders"
     access, which Settings offers ("Allow exact timing"); without it Android may deliver
     a few minutes late.
6. ✅ **Calendar**, with Google Calendar sync. Built 2026-10-16 as the Schedule page (see
   agent-notes/2026-10-16-schedule.md); live-verified 2026-10-16 against the real account
   (events and tasks on Monitor).
7. ✅ **Health data pipeline.** Port FitThing's pulls for calories, macros, weight,
   body fat and steps. Refinements are planned in a later session.
   (Built 2026-10-15 ahead of order while blocked elsewhere; live-verified 2026-10-15.
   Google sign-in is desktop-only so far.) Checked off by the user 2026-10-17.
   **Phone Google sign-in as a backup (user, 2026-10-17; built 2026-10-17, waiting for the
   user's Android OAuth client; agent-notes/2026-10-17-phone-google-sign-in.md):** the phone signs
   in to Google with Android's own sign-in (Google Play services keeps the grant, so no
   refresh token is stored and there's no 7-day expiry). It uses Google only when it hasn't
   synced with the desktop for 12 hours or more (away from home); otherwise the desktop
   stays the only device talking to Google, so the two don't push the same Calendar and
   Tasks changes. Needs the user to create an Android OAuth client in Google Cloud (package
   name and signing certificate fingerprint); exact steps in the agent note. While away, the
   phone sends only Schedule changes it made itself and hasn't yet handed to the desktop.
   **Queued for the refinements session (user, 2026-10-15; not started):** flag days whose
   data looks wrong, e.g. outrageous step counts or strangely low calories (likely a
   partly logged day). The user must be able to accept or reject a flagged day as valid,
   and that choice should stick (and sync). Thresholds and what a rejected day means for
   later uses (e.g. averages) are to be decided then. (Decided 2026-10-16, see 7a.)
7a. **Health analysis: expenditure and adaptive targets** (agreed with the user 2026-10-16;
   build started the same day; details and reasoning in
   agent-notes/2026-10-16-health-targets.md). Cronometer stays the place food is recorded;
   Lifeboard does the analysis. Display only: nothing is written back to Cronometer.
   - **Body composition:** 7-day moving averages of weight and body fat %. An average needs at
     least 3 weigh-ins in its 7 days, otherwise the last valid value carries forward. Lean
     body mass (LBM) = weight × (1 − body fat %).
   - **BMR:** Katch-McArdle from LBM: 370 + 21.6 × LBM (kg).
   - **Expenditure:** over a fit window (setting, default 28 days; 14 at first, raised 2026-10-16 after short windows proved noisy on real data) ending the day before
     (1-day lag: a day's numbers use only earlier days): average intake minus the energy the
     weight trend implies. Default 3,500 kcal per lb of trend; a settings toggle switches to
     an advanced fat/lean split (fat mass vs lean mass change from body fat %). Steps are the
     activity proxy: they spread the window's expenditure over its days. A given day's steps
     are informational and don't change that day's target.
   - **Heart rate:** pulled from Google Health (samples and daily resting heart rate).
     **Decided 2026-10-17 (user; investigation in agent-notes/2026-10-17-heart-rate-vs-steps.md;
     built the same day, see agent-notes/2026-10-17-health-page.md):**
     steps stay the main activity measure. Heart rate only adds workouts steps miss (the
     user lifts about 4 mornings a week, ~1,100 steps an hour at ~40 bpm above rest):
     - **Detection:** a run of 10-minute heart-rate samples at or above resting + 30 bpm,
       lasting at least 30 minutes (one lower sample allowed inside), under 3,000 steps an
       hour and no treadmill steps (walks are already counted by steps). On past data this
       finds about 3.6 sessions a week, two-thirds between 5 and 10 AM (with the phone's
       steps; as built, the pace check uses the primary step source like the daily total,
       which finds about 4.5 a week: accepted by the user 2026-10-17). Thresholds are
       settings. Missed sessions are accepted (user: a slow workout that doesn't raise the
       heart rate shouldn't count; it works as an incentive).
     - **Energy:** a fixed cost from the Compendium of Physical Activities, not fitted:
       (METs − 1) × weight (kg) × hours, default 3.5 METs (setting), minus the steps'
       energy in the same span so nothing counts twice. Targets are unchanged on average
       (the fitted part shrinks by the same amount); the per-day burn moves to workout days.
     - **Shown:** each detected workout on the Health page ("Workout 6:50–7:50 AM, +240 kcal").
     - **Days without steps:** filled with the typical day (median of the previous 14 days),
       marked as estimated.
     - FitApp stays fully offline (user): its workout log is not connected to Lifeboard.
     - **Later (user, 2026-10-17; not in the build batch):** a one-off check of the detection
       against a FitApp backup file exported by the user (compared locally, no connection).
     - Resting heart rate: a graph on the Health page, informational only (it doesn't
       follow activity).
     - **Raw data stays local (user, 2026-10-17; built the same day):** raw steps and
       heart-rate samples are never synced. The device that pulls them keeps 90 days and
       syncs one summary per day (steps, average heart rate, detected workouts). Changed
       workout settings re-check only days that still have raw data (accepted).
   - **History (user, 2026-10-16):** Google and Cronometer fetch 90 days of history once per
     device, then only recent days. Body water isn't available: the Google Health API has no
     such type.
   - **Targets:** calories = expenditure + goal (lb/week, setting) × 3,500 / 7. Protein and
     fat = settings in g per lb of LBM (defaults 1.0 and 0.4); carbs fill the remaining
     calories. Flags: carbs would go negative; goal rate beyond informational limits
     (defaults: loss over 1% of body weight per week, gain over 0.5%).
   - **Fallback:** too few valid days in the window → BMR × a fixed activity factor, flagged.
   - **Suspicious data:** thresholds are settings (defaults: calories under 50% of estimated
     expenditure or under 1,000 kcal; steps over 40,000; a weigh-in over 3 lb from the
     7-day average; body fat over 2 points from its 7-day average). A day with no Cronometer
     entry is flagged as a reminder. Flagged items appear in the Hub's alerts. Unresolved or
     rejected items are left out of the calculations, and the targets say how many await
     review. Accepting an item brings it back in; dismissing its alert does not.
   - **History:** each day's targets are saved when computed (synced) and listed from a button.
   - **Where:** a Health card on Monitor and basic cards on the Health page. Settings → Health
     holds the settings.
   - **Yesterday vs targets (user, 2026-10-16):** Monitor's Health card shows yesterday's
     totals under the targets saved for that day. Met ones are green: protein and fat at or
     above target; calories at or below for a loss goal, at or above for a gain goal, within
     ± a tolerance for maintenance (setting, default 5%). Carbs aren't judged.
   - **Health page work (user, 2026-10-16; built 2026-10-17 with the heart-rate decisions
     above, see agent-notes/2026-10-17-health-page.md; weight and body fat are two graphs,
     since a chart has one axis):**
     - **Data table, tabbed:** totals (eaten, highlighted by targets hit, with the same rules
       as Monitor) and deltas (eaten − target). About the past week, with an option to look
       further back through the history. Above it, a summary of days on target (e.g.
       "Protein met 5 of 7 days"); built to try, may be hidden.
     - **Past targets:** days before targets were saved (2026-10-16) get targets worked out
       the way that day would have had them, marked as worked out after the fact.
     - **Review card:** at the top while anything awaits review, at the bottom once all of it
       is addressed.
     - **Weight graph:** weight and body fat % with their 7-day moving averages; raw readings
       as dots, with rejected and pending ones marked differently. Below it, the body and
       expenditure figures grouped into body composition and metabolism.
     - **Time series graphs:** intake and estimated expenditure on one kcal axis, with both
       the 3,500 kcal/lb and fat/lean split estimates as lines (this is the comparison of the
       two); macros, raw and as deltas from target; resting heart rate.
     - **Graph controls:** one time range for all graphs (2 weeks, 4 weeks, 90 days) and a
       cursor that moves across them together.
     - **Library:** uPlot (small, fast time series), for now. Already in use on the Pets
       page (`src/app/ui/chart.ts`, 2026-10-17); reuse it.
     - **Fuller explanations (agreed 2026-10-17):** a fold-out "How this is worked out" under
       the targets and expenditure cards, walking through the calculation with the actual
       numbers (e.g. "Expenditure 2,640 kcal = average intake 2,310 + 330 implied by losing
       0.66 lb/week over 28 days").
     - **Details settled 2026-10-17:** one small graph per macro with its target line (not
       three macros on one axis); deltas as bars above and below zero; graphs open on the
       2-week range.
     - Not planned: a separate fat mass / lean mass graph (body fat % with weight covers it).
8. ✅ **Android home-screen widgets** (user, 2026-10-17; reviewed and agreed the same day;
   built and verified on the emulator the same day, see agent-notes/2026-10-17-widgets.md;
   awaiting user review on the phone). One widget per function, each placed and sized on its own:
   - **Health:** today's targets.
   - **Calendar:** two sections. *Today*: overdue and today's tasks, and today's events.
     *Upcoming*: events of the next 7 days, no tasks (tasks repeat a lot and work as
     reminders at their time; see phase 5).
   - **Alerts:** current, undismissed alerts.
   - **Pets:** when each device needs attention, as a date and time (not a countdown,
     which would go stale between updates): feeder food, fountain refill, Litter-Robot
     drawer full and litter low (see below).
   - **Lists:** a chosen to-do list; items can be ticked on the widget.

   **How it's built:** the app stays a Capacitor app. The widgets are native Android
   (Kotlin layouts and drawing) inside `android/`, and only display a snapshot the
   TypeScript app prepares: whenever the app runs (open, update, sync), it saves what each
   widget shows and asks Android to redraw them, through a small Capacitor plugin. No
   health, pet or list logic is written in Kotlin. Each widget shows how old its data is;
   tapping a widget opens the matching page.
   **Ticking a list item on the widget:** the widget crosses it out at once and queues the
   tick on the phone; the app applies queued ticks through the normal TypeScript code the
   next time it runs, and they sync from there. Kotlin never writes to the database.
   **Litter-Robot estimates (new):** the drawer level is recorded at each update; from its
   rise since the drawer was last emptied, Lifeboard estimates when it reaches the alarm
   level (Settings → Litter-Robot). Likewise when the litter falls to its alarm level.
   Shown on the Pets page as well. (Built 2026-10-17 ahead of the widgets; see
   agent-notes/2026-10-17-litter-estimates.md.)
   Widgets are display only apart from list ticks, like the rest of Lifeboard's device
   handling (see "No device control").
9. **Finances** (stretch). Not in the 2026-10-17 build batch (user: pin down the base
   functionality first, if at all).

## Known risks

- **Pet APIs are unofficial.** They can break or change sign-in without notice.
- **Google OAuth on Android** needs its own OAuth client. While the OAuth app is in
  "Testing" status, Google expires sign-ins after 7 days. Publishing it (status "In
  production") fixes that. See the settled decisions below. Two devices pushing to
  Google could repeat a change; the 12-hour backup rule (phase 7) keeps that to times
  the desktop is out of reach.
- **Cronometer sign-in** is scraped (GWT-RPC) and fragile, and now has to work from
  the phone as well.
- **Phone alerts** arrive only when the phone app updates, because the phone does no
  background polling.
- **Android widgets** need native Android code (Capacitor has no widget support), and the
  app has to hand its data to them. Without background polling they show the data from the
  last update, so each widget should show how old its data is.
- **Two-way Google sync** (Calendar, Tasks) on top of LAN sync means three-way
  conflicts. Google stays the source of truth for those records.

## Settled decisions (2026-10-15)

- **Phone updates:** on command, or when the app is first opened each day (changed from
  12 hours, user, 2026-10-17).
- **Health v1:** calories, macros, weight, body fat, steps (heart rate added 2026-10-16).
  Analysis (expenditure and adaptive targets) agreed 2026-10-16, see phase 7a.
- **Devices:** Whisker Litter-Robot, Petory feeders (via Smart Life), and a water fountain
  with no connection (user, 2026-10-16), tracked only through Refill presses.
- **Notifications:** the main problem is silent sign-outs. Rules are customizable,
  IFTTT-style.
- **Calendar and tasks:** editable, with two-way Google sync.
- **Sign-in:** each device signs in separately; credentials never sync.
- **To-do lists:** generic, multiple lists, synced only between Lifeboard devices.
- **Desktop polling:** at startup, then every hour (changed from 4 hours, user,
  2026-10-17). No continuous monitoring. Health data once a day (see "Updating and
  notifications").
- **Pets:** read-only, for awareness. Rule actions are notifications only.
- **No device control (user, 2026-10-16, reaffirmed):** Lifeboard must not control the
  Litter-Robot, the feeders or any other device in any way (no feeding, cycling, settings
  changes) unless the user changes this rule. Buttons like "Refilled" only record what the
  user did; they send nothing to the device. Agents must not add device commands, even
  when a request sounds like one ("feed all" meant "mark all refilled").
- **Feature plans:** reviewed with the user when each feature is ready to build.
- **Navigation (user, 2026-10-16):** FitApp's bottom bar: pop-up menus plus a gear icon.
  Hub → Monitor (the start screen; in order: alerts, dismissable, red-bordered when any;
  a Health card with today's targets (moved below alerts 2026-10-16); today's tasks and
  events; a card per device with level bars) and Lists;
  Details → Pets, Health, Schedule (Google Calendar events and Google Tasks by day) and
  Maintenance (see below). ⚙ is Settings,
  including Connections with each connection's status.
- **Schedule (user, 2026-10-16):** per day tasks, then all-day, then timed events; overdue
  tasks on today, highlighted; done tasks crossed out; tasks may have a Lifeboard-only time;
  main calendar only, others added in Settings → Calendars; all task lists; repeating-event
  edits for this / this and following / all. Reminders: see phase 5.
- **Lists (user, 2026-10-16):** two kinds. To-do lists: ticked items are crossed out and
  cleared when the app next loads. Prototype lists: standard items whose checkboxes select
  items to copy into other lists. Items can be copied singly, by selection or all at once.
- **Maintenance (user, 2026-10-16):** Details → Maintenance holds recurring chores entered
  like a calendar entry, repeating by default (monthly). On each day one comes due, Lifeboard
  adds a Google task for it that day (fixed id per item and date; after missed days only the
  latest gets a task). Items are synced; the tasks go to the first Google task list.
- **Google OAuth:** publish the app ("In production"). If a hidden cost turns up,
  fall back to signing in again regularly.

## Open questions

See agent-notes/2026-10-15-planning-decisions.md for the follow-up questions asked.
