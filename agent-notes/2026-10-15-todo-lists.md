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

## Update 2026-10-16 (user)
- The Lists screen shows every list as a collapsible card with its items and add box; the
  separate per-list page (#/lists/<id>) is gone.
- Copying (`copyTodoItems`, `copyTodoList`): duplicates into another list as unticked items
  at its end, skipping texts already open there (case-insensitive). "Copy all" includes
  ticked items, so a list works as a template.
- Two kinds (migration 15, `todo_list.kind`): **todo** — ticking crosses out in place; ticked
  items are deleted by `clearCheckedItems` each time the app loads (main.ts, both devices);
  **prototype** — standard items to copy; checkboxes are a screen-only selection for
  "Copy selected to…", never saved. ⚙ menu per card (Rename, Delete); floating + opens a
  dialog for name and kind.
- To-do lists have a **Copy mode** button instead of per-item and "copy all" pickers: in copy
  mode the list works like a prototype (checkboxes select; Copy all / Copy N selected) until
  "Exit copy mode". Screen-only state.

## Update 2026-10-18 (user): sorting and the copy picker
- **Drag sorting** of list cards (within their kind's group) and of items within a list, by
  a ⠿ grip (`drag-handle`) so taps on text/checkboxes still work. SortableJS 1.15.7 (MIT;
  reuse rule: touch support and auto-scroll would be a lot of custom code). SortableJS moves
  the element itself; lit-html owns it, so `onEnd` reads the new order, puts the element back
  where it was (`nextSibling` saved at `onStart`) and saves through `reorderTodoLists` /
  `reorderTodoItems`, then re-renders. Instances are destroyed on the screen's abort signal.
- **A–Z** (user chose a one-time sort, not a kept-sorted toggle): button beside the Lists
  heading (`sortTodoListsByName`), plus "Sort items A–Z" in each ⚙ menu
  (`sortTodoItemsByName`). `byText` uses `Intl.Collator` (case/accent-insensitive, numeric).
- Positions are one sequence across both kinds; a reorder saves only rows whose position
  changed, so a drag syncs a few rows.
- **Copy picker** ("Copy all to…", "Copy N selected to…"): targets grouped under To-do lists /
  Prototype lists (`<optgroup>`), A–Z within each.
- Verified: 2 new tests; desktop (Playwright, scratch server on another port): drag of an
  item and of a list card saved, A–Z for lists and items, picker groups. Touch drag on the
  phone not yet tried.
