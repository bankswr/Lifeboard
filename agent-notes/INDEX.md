# agent-notes index

One line per note: `- [Title](file.md) — one-line summary`

- [FitThing as reuse source](2026-10-15-fitthing-reuse-source.md) — `../FitThing` (HealthLoader) holds prior work to reuse here: Google Health + Cronometer pulls, daily.csv aggregation, local HTML dashboard, agent-notes conventions
- [Planning decisions](2026-10-15-planning-decisions.md) — user's answers that shaped docs/PLAN.md: Android only, data-only LAN sync (newest edit wins), phone pulls external data itself → single TypeScript codebase modeled on FitApp
- [Phase 0 scaffold](2026-10-15-phase-0-scaffold.md) — TS scaffold built and verified on desktop + Android emulator; single `call()` UI→core path; node:sqlite on desktop/tests; gotchas
- [LAN sync](2026-10-15-lan-sync.md) — phase 2: seq-based exchange, newest edit wins, tombstones; how a feature makes a table synced; desktop listens on 0.0.0.0 with key-protected /sync, UI loopback-only; Android cleartext; WebView testing via raw CDP
- [Pet API research](2026-10-15-pet-api-research.md) — Litter-Robot: Cognito + per-model endpoints (LR4 GraphQL), TS route via amazon-cognito-identity-js, alert fields; Petory F01W: no known API, next step is decompiling the app pulled from the user's phone
- [To-do lists](2026-10-15-todo-lists.md) — generic synced lists (built unreviewed while user away); UI decisions; lit-html `live()` gotcha for checkboxes
- [Connections, rules, updates](2026-10-15-connections-and-rules.md) — phase 3: readings → edge-triggered IFTTT-style rules (notify only), per-device connection status + alerts, update schedule per device, notification delivery; built unreviewed
- [Cronometer port](2026-10-15-cronometer-port.md) — TS port of FitThing's Cronometer export (calories+macros), once-a-day pull for the export cap, silent re-sign-in, saved password decision, Android CapacitorHttp hides Set-Cookie (native cookie store used instead); untested against the real site
- [Google Health port](2026-10-15-google-health-port.md) — steps/weight/body fat via PKCE OAuth + Health API v4, desktop-only sign-in (needs client JSON + published consent screen), FitThing steps algorithm, per-row tombstoning; phone Google sign-in not built
