// Schedule (#/schedule, in the Details menu): Google Calendar events and Google Tasks, one
// section per day, in a list that scrolls back and forth without end (more days load near
// either edge). Opens at today; a "Today" button appears when today is off screen. Tasks
// can be ticked here; tapping an item opens its edit page (scheduleForm.ts), and each day's
// + adds one on that day.
import { html } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { addDays, localDate } from "../../../core/dates.ts";
import type { EventItem, ScheduleDay, TaskItem } from "../../../core/schedule/store.ts";
import { call } from "../../backend.ts";
import { act, isNewVisit, refresh, route } from "../app.ts";

/** Days shown when the Schedule opens, around today, and how many more load at an edge. */
const DAYS_BEFORE = 7;
const DAYS_AFTER = 28;
const LOAD_MORE_DAYS = 21;
/** Distance from an edge (px) at which more days load. */
const EDGE_PX = 400;

let range = { from: "", to: "" };
/** Where to scroll after the next render: today, a saved position, or nowhere. */
let scrollTarget: "today" | number | null = null;
let savedScroll = 0;
let loadingMore = false;
/** Set by the edit page when it returns here, so the Schedule comes back where it was. */
let returning = false;
/** A problem reading Google (e.g. a sign-in that needs renewing), shown at the top. */
let googleProblem: string | null = null;

export function returnToSchedule() {
  returning = true;
  location.hash = "#/schedule";
}

route(/^\/schedule$/, async () => {
  const today = localDate();
  if (isNewVisit()) {
    if (returning) {
      scrollTarget = savedScroll;
    } else {
      range = { from: addDays(today, -DAYS_BEFORE), to: addDays(today, DAYS_AFTER) };
      scrollTarget = "today";
      void readGoogle();
    }
    returning = false;
  }
  const days = await call("getSchedule", range.from, range.to);
  return {
    section: "schedule",
    content: html`
      <h1>Schedule</h1>
      ${googleProblem ? html`<p class="card status error small">${googleProblem}</p>` : ""}
      ${days.map((day) => dayView(day, today))}
      <button class="today-button" hidden @click=${scrollToToday}>Today</button>
    `,
    mount: (signal: AbortSignal) => mountSchedule(today, signal),
  };
});

/** Fetches Google's latest in the background (desktop), then shows it if still here. */
async function readGoogle() {
  googleProblem = await call("refreshSchedule");
  if (location.hash === "#/schedule") await refresh();
}

function mountSchedule(today: string, signal: AbortSignal) {
  if (scrollTarget === "today") scrollToToday(false);
  else if (typeof scrollTarget === "number") window.scrollTo(0, scrollTarget);
  scrollTarget = null;

  window.addEventListener("scroll", () => {
    savedScroll = window.scrollY;
    void loadMoreNearEdges();
  }, { signal, passive: true });

  // The Today button shows while today's section is out of view.
  const todaySection = document.getElementById(`day-${today}`);
  const button = document.querySelector<HTMLButtonElement>(".today-button");
  if (todaySection && button) {
    const observer = new IntersectionObserver(([entry]) => {
      button.hidden = entry.isIntersecting;
    });
    observer.observe(todaySection);
    signal.addEventListener("abort", () => observer.disconnect());
  }
}

function scrollToToday(smooth = true) {
  document.getElementById(`day-${localDate()}`)?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
}

/** Adds days at whichever end is near; keeps the view still when days are added above it. */
async function loadMoreNearEdges() {
  if (loadingMore) return;
  const page = document.documentElement;
  const nearTop = window.scrollY < EDGE_PX;
  const nearBottom = window.scrollY + window.innerHeight > page.scrollHeight - EDGE_PX;
  if (!nearTop && !nearBottom) return;
  loadingMore = true;
  try {
    const heightBefore = page.scrollHeight;
    if (nearTop) range.from = addDays(range.from, -LOAD_MORE_DAYS);
    else range.to = addDays(range.to, LOAD_MORE_DAYS);
    await refresh();
    if (nearTop) window.scrollBy(0, page.scrollHeight - heightBefore);
  } finally {
    loadingMore = false;
  }
}

// ---------- one day ----------

function dayView(day: ScheduleDay, today: string) {
  const isToday = day.date === today;
  const empty = day.tasks.length + day.allDay.length + day.timed.length === 0;
  return html`
    <section class="day ${isToday ? "today" : ""}" id="day-${day.date}">
      <header class="day-header">
        <h2>${dayLabel(day.date, today)}</h2>
        <a class="day-add" href="#/schedule/new/${day.date}" aria-label="Add on ${dayLabel(day.date, today)}">+</a>
      </header>
      ${day.tasks.map(taskRow)}
      ${day.allDay.map((event) => eventRow(event, "All day"))}
      ${day.timed.map((event) => eventRow(event, timeRange(event)))}
      ${empty ? html`<p class="muted small day-empty">Nothing planned</p>` : ""}
    </section>
  `;
}

export function taskRow(task: TaskItem & { overdue: boolean }) {
  return html`
    <div class="schedule-item task ${task.done ? "done" : ""} ${task.overdue ? "overdue" : ""}">
      <input type="checkbox" aria-label="Done" .checked=${live(task.done)}
        @change=${(event: Event) => act(() => call("setTaskDone", task.id, (event.target as HTMLInputElement).checked))}>
      <a class="item-main" href="#/schedule/task/${encodeURIComponent(task.id)}">
        <span class="item-title">${task.title}${task.repeat ? html` <span class="muted" title="Repeats">↻</span>` : ""}</span>
        <span class="item-detail small">
          ${task.overdue ? html`<span class="status error">Overdue · was due ${shortDate(task.due!)}</span>` : ""}
          ${task.time ? formatClock(task.time) : ""}
          ${task.pending ? html`<span class="muted">Not in Google yet</span>` : ""}
        </span>
      </a>
    </div>
  `;
}

export function eventRow(event: EventItem, when: string) {
  return html`
    <a class="schedule-item event ${event.allDay ? "all-day" : ""}" href="#/schedule/event/${encodeURIComponent(event.id)}">
      <span class="item-when small">${when}</span>
      <span class="item-main">
        <span class="item-title">${event.title}${event.recurring ? html` <span class="muted" title="Repeats">↻</span>` : ""}</span>
        <span class="item-detail small muted">
          ${event.location}${event.pending ? (event.location ? " · " : "") + "Not in Google yet" : ""}
        </span>
      </span>
    </a>
  `;
}

// ---------- formatting ----------

function dayLabel(date: string, today: string): string {
  const text = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    year: date.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
  });
  if (date === today) return `Today · ${text}`;
  if (date === addDays(today, 1)) return `Tomorrow · ${text}`;
  if (date === addDays(today, -1)) return `Yesterday · ${text}`;
  return text;
}

function shortDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "14:30" → "2:30 PM" in the device's style. */
export function formatClock(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function timeRange(event: EventItem): string {
  const format = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${format(event.start)} – ${format(event.end)}`;
}
