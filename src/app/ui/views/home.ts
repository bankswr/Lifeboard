// Home: when data was last updated, how each connection is doing, and recent alerts.
// Module dashboards (pets, health, ...) will be added here as they're built.
import { html } from "lit-html";
import type { ConnectionInfo } from "../../../core/updates.ts";
import { call } from "../../backend.ts";
import { act, route } from "../app.ts";

const STATUS_TEXT: Record<ConnectionInfo["status"], string> = {
  connected: "Connected",
  signed_out: "Signed out: sign in again",
  error: "Problem",
};

route(/^\/$/, async () => {
  const status = await call("getStatus");
  return {
    section: "home",
    content: html`
      <header class="page-header">
        <h1>Lifeboard</h1>
        <button class="secondary" @click=${() => act(() => call("updateNow"))}>Update now</button>
      </header>
      <p class="muted">Last updated: ${formatTime(status.lastUpdateAt) ?? "never"}</p>

      <section class="card">
        <h2>Connections</h2>
        ${status.connections.length === 0
          ? html`<p class="muted">None set up yet.</p>`
          : status.connections.map(
              (connection) => html`
                <div class="status-row">
                  <span>${connection.name}</span>
                  <span class="status ${connection.status}">${STATUS_TEXT[connection.status]}</span>
                </div>
                ${connection.message ? html`<p class="muted small">${connection.message}</p>` : ""}
              `,
            )}
      </section>

      <section class="card">
        <h2>Recent alerts</h2>
        ${status.alerts.length === 0
          ? html`<p class="muted">No alerts.</p>`
          : status.alerts.map(
              (alert) => html`<p>${alert.message}<br><span class="muted small">${formatTime(alert.createdAt)}</span></p>`,
            )}
      </section>
    `,
  };
});

function formatTime(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleString() : null;
}
