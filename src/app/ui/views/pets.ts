// Pets (#/pets, in the Details menu): the latest status of each Litter-Robot and feeder. The
// Monitor screen shows the same devices as one line each (deviceSummary).
import { html } from "lit-html";
import type { DeviceStatus } from "../../../core/devices.ts";
import { nextMeal, type FeederStatus } from "../../../core/smartlife/feeder.ts";
import type { LitterRobotStatus } from "../../../core/whisker/status.ts";
import { call } from "../../backend.ts";
import { route } from "../app.ts";
import { formatTime } from "../format.ts";

export const NO_DEVICES_HINT = html`<p class="muted">No devices yet. Sign in to Whisker or Smart Life under Settings → Connections.</p>`;

route(/^\/pets$/, async () => {
  const { devices } = await call("getStatus");
  return {
    section: "pets",
    content: html`
      <header class="page-header">
        <h1>Pets</h1>
      </header>
      ${devices.length === 0 ? NO_DEVICES_HINT : devices.map((device) => html`<section class="card">${deviceCard(device)}</section>`)}
    `,
  };
});

/** One line for the Monitor screen: the device's name and whether it needs attention. */
export function deviceSummary(device: DeviceStatus) {
  const { label, ok } = deviceState(device);
  return html`
    <a class="status-row plain-link" href="#/pets">
      <span>${device.name}${device.kind === "feeder" ? " feeder" : ""}</span>
      <span class="status ${ok ? "connected" : "error"}">${label}</span>
    </a>
  `;
}

function deviceState(device: DeviceStatus): { label: string; ok: boolean } {
  if (device.kind === "feeder") {
    const feeder = device.data as FeederStatus;
    if (!feeder.online) return { label: "Offline", ok: false };
    if (feeder.lastFeedPortions === 0) return { label: "Last feed empty", ok: false };
    return { label: "OK", ok: true };
  }
  const robot = device.data as LitterRobotStatus;
  return { label: robot.status, ok: robot.status === "Ready" };
}

function deviceCard(device: DeviceStatus) {
  if (device.kind === "feeder") return feederCard(device);
  if (device.kind === "litter_robot") return litterRobotCard(device);
  return "";
}

function litterRobotCard(device: DeviceStatus) {
  const robot = device.data as LitterRobotStatus;
  const warn = (bad: boolean) => (bad ? "status error" : "");
  return html`
    <div class="status-row">
      <h2>${robot.name}</h2>
      <span class="status ${robot.status === "Ready" ? "connected" : "error"}">${robot.status}</span>
    </div>
    <p class="small">
      <span class=${warn(robot.drawerFull || robot.drawerLevel >= 80)}>Drawer ${robot.drawerLevel}%</span> ·
      <span class=${warn(robot.litterLevel < 20)}>Litter ${robot.litterLevel}%</span>
      ${robot.laserDirty ? html` · <span class="status error">Sensors need cleaning</span>` : ""}
    </p>
    <p class="muted small">Checked ${formatTime(device.updatedAt)}</p>
  `;
}

function feederCard(device: DeviceStatus) {
  const feeder = device.data as FeederStatus;
  const next = nextMeal(feeder.meals);
  const portions = (n: number) => `${n} portion${n === 1 ? "" : "s"}`;
  return html`
    <div class="status-row">
      <h2>${feeder.name} feeder</h2>
      <span class="status ${feeder.online ? "connected" : "error"}">${feeder.online ? "Online" : "Offline"}</span>
    </div>
    <p class="small">
      <span class=${feeder.lastFeedPortions === 0 ? "status error" : ""}>Last feed: ${portions(feeder.lastFeedPortions)}</span> ·
      ${next
        ? `Next: ${next.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, ${portions(next.portions)}`
        : "No meals scheduled"}
    </p>
    <p class="muted small">Checked ${formatTime(device.updatedAt)}</p>
  `;
}
