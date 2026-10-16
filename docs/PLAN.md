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
  app is opened and more than 12 hours have passed since the last update.
- **Desktop:** the server polls when it starts, then every 4 hours while it keeps
  running, and notifies on the desktop. It doesn't need to monitor continuously.
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
1. **Pet API spike.** Prove we can sign in to and read the Litter-Robot and the
   Petory feeders from Node and from the phone. This is the riskiest dependency:
   the APIs are unofficial and may change, and the Petory API is still unknown.
2. ✅ **Data model and LAN sync.** Build both, tested with a throwaway record type.
3. ✅ **Connections and rules engine** (built 2026-10-15, awaiting user review). Sign-in status for every integration, the
   events/conditions/actions model, and default "connection lost" alerts.
4. **Pets module.** Status dashboard, events, and default rules.
   (Litter-Robot 4 built 2026-10-15, awaiting model confirmation and first live run;
   Petory feeders built 2026-10-16 via Smart Life (the user moved them from the Petory app);
   live-verified 2026-10-16.)
5. **Tasks & reminders**, with Google Tasks sync, plus the generic to-do lists
   (to-do lists ✅ built 2026-10-15, awaiting user review). Tasks built 2026-10-16 together
   with phase 6 as the Schedule page; reminders deferred (user).
6. **Calendar**, with Google Calendar sync. Built 2026-10-16 as the Schedule page (see
   agent-notes/2026-10-16-schedule.md); awaiting the first run against the real account.
7. **Health data pipeline.** Port FitThing's pulls for calories, macros, weight,
   body fat and steps. Refinements are planned in a later session.
   (Built 2026-10-15 ahead of order while blocked elsewhere; live-verified 2026-10-15.
   Google sign-in is desktop-only so far.)
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
   - **Heart rate:** pulled from Google Health (samples and daily resting heart rate), to be
     examined as an alternative activity proxy before deciding how to use it.
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
   - **Later, with the Health page work (not started):** charts and fuller explanations on the
     Health page, and a side-by-side comparison of the 3,500 kcal/lb and fat/lean split
     estimates.
8. **Finances** (stretch).

## Known risks

- **Pet APIs are unofficial.** They can break or change sign-in without notice.
- **Google OAuth on Android** needs its own OAuth client. While the OAuth app is in
  "Testing" status, Google expires sign-ins after 7 days. Publishing it (status "In
  production") fixes that. See the settled decisions below.
- **Cronometer sign-in** is scraped (GWT-RPC) and fragile, and now has to work from
  the phone as well.
- **Phone alerts** arrive only when the phone app updates, because the phone does no
  background polling.
- **Two-way Google sync** (Calendar, Tasks) on top of LAN sync means three-way
  conflicts. Google stays the source of truth for those records.

## Settled decisions (2026-10-15)

- **Phone updates:** on command, or when the app opens if more than 12 hours have
  passed since the last update.
- **Health v1:** calories, macros, weight, body fat, steps (heart rate added 2026-10-16).
  Analysis (expenditure and adaptive targets) agreed 2026-10-16, see phase 7a.
- **Devices:** Whisker Litter-Robot, Petory feeders (via Smart Life), and a water fountain
  with no connection (user, 2026-10-16), tracked only through Refill presses.
- **Notifications:** the main problem is silent sign-outs. Rules are customizable,
  IFTTT-style.
- **Calendar and tasks:** editable, with two-way Google sync.
- **Sign-in:** each device signs in separately; credentials never sync.
- **To-do lists:** generic, multiple lists, synced only between Lifeboard devices.
- **Desktop polling:** at startup, then every 4 hours. No continuous monitoring.
- **Pets:** read-only, for awareness. Rule actions are notifications only.
- **No device control (user, 2026-10-16, reaffirmed):** Lifeboard must not control the
  Litter-Robot, the feeders or any other device in any way (no feeding, cycling, settings
  changes) unless the user changes this rule. Buttons like "Refilled" only record what the
  user did; they send nothing to the device. Agents must not add device commands, even
  when a request sounds like one ("feed all" meant "mark all refilled").
- **Feature plans:** reviewed with the user when each feature is ready to build.
- **Navigation (user, 2026-10-16):** FitApp's bottom bar: pop-up menus plus a gear icon.
  Hub → Monitor (the start screen; in order: alerts, dismissable, red-bordered when any;
  today's tasks and events; a card per device with level bars; a Health card, contents to be
  decided) and Lists;
  Details → Pets, Health, Schedule (Google Calendar events and Google Tasks by day) and
  Maintenance (see below). ⚙ is Settings,
  including Connections with each connection's status.
- **Schedule (user, 2026-10-16):** per day tasks, then all-day, then timed events; overdue
  tasks on today, highlighted; done tasks crossed out; tasks may have a Lifeboard-only time;
  main calendar only, others added in Settings → Calendars; all task lists; repeating-event
  edits for this / this and following / all. Reminders later.
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
