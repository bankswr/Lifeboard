// Maintenance (#/maintenance, in the Details menu): repeating chores. Each item makes a task
// on the day it comes due (core/maintenance.ts).
//   #/maintenance           every item with its repeat and next due date
//   #/maintenance/new       a new item (repeats monthly unless changed)
//   #/maintenance/<id>      edit or delete an item
import { html, render } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { localDate } from "../../../core/dates.ts";
import type { ActiveWindow, MaintenanceItem } from "../../../core/maintenance.ts";
import { WEATHER_MEASURES, type WeatherCondition, type WeatherMeasure } from "../../../core/maintenanceWeather.ts";
import type { Repeat } from "../../../core/schedule/repeat.ts";
import { call } from "../../backend.ts";
import { route } from "../app.ts";
import { applyVisibility, readRepeat, repeatFieldset, repeatVisibility } from "../repeatFields.ts";
import { formatClock } from "./schedule.ts";

/** New items repeat monthly by default (user: "repeats by default"). */
const DEFAULT_REPEAT: Repeat = { freq: "monthly", interval: 1, weekdays: [], end: { kind: "never" } };
/** A new weather condition: the mowing example (user, 2026-10-28). */
const DEFAULT_CONDITION: WeatherCondition = { kind: "avoid", measure: "rainChance", op: ">", value: 30, lead: 0, lag: 0 };
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
            <span class="small due-text ${item.waiting || item.nextDue === today || item.weatherPlan?.noDay ? "status warning" : "muted"}">
              ${dueText(item.nextDue, item.waiting, today)}
              ${item.weatherPlan ? weatherNote(item.weatherPlan) : ""}
            </span>
          </a>
        `,
      )}
    `,
  };
});

route(/^\/maintenance\/new$/, async () => formView(null, await call("getWeatherLocation") !== null));

route(/^\/maintenance\/([\w-]+)$/, async ([id]) => {
  const item = await call("getMaintenance", id);
  if (!item) return { section: "maintenance" as const, content: html`<p>This item no longer exists.</p><a href="#/maintenance">Back</a>` };
  return formView(item, await call("getWeatherLocation") !== null);
});

/** `hasWeatherLocation`: weather conditions only work once a location is set. */
function formView(item: MaintenanceItem | null, hasWeatherLocation: boolean) {
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
        ${advancedSection(item, hasWeatherLocation)}
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
      mountWeatherConditions(form, item?.weather ?? []);
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
      weather: readConditions(fields),
    });
    location.hash = "#/maintenance";
  } catch (error) {
    const message = form.querySelector<HTMLElement>(".form-error")!;
    message.textContent = (error as Error).message;
    message.hidden = false;
  }
}

/** Settings most items don't need (user, 2026-10-28); open when the item uses any of them. */
function advancedSection(item: MaintenanceItem | null, hasWeatherLocation: boolean) {
  const window = item?.activeWindow ?? null;
  return html`
    <details class="advanced" ?open=${!!window || (item?.weather.length ?? 0) > 0}>
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
      <fieldset>
        <legend>Weather</legend>
        <p class="muted small">
          A due date the forecast rules out moves to the nearest day that fits, up to 16 days ahead.
          With no day that fits, the task waits and an alert says so.
          ${hasWeatherLocation ? "" : html`<strong>Set a location under Settings → Connections → Weather first.</strong>`}
        </p>
        <div class="weather-rows"></div>
        <button type="button" class="secondary add-condition">Add condition</button>
      </fieldset>
    </details>
  `;
}

/**
 * The weather condition rows, drawn into the form from a list kept here; adding or removing
 * one reads the rows back first so typed values survive.
 */
function mountWeatherConditions(form: HTMLFormElement, initial: WeatherCondition[]) {
  const host = form.querySelector<HTMLElement>(".weather-rows")!;
  let conditions = initial;
  const draw = () => render(conditions.map((condition, index) => conditionRow(condition, () => removeAt(index))), host);
  const removeAt = (index: number) => {
    conditions = readConditions(new FormData(form)).filter((_, i) => i !== index);
    draw();
  };
  form.querySelector(".add-condition")!.addEventListener("click", () => {
    conditions = [...readConditions(new FormData(form)), DEFAULT_CONDITION];
    draw();
  });
  draw();
}

function conditionRow(condition: WeatherCondition, remove: () => void) {
  return html`
    <div class="weather-condition">
      <div class="line">
        <select name="wKind" aria-label="Avoid or only" .value=${live(condition.kind)}>
          <option value="avoid">Avoid days when</option>
          <option value="only">Only days when</option>
        </select>
        <button type="button" class="secondary" aria-label="Remove condition" @click=${remove}>✕</button>
      </div>
      <div class="line">
        <select name="wMeasure" aria-label="Measure" .value=${live(condition.measure)}>
          ${(Object.keys(WEATHER_MEASURES) as WeatherMeasure[]).map(
            // ?selected as well: the select's value is set before these options are drawn.
            (measure) => html`<option value=${measure} ?selected=${measure === condition.measure}>${WEATHER_MEASURES[measure].label} (${WEATHER_MEASURES[measure].unit.trim()})</option>`,
          )}
        </select>
        <select name="wOp" aria-label="Comparison" .value=${live(condition.op)}>
          <option value=">">is over</option>
          <option value="<">is under</option>
        </select>
        <input type="number" name="wValue" step="any" aria-label="Value" required .value=${live(String(condition.value))}>
      </div>
      <div class="line">
        Also rule out
        <input type="number" name="wLead" min="0" max="7" aria-label="Days before" .value=${live(String(condition.lead))}> day(s) before and
        <input type="number" name="wLag" min="0" max="7" aria-label="Days after" .value=${live(String(condition.lag))}> after
      </div>
    </div>
  `;
}

/** The condition rows as conditions; each field name appears once per row, in row order. */
function readConditions(fields: FormData): WeatherCondition[] {
  const column = (name: string) => fields.getAll(name).map(String);
  const [kinds, measures, ops, values, leads, lags] = ["wKind", "wMeasure", "wOp", "wValue", "wLead", "wLag"].map(column);
  return kinds.map((kind, index) => ({
    kind: kind as WeatherCondition["kind"],
    measure: measures[index] as WeatherMeasure,
    op: ops[index] as WeatherCondition["op"],
    value: Number(values[index]),
    lead: Number(leads[index]) || 0,
    lag: Number(lags[index]) || 0,
  }));
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

function weekdayOf(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
}

/** Why the weather moved or holds the next date, under it. */
function weatherNote(plan: { movedFrom: string | null; reason: string | null; noDay: boolean; dropping: boolean }) {
  if (plan.dropping) return html`<br><span>Weather fits no day before the period ends (${plan.reason})</span>`;
  if (plan.noDay) return html`<br><span>No day in the forecast fits yet (${plan.reason})</span>`;
  if (plan.movedFrom) return html`<br><span class="muted">moved from ${weekdayOf(plan.movedFrom)}: ${plan.reason}</span>`;
  return "";
}

/** `waiting`: the item's task for `due` is still open, so the next date isn't known yet. */
function dueText(due: string | null, waiting: boolean, today: string): string {
  if (!due) return "No more due dates";
  if (due === today) return "Due today";
  const date = new Date(`${due}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: due.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" });
  return waiting ? `Overdue since ${date}` : `Next ${date}`;
}
