# Pet device APIs: research for the phase 1 spike

2026-10-15, agent (Claude). Research only; nothing has signed in to a real account yet.

## Litter-Robot (Whisker)
- **Model matters; the user hasn't said which.** pylitterbot (2025.7.0, MIT, used by Home
  Assistant) supports LR3 (REST `API_V2_ENDPOINT` + x-api-key), LR4 (GraphQL
  `https://lr4.iothings.site/graphql`) and LR5 (`https://ub.prod.iothings.site`). Whisker's
  Feeder-Robot is also covered, but the user's feeders are Petory, not Whisker.
- **Sign-in:** AWS Cognito user pool (SRP), pool/client IDs are public app constants
  (pylitterbot `session.py`). TS route: `amazon-cognito-identity-js` (AWS's own library;
  works in Node and browsers/WebView), exactly what `@ddgold/homebridge-litter-robot`
  (MIT, TS, Node ≥24, LR4 only) does. User id = ID token's `mid` claim.
- **Session lifetime:** ID token ~1 h; refreshed with the Cognito refresh token. Refresh
  token lifetime is set by Whisker's pool (unknown; Cognito default 30 days). When the
  refresh fails the app must raise a "connection lost" event — this is exactly the user's
  complaint about the vendor app. Open design question for the Connections phase: store
  the password (encrypted) to re-sign-in silently, or only the refresh token and alert.
- **Alert-relevant LR4 fields:** `isOnline`, `lastSeen`, `unitPowerStatus`, `robotStatus`,
  `robotCycleStatus`, `displayCode`, `DFILevelPercent`, `isDFIFull`, `isDFIPartialFull`,
  `litterLevelPercentage`, `litterLevelState`, `catDetect`, `catWeight`, `isLaserDirty`,
  `isBonnetRemoved`, `isHopperRemoved`. Full field list: pylitterbot `robot/models.py`.
  Status codes (DFS drawer full, OFFLINE, CSF cat sensor fault, PD pinch detect, ...):
  pylitterbot `enums.py` `LitterBoxStatus`. Activity history: `GetLR4Activity` query.
- **Spike script:** `spikes/litterrobot.ts` (read-only; prompts for email/password, saves
  nothing). Run `node spikes/litterrobot.ts`. Needs the user. Type-checked only.

## Petory feeders

**Update 2026-10-15 (later): Petory is a Tuya white-label app.** APK pulled from the user's
Pixel 7 Pro over wireless adb (Petory 1.0.4, versionCode 5; base.apk + arm64 split, kept
only in the session scratchpad, not in the repo). Its code is Tuya's OEM app SDK:
`com.thingclips.*` packages and `libThing*.so` / `libthingsmart.so` native libs ("Thing" is
Tuya's 2023 rename of "TuyaSmart"). So the feeders are ordinary Tuya cloud devices, and the
plan's option (a) applies; decompiling Petory's private API is not needed. Choice of Tuya
route (Smart Life re-pair vs developer cloud project vs others) is with the user; see
whichever note records it.

**LAN finding:** three Tuya devices broadcast on the home LAN (UDP 6667, decrypted with the
public broadcast key): same productKey `kf5grvjfxbmaijbo`, protocol **3.3**, so almost
certainly the three feeders. Local reads need each device's local key, which only Tuya's
cloud hands out (changes on re-pair).

**User decision (2026-10-15):** keep the Petory app (strongly prefers not to switch). Plan:
sign in with the Petory account the way the Petory app does (Tuya mobile API using the
app's built-in app key/secret + `assets/t_s.bmp` signing key), read device status and the
local keys, then poll locally from the desktop with cloud as fallback. User accepts the
fragility; if it doesn't work, they will move the feeders to Smart Life (QR sign-in, as
Home Assistant does). **Blocked:** extracting the app key from the APK was denied by the
agent's permission classifier ("credential exploration"); needs the user's explicit
permission rule or another route before continuing.

Earlier research (superseded by the above where it conflicts):
- Model **F01W** (Amazon ASIN B0B376CLN3). App: Google Play `com.petory.smart`, developer
  "patpet" = Shenzhen Patpet Technology Co., Ltd. Not Tuya-branded as far as found.
- **No public API, library, Home Assistant or Homebridge integration found** (web searches
  2026-10-15). Not PetLibro/PetKit/Tuya as far as the listings show.
- Next step: static analysis of the app to find its cloud API (endpoints, sign-in).
  APKPure blocks scripted downloads (403); APKMirror needs a browser. **Best source: the
  user's own phone**: `adb shell pm path com.petory.smart` then `adb pull <path>` (needs USB
  debugging). Then decompile with jadx (not installed; GitHub release jar, run with
  `~/android-studio/jbr`). Treat the APK as untrusted: analyze only, never install/run here.
- Fallback if the API is unusable (signed requests, certificate pinning, etc.): watch the
  app's traffic with mitmproxy, which needs a patched APK or rooted phone — more fragile.

Sources: pylitterbot on PyPI; @ddgold/homebridge-litter-robot on npm; Play Store
`com.petory.smart`; App Store id1622792508.
