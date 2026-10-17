# Phone Google sign-in (backup)

2026-10-17, agent (Claude), Lane B of the build batch. Plan: docs/PLAN.md phase 7, "Phone
Google sign-in as a backup". Built and tested with fakes; on the emulator the sign-in reaches
Google's own account screen. **Not yet signed in for real**: that needs the Android OAuth
client below, which only the user can create.

## How it works
- `core/google/token.ts`: the Google credential is either the desktop's
  (`clientId`, `clientSecret`, `refreshToken`, as before) or the phone's (`{ android: true }`,
  nothing secret: Google Play services keeps the grant). `googleAccessToken` gets a token
  from either; the phone's comes from a `NativeGoogleAuthorizer` the app installs at start
  (`setNativeGoogleAuthorizer`, same pattern as the cookie session in `core/http.ts`).
  Updates ask without UI; if Android needs consent again → `SignedOutError` → "signed out"
  alert. Health and Schedule tokens are requested separately (the Health API refuses mixed
  scopes), so the phone sign-in asks for two grants.
- **12-hour rule** (`googleActiveHere`): the desktop always uses Google; the phone only when
  `MAX(sync_peer.last_synced_at)` is 12+ hours old or it never synced. Otherwise the Google
  integration's update returns at once and `syncSchedule` does nothing.
- **No change sent twice** (`push.ts`): the phone sends only `schedule_change` rows it made
  itself (`updated_by` = this device) with `seq` above `MAX(sync_peer.sent_seq)`, i.e. not yet
  handed to a desktop. Handed-over or desktop-made changes are the desktop's. The re-read
  after sending uses the same filter.
- **Phone concurrency:** core used to start an unawaited Schedule push after every edit
  (`thenSend`, `setCalendarIncluded`). On the phone that would run outside the one-at-a-time
  queue (`src/app/backend.ts`), so `sendInBackground` now does nothing for a phone
  credential, and the phone app runs `refreshSchedule` through its queue after Schedule
  edits (`SCHEDULE_EDITS` in `src/app/main.ts`).
- Native: `android/app/src/main/java/org/lifeboard/app/GoogleAuthorizationPlugin.java`
  (`authorize({ scopes, interactive })` → `{ accessToken }`), registered in `MainActivity`,
  with `com.google.android.gms:play-services-auth:21.6.0` (May 2026; 22.0.0 is a newer
  major, not taken). JS side: `src/app/googleAuth.ts`.
- **Why a custom plugin (AGENTS.md reuse order):** @capgo/capacitor-social-login (8.5.x,
  maintained) is built around one login with one scope set and a Web client ID through
  Credential Manager; Lifeboard needs a silent token per scope set at every update.
  @codetrix-studio/capacitor-google-auth is unmaintained (Capacitor 6);
  @capawesome/capacitor-google-sign-in is 0.1.x. Play services' `AuthorizationClient`
  gives exactly silent per-scope tokens and needs only an Android client: ~100 lines.
- UI: Settings → Connections → Google on the phone: "Sign in with Google", with the 12-hour
  rule explained. Sign out removes Lifeboard's record; Android keeps the grant (revoke it in
  the Google account if wanted).
- No migration.

## The user's Google Cloud steps (one time)
1. Google Cloud Console, **the same project** as the desktop's OAuth client.
2. APIs & Services → Credentials → Create credentials → **OAuth client ID** → Application
   type **Android**.
3. Package name: `org.lifeboard.app`.
4. SHA-1 certificate fingerprint of the key the installed APK is signed with. APKs built on
   this computer with `./gradlew assembleDebug` use the debug key:
   `4A:E9:03:CE:DC:6B:D8:35:25:3E:D4:65:F3:BF:09:35:42:6B:B1:D0`
   (`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey
   -storepass android -keypass android`, or
   `~/Android/Sdk/build-tools/36.1.0/apksigner verify --print-certs <apk>`). An APK built on
   another computer, or a release build with its own key, needs that key's SHA-1 added as
   another Android client.
5. Create. Nothing goes into the app: no client ID or file. Android matches the package and
   key.
6. Scopes: no change. The consent screen's data access already lists the desktop's scopes
   (googlehealth.activity_and_fitness.readonly,
   googlehealth.health_metrics_and_measurements.readonly, calendar.calendarlist.readonly,
   calendar.events, tasks). The consent screen should be "In production" (already the plan);
   while in "Testing", the Google account must be a listed test user.
7. On the phone: Settings → Connections → Google → Sign in with Google → choose the account →
   agree twice (Health, then Calendar and Tasks).
- If it says "Google doesn't recognize this app yet", the package name or SHA-1 doesn't match
  the installed APK.

## Verified
- `test/googlePhone.test.ts`: 12-hour rule; no Google use at update while the desktop is in
  reach; non-interactive phone tokens; consent needed → signed out; the push filter sends
  only unsent own changes.
- Emulator: "Sign in with Google" → Play services opened Google's account screen
  (`MinuteMaidActivity`; the emulator has no Google account); Back → "Google sign-in was
  cancelled.", nothing saved. Real sign-in not attempted.
