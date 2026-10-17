# Feeders via Smart Life: sign-in and what they report

2026-10-16, agent (Claude). Spike passed against the user's real account; integration not
built yet. Follows [[2026-10-15-pet-api-research]].

## Route
- User moved the three Petory F01W feeders to the **Smart Life** app (Petory app dropped).
- No browser/OAuth-style sign-in exists for Smart Life accounts (user asked). Options were:
  Home Assistant's **QR sign-in** (chosen), a Tuya developer cloud project (free IoT Core
  service must be renewed by hand every ≤6 months: a silent-failure source), or the Smart
  Life app's private keys (same blocked route as Petory).
- QR sign-in = Tuya's `tuya-device-sharing-sdk` 0.2.15 (MIT, Tuya Inc.), ported in
  `spikes/smartlife.ts`. Needs the user's **User Code** (Smart Life → Me → Settings →
  Account and Security), then a scan with the app. Uses HA's public client id
  `HA_3y9q4ak7g4ephrvke` / schema `haauthorize`; Tuya could restrict it.
- Login result: `access_token`, `refresh_token`, `expire_time` (7200 s), `terminal_id`,
  `uid`, `username`, `endpoint` (per-region API host). Refresh: `GET /v1.0/m/token/{refresh}`
  (signed). Every request is AES-128-GCM encrypted + HMAC-signed with keys derived from
  a request UUID and the refresh token (see `customerapi.py`).
- **Phone port:** the signing uses MD5, which WebCrypto lacks; the phone would need a small
  MD5 implementation or package. Phone can't scan its own QR, so desktop-only sign-in first.

## What an F01W reports (category `cwwsq`, product `kf5grvjfxbmaijbo`)
| code | type | meaning |
|---|---|---|
| `feed_state` | enum standby/feeding/done | |
| `feed_report` | int 0–50 | portions dispensed by the last feed |
| `meal_plan` | raw (base64) | 5 bytes per meal: weekday bitmask, hour, minute, portions, enabled |
| `manual_feed`, `quick_feed`, `slow_feed`, `light`, `voice_times` | settings/commands | |

Plus `online` per device. **No food level, jam/fault, battery or desiccant data**, and no
per-value timestamps (`update_time` is the pairing time). User's schedule on all three:
1 portion at 01:00, 07:00, 13:00, 19:00 daily.

## No device control
The user's rule (2026-10-16, docs/PLAN.md settled decisions): Lifeboard never sends commands
to the feeders (or any device) unless the user changes that rule. The Smart Life API can
send commands (`/v1.1/m/thing/{id}/commands`); Lifeboard deliberately has no code for it.

## Food estimate (2026-10-16)
The F01W has no food level. `core/smartlife/food.ts`: user presses Refilled (always to
full); each refill after a feeder's first counts the scheduled portions since that feeder's
previous refill (cut off at the first 0-portion feed seen) as one hopper; all feeders' samples
are pooled and the median is the capacity. Days left = (capacity − scheduled portions since
last refill) / portions per day. Thresholds in days (default 3 / 1) and an optional
"Refill the feeders" task (fixed id per day) in Settings → Feeders. Refills and run-dry
sightings are synced `feeder_event` rows. The user's first refill (2026-10-16) is a starting
point only.

## Water fountain (2026-10-16)
A fourth "device" with no connection: `core/fountain.ts`, same learning scheme in time
instead of portions (days between refills, median = how long a fill lasts). Its alarm check
runs in `runUpdate` (no integration). Settings → Water fountain.

## Integration (built 2026-10-16, user approved the plan; live-verified the same day: 3 feeders read)
- `core/smartlife/api.ts`: QR sign-in + signed/encrypted GETs, crypto via `@noble/hashes`
  (MD5, HMAC-SHA256) and `@noble/ciphers` (AES-GCM) so it runs on the phone too. Only a
  failed token refresh counts as signed out; other refusals show as connection "error"
  (both alert through the default connection rule).
- `core/smartlife/feeder.ts`: status, meal-plan decoding (weekday bit order assumed Monday =
  lowest bit; unverified, the user's plan is every day), `nextMeal` (computed in the UI at
  render time, local clock).
- `core/smartlife/integration.ts`: `signInMethod: "qr"`; `startQrSignIn`/`finishQrSignIn`
  on `Integration`, exposed in `core/api.ts`. The pending QR lives in memory in the
  integration. Connections screen shows the QR (qrcode → SVG data URL) and polls every 2 s
  for 3 min. Access token lasts 2 h, so nearly every 4-hourly update refreshes it.
- Default rules (migration 8): "Feeder offline", "Feeder dispensed nothing"
  (`lastFeedPortions = 0`; whether the F01W really reports 0 on a failed feed is untested).
- **Phone:** sign-in is offered there too (untested; the QR must be scanned from another
  screen). `device_status` was not synced then (synced since migration 20, 2026-10-17), so the phone showed no feeders unless it signed in
  itself — contrary to what the user was told earlier ("phone gets it through sync").
