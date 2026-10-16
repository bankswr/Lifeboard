// To-do lists (in the Hub menu): #/lists shows every list; #/lists/<id> shows one list's items.
// Renames, edits and delete confirmations use the browser's own prompt/confirm dialogs.
import { html } from "lit-html";
import { live } from "lit-html/directives/live.js";
import type { TodoItem, TodoList } from "../../../core/todos.ts";
import { call } from "../../backend.ts";
import { act, route } from "../app.ts";

route(/^\/lists$/, async () => {
  const lists = await call("listTodoLists");
  return { section: "lists", content: listsPage(lists) };
});

function listsPage(lists: TodoList[]) {
  return html`
    <header class="page-header">
      <h1>Lists</h1>
    </header>
    <form class="add-row" @submit=${(event: SubmitEvent) => addFromForm(event, (name) => call("createTodoList", name))}>
      <input name="text" placeholder="New list" aria-label="New list name" autocomplete="off">
      <button type="submit">Add</button>
    </form>
    ${lists.length === 0 ? html`<p class="muted">No lists yet.</p>` : ""}
    ${lists.map(
      (list) => html`
        <a class="card list-card" href="#/lists/${list.id}">
          <span>${list.name}</span>
          <span class="muted">${list.openCount} open${list.doneCount ? `, ${list.doneCount} done` : ""}</span>
        </a>
      `,
    )}
  `;
}

route(/^\/lists\/([\w-]+)$/, async ([listId]) => {
  const list = await call("getTodoList", listId);
  if (!list) {
    return { section: "lists", content: html`<p>This list no longer exists.</p><a href="#/lists">Back to lists</a>` };
  }
  return {
    section: "lists",
    content: html`
      <header class="page-header">
        <a class="back" href="#/lists" aria-label="Back to lists">←</a>
        <h1>${list.name}</h1>
        <button class="secondary" @click=${() => renameList(list.id, list.name)}>Rename</button>
      </header>
      <form class="add-row" @submit=${(event: SubmitEvent) => addFromForm(event, (text) => call("addTodoItem", list.id, text))}>
        <input name="text" placeholder="Add an item" aria-label="New item" autocomplete="off">
        <button type="submit">Add</button>
      </form>
      ${list.open.length === 0 ? html`<p class="muted">Nothing left to do.</p>` : ""}
      <ul class="items">${list.open.map(itemRow)}</ul>
      ${list.done.length
        ? html`
            <div class="section-header">
              <h2>Done</h2>
              <button class="secondary" @click=${() => act(() => call("clearDoneTodoItems", list.id))}>Clear done</button>
            </div>
            <ul class="items">${list.done.map(itemRow)}</ul>
          `
        : ""}
      <button class="danger" @click=${() => deleteList(list.id, list.name)}>Delete list</button>
    `,
  };
});

function itemRow(item: TodoItem) {
  return html`
    <li class="item ${item.done ? "done" : ""}">
      <!-- live(): compare with the checkbox's actual state, which the user's click changed;
           otherwise a reused row can keep a stale check mark. -->
      <input type="checkbox" aria-label="Done" .checked=${live(item.done)}
        @change=${(event: Event) => act(() => call("setTodoItemDone", item.id, (event.target as HTMLInputElement).checked))}>
      <span class="item-text" @click=${() => editItem(item)}>${item.text}</span>
      <button class="icon" aria-label="Delete item" @click=${() => act(() => call("deleteTodoItem", item.id))}>×</button>
    </li>
  `;
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
  const name = prompt("List name", current);
  if (name !== null && name !== current) await act(() => call("renameTodoList", listId, name));
}

async function editItem(item: TodoItem) {
  const text = prompt("Edit item", item.text);
  if (text !== null && text !== item.text) await act(() => call("editTodoItem", item.id, text));
}

async function deleteList(listId: string, name: string) {
  if (!confirm(`Delete the list "${name}" and everything on it?`)) return;
  await act(() => call("deleteTodoList", listId));
  location.hash = "#/lists";
}
