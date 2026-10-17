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
  (UTC-midnight bounds) for `steps`, `weight`, `body-fat`.
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
