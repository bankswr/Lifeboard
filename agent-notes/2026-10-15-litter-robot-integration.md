# Litter-Robot integration (pets, part 1)

2026-10-15, agent (Claude). Built while the user was away. **Assumes a Litter-Robot 4**
(the user hasn't said which model) and **has never signed in to a real account**; tested
with a fake Whisker API. Feeders (Petory) are not started; see
[[2026-10-15-pet-api-research]].

## What exists
- `core/whisker/api.ts`: Cognito sign-in/refresh via `amazon-cognito-identity-js` (in-memory
  token storage, so the library never touches localStorage) + the LR4 GraphQL query
  (`getLitterRobot4ByUser`, user id = ID token's `mid` claim). Read-only.
- `core/whisker/status.ts`: pylitterbot's LR4 status rules ported (offline → off → cycle
  state → robotStatus, with "Drawer full"/"Cat detected" overriding Ready).
  `litterLevelPercentage` is a 0–1 fraction (×100); `DFILevelPercent` is already 0–100.
- `core/whisker/integration.ts`: refresh token first; if refresh fails, silent re-sign-in
  with the saved password; only a rejected password → `SignedOutError` → alert. API is
  injectable (`makeWhiskerIntegration(api)`) for tests.
- `device_status` table (per device, not synced) holds each robot's latest status for the
  Home "Pets" card; `litter_robot` readings feed the rules.
- **Default rules** (migration 7): drawer full, offline, litter below 20%. Rule names and
  thresholds are guesses at sensible defaults; the user can edit them.
  `insertDefaultRules` now only adds missing default ids (never overwrites user edits), so
  future migrations can add defaults by calling it again.
- Password sign-in is generic now: `Integration.signIn(db, email, password)` +
  `api.signInWithPassword` (Cronometer moved to it too).
- Vite needs `define: { global: "globalThis" }` for amazon-cognito-identity-js in the
  browser/WebView bundle (`global is not defined` otherwise).

## If the user's robot is not an LR4
- LR3: REST `API_V2_ENDPOINT` + x-api-key (pylitterbot `robot/litterrobot3.py`).
- LR5: `https://ub.prod.iothings.site` (pylitterbot `robot/litterrobot5.py`).
- Only `api.robots()` and `status.ts` change; readings, rules, UI stay.
- `node spikes/litterrobot.ts` prints the raw LR4 fields for a quick check.
