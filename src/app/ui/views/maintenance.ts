// Maintenance (#/maintenance, in the Details menu): repeating chores. Each item makes a task
// on the day it comes due (core/maintenance.ts).
//   #/maintenance           every item with its repeat and next due date
//   #/maintenance/new       a new item (repeats monthly unless changed)
//   #/maintenance/<id>      edit or delete an item
import { html } from "lit-html";
import { localDate } from "../../../core/dates.ts";
import type { ActiveWindow, MaintenanceItem } from "../../../core/maintenance.ts";
import type { Repeat } from "../../../core/schedule/repeat.ts";
import { call } from "../../backend.ts";
import { route } from "../app.ts";
import { applyVisibility, readRepeat, repeatFieldset, repeatVisibility } from "../repeatFields.ts";
import { formatClock } from "./schedule.ts";

/** New items repeat monthly by default (user: "repeats by default"). */
const DEFAULT_REPEAT: Repeat = { freq: "monthly", interval: 1, weekdays: [], end: { kind: "never" } };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
            <span>${item.name}<br><span class="muted small">${item.repeatText}${item.activeWindow ? ` · ${windowText(item.activeWindow)}` : ""}${item.time ? ` · ${formatClock(item.time)}` : ""}</span></span>
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
        ${advancedSection(item)}
        <p class="form-error status error" hidden></p>
        <div class="form-actions">
          <button type="submit">Save</button>
          ${item ? html`<button type="button" class="danger" @click=${() => remove(item)}>Delete</button>` : ""}
        </div>
      </form>
    `,
    mount: (signal: AbortSignal) => {
      const form = document.querySelector<HTMLFormElement>(".maintenance-form")!;
      const update = () => {
        const fields = new FormData(form);
        applyVisibility(form, { ...repeatVisibility(fields), window: fields.has("windowOn") });
      };
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
      activeWindow: readWindow(fields),
    });
    location.hash = "#/maintenance";
  } catch (error) {
    const message = form.querySelector<HTMLElement>(".form-error")!;
    message.textContent = (error as Error).message;
    message.hidden = false;
  }
}

/** Settings most items don't need (user, 2026-10-28); open when the item uses any of them. */
function advancedSection(item: MaintenanceItem | null) {
  const window = item?.activeWindow ?? null;
  return html`
    <details class="advanced" ?open=${!!window}>
      <summary>Advanced</summary>
      <fieldset>
        <legend>Active period</legend>
        <label class="check"><input type="checkbox" name="windowOn" ?checked=${!!window}> Only part of each year</label>
        <div class="month-days" data-show="window">
          ${monthDayField("windowFrom", "From", window?.from ?? "10-01")}
          ${monthDayField("windowTo", "To", window?.to ?? "10-31")}
        </div>
        <p class="muted small" data-show="window">Due dates outside this period are skipped. The schedule starts again each time the period begins.</p>
      </fieldset>
    </details>
  `;
}

/** A day of the year ("MM-DD") as a month list and a day number. */
function monthDayField(name: string, label: string, value: string) {
  const [month, day] = value.split("-").map(Number);
  return html`
    <label>${label}
      <span class="month-day">
        <select name="${name}Month" aria-label="${label} month">
          ${MONTHS.map((text, index) => html`<option value=${index + 1} ?selected=${index + 1 === month}>${text}</option>`)}
        </select>
        <input type="number" name="${name}Day" min="1" max="31" aria-label="${label} day" .value=${String(day)}>
      </span>
    </label>
  `;
}

function windowText(window: ActiveWindow): string {
  const day = (monthDay: string) => `${MONTHS[Number(monthDay.slice(0, 2)) - 1]} ${Number(monthDay.slice(3))}`;
  return `${day(window.from)} – ${day(window.to)}`;
}

function readWindow(fields: FormData): ActiveWindow | null {
  if (!fields.has("windowOn")) return null;
  const monthDay = (name: string) =>
    `${String(fields.get(`${name}Month`)).padStart(2, "0")}-${String(fields.get(`${name}Day`)).padStart(2, "0")}`;
  return { from: monthDay("windowFrom"), to: monthDay("windowTo") };
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
