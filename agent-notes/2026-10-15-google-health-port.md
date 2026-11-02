# Google Health port (health pipeline, part 2): steps, weight, body fat

2026-10-15, agent (Claude). Built while the user was away. **Never run against the real
Google API** (needs the user's interactive sign-in); tested against a fake API.

## What exists
- `core/google/oauth.ts`: installed-app OAuth with PKCE via plain fetch (sign-in URL, code
  exchange, refresh). `google-auth-library` was not used: it's Node-only and core code must
  also run on the phone. Scopes: `googlehealth.activity_and_fitness.readonly` +
  `googlehealth.health_metrics_and_measurements.readonly` (subset of FitThing's).
  `invalid_grant` on refresh → `SignedOutError` → "signed out" alert.
- Once a day (user, 2026-10-17): the health pull runs only if `healthPulledOn` (in the
  credential) isn't today or the history is missing (`needsHealthPull`). The Schedule sync
  still runs every update, so a revoked refresh token is still noticed hourly.
- `core/google/healthApi.ts`: paginated `dataPoints` list with FitThing's AIP-160 filters
  for `steps`, `weight`, `body-fat`. Bounds are local midnight since 2026-11-02 (see below).
- `core/google/integration.ts`: first pull 30 days (90 since 2026-10-16, see
  2026-10-16-health-targets.md), then from 3 days before the newest
  stored day of each type, up to today (exclusive), as FitThing did.
- `health_point` table (synced): one row per Google point, weight in grams, body fat %,
  step counts with interval and source package. Ids: `google-<point name>`; step points
  have no `name`, so `google-steps-<package>-<start>-<end>`. Each fetch tombstones stored
  points in its time range that Google no longer returns (FitThing's "window owner" idea,
  done per row).
- `core/steps.ts`: FitThing's ring-primary / treadmill-replaces algorithm, ported with its
  tests' scenarios. Sources are constants (`STEP_SOURCES`: ring `com.gdjztech.ringconn`,
  treadmill `com.urevo.app`, from FitThing's note); no settings UI yet.
- `dailyHealth()` combines Cronometer + Google per day (weight shown in lb as in FitThing).
  Health tab shows two tables (nutrition; body and steps) for the last 14 days.

## Sources stalling (2026-11-02)
- **What happened:** the ring stopped reaching Google on 2026-10-29 (an update on the ring's
  side reset its connection settings, per the user), and phone, scale and treadmill data lagged
  about a day around 2026-11-01. Lifeboard's pull was fine and showed "connected" throughout.
  Google returned the same cut-offs when queried directly.
- **Fetch window per source** (`healthCatchUpDay`): starts 3 days before the newest day of the
  source furthest behind. It used the newest day of any source, so phone steps would have moved
  the window past a stalled ring and its backlog would never have been read. Sources silent
  over 30 days count as retired, or the weight type's old sources would force 90-day fetches
  forever. A ring outage longer than 30 days loses the part older than that (the alert below
  should come long before).
- **Canaries** (`HEALTH_CANARIES`): phone steps and ring heart rate, a `health_data` reading per
  update and the editable default rule `default-health-data-stale`. Two, because steps from any
  source stayed fresh during the ring outage. Largest gaps over 90 days: phone steps 11.9 h,
  ring heart rate 6.2 h, ring steps 9.5 h, treadmill 112.8 h (unusable). These are gaps in when
  data was recorded, not how late it reached Google; that lag isn't measured.
- **Threshold:** 18 hours (user), Settings → Health → "Data stopped updating". Stored in
  `HealthSettings`, so it syncs.
- **Asks Google directly each update:** stored data is pulled once a day and stops at UTC
  midnight of the local date, so it can look 18-42 hours old when nothing is wrong. Failed
  checks are logged and stay quiet, so the extra hourly calls can't raise connection alerts.

## Day bounds and today's weigh-in (2026-11-02)
- FitThing's UTC-midnight bounds cut each day at 6 PM in Chicago, so a day's evening data missed
  that night's pull and arrived a day late; targets ran on a partial yesterday. Now local midnight
  (`localDayStartUtc`). `daily-resting-heart-rate` keeps plain dates, stored at UTC midnight
  (`storedDayStart`). Data recorded before midnight but uploaded after it still waits a day.
- Today's weight and body fat are fetched every update (user: a morning weigh-in is final when
  taken) into `health_point`, so they sync. `healthPage.todayWeighIn` shows them; the analysis
  reads days before today only, so targets and flags don't move (tested). Not in the graphs or
  the Data table, which also stop at yesterday.

## Not changed: days without the ring
`steps.ts` ignores phone steps, so a day without the ring counts only the treadmill (2026-10-31
shows 11,114, treadmill only). Effect on the targets not checked. Corrected for the outage
only if the ring's backlog reaches Google.

## Sign-in
- **Desktop only for now.** Settings → Connections → "Sign in with Google" →
  `/oauth/google/start` → Google → `/oauth/google/callback` (loopback only) → refresh token
  saved in the desktop's `credential` table, then an update runs.
- **Needs `data/google_client_secret.json`** (a "Desktop app" OAuth client JSON). The user
  can copy FitThing's `secrets/client_secret.json` — not copied by the agent (user's secret,
  different project). The route explains this if the file is missing.
- **Publish the OAuth consent screen ("In production")** or refresh tokens die after 7 days
  (user agreed 2026-10-15; must be done in Google Cloud console by the user).
- **Phone Google sign-in is not built.** It needs an Android OAuth client (package
  `org.lifeboard.app` + signing-cert SHA-1) or a custom-scheme redirect, plus deep-link
  handling. Until then the phone gets Google data via LAN sync (verified with demo data on
  the emulator). This is a gap vs the plan ("phone pulls external data itself").

## Not done
- Retry/backoff and request pacing from FitThing (rate-limit finding) — not needed for
  three types over a few days; add if 429s appear.
- Interpolation, targets, deltas, charts: "refinements later" per the user.
