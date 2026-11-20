// Monitor (#/monitor, in the Hub menu; the start screen): what needs attention today, in the
// user's order (2026-10-16): alerts (dismissable; red border when there are any), a Health
// card with today's targets and yesterday's totals against its targets (docs/PLAN.md phase 7a), today's tasks and events from the
// Schedule, and a card per device with its levels.
// On the phone the header button is "Sync now" (user, 2026-11-20): the desktop reads every
// connection hourly, so at home the phone only needs its data. If the desktop can't be
// reached (away from home), the button runs the phone's own update instead.
import { html } from "lit-html";
import { localDate } from "../../../core/dates.ts";
import type { ScheduleDay } from "../../../core/schedule/store.ts";
import { SyncKeyRejected } from "../../../core/sync/pairing.ts";
import { call, platform } from "../../backend.ts";
import { syncNow } from "../../sync.ts";
import { act, route, showBusy } from "../app.ts";
import { card } from "../card.ts";
import { formatTime } from "../format.ts";
import { targetsBody, yesterdayBody } from "./health.ts";
import { deviceCards, NO_DEVICES_HINT } from "./pets.ts";
import { eventRow, taskRow, timeRange } from "./schedule.ts";

/** True while an update or sync started here runs, so a re-render meanwhile keeps the button disabled. */
let updating = false;
/** Phone: what the last "Sync now" press did, shown under the button. */
let syncMessage = "";

const BUTTON = platform === "android" ? { idle: "Sync now", busy: "Syncing…" } : { idle: "Update now", busy: "Updating…" };

/** An update or sync takes a while, so the button and banner show it's running. */
async function updateNow() {
  if (updating) return;
  updating = true;
  const button = document.querySelector<HTMLButtonElement>(".page-header button");
  if (button) {
    button.disabled = true;
    button.textContent = BUTTON.busy;
  }
  // Cleared before act's refresh, so the redrawn page shows the button ready again.
  await act(() => (platform === "android" ? syncOrUpdate() : updateHere()).finally(() => {
    updating = false;
    showBusy(null);
  }));
}

async function updateHere() {
  showBusy("Updating devices and health…");
  await call("updateNow");
}

/**
 * Phone: syncs with the desktop; if that fails (not set up, or out of reach), updates on the
 * phone instead. A rejected sync key is reported, not worked around, since it needs fixing.
 */
async function syncOrUpdate() {
  showBusy("Syncing with the desktop…");
  try {
    const summary = await syncNow();
    syncMessage = `Synced: sent ${summary.sent}, received ${summary.received}.`;
  } catch (error) {
    if (error instanceof SyncKeyRejected) {
      syncMessage = `${error.message} Check it under Settings → Desktop sync.`;
      return;
    }
    await updateHere();
    syncMessage = `Updated on this phone: ${(error as Error).message}`;
  }
}

route(/^\/monitor$/, async () => {
  const today = localDate();
  const [status, [schedule], health, sync] = await Promise.all([
    call("getStatus"), call("getSchedule", today, today), call("analyzeHealth"),
    platform === "android" ? call("getSyncSettings") : null,
  ]);
  const connectionProblems = status.connections.filter((connection) => connection.status !== "connected");
  return {
    section: "monitor",
    content: html`
      <header class="page-header">
        <h1>Monitor</h1>
        <button class="secondary" ?disabled=${updating} @click=${updateNow}>${updating ? BUTTON.busy : BUTTON.idle}</button>
      </header>
      <p class="muted">
        ${sync ? `Last synced: ${formatTime(sync.lastSyncedAt) ?? "never"} · Last updated on this phone` : "Last updated"}:
        ${formatTime(status.lastUpdateAt) ?? "never"}
      </p>
      ${syncMessage ? html`<p class="muted small">${syncMessage}</p>` : ""}

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
