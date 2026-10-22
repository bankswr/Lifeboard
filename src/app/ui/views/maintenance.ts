// Maintenance (#/maintenance, in the Details menu): repeating chores. Each item makes a task
// on the day it comes due (core/maintenance.ts).
//   #/maintenance           every item with its repeat and next due date
//   #/maintenance/new       a new item (repeats monthly unless changed)
//   #/maintenance/<id>      edit or delete an item
import { html } from "lit-html";
import { localDate } from "../../../core/dates.ts";
import type { MaintenanceItem } from "../../../core/maintenance.ts";
import type { Repeat } from "../../../core/schedule/repeat.ts";
import { call } from "../../backend.ts";
import { route } from "../app.ts";
import { applyVisibility, readRepeat, repeatFieldset, repeatVisibility } from "../repeatFields.ts";
import { formatClock } from "./schedule.ts";

/** New items repeat monthly by default (user: "repeats by default"). */
const DEFAULT_REPEAT: Repeat = { freq: "monthly", interval: 1, weekdays: [], end: { kind: "never" } };

route(/^\/maintenance$/, async () => {
  const items = await call("listMaintenance");
  const today = localDate();
  return {
    section: "maintenance",
    content: html`
      <header class="page-header">
        <h1>Maintenance</h1>
        <a class="button" href="#/maintenance/new">Add</a>
      </header>
      <p class="muted">Each item adds a task to that day's Schedule when it comes due. Done on another day, the next due dates count from that day.</p>
      ${items.length === 0 ? html`<p class="muted">No maintenance items yet.</p>` : ""}
      ${items.map(
        (item) => html`
          <a class="card list-card" href="#/maintenance/${item.id}">
            <span>${item.name}<br><span class="muted small">${item.repeatText}${item.time ? ` · ${formatClock(item.time)}` : ""}</span></span>
            <span class="small ${item.waiting || item.nextDue === today ? "status warning" : "muted"}">${dueText(item.nextDue, item.waiting, today)}</span>
          </a>
        `,
      )}
    `,
  };
});

route(/^\/maintenance\/new$/, async () => formView(null));

route(/^\/maintenance\/([\w-]+)$/, async ([id]) => {
  const item = await call("getMaintenance", id);
  if (!item) return { section: "maintenance" as const, content: html`<p>This item no longer exists.</p><a href="#/maintenance">Back</a>` };
  return formView(item);
});

function formView(item: MaintenanceItem | null) {
  return {
    section: "maintenance" as const,
    content: html`
      <header class="page-header">
        <a class="back" href="#/maintenance" aria-label="Back to maintenance">←</a>
        <h1>${item ? "Edit item" : "New item"}</h1>
      </header>
      <form class="card maintenance-form schedule-form" @submit=${(event: SubmitEvent) => save(event, item)}>
        <label>Name <input name="name" required autocomplete="off" placeholder="e.g. Replace HVAC filter" .value=${item?.name ?? ""}></label>
        <label>First due <input type="date" name="startDate" required .value=${item?.startDate ?? localDate()}></label>
        <label>Time <span class="muted small">(optional; Lifeboard only)</span> <input type="time" name="time" .value=${item?.time ?? ""}></label>
        <label>Notes <textarea name="notes" rows="3" .value=${item?.notes ?? ""}></textarea></label>
        ${repeatFieldset(item ? item.repeat : DEFAULT_REPEAT)}
        <p class="form-error status error" hidden></p>
        <div class="form-actions">
          <button type="submit">Save</button>
          ${item ? html`<button type="button" class="danger" @click=${() => remove(item)}>Delete</button>` : ""}
        </div>
      </form>
    `,
    mount: (signal: AbortSignal) => {
      const form = document.querySelector<HTMLFormElement>(".maintenance-form")!;
      const update = () => applyVisibility(form, repeatVisibility(new FormData(form)));
      update();
      form.addEventListener("change", update, { signal });
      if (!item) form.querySelector<HTMLInputElement>("[name=name]")!.focus();
    },
  };
}

async function save(event: SubmitEvent, item: MaintenanceItem | null) {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const fields = new FormData(form);
  const startDate = String(fields.get("startDate"));
  try {
    await call("saveMaintenance", {
      id: item?.id,
      name: String(fields.get("name")),
      notes: String(fields.get("notes")),
      startDate,
      time: String(fields.get("time")) || null,
      repeat: readRepeat(fields, startDate, item?.repeat ?? null),
    });
    location.hash = "#/maintenance";
  } catch (error) {
    const message = form.querySelector<HTMLElement>(".form-error")!;
    message.textContent = (error as Error).message;
    message.hidden = false;
  }
}

async function remove(item: MaintenanceItem) {
  if (!confirm(`Delete "${item.name}"? Tasks it already added stay in your task list.`)) return;
  await call("deleteMaintenance", item.id);
  location.hash = "#/maintenance";
}

/** `waiting`: the item's task for `due` is still open, so the next date isn't known yet. */
function dueText(due: string | null, waiting: boolean, today: string): string {
  if (!due) return "No more due dates";
  if (due === today) return "Due today";
  const date = new Date(`${due}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: due.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" });
  return waiting ? `Overdue since ${date}` : `Next ${date}`;
}
