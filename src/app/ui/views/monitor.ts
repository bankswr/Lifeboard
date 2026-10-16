// Monitor (#/monitor, in the Hub menu; the start screen): what needs attention now: recent alerts, one line per
// device, and connections that are signed out or failing. Full device data is under Details → Pets.
import { html } from "lit-html";
import { call } from "../../backend.ts";
import { act, route } from "../app.ts";
import { formatTime } from "../format.ts";
import { deviceSummary, NO_DEVICES_HINT } from "./pets.ts";

route(/^\/monitor$/, async () => {
  const status = await call("getStatus");
  const connectionProblems = status.connections.filter((connection) => connection.status !== "connected");
  return {
    section: "monitor",
    content: html`
      <header class="page-header">
        <h1>Monitor</h1>
        <button class="secondary" @click=${() => act(() => call("updateNow"))}>Update now</button>
      </header>
      <p class="muted">Last updated: ${formatTime(status.lastUpdateAt) ?? "never"}</p>

      <section class="card">
        <h2>Recent alerts</h2>
        ${status.alerts.length === 0
          ? html`<p class="muted">No alerts.</p>`
          : status.alerts.map(
              (alert) => html`<p>${alert.message}<br><span class="muted small">${formatTime(alert.createdAt)}</span></p>`,
            )}
      </section>

      <section class="card">
        <h2>Devices</h2>
        ${status.devices.length === 0 ? NO_DEVICES_HINT : status.devices.map(deviceSummary)}
        ${connectionProblems.map(
          (connection) => html`
            <a class="status-row plain-link" href="#/connections">
              <span>${connection.name}</span>
              <span class="status error">${connection.status === "signed_out" ? "Signed out" : "Problem"}</span>
            </a>
          `,
        )}
      </section>
    `,
  };
});
