// Health (#/health, in the Details menu; docs/PLAN.md phase 7a, Health page work 2026-10-17):
// - the review card at the top while anything awaits review, at the bottom once all of it is
//   addressed;
// - today's targets and the body composition and metabolism behind them, each with a fold-out
//   "How this is worked out" using the actual numbers;
// - graphs (weight, body fat, intake vs both burn estimates, one per macro, resting heart
//   rate) sharing one range and a cursor that moves across them together;
// - workouts found in the heart rate;
// - the data table, tabbed: totals (met targets in green) and deltas (eaten − target).
// #/health/history lists the saved targets.
import { html } from "lit-html";
import { stepEnergy, type Targets } from "../../../core/energy.ts";
import type { HealthPage, HealthPageDay, PageWorkout } from "../../../core/healthPage.ts";
import type { DayComparison, HealthSettings } from "../../../core/healthTargets.ts";
import type { Flag } from "../../../core/healthReview.ts";
import { call } from "../../backend.ts";
import { act, isNewVisit, refresh, route } from "../app.ts";
import { card } from "../card.ts";
import { chartSlot, mountCharts, type ChartSpec } from "../chart.ts";

// ---------- view state (kept while on the page) ----------

const RANGES = [[14, "2 weeks"], [28, "4 weeks"], [90, "90 days"]] as const;
type MacroView = "amounts" | "deltas";
type TableTab = "totals" | "deltas";

let rangeDays = 14;
let macroView: MacroView = "amounts";
let tableTab: TableTab = "totals";
/** Days shown in the data table: a week, then two more weeks per "Show more". */
let tableDays = 7;
/** The page's data, reused when only the view changes (a tab or the range). */
let cached: HealthPage | null = null;

/** Re-renders with the data already loaded. */
function rerender() {
  void refresh();
}

/** Runs a change to the data (a verdict), then loads the page again. */
function change(work: () => Promise<unknown>) {
  cached = null;
  return act(work);
}

route(/^\/health$/, async () => {
  if (!cached || isNewVisit()) cached = await call("getHealthPage");
  const page = cached;
  const { analysis } = page;
  const reviewCard = card("health-review", analysis.pendingCount ? `Needs review (${analysis.pendingCount})` : "Review", reviewBody(analysis.flags), {
    extraClass: analysis.pendingCount ? "attention" : "",
  });
  const days = page.days.filter((day) => day.date < todayOf(page)); // today has no totals yet
  return {
    section: "health",
    wide: true,
    content: html`
      <header class="page-header">
        <h1>Health</h1>
        <a class="small" href="#/health-settings">Settings ›</a>
      </header>
      ${analysis.pendingCount ? reviewCard : ""}
      ${card("health-targets", "Today's targets", html`
        ${targetsBody(analysis.targets)}
        ${analysis.targets ? targetsExplained(analysis.targets, analysis.settings) : ""}
      `, { actions: html`<a class="small" href="#/health/history">History ›</a>` })}
      ${analysis.targets ? card("health-body", "Body composition", bodyBody(analysis.targets)) : ""}
      ${analysis.targets ? card("health-metabolism", "Metabolism", metabolismBody(analysis.targets, page, analysis.settings)) : ""}
      ${card("health-graphs", "Graphs", html`${rangePicker()}${graphsBody()}`)}
      ${card("health-workouts", "Workouts", workoutsBody(page.workouts, analysis.settings))}
      ${card("health-data", "Data", html`${tableTabs()}${dataBody(days)}`)}
      ${analysis.pendingCount ? "" : reviewCard}
    `,
    mount: (signal) => mountCharts(chartSpecs(page.days), signal),
  };
});

function todayOf(page: HealthPage): string {
  return page.days.at(-1)!.date;
}

// ---------- today's targets ----------

/** Calories and macros for today, plus any warnings. Also used by Monitor's Health card. */
export function targetsBody(targets: Targets | null) {
  if (!targets) {
    return html`<p class="muted">Needs at least 3 weigh-ins with body fat in the last 7 days. Sign in to Google under Settings → Connections.</p>`;
  }
  return html`
    <table class="data">
      <thead><tr><th>kcal</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th></tr></thead>
      <tbody><tr>
        <td>${Math.round(targets.calories)}</td><td>${Math.round(targets.proteinG)}</td>
        <td>${Math.round(targets.carbsG)}</td><td>${Math.round(targets.fatG)}</td>
      </tr></tbody>
    </table>
    <p class="muted small">
      Burn ≈ ${Math.round(targets.expenditure)} kcal/day ${goalText(targets.goalLbsPerWeek)}
      ${targets.method === "fallback" ? "· estimate from BMR (fallback)" : ""}
    </p>
    ${targets.warnings.map((warning) => html`<p class="small danger-text">${warning}</p>`)}
  `;
}

/**
 * Yesterday's totals under the targets that applied to it, met ones in green (Monitor's
 * Health card). Carbs are the remainder, so they aren't judged.
 */
export function yesterdayBody({ intake, targets, met }: DayComparison) {
  if (!intake) return html`<p class="muted small">Nothing logged yesterday.</p>`;
  const mark = (ok: boolean | undefined) => (ok ? "good-text" : "");
  const round = (value: number | null | undefined) => (value == null ? "–" : Math.round(value));
  return html`
    <p class="label">Yesterday</p>
    <table class="data">
      <thead><tr><th></th><th>kcal</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th></tr></thead>
      <tbody>
        <tr>
          <td>Eaten</td>
          <td class=${mark(met?.calories)}>${round(intake.calories)}</td>
          <td class=${mark(met?.protein)}>${round(intake.proteinG)}</td>
          <td>${round(intake.carbsG)}</td>
          <td class=${mark(met?.fat)}>${round(intake.fatG)}</td>
        </tr>
        ${targets ? html`<tr class="muted">
          <td>Target</td><td>${round(targets.calories)}</td><td>${round(targets.proteinG)}</td>
          <td>${round(targets.carbsG)}</td><td>${round(targets.fatG)}</td>
        </tr>` : ""}
      </tbody>
    </table>
  `;
}

function goalText(goal: number): string {
  if (goal === 0) return "· goal: maintain";
  return `${goal < 0 ? "−" : "+"} ${Math.round((Math.abs(goal) * 3500) / 7)} for ${goal > 0 ? "+" : ""}${goal} lb/week`;
}

function targetsExplained(t: Targets, settings: HealthSettings) {
  const goalKcal = (t.goalLbsPerWeek * 3500) / 7;
  const carbKcal = t.calories - t.proteinG * 4 - t.fatG * 9;
  return explained(html`
    <p><strong>Calories ${n(t.calories)}</strong> = average burn ${n(t.expenditure)}
      ${t.goalLbsPerWeek === 0 ? "(goal: maintain)" : html`${goalKcal < 0 ? "−" : "+"} ${n(Math.abs(goalKcal))} for ${signed(t.goalLbsPerWeek, 2)} lb/week (× 3,500 kcal per lb ÷ 7 days)`}.</p>
    <p><strong>Protein ${n(t.proteinG)} g</strong> = ${settings.proteinPerLbLean} g × ${t.leanLbs.toFixed(1)} lb lean mass.
      <strong>Fat ${n(t.fatG)} g</strong> = ${settings.fatPerLbLean} g × ${t.leanLbs.toFixed(1)} lb.</p>
    <p><strong>Carbs ${n(t.carbsG)} g</strong> fill what's left:
      (${n(t.calories)} − ${n(t.proteinG)} × 4 − ${n(t.fatG)} × 9) ÷ 4${carbKcal < 0 ? "; protein and fat already go over, so carbs are 0" : ""}.</p>
  `);
}

// ---------- body composition and metabolism ----------

function bodyBody(t: Targets) {
  return html`
    ${rows([
      ["Weight (7-day average)", `${t.weightLbs.toFixed(1)} lb`],
      ["Body fat (7-day average)", `${t.bodyFatPercent.toFixed(1)}%`],
      ["Lean mass", `${t.leanLbs.toFixed(1)} lb`],
      ["Weight trend", t.weightTrendLbsPerWeek === null ? "–" : `${signed(t.weightTrendLbsPerWeek, 2)} lb/week`],
    ])}
    ${explained(html`
      <p>Averages of the valid weigh-ins in the last 7 days (at least 3; otherwise the last average carries over).
        Lean mass = ${t.weightLbs.toFixed(1)} × (1 − ${t.bodyFatPercent.toFixed(1)}%) = ${t.leanLbs.toFixed(1)} lb.</p>
      ${t.weightTrendLbsPerWeek === null ? "" : html`<p>The trend is the straight-line slope of the 7-day average over the last ${t.windowDays} days.</p>`}
      <p>Uses only days before today. Flagged readings awaiting review or rejected are left out.</p>
    `)}
  `;
}

function metabolismBody(t: Targets, page: HealthPage, settings: HealthSettings) {
  const yesterday = page.days.at(-2);
  return html`
    ${rows([
      ["BMR (Katch-McArdle)", `${n(t.bmr)} kcal`],
      ["Average burn", `${n(t.expenditure)} kcal/day`],
      ["Yesterday's burn", t.previousDayExpenditure === null ? "–" : `${n(t.previousDayExpenditure)} kcal${t.previousDayStepsEstimated ? " (steps estimated)" : ""}`],
      ["Besides steps and workouts", t.activityMultiplier === null ? "–" : `${t.activityMultiplier.toFixed(2)} × BMR`],
      ["Logged days in window", `${t.validDays} of ${t.windowDays}`],
      ["Model", t.energyModel === "split" ? "Fat/lean split" : "3,500 kcal per lb"],
    ])}
    ${explained(html`
      <p><strong>BMR ${n(t.bmr)}</strong> = 370 + 21.6 × ${(t.leanLbs / 2.20462262185).toFixed(1)} kg lean mass.</p>
      ${t.method === "fallback" || t.averageIntake == null
        ? html`<p>Too little history for a fitted estimate, so the burn is BMR × ${settings.fallbackActivityFactor} = ${n(t.expenditure)}.</p>`
        : html`
          <p><strong>Average burn ${n(t.expenditure)}</strong> = average intake ${n(t.averageIntake)} over ${t.validDays} logged days
            of the last ${t.windowDays} ${t.storedPerDay! >= 0 ? "−" : "+"} ${n(Math.abs(t.storedPerDay!))} kcal/day
            ${t.storedPerDay! >= 0 ? "stored" : "drawn from the body"}
            (${t.energyModel === "split"
              ? "fat and lean mass changes, at 9,400 and 1,800 kcal per kg"
              : html`weight trend ${signed(t.weightTrendLbsPerWeek ?? 0, 2)} lb/week × 3,500 kcal per lb ÷ 7`}).</p>
          <p>Of that, steps ≈ ${n(t.averageStepKcal ?? 0)} kcal/day (0.5 kcal per kg per km, ~1,300 steps a km) and
            workouts ≈ ${n(t.averageWorkoutKcal ?? 0)} kcal/day (${settings.workoutMets} METs); the rest is
            ${t.activityMultiplier!.toFixed(2)} × BMR.</p>
          ${t.previousDayExpenditure !== null && yesterday?.steps != null ? html`
            <p><strong>Yesterday's burn ${n(t.previousDayExpenditure)}</strong> = ${t.activityMultiplier!.toFixed(2)} × ${n(t.bmr)} BMR
              + ${n(stepEnergy(yesterday.steps, t.weightLbs))} for ${yesterday.steps.toLocaleString()} steps${yesterday.stepsEstimated
                ? " (none recorded, so the typical day: the median of the 14 days before)" : ""}${yesterday.workoutKcal
                ? ` + ${n(yesterday.workoutKcal)} for workouts` : ""}.</p>` : ""}
        `}
    `)}
  `;
}

// ---------- graphs ----------

const COLORS = {
  // Dark-surface steps of the reference categorical palette, fixed per measure (validated
  // against --surface #1e293b, first three all-pairs).
  blue: "#3987e5",
  orange: "#d95926",
  aqua: "#199e70",
  // Status colors (the app's --warning and --danger) for readings awaiting review or left out,
  // always with their legend label.
  pending: "#facc15",
  rejected: "#f87171",
  target: "#94a3b8",
};

function rangePicker() {
  return html`
    <div class="segmented small-segmented" role="radiogroup" aria-label="Range">
      ${RANGES.map(([days, label]) => html`
        <label><input type="radio" name="health-range" .checked=${rangeDays === days}
          @change=${() => { rangeDays = days; rerender(); }}> ${label}</label>`)}
    </div>
  `;
}

function graphsBody() {
  return html`
    <p class="label">Weight, lb</p>${chartSlot("weight")}
    <p class="label">Body fat, %</p>${chartSlot("body-fat")}
    <p class="label">Intake and estimated burn, kcal</p>${chartSlot("energy")}
    <div class="label-row">
      <p class="label">Macros, g</p>
      <div class="segmented small-segmented" role="radiogroup" aria-label="Macros">
        <label><input type="radio" name="macro-view" .checked=${macroView === "amounts"} @change=${() => { macroView = "amounts"; rerender(); }}> Eaten</label>
        <label><input type="radio" name="macro-view" .checked=${macroView === "deltas"} @change=${() => { macroView = "deltas"; rerender(); }}> vs target</label>
      </div>
    </div>
    ${chartSlot("protein")}${chartSlot("carbs")}${chartSlot("fat")}
    <p class="label">Resting heart rate, bpm</p>${chartSlot("resting")}
    <p class="muted small">Burn lines are each morning's estimate of the average daily burn, from the days before.
      Carbs are the remainder of the calories, so their target moves with the others.</p>
  `;
}

function chartSpecs(days: HealthPageDay[]): Record<string, ChartSpec> {
  const dates = days.map((d) => d.date);
  const common = { dates, visibleDays: rangeDays, syncKey: "health" };
  /** A reading's dots split by review state, so each state has its own marker and legend entry. */
  const byState = (value: (d: HealthPageDay) => number | null, state: (d: HealthPageDay) => string | null, wanted: (string | null)[]) =>
    days.map((d) => (wanted.includes(state(d)) ? value(d) : null));
  const readings = (label: string, value: (d: HealthPageDay) => number | null, state: (d: HealthPageDay) => string | null, average: (d: HealthPageDay) => number | null) => [
    { label: "7-day average", values: days.map(average), color: COLORS.blue, kind: "line" as const, pointSize: 0 },
    { label, values: byState(value, state, [null, "accepted"]), color: COLORS.blue, kind: "points" as const, pointSize: 4 },
    { label: "Awaiting review", values: byState(value, state, ["pending"]), color: COLORS.pending, kind: "points" as const, pointSize: 7 },
    { label: "Left out", values: byState(value, state, ["rejected"]), color: COLORS.rejected, kind: "points" as const, pointSize: 7, hollow: true },
  ].filter((series, index) => index < 2 || series.values.some((v) => v !== null)); // review markers only when there are any
  const macro = (label: string, color: string, eaten: (d: HealthPageDay) => number | null, target: (d: HealthPageDay) => number | null): ChartSpec =>
    macroView === "amounts"
      ? { ...common, decimals: 0, yRange: "zero", series: [
          { label: `${label} eaten`, values: days.map(eaten), color, kind: "line", spanGaps: false },
          { label: "Target", values: days.map(target), color: COLORS.target, kind: "line", dashed: true },
        ] }
      : { ...common, decimals: 0, yRange: "symmetric", series: [
          { label: `${label} − target`, values: days.map((d) => (eaten(d) !== null && target(d) !== null ? eaten(d)! - target(d)! : null)), color, kind: "bars" },
        ] };
  return {
    weight: { ...common, decimals: 1, yRange: "span", minSpan: 2, series: readings("Weigh-ins", (d) => d.weightLbs, (d) => d.weightState, (d) => d.weightAverage) },
    "body-fat": { ...common, decimals: 1, yRange: "span", minSpan: 1, series: readings("Readings", (d) => d.bodyFatPercent, (d) => d.bodyFatState, (d) => d.bodyFatAverage) },
    energy: { ...common, decimals: 0, yRange: "span", minSpan: 500, series: [
      { label: "Intake", values: days.map((d) => d.intake?.calories ?? null), color: COLORS.blue, kind: "line", spanGaps: false },
      { label: "Burn (3,500 kcal/lb)", values: days.map((d) => d.expenditureSimple), color: COLORS.orange, kind: "line", pointSize: 0 },
      { label: "Burn (fat/lean split)", values: days.map((d) => d.expenditureSplit), color: COLORS.aqua, kind: "line", pointSize: 0 },
    ] },
    protein: macro("Protein", COLORS.blue, (d) => d.intake?.proteinG ?? null, (d) => d.targets?.proteinG ?? null),
    carbs: macro("Carbs", COLORS.orange, (d) => d.intake?.carbsG ?? null, (d) => d.targets?.carbsG ?? null),
    fat: macro("Fat", COLORS.aqua, (d) => d.intake?.fatG ?? null, (d) => d.targets?.fatG ?? null),
    resting: { ...common, decimals: 0, yRange: "span", minSpan: 10, series: [
      { label: "Resting heart rate", values: days.map((d) => d.restingHeartRate), color: COLORS.blue, kind: "line" },
    ] },
  };
}

// ---------- workouts ----------

function workoutsBody(workouts: PageWorkout[], settings: HealthSettings) {
  const since = new Date(Date.now() - rangeDays * 86_400_000).toISOString();
  const shown = workouts.filter((w) => w.start >= since);
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return html`
    ${shown.length === 0
      ? html`<p class="muted">None found in the last ${rangeLabel()}.</p>`
      : html`
        <p class="small">${shown.length} in the last ${rangeLabel()} (${(shown.length / (rangeDays / 7)).toFixed(1)} a week).</p>
        <div class="table-scroll">
          <table class="data">
            <thead><tr><th>Day</th><th>Time</th><th>Minutes</th><th>Above rest</th><th>Steps</th><th>Extra kcal</th></tr></thead>
            <tbody>${shown.map((w) => html`<tr>
              <td>${formatDay(w.date)}</td><td>${time(w.start)}–${time(w.end)}</td><td>${w.minutes}</td>
              <td>+${Math.round(w.aboveRest)} bpm</td><td>${w.steps.toLocaleString()}</td><td>+${n(w.kcal)}</td>
            </tr>`)}</tbody>
          </table>
        </div>`}
    <p class="muted small">
      Found in the heart rate: at least ${settings.workoutHeartRateAbove} bpm above resting for ${settings.workoutMinMinutes}+ minutes,
      under ${settings.workoutMaxStepsPerHour.toLocaleString()} steps an hour (walks are counted by their steps). A slow session that
      doesn't raise the heart rate doesn't count. Extra energy = (${settings.workoutMets} − 1) METs × weight × time, minus the steps
      taken meanwhile.
    </p>
  `;
}

function rangeLabel(): string {
  return RANGES.find(([days]) => days === rangeDays)![1];
}

// ---------- data table ----------

function tableTabs() {
  return html`
    <div class="segmented small-segmented" role="radiogroup" aria-label="Table">
      <label><input type="radio" name="table-tab" .checked=${tableTab === "totals"} @change=${() => { tableTab = "totals"; rerender(); }}> Totals</label>
      <label><input type="radio" name="table-tab" .checked=${tableTab === "deltas"} @change=${() => { tableTab = "deltas"; rerender(); }}> vs target</label>
    </div>
  `;
}

function dataBody(days: HealthPageDay[]) {
  const shown = days.slice(-tableDays).reverse();
  if (!shown.some((d) => d.intake || d.weightLbs !== null || d.steps !== null)) {
    return html`<p class="muted">No data yet. Sign in under Settings → Connections.</p>`;
  }
  const workedOut = shown.some((d) => d.targets?.workedOut);
  return html`
    ${onTargetSummary(shown)}
    <div class="table-scroll">
      ${tableTab === "totals" ? totalsTable(shown) : deltasTable(shown)}
    </div>
    <p class="muted small">
      ${tableTab === "totals" ? "Green: met that day's target (protein and fat at or above; calories by the goal). " : "Eaten − target. "}
      ${workedOut ? "* No targets were saved that day; they're worked out the way that day would have had them. " : ""}
      ${shown.some((d) => d.stepsEstimated) ? "≈ No steps recorded: the typical day (median of the 14 days before)." : ""}
    </p>
    ${tableDays < days.length ? html`<button class="secondary small" @click=${() => { tableDays = Math.min(days.length, tableDays + 14); rerender(); }}>Show 2 more weeks</button>` : ""}
  `;
}

/** "Calories on target 3 of 6 logged days · protein 5 of 6 · fat 4 of 6" (plan: built to try). */
function onTargetSummary(days: HealthPageDay[]) {
  const judged = days.filter((d) => d.met);
  if (judged.length === 0) return "";
  const count = (key: "calories" | "protein" | "fat") => judged.filter((d) => d.met![key]).length;
  return html`<p class="small">Last ${days.length} days: calories on target ${count("calories")} of ${judged.length} logged days ·
    protein ${count("protein")} of ${judged.length} · fat ${count("fat")} of ${judged.length}</p>`;
}

function dayCell(day: HealthPageDay) {
  return html`<td>${formatDay(day.date)}${day.targets?.workedOut ? "*" : ""}</td>`;
}

function totalsTable(days: HealthPageDay[]) {
  const mark = (ok: boolean | undefined) => (ok ? "good-text" : "");
  return html`
    <table class="data">
      <thead><tr>
        <th>Day</th><th>kcal</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th>
        <th>Steps</th><th>Weight lb</th><th>Body fat %</th><th>Resting HR</th>
      </tr></thead>
      <tbody>${days.map((d) => html`<tr>
        ${dayCell(d)}
        <td class=${mark(d.met?.calories)}>${show(d.intake?.calories)}</td>
        <td class=${mark(d.met?.protein)}>${show(d.intake?.proteinG)}</td>
        <td>${show(d.intake?.carbsG)}</td>
        <td class=${mark(d.met?.fat)}>${show(d.intake?.fatG)}</td>
        <td>${d.steps === null ? "–" : `${d.stepsEstimated ? "≈" : ""}${d.steps.toLocaleString()}`}</td>
        <td class=${stateClass(d.weightState)}>${show(d.weightLbs, 1)}</td>
        <td class=${stateClass(d.bodyFatState)}>${show(d.bodyFatPercent, 1)}</td>
        <td>${show(d.restingHeartRate)}</td>
      </tr>`)}</tbody>
    </table>
  `;
}

function deltasTable(days: HealthPageDay[]) {
  const delta = (eaten: number | null | undefined, target: number | undefined, ok?: boolean) => {
    if (eaten == null || target === undefined) return html`<td>–</td>`;
    return html`<td class=${ok ? "good-text" : ""}>${signed(eaten - target, 0)}</td>`;
  };
  return html`
    <table class="data">
      <thead><tr><th>Day</th><th>kcal</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th><th>Target kcal</th></tr></thead>
      <tbody>${days.map((d) => html`<tr>
        ${dayCell(d)}
        ${delta(d.intake?.calories, d.targets?.calories, d.met?.calories)}
        ${delta(d.intake?.proteinG, d.targets?.proteinG, d.met?.protein)}
        ${delta(d.intake?.carbsG, d.targets?.carbsG)}
        ${delta(d.intake?.fatG, d.targets?.fatG, d.met?.fat)}
        <td class="muted">${show(d.targets?.calories)}</td>
      </tr>`)}</tbody>
    </table>
  `;
}

/** Readings awaiting review in yellow, left out struck through. */
function stateClass(state: HealthPageDay["weightState"]): string {
  return state === "pending" ? "status warning" : state === "rejected" ? "struck muted" : "";
}

// ---------- review ----------

const KIND_LABEL: Record<Flag["kind"], string> = {
  "no-log": "Not logged",
  "low-calories": "Low calories",
  "high-steps": "Steps",
  weight: "Weigh-in",
  "body-fat": "Body fat",
};

function reviewBody(flags: Flag[]) {
  if (flags.length === 0) return html`<p class="muted">Nothing flagged in the days the estimate uses.</p>`;
  const pending = flags.filter((flag) => flag.verdict === null);
  const settled = flags.filter((flag) => flag.verdict !== null);
  return html`
    ${pending.map((flag) => html`
      <div class="alert-row">
        <p><strong>${formatDay(flag.date)} · ${KIND_LABEL[flag.kind]}</strong><br><span class="small">${flag.message}</span></p>
        <div class="list-actions">
          ${flag.kind === "no-log"
            ? html`<button class="secondary small" @click=${() => change(() => call("setHealthVerdict", flag.id, "rejected"))}>Skip day</button>`
            : html`
                <button class="secondary small" @click=${() => change(() => call("setHealthVerdict", flag.id, "accepted"))}>Valid</button>
                <button class="secondary small" @click=${() => change(() => call("setHealthVerdict", flag.id, "rejected"))}>Reject</button>
              `}
        </div>
      </div>
    `)}
    ${pending.length === 0 ? html`<p class="muted small">Everything flagged has been reviewed.</p>` : ""}
    ${settled.length ? html`<p class="label">Reviewed</p>` : ""}
    ${settled.map((flag) => html`
      <div class="alert-row">
        <p class="muted small">${formatDay(flag.date)} · ${KIND_LABEL[flag.kind]}: ${flag.verdict === "accepted" ? "valid" : "left out"}</p>
        <button class="secondary small" @click=${() => change(() => call("clearHealthVerdict", flag.id))}>Undo</button>
      </div>
    `)}
    <p class="muted small">Unlogged days clear themselves once logged in Cronometer and fetched again.</p>
  `;
}

// ---------- history ----------

route(/^\/health\/history$/, async () => {
  const history = await call("getTargetHistory");
  return {
    section: "health",
    wide: true,
    content: html`
      <header class="page-header">
        <a class="back" href="#/health" aria-label="Back to Health">←</a>
        <h1>Target history</h1>
      </header>
      <section class="card">
        ${history.length === 0
          ? html`<p class="muted">No targets saved yet.</p>`
          : html`
              <div class="table-scroll">
                <table class="data">
                  <thead><tr>
                    <th>Day</th><th>Target kcal</th><th>Eaten</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th>
                    <th>Burn</th><th>Weight lb</th><th>Lean lb</th><th>Goal lb/wk</th><th>Method</th>
                  </tr></thead>
                  <tbody>
                    ${history.map(({ targets, intake }) => html`<tr>
                      <td>${formatDay(targets.date)}</td>
                      <td>${Math.round(targets.calories)}</td>
                      <td>${intake ? Math.round(intake.calories) : "–"}</td>
                      <td>${Math.round(targets.proteinG)}${intake ? ` / ${show(intake.proteinG)}` : ""}</td>
                      <td>${Math.round(targets.carbsG)}${intake ? ` / ${show(intake.carbsG)}` : ""}</td>
                      <td>${Math.round(targets.fatG)}${intake ? ` / ${show(intake.fatG)}` : ""}</td>
                      <td>${Math.round(targets.expenditure)}</td>
                      <td>${targets.weightLbs.toFixed(1)}</td>
                      <td>${targets.leanLbs.toFixed(1)}</td>
                      <td>${targets.goalLbsPerWeek}</td>
                      <td>${targets.method === "trend" ? (targets.energyModel === "split" ? "Trend, split" : "Trend") : "Fallback"}</td>
                    </tr>`)}
                  </tbody>
                </table>
              </div>
              <p class="muted small">Macros show target / eaten. Each day keeps the targets computed for it.</p>
            `}
      </section>
    `,
  };
});

// ---------- helpers ----------

/** A fold-out "How this is worked out" with the actual numbers. */
function explained(body: unknown) {
  return html`<details class="explained"><summary>How this is worked out</summary><div class="small">${body}</div></details>`;
}

function rows(entries: [string, string][]) {
  return html`<table class="data"><tbody>${entries.map(([label, value]) => html`<tr><td>${label}</td><td>${value}</td></tr>`)}</tbody></table>`;
}

/** A whole number with thousands separators. */
function n(value: number): string {
  return Math.round(value).toLocaleString();
}

function signed(value: number, decimals: number): string {
  const rounded = Number(value.toFixed(decimals));
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toLocaleString([], { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** A number rounded for display, or a dash when there's no value. Units are in the headers. */
function show(value: number | null | undefined, decimals = 0): string {
  return value == null ? "–" : value.toFixed(decimals);
}

/** "2026-10-14" → "Wed, Oct 14" in the device's language. */
function formatDay(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
