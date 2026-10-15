# Phase 0 scaffold

2026-10-15, agent (Claude). Plan phase 0 from docs/PLAN.md: complete.

## What was built
- Single npm package (no workspaces) with `src/core`, `src/app`, `src/desktop`, `android/`.
  Dependency versions match FitApp's lockfile where shared (Capacitor 8.5.2, Vite 8.3.1,
  Vitest 5.0.3, TypeScript 7.0.2, lit-html 3.3.3).
- **One UI→core path, `call(name, ...args)`** (`src/app/backend.ts`). Phone: runs
  `core/api.ts` directly on the Capacitor SQLite DB. Desktop browser: `POST /api/<name>`
  to the Fastify server, which runs the same function. New features add functions to
  the `api` object in `core/api.ts`; nothing else needs wiring.
- Desktop DB uses Node's built-in `node:sqlite` (no native module to build). Tests use the
  same adapter with `:memory:`, so FitApp's sql.js test adapter and its wasm version pin
  were not needed. The phone adapter is FitApp's minus its browser/IndexedDB path (desktop
  browser never opens a local DB).
- Desktop server runs `.ts` directly with Node 24 type stripping; see AGENTS.md for the
  import/syntax rules that follow from that.
- Fastify + @fastify/static instead of a hand-written static server (reuse rule).
- Schema v1: `meta` table with a per-install `device_id` (UUID) for later sync.

## Verified
- `npm test` (4 tests), `tsc --noEmit`, `vite build`.
- Desktop: server on 127.0.0.1:5180, page renders "Running on desktop", device id shown
  (Playwright Chromium from `~/.cache/ms-playwright`, installed `playwright-core` in the
  session scratchpad). `POST /api/constructor` → 404 (only own `api` keys callable).
- Android: debug APK built, installed on the `fitapp_test` AVD (FitApp's emulator, Android
  16), renders "Running on android", migration ran on the device.

## Gotchas
- `firefox --headless --screenshot` captures before async rendering finishes → blank page.
  Use Playwright.
- Emulator screenshot right after `am start` may catch the launch animation; wait/retake.
- `npm audit` reports moderate `uuid` issue via `@capacitor/cli` → `xcode` (iOS tooling,
  dev-only, unused). Fix requires a CLI downgrade; ignored.

## Not done
- Release signing key: not created. Debug APKs only so far. When a release build is
  wanted, create a Lifeboard keystore outside the repo (FitApp's pattern:
  `~/.fitapp-release/`) — the user must back it up.
- App icon/splash are Capacitor defaults.
