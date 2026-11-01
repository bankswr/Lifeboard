// Lists (#/lists, in the Hub menu): every list on one screen as a collapsible card with its
// items and an add box (user, 2026-10-16). Two kinds:
// - To-do: ticking crosses an item out; ticked items are cleared when the app next loads.
// - Prototype: standard items to copy into other lists; its checkboxes select items for
//   "Copy selected to…" and are never saved.
// A to-do list's "Copy mode" makes it work like a prototype list until switched off.
// Each card's ⚙ menu has Rename, Sort items A–Z and Delete; the floating + makes a new list.
// Renames and edits use an in-page dialog (askText); delete confirmations use confirm().
// Lists (within their kind) and items are reordered by dragging their ⠿ handle (user,
// 2026-10-18), with SortableJS; the A–Z button sorts the lists once.
import { html, render } from "lit-html";
import { live } from "lit-html/directives/live.js";
import Sortable from "sortablejs";
import { byText, type ListKind, type TodoItem, type TodoListDetail } from "../../../core/todos.ts";
import { call } from "../../backend.ts";
import { act, route } from "../app.ts";
import { card } from "../card.ts";

/** The result of the last copy, shown once at the top. */
let message = "";
/** Selected items (prototype lists, and to-do lists in copy mode), by list id. Screen-only: never saved. */
const selected = new Map<string, Set<string>>();
/** To-do lists in copy mode. */
const copyMode = new Set<string>();

function setCopyMode(listId: string, on: boolean) {
  if (on) copyMode.add(listId);
  else copyMode.delete(listId);
  selected.get(listId)?.clear();
  void act(async () => {}); // re-render
}

route(/^\/lists$/, async () => {
  const lists = await call("getAllTodoLists");
  const shownMessage = message;
  message = "";
  return {
    section: "lists",
    content: html`
      <div class="page-header">
        <h1>Lists</h1>
        ${lists.length > 1
          ? html`<button class="secondary small" title="Sort the lists by name" @click=${() => act(() => call("sortTodoListsByName"))}>A–Z</button>`
          : ""}
      </div>
      ${shownMessage ? html`<p class="muted">${shownMessage}</p>` : ""}
      ${lists.length === 0 ? html`<p class="muted">No lists yet. Tap + to make one.</p>` : ""}
      ${listGroup("lists-todo", "To-do lists", "todo", lists)}
      ${listGroup("lists-prototype", "Prototype lists", "prototype", lists)}
      <button class="fab" aria-label="New list" title="New list" @click=${openNewListDialog}>+</button>
      ${newListDialog()}
    `,
    mount: (signal: AbortSignal) => {
      // A ⚙ menu closes when clicking anywhere else.
      document.addEventListener("click", (event) => {
        for (const menu of document.querySelectorAll<HTMLDetailsElement>(".gear-menu[open]")) {
          if (!menu.contains(event.target as Node)) menu.open = false;
        }
      }, { signal });
      makeSortable(signal, lists);
    },
  };
});

/** One collapsible section of lists of a kind; left out when there are none of that kind. */
function listGroup(id: string, title: string, kind: ListKind, lists: TodoListDetail[]) {
  const group = lists.filter((list) => list.kind === kind);
  if (group.length === 0) return "";
  return card(
    id,
    html`${title} <span class="muted small">${group.length}</span>`,
    html`<div class="list-cards" data-kind=${kind}>${group.map((list) => listCard(list, lists))}</div>`,
    { group: true },
  );
}

function listCard(list: TodoListDetail, lists: TodoListDetail[]) {
  const others = lists.filter((other) => other.id !== list.id);
  const prototype = list.kind === "prototype";
  const counts = prototype
    ? `Prototype · ${list.items.length} item${list.items.length === 1 ? "" : "s"}`
    : `${list.open.length} open${list.done.length ? `, ${list.done.length} done` : ""}`;
  const chosen = selectionOf(list);
  // A prototype list always selects; a to-do list does in copy mode (then works like one).
  const selecting = prototype || copyMode.has(list.id);
  return card(
    `list-${list.id}`,
    html`${list.name} <span class="muted small">${counts}</span>`,
    html`
      <form class="add-row" @submit=${(event: SubmitEvent) => addFromForm(event, (text) => call("addTodoItem", list.id, text))}>
        <input name="text" placeholder="Add an item" aria-label="New item on ${list.name}" autocomplete="off">
        <button type="submit">Add</button>
      </form>
      ${list.items.length === 0 ? html`<p class="muted">${prototype ? "No items yet." : "Nothing left to do."}</p>` : ""}
      ${copyMode.has(list.id) ? html`<p class="muted small">Copy mode: tick items to select them for copying.</p>` : ""}
      <ul class="items" data-list-id=${list.id}>${list.items.map((item) => (selecting ? selectRow(item, chosen) : todoRow(item)))}</ul>
      ${others.length > 0 && list.items.length > 0
        ? html`
            <div class="list-actions">
              ${prototype
                ? ""
                : html`<button class="secondary small copy-mode-toggle" @click=${() => setCopyMode(list.id, !copyMode.has(list.id))}>
                    ${copyMode.has(list.id) ? "Exit copy mode" : "Copy mode"}</button>`}
              ${selecting
                ? copySelect("Copy all to…", others, (targetId) => copied(call("copyTodoList", list.id, targetId), targetId, others))
                : ""}
              ${selecting && chosen.size > 0
                ? copySelect(`Copy ${chosen.size} selected to…`, others, (targetId) =>
                    copied(call("copyTodoItems", [...chosen], targetId), targetId, others, () => chosen.clear()), "primary")
                : ""}
            </div>
          `
        : ""}
    `,
    { actions: html`${dragHandle("Drag to move the list", list.id)}${gearMenu(list)}` },
  );
}

/** To-do item: the checkbox ticks it off (crossed out until the app next loads). */
function todoRow(item: TodoItem) {
  return html`
    <li class="item ${item.done ? "done" : ""}" data-id=${item.id}>
      ${dragHandle("Drag to move the item")}
      <!-- live(): compare with the checkbox's actual state, which the user's click changed;
           otherwise a reused row can keep a stale check mark. -->
      <input type="checkbox" aria-label="Done" .checked=${live(item.done)}
        @change=${(event: Event) => act(() => call("setTodoItemDone", item.id, (event.target as HTMLInputElement).checked))}>
      <span class="item-text" @click=${() => editItem(item)}>${item.text}</span>
      <button class="icon" aria-label="Delete item" @click=${() => act(() => call("deleteTodoItem", item.id))}>×</button>
    </li>
  `;
}

/**
 * An item on a prototype list, or a to-do list in copy mode: the checkbox selects it for
 * copying; nothing is saved. A ticked to-do item still shows crossed out.
 */
function selectRow(item: TodoItem, chosen: Set<string>) {
  return html`
    <li class="item ${chosen.has(item.id) ? "selected" : ""} ${item.done ? "done" : ""}" data-id=${item.id}>
      ${dragHandle("Drag to move the item")}
      <input type="checkbox" aria-label="Select" .checked=${live(chosen.has(item.id))}
        @change=${(event: Event) => {
          if ((event.target as HTMLInputElement).checked) chosen.add(item.id);
          else chosen.delete(item.id);
          void act(async () => {}); // re-render: shows or updates "Copy selected"
        }}>
      <span class="item-text" @click=${() => editItem(item)}>${item.text}</span>
      <button class="icon" aria-label="Delete item" @click=${() => act(() => call("deleteTodoItem", item.id))}>×</button>
    </li>
  `;
}

/** A list's selection, dropping items that no longer exist. */
function selectionOf(list: TodoListDetail): Set<string> {
  const chosen = selected.get(list.id) ?? new Set<string>();
  const ids = new Set(list.items.map((item) => item.id));
  for (const id of chosen) if (!ids.has(id)) chosen.delete(id);
  selected.set(list.id, chosen);
  return chosen;
}

function gearMenu(list: TodoListDetail) {
  const close = (event: Event) => ((event.target as HTMLElement).closest("details") as HTMLDetailsElement).open = false;
  return html`
    <details class="gear-menu">
      <summary aria-label="List options" title="List options">⚙</summary>
      <div class="gear-menu-list">
        <button type="button" @click=${(event: Event) => { close(event); void renameList(list.id, list.name); }}>Rename</button>
        <button type="button" @click=${(event: Event) => { close(event); void act(() => call("sortTodoItemsByName", list.id)); }}>Sort items A–Z</button>
        <button type="button" class="danger-text" @click=${(event: Event) => { close(event); void deleteList(list.id, list.name); }}>Delete</button>
      </div>
    </details>
  `;
}

/**
 * A small "Copy to…" picker: choosing a list copies at once, then the picker resets.
 * "primary" makes it the green, right-aligned one (the selection's copy, user 2026-10-16).
 */
function copySelect(label: string, targets: TodoListDetail[], copy: (targetId: string) => Promise<void>, style = "") {
  return html`
    <select class="copy-select ${style}" aria-label=${label}
      @change=${(event: Event) => {
        const select = event.target as HTMLSelectElement;
        const targetId = select.value;
        select.value = "";
        if (targetId) void copy(targetId);
      }}>
      <option value="" selected>${label}</option>
      ${targetGroup("To-do lists", targets.filter((target) => target.kind === "todo"))}
      ${targetGroup("Prototype lists", targets.filter((target) => target.kind === "prototype"))}
    </select>
  `;
}

/** Copy targets of one kind, A–Z under a heading, so it's clear which kind each list is. */
function targetGroup(label: string, targets: TodoListDetail[]) {
  if (targets.length === 0) return "";
  return html`<optgroup label=${label}>${byText(targets, (target) => target.name).map((target) => html`<option value=${target.id}>${target.name}</option>`)}</optgroup>`;
}

async function copied(
  result: Promise<{ copied: number; skipped: number }>,
  targetId: string,
  lists: TodoListDetail[],
  afterwards?: () => void,
) {
  await act(async () => {
    const { copied: count, skipped } = await result;
    afterwards?.();
    const name = lists.find((list) => list.id === targetId)?.name ?? "the list";
    message = `Copied ${count} item${count === 1 ? "" : "s"} to ${name}${skipped ? ` (${skipped} already there)` : ""}.`;
  });
}

// ---------- drag sorting ----------

/** The ⠿ grip that drags a list card or an item; the rest of the row stays tappable. */
function dragHandle(label: string, id?: string) {
  return html`<span class="drag-handle" role="img" aria-label=${label} title=${label} data-id=${id ?? ""}>⠿</span>`;
}

/**
 * Turns the list cards (within each kind) and each list's items into drag-sortable groups
 * until the screen re-renders (`signal`). SortableJS moves the dragged element itself, but
 * lit-html owns these elements, so the move is undone at once and the new order is saved
 * and rendered the normal way.
 */
function makeSortable(signal: AbortSignal, lists: TodoListDetail[]) {
  const sortables: Sortable[] = [];
  for (const container of document.querySelectorAll<HTMLElement>(".list-cards")) {
    const kind = container.dataset.kind;
    const idsOfKind = (other: ListKind) => lists.filter((list) => list.kind === other).map((list) => list.id);
    sortables.push(sortable(container, ":scope > section > .card-head .drag-handle", (moved) =>
      // Positions are shared by both kinds: save the whole order, with this group's new one.
      call("reorderTodoLists", [...(kind === "todo" ? moved : idsOfKind("todo")), ...(kind === "prototype" ? moved : idsOfKind("prototype"))])));
  }
  for (const container of document.querySelectorAll<HTMLElement>("ul.items[data-list-id]")) {
    sortables.push(sortable(container, ":scope > li", (moved) => call("reorderTodoItems", container.dataset.listId!, moved)));
  }
  signal.addEventListener("abort", () => sortables.forEach((s) => s.destroy()));
}

/** `idSelector` finds the elements carrying the rows' `data-id`, in order. */
function sortable(container: HTMLElement, idSelector: string, save: (ids: string[]) => Promise<unknown>): Sortable {
  let placeBefore: Node | null = null;
  return Sortable.create(container, {
    handle: ".drag-handle",
    animation: 150,
    onStart: (event) => (placeBefore = event.item.nextSibling),
    onEnd: (event) => {
      if (event.oldIndex === event.newIndex) return;
      const ids = [...container.querySelectorAll<HTMLElement>(idSelector)].map((element) => element.dataset.id!);
      container.insertBefore(event.item, placeBefore); // back where lit-html expects it
      void act(() => save(ids));
    },
  });
}

// ---------- new list ----------

function newListDialog() {
  return html`
    <dialog class="sheet new-list-dialog" aria-labelledby="new-list-title"
      @click=${(event: Event) => event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}>
      <form @submit=${createList}>
        <h2 id="new-list-title">New list</h2>
        <label>Name <input name="name" required autocomplete="off"></label>
        <div class="segmented" role="radiogroup" aria-label="Type">
          <label><input type="radio" name="kind" value="todo" checked> To-do</label>
          <label><input type="radio" name="kind" value="prototype"> Prototype</label>
        </div>
        <p class="muted small">Prototype lists hold standard items to copy into other lists.</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" @click=${(event: Event) => (event.target as HTMLElement).closest("dialog")!.close()}>Cancel</button>
          <button type="submit">Create</button>
        </div>
      </form>
    </dialog>
  `;
}

function openNewListDialog() {
  const dialog = document.querySelector<HTMLDialogElement>(".new-list-dialog")!;
  dialog.querySelector("form")!.reset();
  dialog.showModal();
  dialog.querySelector<HTMLInputElement>("[name=name]")!.focus();
}

async function createList(event: SubmitEvent) {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const fields = new FormData(form);
  form.closest("dialog")!.close();
  await act(() => call("createTodoList", String(fields.get("name")), fields.get("kind") as ListKind));
}

// ---------- editing ----------

/**
 * Asks for a line of text, starting with `current`; resolves to null on Cancel.
 * Used instead of prompt(): Capacitor's Android prompt dialog ignores the default
 * value, so edits started with an empty field.
 */
function askText(title: string, current: string): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "sheet";
  render(html`
    <form method="dialog">
      <h2>${title}</h2>
      <input name="text" required autocomplete="off" .value=${current}>
      <div class="dialog-actions">
        <button type="button" class="secondary" @click=${() => dialog.close()}>Cancel</button>
        <button type="submit" value="ok">Save</button>
      </div>
    </form>
  `, dialog);
  document.body.append(dialog);

  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const input = dialog.querySelector("input")!;
      resolve(dialog.returnValue === "ok" ? input.value.trim() : null);
      dialog.remove();
    });
    dialog.showModal();
    dialog.querySelector("input")!.select();
  });
}

/** Adds what was typed in an add-row form, then keeps the cursor there for the next one. */
async function addFromForm(event: SubmitEvent, add: (text: string) => Promise<unknown>) {
  event.preventDefault();
  const input = (event.target as HTMLFormElement).elements.namedItem("text") as HTMLInputElement;
  const text = input.value;
  if (!text.trim()) return;
  await act(() => add(text));
  input.value = "";
  input.focus();
}

async function renameList(listId: string, current: string) {
  const name = await askText("List name", current);
  if (name !== null && name !== current) await act(() => call("renameTodoList", listId, name));
}

async function editItem(item: TodoItem) {
  const text = await askText("Edit item", item.text);
  if (text !== null && text !== item.text) await act(() => call("editTodoItem", item.id, text));
}

async function deleteList(listId: string, name: string) {
  if (!confirm(`Delete the list "${name}" and everything on it?`)) return;
  await act(() => call("deleteTodoList", listId));
}
