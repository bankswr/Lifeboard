# Connections, alert rules and updates (plan phase 3)

2026-10-15, agent (Claude). Built while the user was away. **Not yet reviewed by the user.**

## Model
- **Readings** (`core/readings.ts`): every update produces one reading per thing it checks:
  `{type, subject, data}`. `READING_TYPES` describes each type's fields for the rule editor.
  Today only `connection` exists (fields `status` ∈ connected/signed_out/error, `message`);
  each integration adds its own type (e.g. a Litter-Robot status reading).
- **Rules** (`core/rules.ts`, synced table `rule`): when <reading type>, if all conditions
  (field, operator is/is not/more than/less than, value), then notify <message with
  `{subject}`/`{field}` placeholders>. Notify is the only action (user: awareness only,
  read-only devices).
- **Edge-triggered:** a rule alerts when its conditions *become* true for a subject
  (`rule_state`, per device) and not again while they stay true; after they turn false it
  can alert again. One mechanism covers "signed out" and future "drawer full" without
  repeat spam, and needs no separate "event" concept.
- **Self-clearing (user, 2026-11-10):** whenever a rule doesn't match a subject's reading,
  its undismissed alerts for that subject are marked dismissed (`clearAlerts`), on every
  evaluation rather than only on the true→false edge, so alerts left from before the change
  clear too. Their phone notifications are withdrawn: `setAlertDelivery(deliver, withdraw)`;
  the phone tags alert notifications `extra {kind: "alert", alertId}` and removes delivered
  ones by that. Desktop pop-ups can't be withdrawn (notify-send) and just expire. Built-in
  alerts not tied to a condition (Schedule conflicts, cat visit counts, health flags) are
  events and stay until dismissed; the Litter-Robot stall alert clears itself too (see
  `2026-10-18-litter-cycle-stalls.md`). A subject with no reading (e.g. a failed Google
  check) keeps its alert.
- **Built-in level alarms clear too (user, 2026-11-19):** the Litter-Robot drawer/litter
  alarm (`rule_id` `litter-alarm`, cleared when the robot is out of alarm) and the water
  fountain alarm (`fountain-alarm`, cleared when Refill is pressed, or at the next update
  once out of alarm, which covers a refill pressed on the other device). Before this they
  were recorded as `builtin` and stayed until dismissed: the user saw a "drawer 77% full"
  alert a day after emptying the drawer. Alerts already stored as `builtin` aren't migrated;
  dismiss them by hand. The same day the LitterHopper alarm (`hopper-alarm`, cleared by
  "Hopper refilled" or once out of alarm) and the feeders' one shared "running low" alert
  (`feeder-alarm`, cleared once no feeder is low, by "Refilled" or at the next update) joined.
- **Default rule** `default-connection-problem` (status is not connected) is inserted by
  migration 4 with a fixed id and timestamp, so both devices' copies are the same row and
  sync never duplicates it. The user can edit or disable it like any rule.
- **Deviation from plan wording:** the plan said an alert shouldn't repeat across devices
  after a sync. Implemented per device instead: desktop pop-up and phone notification are
  separate channels, and the phone only learns things when opened. Revisit if the user
  finds double alerts annoying.

## Updates (`core/updates.ts`)
- `runUpdate` calls each set-up integration in `INTEGRATIONS` (empty until pets/health are
  built) in isolation, records `connection` rows (per device: status, message, last
  checked, last success), turns each into a `connection` reading, evaluates rules, stores
  `alert` rows. `SignedOutError` → signed_out; any other error → error.
- Desktop server: update at start, then every hour (`setInterval`; was 4 h until
  2026-10-17), notifications via `notify-send` (`src/desktop/notify.ts`).
- Phone: on open, sync quietly, then update if `isUpdateDue` (never, or not yet today in
  local time; was > 12 h until 2026-10-17); "Update now" button on Home.
- Health pulls (2026-10-17, user): Cronometer and Google Health run at most once per local
  day per device, even on Update now; Google's Calendar/Tasks sync still runs every update.
  Settings → Health → "Re-pull health data" (`api.repullHealth`) clears both day markers
  and runs a full update. Notifications via `@capacitor/local-notifications` (8.3.1, same as
  FitApp); permission is requested on first alert (Android 13+).
- `core/notify.ts` holds the platform's delivery function (`setAlertDelivery`); delivery
  failures are logged and never break an update.

## UI
- Home: last updated, Update now, connection statuses, recent alerts.
- Settings → Alert rules (`#/rules`): list with on/off switch; editor `#/rules/new|<id>`
  with condition rows (value is a dropdown when the field has fixed options). The editor
  keeps a draft in module state between re-renders.

## Verified
- 10 tests in `test/rules.test.ts` (alert once / no repeat / re-alert after recovery,
  error vs signed-out, last-success kept, not-set-up skipped, all-conditions, disabled,
  validation, number comparison, placeholders, rule sync without default duplicates,
  12-hour rule).
- Desktop (Playwright): home renders; rule created via editor, validation message shown,
  reopened with values intact.
- Emulator: app opens, update-on-open ran ("Last updated" set), no console errors.
- **Not verified:** an actual notification on the phone or desktop (no integration
  produces alerts yet, and a test pop-up on the user's desktop while they were away was
  avoided). Check both when the first integration lands.
