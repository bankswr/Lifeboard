# Generic to-do lists

2026-10-15, agent (Claude). Built while the user was away (they asked for work to continue
on anything not needing them). **Not yet reviewed by the user**; treat the UI as a first
draft.

## What exists
- Tables `todo_list`, `todo_item` (migration 3), both synced. No foreign key from item to
  list: sync can deliver an item before its list.
- Core: `src/core/todos.ts`; screens: `src/app/ui/views/lists.ts` (`#/lists`,
  `#/lists/<id>`), new "Lists" tab.
- Features: multiple lists; add (Enter keeps the cursor in the box for fast entry), check
  off (done items move to a "Done" section), tap text to edit, × to delete, "Clear done",
  rename list, delete list (with confirm; deletes its items too).
- Rename/edit/confirm use the browser's `prompt`/`confirm` (Capacitor's WebView supports
  them). Simple; replace with in-app sheets if the user wants nicer dialogs.

## Decisions
- New lists/items go at the end (`position` = max + 1). Lists made on two devices before a
  sync can share a position; ties sort by name. No reordering yet.
- Core errors are user-facing messages. The desktop server now returns them as 400
  `{error}` and `call()` rethrows the message; `act()` in `ui/app.ts` shows it with
  `alert` and re-renders.
- `COALESCE(SUM(done = 0), 0)` instead of `COUNT(...) FILTER (...)`, to avoid relying on
  newer SQLite syntax on the phone.

## Gotcha
- lit-html property bindings compare with the last *rendered* value, not the DOM. A
  checkbox the user clicked kept its check when its row was reused for another item.
  Fixed with `live()` (`lit-html/directives/live.js`). Use `live()` for any input whose
  value/checked the user can change and that is re-rendered from data.

## Verified
- 5 tests (`test/todos.test.ts`) including a phone→desktop sync.
- Desktop (Playwright): add/check/rename/back, checkbox states correct after fix.
- Emulator: created a list on the phone, synced: sent 2, received 5; both sides then
  list the same three lists.
