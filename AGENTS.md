# Lifeboard — instructions for AI agents

These instructions apply to any LLM agent (Claude, Codex, Copilot, Cursor, etc.)
working in this repository.

## Scope
`docs/PLAN.md` defines the project's scope, architecture, and phases. Check work against it;
do not build features outside it without the user's agreement, and record agreed changes there.
In particular, Lifeboard never controls devices (no commands to the Litter-Robot, feeders or
anything else) unless the user changes that rule; see "No device control" in `docs/PLAN.md`.

## Agent notes
`agent-notes/` is a shared reference folder for agents. Before starting work, read
`agent-notes/INDEX.md` and any relevant notes. When you make a non-obvious decision,
finish an investigation, or leave work in progress, record it there following the
conventions in `agent-notes/README.md`, and update the index.

## Coding standards
- **Reuse before writing.** Prefer existing code over new custom code, as far as is
  reasonable, in this order: code already in this repo, code from the related projects
  `../FitApp` (stack/skeleton) and `../FitThing` (health logic; see
  `agent-notes/2026-10-15-fitthing-reuse-source.md`), the standard
  library, then a well-maintained third-party package. Write custom code only when none
  of these fit, and say why in the commit or an agent note.
- **Readability first.** Favor clear, plain code over clever or compact code: descriptive
  names, small single-purpose functions, straightforward control flow, and comments that
  explain *why* rather than *what*. Choose the readable version when it costs little in
  performance.

## Project layout and commands
See `README.md`. In short: `src/core/` is shared by both devices and must not use DOM or
Node-only APIs; `src/app/` is the UI; `src/desktop/` is the Node server. Node runs the
desktop `.ts` files directly (type stripping), so imports name the `.ts` file and
TypeScript-only syntax such as enums and parameter properties is not allowed
(`erasableSyntaxOnly` enforces this). Check work with `npm test` and `npm run build`.
After a build, restart the desktop server
(`pkill -f "node src/desktop/server.ts"; ./start-lifeboard.sh`): it loads `core` only at
start, so otherwise the new UI runs against the old server (see `README.md`).

## Native Android code
- Lives in `android/app/src/main/java/org/lifeboard/app/` (Java, like Capacitor's own):
  small Capacitor plugins (e.g. `GoogleAuthorizationPlugin`) and the home-screen widgets
  in `widgets/`, with their layouts and definitions under `android/app/src/main/res/`.
- Native code holds no app logic. The widgets only draw the snapshot built in
  `src/core/widgets.ts` (unit-tested), handed over by `src/app/widgets.ts`; list ticks on a
  widget are queued natively and applied by the app through the normal core code. Native
  code never writes the app's database.
- Check native changes by building the debug APK (`npm run android`, then
  `JAVA_HOME=~/android-studio/jbr ANDROID_HOME=~/Android/Sdk android/gradlew -p android assembleDebug`)
  and trying it on the `fitapp_test` emulator; see `agent-notes/2026-10-17-widgets.md`
  for driving the widgets with adb.
