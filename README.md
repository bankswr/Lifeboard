# Lifeboard

A personal dashboard for organizing daily life: a web app served from this computer and an
Android app that works on its own away from home. When both are on the same network they
sync data. Scope and roadmap: [docs/PLAN.md](docs/PLAN.md).

One TypeScript codebase (layout and tooling modeled on FitApp):

| Path | What it is |
|---|---|
| `src/core/` | Shared logic for both devices: database schema, API functions (`api.ts`) |
| `src/app/` | The UI (Vite + lit-html). On the phone it calls `core` directly; on the desktop it calls the server |
| `src/desktop/` | Local Node server: desktop database, runs `core` for the UI, serves the built UI |
| `android/` | Capacitor Android project |
| `test/` | Vitest tests (run against Node's built-in SQLite) |

## Development

Requires Node.js 24+. The Android build also needs the Android SDK and a JDK (Android
Studio's bundled JBR works).

```bash
npm install
npm test
npm run desktop       # build the UI and start the desktop app at http://127.0.0.1:5180

# Live-reload UI development: run both, then open http://127.0.0.1:5173
npm run server        # desktop server, restarts on changes
npm run dev           # Vite dev server, forwards /api to the desktop server
```

**After building, restart the desktop server.** The running server (from `npm run desktop`
or `start-lifeboard.sh`) loads `core` once when it starts; `npm run build` only replaces the
UI in `dist/`, so the new UI ends up talking to the old server and new features don't
appear (or pages fail). `start-lifeboard.sh` does nothing if a server is already up, so stop
it first:

```bash
pkill -f "^node src/desktop/server.ts"; ./start-lifeboard.sh
```

The restart also runs any new database migrations on the desktop database.

The desktop database is `data/lifeboard.db` (gitignored). Set `LIFEBOARD_DATA_DIR`,
`LIFEBOARD_PORT` or `LIFEBOARD_HOST` to change where it lives or where the server listens.

### Android APK

```bash
npm run android                                   # build the UI and copy it into android/
cd android
JAVA_HOME=~/android-studio/jbr ANDROID_HOME=~/Android/Sdk ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Or `npm run apk`, which does all of the above and copies the APK to `release/lifeboard.apk`
(gitignored; named so it isn't mixed up with FitApp's).

### Versions

The version is set only in `package.json`. The Android build takes `versionName` from it and
works out `versionCode` (0.2.0 → 200), and **Settings → This device** shows the version and
the git commit it was built from (`+changes` if built with uncommitted edits), so the phone
and desktop can be compared at a glance. To release, with a clean working tree:

```bash
npm version patch   # or minor / major: bumps package.json, commits and tags vX.Y.Z
git push --follow-tags
npm run apk         # then install release/lifeboard.apk on the phone
pkill -f "^node src/desktop/server.ts"; ./start-lifeboard.sh   # restart the desktop server
```

Android won't install an APK with a lower `versionCode` over a newer one, so always bump up.

## Connections

Sign in under **Settings → Connections** on each device (sign-ins are never synced):

- **Whisker (Litter-Robot)** and **Cronometer**: email and password. The password is saved
  on the device so expired sessions renew themselves; a rejected password raises an alert.
- **Google** (Google Health steps, weight, body fat; Google Calendar and Google Tasks for the
  Schedule): desktop only for now. The Cloud project needs the Google Calendar API and Google
  Tasks API turned on, and the consent screen needs their scopes (see `GOOGLE_SCOPES` in
  `src/core/google/oauth.ts`). Put a "Desktop app"
  OAuth client JSON at `data/google_client_secret.json` (FitThing's
  `secrets/client_secret.json` works), and publish the OAuth consent screen in Google Cloud
  ("In production"), or Google ends the sign-in after 7 days. The phone receives this data
  through sync.

The desktop updates when it starts and every hour; the phone when first opened each day
or with **Update now**. Health data (Cronometer, Google Health) is pulled at most once a
day on each device. Alerts are set under
**Settings → Alert rules**.
