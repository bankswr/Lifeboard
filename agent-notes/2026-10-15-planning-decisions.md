# Planning decisions behind docs/PLAN.md

2026-10-15, agent (Claude).

User's answers during initial planning:
- v1: most of FitThing (to be enumerated), tasks & reminders, calendar, and — stated as
  very important — litter robot + cat feeders with more consistent notifications than
  the vendor apps. Finances is a stretch goal.
- Phone: Android only.
- Sync: data only, newest edit wins per record; app updates installed manually.
- Phone must work alone, *including* pulling external data.

Consequence: logic must run on Android, so the codebase is TypeScript, modeled on
`../FitApp` (TS + Vite + Capacitor + SQLite, which already ships an Android APK). FitThing's
Python gets ported rather than reused directly — the main cost of that answer. Desktop
uses a local Node server (CORS to Cronometer/Whisker, background polling, LAN sync peer).

Open questions are tracked at the bottom of docs/PLAN.md.

## Round 2 answers (same day)
- Phone: no background polling. Update on command, or on app open if >12h since last update.
- Health v1 = calories, macros, weight, body fat, steps — data only; refinements later.
- Devices: Whisker Litter-Robot; Petory-brand feeders.
- Notification pain point: silently signed out, then no notifications. Wants IFTTT-style
  customizable rules → plan adds a Connections module (auth status → events) + rules engine.
- Calendar editable, synced with Google (assumed tasks sync with Google Tasks too).
- Separate sign-in per device; credentials never sync.

## Round 3 answers (same day)
- Added: generic to-do lists, multiple separate lists, no external sync (LAN sync between
  own devices assumed fine — confirm if it matters).
- Petory feeders use the Petory app; user open to suggestions on access. No public API or
  HA integration found (web search 2026-10-15). Plan: check for Tuya white-label first,
  else inspect app traffic.
- Desktop: poll on startup, then every 4h if left running. No continuous monitoring.
- Pets read-only; rules are awareness only (notify action only).
- Review each feature's plan with the user when that feature is ready to build.
- Google OAuth "In production": publishing is a free button. Verification is only needed
  to remove the unverified-app warning; personal use doesn't need it. Production refresh
  tokens don't have the 7-day Testing expiry (they still expire after ~6 months unused,
  or on revocation).
