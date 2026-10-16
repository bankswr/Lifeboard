// Monitor (#/monitor, in the Hub menu; the start screen): what needs attention today, in the
// user's order (2026-10-16): alerts (dismissable; red border when there are any), a Health
// card with today's targets and yesterday's totals against its targets (docs/PLAN.md phase 7a), today's tasks and events from the
// Schedule, and a card per device with its levels.
import { html } from "lit-html";
import { localDate } from "../../../core/dates.ts";
import type { ScheduleDay } from "../../../core/schedule/store.ts";
import { call } from "../../backend.ts";
import { act, route } from "../app.ts";
import { card } from "../card.ts";
import { formatTime } from "../format.ts";
import { targetsBody, yesterdayBody } from "./health.ts";
import { deviceCards, NO_DEVICES_HINT } from "./pets.ts";
import { eventRow, taskRow, timeRange } from "./schedule.ts";

route(/^\/monitor$/, async () => {
  const today = localDate();
  const [status, [schedule], health] = await Promise.all([
    call("getStatus"), call("getSchedule", today, today), call("analyzeHealth"),
  ]);
  const connectionProblems = status.connections.filter((connection) => connection.status !== "connected");
  return {
    section: "monitor",
    content: html`
      <header class="page-header">
        <h1>Monitor</h1>
        <button class="secondary" @click=${() => act(() => call("updateNow"))}>Update now</button>
      </header>
      <p class="muted">Last updated: ${formatTime(status.lastUpdateAt) ?? "never"}</p>

      ${card(
        "monitor-alerts",
        status.alerts.length > 0 ? `Alerts (${status.alerts.length})` : "Alerts",
        html`
          ${status.alerts.length === 0
            ? html`<p class="muted">No alerts.</p>`
            : status.alerts.map(
                (alert) => html`
                  <div class="alert-row">
                    <p>${alert.message}<br><span class="muted small">${formatTime(alert.createdAt)}</span></p>
                    <button class="icon" aria-label="Dismiss" title="Dismiss" @click=${() => act(() => call("dismissAlert", alert.id))}>×</button>
                  </div>
                `,
              )}
          ${connectionProblems.map(
            (connection) => html`
              <a class="status-row plain-link" href="#/connections">
                <span>${connection.name}</span>
                <span class="status error">${connection.status === "signed_out" ? "Signed out" : "Problem"}</span>
              </a>
            `,
          )}
        `,
        {
          extraClass: status.alerts.length + connectionProblems.length > 0 ? "attention" : "",
          actions: status.alerts.length > 1
            ? html`<button class="secondary small" @click=${() => act(() => call("dismissAllAlerts"))}>Dismiss all</button>`
            : "",
        },
      )}

      ${card("monitor-health", "Health", html`
        ${targetsBody(health.targets)}
        ${yesterdayBody(health.yesterday)}
        ${health.pendingCount && !health.targets
          ? html`<p class="small danger-text">${health.pendingCount} flagged item${health.pendingCount === 1 ? "" : "s"} to review.</p>`
          : ""}
      `, { actions: html`<a class="small" href="#/health">Health ›</a>` })}

      ${card("monitor-today", "Today", todayItems(schedule), { actions: html`<a class="small" href="#/schedule">Schedule ›</a>` })}

      <h2 class="section-title">Devices</h2>
      ${status.devices.length === 0 ? html`<section class="card">${NO_DEVICES_HINT}</section>` : ""}
      <div class="device-grid">${deviceCards(status.devices, status)}</div>
    `,
  };
});

/** Today's tasks (overdue ones included), all-day events, then timed events, as on the Schedule. */
function todayItems(day: ScheduleDay) {
  if (day.tasks.length + day.allDay.length + day.timed.length === 0) return html`<p class="muted">Nothing planned today.</p>`;
  return html`
    ${day.tasks.map(taskRow)}
    ${day.allDay.map((event) => eventRow(event, "All day"))}
    ${day.timed.map((event) => eventRow(event, timeRange(event)))}
  `;
}
