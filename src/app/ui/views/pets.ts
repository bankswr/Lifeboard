// Pets (#/pets, in the Details menu): the latest status of each Litter-Robot and feeder,
// then a card per cat with its weight and visits (core/whisker/cats.ts).
// Monitor shows the same device cards (deviceCards).
import { html } from "lit-html";
import type { DeviceStatus } from "../../../core/devices.ts";
import { nextMeal, type FeederStatus } from "../../../core/smartlife/feeder.ts";
import type { FountainEstimate } from "../../../core/fountain.ts";
import type { FoodEstimate } from "../../../core/smartlife/food.ts";
import { drawerState, litterState, type LevelState, type LitterSettings } from "../../../core/whisker/levels.ts";
import type { CatSummary } from "../../../core/whisker/cats.ts";
import type { LitterRobotStatus } from "../../../core/whisker/status.ts";
import { call } from "../../backend.ts";
import { act, route } from "../app.ts";
import { card } from "../card.ts";
import { chartSlot, mountCharts, type ChartSpec } from "../chart.ts";
import { formatTime } from "../format.ts";

export const NO_DEVICES_HINT = html`<p class="muted">No connected devices yet. Sign in to Whisker or Smart Life under Settings → Connections.</p>`;

route(/^\/pets$/, async () => {
  const [status, cats] = await Promise.all([call("getStatus"), call("getCats")]);
  return {
    section: "pets",
    content: html`
      <header class="page-header">
        <h1>Pets</h1>
      </header>
      ${status.devices.length === 0 ? NO_DEVICES_HINT : ""}
      ${deviceCards(status.devices, status)}
      ${cats.length > 0 ? html`<h2 class="section-title">Cats</h2>` : ""}
      ${cats.map((cat) => catCard(cat))}
    `,
    mount: (signal) => mountCharts(catCharts(cats), signal),
  };
});

/**
 * Each cat keeps one color on every chart, assigned by its place in name order (dark-surface
 * steps of the reference categorical palette; the first three checked for color-blind
 * separation on --surface).
 */
const CAT_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

function catCard(cat: CatSummary) {
  const change = cat.weightChange;
  return card(
    `cat-${cat.id}`,
    cat.name,
    html`
      <p>
        ${cat.recentWeight !== null ? html`<strong>${cat.recentWeight.toFixed(1)} lb</strong> <span class="muted small">7-day median</span>` : "No weigh-ins this week"}
        ${change !== null
          ? html` · <span>${change > 0 ? "+" : ""}${change.toFixed(1)}%</span> <span class="muted small">vs ${cat.weightCompareDays} days earlier</span>`
          : html`<br><span class="muted small">Weight change shows once there are ${cat.weightCompareDays + 7} days of weigh-ins.</span>`}
      </p>
      ${chartSlot(`${cat.id}-weight`)}
      <p>
        <span class=${cat.visitLimit !== null && cat.todayVisits > cat.visitLimit ? "status error" : ""}>${cat.todayVisits} visit${cat.todayVisits === 1 ? "" : "s"} today</span>
        <span class="muted small">
          ${cat.visitLimit !== null ? `· alert above ${cat.visitLimit}${cat.visitLimitIsAuto ? " (automatic)" : ""}` : "· alert limit: learning"}
        </span>
      </p>
      ${chartSlot(`${cat.id}-visits`)}
      ${cat.latestAt ? html`<p class="muted small">Last weighed ${shortDateTime(cat.latestAt)}: ${cat.latestWeight!.toFixed(2)} lb</p>` : ""}
    `,
  );
}

function catCharts(cats: CatSummary[]): Record<string, ChartSpec> {
  const specs: Record<string, ChartSpec> = {};
  cats.forEach((cat, index) => {
    // Colors are never reused: a ninth cat onward is drawn in the muted gray.
    const color = CAT_COLORS[index] ?? "#94a3b8";
    const dates = cat.days.map((day) => day.date);
    specs[`${cat.id}-weight`] = { dates, values: cat.days.map((day) => day.weight), label: "Weight, lb (day's median)", color, kind: "line", decimals: 2 };
    specs[`${cat.id}-visits`] = { dates, values: cat.days.map((day) => day.visits), label: "Visits", color, kind: "bars", decimals: 0 };
  });
  return specs;
}

interface DeviceContext {
  litterSettings: LitterSettings;
  foodEstimates: Record<string, FoodEstimate>;
  fountain: FountainEstimate;
}

/** The Litter-Robot cards (each its own), one card for all feeders, then the water fountain. */
export function deviceCards(devices: DeviceStatus[], status: DeviceContext) {
  const feeders = devices.filter((device) => device.kind === "feeder");
  return html`
    ${devices.filter((device) => device.kind === "litter_robot").map((device) => litterRobotCard(device, status.litterSettings))}
    ${feeders.length > 0 ? feedersCard(feeders, status.foodEstimates) : ""}
    ${fountainCard(status.fountain)}
  `;
}

/** The water fountain has no connection: everything shown is estimated from the user's refills. */
function fountainCard(estimate: FountainEstimate) {
  return card(
    "fountain",
    "Water fountain",
    html`
      ${estimate.percentLeft !== null
        ? levelBar("Water", estimate.percentLeft, estimate.state, `≈${estimate.percentLeft}%`)
        : html`<div class="level"><span>Water</span><span class="muted small level-none">Learning</span></div>`}
      <p class="small">
        ${estimate.daysLeft !== null
          ? html`<span class=${estimate.state === "ok" ? "" : `status ${estimate.state}`}>≈${estimate.daysLeft.toFixed(1)} days left</span> · `
          : ""}
        ${estimate.lastRefill ? html`<span class="muted">Last refill ${shortDateTime(estimate.lastRefill)}</span>` : html`<span class="muted">No refill recorded yet</span>`}
      </p>
      <p class="muted small">
        No connection: estimated from your refills.
        ${estimate.fillDays === null
          ? "Press Refill each time you fill it; the estimate starts after the second refill."
          : `A fill lasts ≈ ${estimate.fillDays.toFixed(1)} days (median of your refills).`}
      </p>
    `,
    { actions: html`<button class="secondary small" @click=${refillFountain}>Refill</button>` },
  );
}

async function refillFountain() {
  if (!confirm("Record a refill of the water fountain (full) now?")) return;
  await act(() => call("refillFountain"));
}

function litterRobotCard(device: DeviceStatus, settings: LitterSettings) {
  const robot = device.data as LitterRobotStatus;
  return card(
    device.id,
    robot.name,
    html`
      ${levelBar("Waste Drawer", robot.drawerLevel, drawerState(robot, settings))}
      ${levelBar("Litter Hopper", robot.litterLevel, litterState(robot, settings))}
      ${robot.laserDirty ? html`<p class="small status error">Sensors need cleaning</p>` : ""}
      <p class="muted small">Checked ${formatTime(device.updatedAt)}</p>
    `,
    { actions: html`<span class="status ${robot.status === "Ready" ? "connected" : "error"}">${robot.status}</span>` },
  );
}

/**
 * One card for all the feeders (same model and food, user 2026-10-16): per feeder its
 * online state, estimated food and days left, last feed and a Refill button; below, the
 * learned hopper size and the next meal.
 */
function feedersCard(devices: DeviceStatus[], estimates: Record<string, FoodEstimate>) {
  const feeders = devices.map((device) => device.data as FeederStatus);
  const capacity = estimates[feeders[0].id]?.capacityPortions ?? null;
  const next = nextMeal(feeders[0].meals);
  const sameSchedule = feeders.every((f) => JSON.stringify(f.meals) === JSON.stringify(feeders[0].meals));
  const checked = devices.map((d) => d.updatedAt).sort()[0];
  return card(
    "feeders",
    "Feeders",
    html`
      ${feeders.map((feeder) => feederRow(feeder, estimates[feeder.id]))}
      <p class="muted small">
        ${capacity === null
          ? "Food estimate: learning. Press Refill each time you fill a feeder; the estimate starts after the second refill."
          : `A full hopper ≈ ${Math.round(capacity)} portions (median of your refills).`}
        ${sameSchedule && next ? html`<br>Next meal ${next.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, ${portions(next.portions)} each.` : ""}
      </p>
      <p class="muted small">Checked ${formatTime(checked)}</p>
    `,
    { actions: html`<button class="secondary small" @click=${refillAll}>Refill all</button>` },
  );
}

function feederRow(feeder: FeederStatus, estimate: FoodEstimate | undefined) {
  return html`
    <div class="feeder-row">
      <div class="status-row">
        <strong>${feeder.name}</strong>
        <span class="status ${feeder.online ? "connected" : "error"}">${feeder.online ? "Online" : "Offline"}</span>
      </div>
      ${estimate?.percentLeft != null
        ? levelBar("Food", estimate.percentLeft, estimate.state, `≈${estimate.percentLeft}%`)
        : html`<div class="level"><span>Food</span><span class="muted small level-none">Learning</span></div>`}
      <div class="feeder-meta small">
        <span>
          ${estimate?.daysLeft != null ? html`<span class=${estimate.state === "ok" ? "" : `status ${estimate.state}`}>≈${estimate.daysLeft.toFixed(1)} days left</span> · ` : ""}
          <span class=${feeder.lastFeedPortions === 0 ? "status error" : ""}>Last feed ${portions(feeder.lastFeedPortions)}</span>
          ${estimate?.lastRefill ? html` · <span class="muted">Last refill ${shortDateTime(estimate.lastRefill)}</span>` : ""}
        </span>
        <button class="secondary small" @click=${() => refill(feeder)}>Refill</button>
      </div>
    </div>
  `;
}

async function refill(feeder: FeederStatus) {
  if (!confirm(`Record a refill of ${feeder.name} (full) now?`)) return;
  await act(() => call("markFeederRefilled", feeder.id));
}

async function refillAll() {
  if (!confirm("Record a refill of every feeder (full) now?")) return;
  await act(() => call("markAllFeedersRefilled"));
}

function portions(n: number): string {
  return `${n} portion${n === 1 ? "" : "s"}`;
}

function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A labelled 0–100% bar: yellow at warning, red at alarm (thresholds in Settings). */
function levelBar(label: string, percent: number, state: LevelState, valueText = `${Math.round(percent)}%`) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return html`
    <div class="level">
      <span>${label}</span>
      <div class="level-bar ${state}" role="meter" aria-label=${label}
        aria-valuemin="0" aria-valuemax="100" aria-valuenow=${clamped}><span style="width: ${clamped}%"></span></div>
      <span class="level-value small">${valueText}</span>
    </div>
  `;
}
