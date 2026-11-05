// Calendars and tasks (#/calendars, under Settings): which Google calendars the Schedule shows
// (the main calendar always is; others can be added; user, 2026-10-16), and whether new tasks
// are added to Google Tasks (user, 2026-11-05).
import { html } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { call } from "../../backend.ts";
import { act, route } from "../app.ts";

route(/^\/calendars$/, async () => {
  const [calendars, tasksToGoogle] = await Promise.all([call("listCalendars"), call("getTasksToGoogle")]);
  return {
    section: "settings",
    content: html`
      <header class="page-header">
        <a class="back" href="#/settings" aria-label="Back to settings">←</a>
        <h1>Calendars and tasks</h1>
      </header>
      <p class="muted">Calendars shown on the Schedule. New events go to your main calendar unless you choose another.</p>
      <section class="card">
        ${calendars.length === 0
          ? html`<p class="muted">No calendars yet. Sign in to Google under Settings → Connections (on the phone: sync with the desktop).</p>`
          : calendars.map(
              (calendar) => html`
                <label class="check calendar-row">
                  <input type="checkbox" .checked=${live(calendar.included)} ?disabled=${calendar.primary}
                    @change=${(event: Event) => act(() => call("setCalendarIncluded", calendar.id, (event.target as HTMLInputElement).checked))}>
                  ${calendar.name}${calendar.primary ? html` <span class="muted small">(main)</span>` : ""}
                </label>
              `,
            )}
      </section>
      <section class="card">
        <label class="check">
          <input type="checkbox" .checked=${live(tasksToGoogle)}
            @change=${(event: Event) => act(() => call("setTasksToGoogle", (event.target as HTMLInputElement).checked))}>
          Add new tasks to Google Tasks
        </label>
        <p class="muted small">When off, new tasks stay in Lifeboard, automatic ones and the next time a repeating task comes up included. Tasks already in Google stay there and keep syncing. Lifeboard's phone reminders cover tasks with a date, at 8 AM if they have no time.</p>
      </section>
    `,
  };
});
