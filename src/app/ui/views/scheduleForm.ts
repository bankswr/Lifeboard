// The Schedule's new/edit page for events and tasks:
//   #/schedule/new/<date>   a new event or task, dated the day whose + was tapped
//   #/schedule/event/<id>   edit or delete an event (for a repeating one: this, this and
//                           following, or all occurrences)
//   #/schedule/task/<id>    edit or delete a task
// Which fields show depends on other fields (event or task, all-day, repeat), so the form
// shows and hides them itself on each change rather than re-rendering.
import { html } from "lit-html";
import { localDate } from "../../../core/dates.ts";
import type { Scope } from "../../../core/schedule/edit.ts";
import type { Repeat } from "../../../core/schedule/repeat.ts";
import type { ScheduleOptions } from "../../../core/schedule/store.ts";
import { call } from "../../backend.ts";
import { route } from "../app.ts";
import { applyVisibility, readRepeat, repeatFieldset, repeatVisibility } from "../repeatFields.ts";
import { returnToSchedule } from "./schedule.ts";

type Kind = "event" | "task";

/** What the form starts with: a new item's defaults, or the item being edited. */
interface Initial {
  kind: Kind;
  id?: string;
  title: string;
  location: string;
  notes: string;
  date: string;
  allDay: boolean;
  days: number;
  startTime: string;
  endTime: string;
  /** Tasks: the Lifeboard-only time. */
  time: string;
  repeat: Repeat | null;
  /** Editing an occurrence of a repeating event. */
  recurring: boolean;
}

/** The repeat being edited, kept so a custom Google rule survives a save that doesn't change it. */
let originalRepeat: Repeat | null = null;

route(/^\/schedule\/new\/(\d{4}-\d{2}-\d{2})$/, async ([date]) => {
  const [hour, minute] = defaultStart(date);
  const start = `${pad(hour)}:${minute}`;
  const initial: Initial = {
    kind: "event", title: "", location: "", notes: "", date, allDay: false, days: 1,
    startTime: start, endTime: `${pad((hour + 1) % 24)}:${minute}`, time: "", repeat: null, recurring: false,
  };
  return formView(initial, await call("getScheduleOptions"));
});

route(/^\/schedule\/event\/(.+)$/, async ([id]) => {
  const event = await call("getEvent", id);
  if (!event) return missing();
  const localStart = event.allDay ? null : new Date(event.start);
  const localEnd = event.allDay ? null : new Date(event.end);
  const initial: Initial = {
    kind: "event", id: event.id, title: event.title, location: event.location, notes: event.notes,
    date: event.allDay ? event.start : localDate(localStart!),
    allDay: event.allDay,
    days: event.allDay ? daysBetween(event.start, event.end) : 1,
    startTime: localStart ? clock(localStart) : "09:00",
    endTime: localEnd ? clock(localEnd) : "10:00",
    time: "", repeat: event.repeat, recurring: event.recurring,
  };
  return formView(initial, await call("getScheduleOptions"));
});

route(/^\/schedule\/task\/(.+)$/, async ([id]) => {
  const task = await call("getTask", id);
  if (!task) return missing();
  const initial: Initial = {
    kind: "task", id: task.id, title: task.title, location: "", notes: task.notes, date: task.due ?? "",
    allDay: false, days: 1, startTime: "09:00", endTime: "10:00", time: task.time ?? "", repeat: task.repeat, recurring: false,
  };
  return formView(initial, await call("getScheduleOptions"));
});

function missing() {
  return {
    section: "schedule" as const,
    content: html`<p>This item no longer exists.</p><a href="#/schedule" @click=${back}>Back to the Schedule</a>`,
  };
}

function formView(initial: Initial, options: ScheduleOptions) {
  originalRepeat = initial.repeat;
  const editing = Boolean(initial.id);
  const repeat = initial.repeat;
  const heading = editing ? (initial.kind === "event" ? "Edit event" : "Edit task") : "New";
  return {
    section: "schedule" as const,
    content: html`
      <header class="page-header">
        <a class="back" href="#/schedule" aria-label="Back to the Schedule" @click=${back}>←</a>
        <h1>${heading}</h1>
      </header>
      <form class="card schedule-form" @submit=${(event: SubmitEvent) => save(event, initial)}>
        ${editing
          ? html`<input type="hidden" name="kind" value=${initial.kind}>`
          : html`
              <div class="segmented" role="radiogroup" aria-label="Type">
                <label><input type="radio" name="kind" value="event" checked> Event</label>
                <label><input type="radio" name="kind" value="task"> Task</label>
              </div>
            `}
        <label>Name <input name="title" required autocomplete="off" .value=${initial.title}></label>
        <label>Date <input type="date" name="date" .value=${initial.date}></label>

        <label class="check" data-show="event"><input type="checkbox" name="allDay" ?checked=${initial.allDay}> All day</label>
        <input type="hidden" name="days" value=${initial.days}>
        <div class="field-row" data-show="timed">
          <label>Start <input type="time" name="startTime" .value=${initial.startTime}></label>
          <label>End <input type="time" name="endTime" .value=${initial.endTime}></label>
        </div>
        <label data-show="task">Time <span class="muted small">(Lifeboard only; Google Tasks keeps dates)</span>
          <input type="time" name="time" .value=${initial.time}></label>
        <label data-show="event">Location <input name="location" autocomplete="off" .value=${initial.location}></label>
        <label>Notes <textarea name="notes" rows="3" .value=${initial.notes}></textarea></label>

        ${!editing && options.calendars.length > 1
          ? html`<label data-show="event">Calendar <select name="calendarId">
              ${options.calendars.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></label>`
          : ""}
        ${!editing && options.taskLists.length > 1
          ? html`<label data-show="task">List <select name="listId">
              ${options.taskLists.map((l) => html`<option value=${l.id}>${l.title}</option>`)}</select></label>`
          : ""}

        ${initial.recurring
          ? html`<label>Apply to <select name="scope">
              <option value="this">This event</option>
              <option value="following">This and following events</option>
              <option value="all">All events</option>
            </select></label>`
          : ""}

        ${repeatFieldset(repeat)}

        <p class="form-error status error" hidden></p>
        <div class="form-actions">
          <button type="submit">Save</button>
          ${editing ? html`<button type="button" class="danger" @click=${() => remove(initial)}>Delete</button>` : ""}
        </div>
      </form>
    `,
    mount: (signal: AbortSignal) => {
      const form = document.querySelector<HTMLFormElement>(".schedule-form")!;
      updateVisibility(form);
      form.addEventListener("change", () => updateVisibility(form), { signal });
      if (!editing) form.querySelector<HTMLInputElement>("[name=title]")!.focus();
    },
  };
}


/** Shows each [data-show] part only when it applies to the current choices. */
function updateVisibility(form: HTMLFormElement) {
  const fields = new FormData(form);
  const kind = fields.get("kind") as Kind;
  applyVisibility(form, {
    event: kind === "event",
    task: kind === "task",
    timed: kind === "event" && !fields.has("allDay"),
    // One occurrence can't change the series' repeat.
    repeat: fields.get("scope") !== "this",
    ...repeatVisibility(fields),
  });
}


async function save(event: SubmitEvent, initial: Initial) {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const fields = new FormData(form);
  const text = (name: string) => String(fields.get(name) ?? "");
  const date = text("date");
  const repeat = readRepeat(fields, date, originalRepeat);
  try {
    if (fields.get("kind") === "event") {
      await call("saveEvent", {
        id: initial.id,
        calendarId: fields.get("calendarId") ? text("calendarId") : undefined,
        title: text("title"), location: text("location"), notes: text("notes"), date,
        allDay: fields.has("allDay"), days: Number(text("days")) || 1,
        startTime: text("startTime"), endTime: text("endTime"), repeat,
      }, (fields.get("scope") as Scope | null) ?? "all");
    } else {
      await call("saveTask", {
        id: initial.id,
        listId: fields.get("listId") ? text("listId") : undefined,
        title: text("title"), notes: text("notes"), date: date || null, time: text("time") || null, repeat,
      });
    }
    returnToSchedule();
  } catch (error) {
    const message = form.querySelector<HTMLElement>(".form-error")!;
    message.textContent = (error as Error).message;
    message.hidden = false;
  }
}

async function remove(initial: Initial) {
  const form = document.querySelector<HTMLFormElement>(".schedule-form")!;
  const scope = (new FormData(form).get("scope") as Scope | null) ?? "all";
  const what = !initial.recurring ? `"${initial.title}"` : scope === "this" ? "this event" : scope === "following" ? "this and following events" : "all events in the series";
  if (!confirm(`Delete ${what}?`)) return;
  if (initial.kind === "event") await call("deleteEvent", initial.id!, scope);
  else await call("deleteTask", initial.id!);
  returnToSchedule();
}

function back(event: Event) {
  event.preventDefault();
  returnToSchedule();
}

/** A new event's start: the next full hour today, 9:00 on other days. */
function defaultStart(date: string): [number, string] {
  if (date !== localDate()) return [9, "00"];
  return [Math.min(new Date().getHours() + 1, 23), "00"];
}

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
