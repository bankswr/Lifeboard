# Cronometer port (health pipeline, part 1)

2026-10-15, agent (Claude). Built while the user was away. **Never run against the real
Cronometer** (that needs the user's sign-in); everything is tested against a fake site.

## What exists
- `src/core/cronometer/client.ts`: TS port of FitThing's `cronometer/auth.py` + `client.py`
  (login form → `sesnonce` cookie → GWT-RPC `authenticate` + `generateAuthorizationToken` →
  `/export?generate=dailySummary`). Same request templates and GWT hashes as FitThing
  (live-verified there 2026-09-18). If Cronometer redeploys, re-capture per FitThing
  `agent-notes/2026-09-17-cronometer-endpoints.md`.
- `parse.ts`: calories (kJ converted) + protein/carbs/fat only, via papaparse. Same
  column-candidate lists as FitThing; a missing required column is an error.
- `integration.ts`: first pull 30 days (90 since 2026-10-16, see 2026-10-16-health-targets.md), then from 3 days before the newest stored day;
  always ends **yesterday** (FitThing excluded today too: the day isn't fully logged).
  **At most one pull per local calendar day per device**, because of Cronometer's ~10
  exports/day cap (desktop updates every 4 h would otherwise burn 6/day).
- Expired session (export returns the login page, or `authenticate` fails) → one silent
  re-sign-in with the saved email/password → retry. Password rejected → `SignedOutError`
  → connection "signed_out" → default rule alerts.
- `nutrition_day` table (synced) with id `nutrition-<date>`, so the same day fetched on
  both devices is one row. Unchanged days aren't re-saved (keeps sync traffic down).
- Sign-in UI: Settings → Connections. Health tab shows the last 14 days.
- Dropped from FitThing: retry/backoff on 429/5xx (the next scheduled update is the retry),
  all non-macro nutrients, CSV import, the gap-fill/targets logic (user: refinements later).

## Cronometer redeploy, fixed 2026-10-15 (first live run)
- Cronometer's GWT build changed since FitThing's capture: new permutation and policy hash
  (where to find them is commented in `client.ts`). Old permutation's `.cache.js` → 404 is
  the quick test for "they redeployed". Method signatures were unchanged.
- **`generateAuthorizationToken` no longer accepts the `sesnonce` cookie** as its session
  argument (`NotLoggedInException: Invalid or expired session`). The web app passes a field
  of the User object instead (minified `T_b()` → `$c.Q`); it arrives as a 32-hex string in
  `authenticate`'s GWT string table. Its index depends on account data (was [112] of 116, a
  different 32-hex string came earlier), so the client tries every 32-hex string, last
  first, then the cookie. Found with a throwaway diagnostic the user ran (credentials never
  passed through the agent).
- Verified live: sign-in, export, 29 days stored. FitThing has the same break (not fixed).

## Credentials (decision to confirm with the user)
- Email + password are saved in the per-device `credential` table (never synced), like
  FitThing's `secrets/cronometer.json`. That is what makes "never silently signed out"
  possible: the 14-day session renews itself. Desktop: `data/lifeboard.db` (gitignored).
  Phone: app-private SQLite. **`android:allowBackup="true"` (Capacitor default) means
  Android cloud backup may include that database** — consider turning it off or adding
  backup exclusion rules.

## Cookies differ per platform (verified on the emulator)
- Node: `fetch-cookie` + `tough-cookie` jar, serialized into the credential.
- Android: CapacitorHttp **hides Set-Cookie from JS** (`headers.get` → null,
  `getSetCookie()` → []) and **stores/sends cookies natively** (a test server saw them
  on the next request). `response.url` is also an interceptor URL
  (`https://localhost/_capacitor_http_interceptor_?u=...`). So the phone uses
  `src/app/nativeCookies.ts`: plain fetch + `CapacitorCookies.getCookies({url})` to read
  `sesnonce`. Installed via `setCookieSessionFactory` in `main.ts`.
- `CapacitorCookies.clearCookies({url})` did **not** clear in that test; not needed so far.
- The phone path is the least certain part: it has only been checked with a local test
  server, not with Cronometer's real (Secure, cross-path) cookies.

## Other
- Capacitor logs "Error injecting safe area CSS" a few times at startup (SystemBars runs
  its script before the document exists). Harmless framework noise.
