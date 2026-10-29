// Pets (#/pets, in the Details menu): the latest status of each Litter-Robot and feeder,
// then a Cats card: one cat at a time from a selector, its weight and visits graphs and a
// histogram of its visits by time of day, all over a chosen range (core/whisker/cats.ts).
// Monitor shows the same device cards (deviceCards).
import { html } from "lit-html";
import type { DeviceStatus } from "../../../core/devices.ts";
import { nextMeal, type FeederStatus } from "../../../core/smartlife/feeder.ts";
import type { FountainEstimate } from "../../../core/fountain.ts";
import type { FoodEstimate } from "../../../core/smartlife/food.ts";
import { drawerState, litterState, type LevelState, type LitterSettings } from "../../../core/whisker/levels.ts";
import { TIME_BIN_MINUTES, visitsByTimeOfDay, type CatSummary } from "../../../core/whisker/cats.ts";
import type { LevelEstimate, LitterEstimate } from "../../../core/whisker/estimates.ts";
import type { HopperEstimate } from "../../../core/whisker/hopper.ts";
import type { LitterRobotStatus } from "../../../core/whisker/status.ts";
import { call } from "../../backend.ts";
import { act, refresh, route } from "../app.ts";
import { card } from "../card.ts";
import { chartSlot, mountCharts, RANGES, rangePicker, type ChartSpec } from "../chart.ts";
import { formatTime } from "../format.ts";

export const NO_DEVICES_HINT = html`<p class="muted">No connected devices yet. Sign in to Whisker or Smart Life under Settings → Connections.</p>`;

// View state, kept while the app runs: the cat shown and the graphs' range.
let shownCatId: string | null = null;
let rangeDays = 14;

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
      ${cats.length > 0 ? catsCard(cats) : ""}
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

/** The cat picked in the selector, else the first (also when the picked one is gone). */
function shownCat(cats: CatSummary[]): CatSummary {
  return cats.find((cat) => cat.id === shownCatId) ?? cats[0];
}

/** One card for all cats (user, 2026-10-26): a selector, the range, then the shown cat. */
function catsCard(cats: CatSummary[]) {
  const cat = shownCat(cats);
  return card(
    "cats",
    "Cats",
    html`
      <select class="graph-select" aria-label="Cat" @change=${(event: Event) => { shownCatId = (event.target as HTMLSelectElement).value; void refresh(); }}>
        ${cats.map((each) => html`<option value=${each.id} ?selected=${each.id === cat.id}>${each.name}</option>`)}
      </select>
      ${rangePicker("cat-range", rangeDays, (days) => { rangeDays = days; void refresh(); })}
      ${catBody(cat)}
    `,
  );
}

function catBody(cat: CatSummary) {
  const change = cat.weightChange;
  return html`
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
        · <a href="#/litter">Change</a>
      </span>
    </p>
    ${chartSlot(`${cat.id}-visits`)}
    <p>Time of day <span class="muted small">visits per half hour, last ${RANGES.find(([days]) => days === rangeDays)?.[1]}</span></p>
    ${chartSlot(`${cat.id}-times`)}
    ${cat.latestAt ? html`<p class="muted small">Last weighed ${shortDateTime(cat.latestAt)}: ${cat.latestWeight!.toFixed(2)} lb</p>` : ""}
  `;
}

function catCharts(cats: CatSummary[]): Record<string, ChartSpec> {
  const specs: Record<string, ChartSpec> = {};
  // Every cat's specs; only the shown cat has slots on the page, so only its charts are drawn.
  cats.forEach((cat, index) => {
    // Colors are never reused: a ninth cat onward is drawn in the muted gray.
    const color = CAT_COLORS[index] ?? "#94a3b8";
    const dates = cat.days.map((day) => day.date);
    specs[`${cat.id}-weight`] = {
      dates, decimals: 2, yRange: "span", visibleDays: rangeDays,
      series: [{ label: "Weight, lb (day's median)", values: cat.days.map((day) => day.weight), color, kind: "line" }],
    };
    specs[`${cat.id}-visits`] = {
      dates, decimals: 0, yRange: "zero", counts: true, visibleDays: rangeDays,
      series: [{ label: "Visits", values: cat.days.map((day) => day.visits), color, kind: "bars" }],
    };
    const binHours = TIME_BIN_MINUTES / 60;
    const counts = visitsByTimeOfDay(cat.days, rangeDays);
    specs[`${cat.id}-times`] = {
      dates: [], decimals: 0, yRange: "zero", counts: true,
      timeOfDay: { hours: counts.map((_, bin) => (bin + 0.5) * binHours), binHours },
      series: [{ label: "Visits", values: counts, color, kind: "bars" }],
    };
  });
  return specs;
}

interface DeviceContext {
  litterSettings: LitterSettings;
  litterEstimates: Record<string, LitterEstimate>;
  hopperEstimates: Record<string, HopperEstimate>;
  foodEstimates: Record<string, FoodEstimate>;
  fountain: FountainEstimate;
}

/** The Litter-Robot cards (each its own), one card for all feeders, then the water fountain. */
export function deviceCards(devices: DeviceStatus[], status: DeviceContext) {
  const feeders = devices.filter((device) => device.kind === "feeder");
  return html`
    ${devices.filter((device) => device.kind === "litter_robot").map((device) => {
      const serial = (device.data as LitterRobotStatus).serial;
      return litterRobotCard(device, status.litterSettings, status.litterEstimates[serial], status.hopperEstimates[serial]);
    })}
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

function litterRobotCard(device: DeviceStatus, settings: LitterSettings, estimate: LitterEstimate | undefined, hopper: HopperEstimate | undefined) {
  const robot = device.data as LitterRobotStatus;
  return card(
    device.id,
    robot.name,
    html`
      ${levelBar("Waste Drawer", robot.drawerLevel, drawerState(robot, settings))}
      ${levelBar("Litter level", robot.litterLevel, litterState(robot, settings))}
      ${estimate ? html`<p class="small">
        ${levelEstimateText("Drawer", `${settings.drawerAlarm}%`, estimate.drawer)}<br>
        ${levelEstimateText("Litter", `${settings.litterAlarm}%`, estimate.litter)}
      </p>` : ""}
      ${hopperRows(robot, hopper)}
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

/** The LitterHopper: estimated from the activity log's dispenses and the user's refills (core/whisker/hopper.ts). */
function hopperRows(robot: LitterRobotStatus, estimate: HopperEstimate | undefined) {
  return html`
    ${estimate?.percentLeft != null
      ? levelBar("Litter hopper", estimate.percentLeft, estimate.state, `≈${estimate.percentLeft}%`)
      : html`<div class="level"><span>Litter hopper</span><span class="muted small level-none">Learning</span></div>`}
    <div class="feeder-meta small">
      <span>
        ${estimate?.daysLeft != null
          ? html`<span class=${estimate.state === "ok" ? "" : `status ${estimate.state}`}>≈${estimate.daysLeft.toFixed(1)} days left</span> · `
          : ""}
        ${estimate?.lastRefill
          ? html`<span class="muted">${dispenses(estimate.usedSinceRefill)} since refill ${shortDateTime(estimate.lastRefill)}</span>`
          : html`<span class="muted">No refill recorded yet</span>`}
      </span>
      <button class="secondary small" @click=${() => refillHopper(robot)}>Refill</button>
    </div>
    <p class="muted small">
      ${estimate?.capacity == null
        ? "Hopper estimate: learning. Press Refill each time you fill the hopper; the estimate starts after the second refill."
        : `A full hopper ≈ ${Math.round(estimate.capacity)} dispenses (median of your refills).`}
    </p>
  `;
}

async function refillHopper(robot: LitterRobotStatus) {
  if (!confirm(`Record a refill of ${robot.name}'s litter hopper (full) now?`)) return;
  await act(() => call("markLitterHopperRefilled", robot.serial));
}

function dispenses(n: number): string {
  return `${n} dispense${n === 1 ? "" : "s"}`;
}

async function refill(feeder: FeederStatus) {
  if (!confirm(`Record a refill of ${feeder.name} (full) now?`)) return;
  await act(() => call("markFeederRefilled", feeder.id));
}

async function refillAll() {
  if (!confirm("Record a refill of every feeder (full) now?")) return;
  await act(() => call("markAllFeedersRefilled"));
}

/** "Drawer reaches 90% ≈ Tue 3:00 PM", or why there's no estimate yet. */
function levelEstimateText(label: string, alarm: string, estimate: LevelEstimate) {
  if (estimate.reached) return html`<span class="status alarm">${label} at ${alarm} or worse</span>`;
  if (!estimate.at) return html`<span class="muted">${label}: estimate learning</span>`;
  const at = new Date(estimate.at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return html`${label} reaches ${alarm} ≈ <strong>${at}</strong>`;
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
