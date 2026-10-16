// Health (#/health, in the Details menu): today's targets, the body composition and
// expenditure behind them, flagged data to review, and the data itself (one row per day,
// Cronometer and Google side by side). #/health/history lists the saved targets.
// These are basic cards (user, 2026-10-16): charts and fuller explanations come with the
// Health page work later (docs/PLAN.md phase 7a).
import { html } from "lit-html";
import type { Targets } from "../../../core/energy.ts";
import type { DayComparison } from "../../../core/healthTargets.ts";
import type { HealthDay } from "../../../core/health.ts";
import type { Flag } from "../../../core/healthReview.ts";
import { call } from "../../backend.ts";
import { act, route } from "../app.ts";
import { card } from "../card.ts";

route(/^\/health$/, async () => {
  const [days, analysis] = await Promise.all([call("dailyHealth", 14), call("analyzeHealth")]);
  return {
    section: "health",
    wide: true,
    content: html`
      <header class="page-header">
        <h1>Health</h1>
        <a class="small" href="#/health-settings">Settings ›</a>
      </header>
      ${card("health-targets", "Today's targets", targetsBody(analysis.targets), {
        actions: html`<a class="small" href="#/health/history">History ›</a>`,
      })}
      ${analysis.targets ? card("health-estimate", "Body and expenditure", estimateBody(analysis.targets)) : ""}
      ${card("health-review", analysis.pendingCount ? `Needs review (${analysis.pendingCount})` : "Review", reviewBody(analysis.flags), {
        extraClass: analysis.pendingCount ? "attention" : "",
      })}
      ${card("health-data", "Data", dataTable(days))}
    `,
  };
});

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

function estimateBody(targets: Targets) {
  const rows: [string, string][] = [
    ["Weight (7-day average)", `${targets.weightLbs.toFixed(1)} lb`],
    ["Body fat (7-day average)", `${targets.bodyFatPercent.toFixed(1)}%`],
    ["Lean mass", `${targets.leanLbs.toFixed(1)} lb`],
    ["BMR (Katch-McArdle)", `${Math.round(targets.bmr)} kcal`],
    ["Weight trend", targets.weightTrendLbsPerWeek === null ? "–" : `${signed(targets.weightTrendLbsPerWeek, 2)} lb/week`],
    ["Average burn", `${Math.round(targets.expenditure)} kcal/day`],
    ["Yesterday's burn (by steps)", targets.previousDayExpenditure === null ? "–" : `${Math.round(targets.previousDayExpenditure)} kcal`],
    ["Besides steps", targets.activityMultiplier === null ? "–" : `${targets.activityMultiplier.toFixed(2)} × BMR`],
    ["Logged days in window", `${targets.validDays} of ${targets.windowDays}`],
    ["Model", targets.energyModel === "split" ? "Fat/lean split" : "3,500 kcal per lb"],
  ];
  return html`
    <table class="data">
      <tbody>${rows.map(([label, value]) => html`<tr><td>${label}</td><td>${value}</td></tr>`)}</tbody>
    </table>
    <p class="muted small">Uses only days before today. Flagged items awaiting review or rejected are left out.</p>
  `;
}

function signed(value: number, decimals: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(decimals)}`;
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
            ? html`<button class="secondary small" @click=${() => act(() => call("setHealthVerdict", flag.id, "rejected"))}>Skip day</button>`
            : html`
                <button class="secondary small" @click=${() => act(() => call("setHealthVerdict", flag.id, "accepted"))}>Valid</button>
                <button class="secondary small" @click=${() => act(() => call("setHealthVerdict", flag.id, "rejected"))}>Reject</button>
              `}
        </div>
      </div>
    `)}
    ${settled.length ? html`<p class="label">Reviewed</p>` : ""}
    ${settled.map((flag) => html`
      <div class="alert-row">
        <p class="muted small">${formatDay(flag.date)} · ${KIND_LABEL[flag.kind]}: ${flag.verdict === "accepted" ? "valid" : "left out"}</p>
        <button class="secondary small" @click=${() => act(() => call("clearHealthVerdict", flag.id))}>Undo</button>
      </div>
    `)}
    <p class="muted small">Unlogged days clear themselves once logged in Cronometer and fetched again.</p>
  `;
}

// ---------- data ----------

function dataTable(days: HealthDay[]) {
  const hasAny = days.some((d) => (d.calories ?? d.weightLbs ?? d.bodyFatPercent ?? d.steps ?? d.averageHeartRate) !== null);
  if (!hasAny) return html`<p class="muted">No data yet. Sign in under Settings → Connections.</p>`;
  return html`
    <div class="table-scroll">
      <table class="data">
        <thead><tr>
          <th>Day</th><th>kcal</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th>
          <th>Weight lb</th><th>Body fat %</th><th>Steps</th><th>Avg HR</th><th>Resting HR</th>
        </tr></thead>
        <tbody>
          ${days.map((day) => html`<tr>
            <td>${formatDay(day.date)}</td><td>${show(day.calories)}</td>
            <td>${show(day.proteinG)}</td><td>${show(day.carbsG)}</td><td>${show(day.fatG)}</td>
            <td>${show(day.weightLbs, 1)}</td><td>${show(day.bodyFatPercent, 1)}</td>
            <td>${day.steps === null ? "–" : day.steps.toLocaleString()}</td>
            <td>${show(day.averageHeartRate)}</td><td>${show(day.restingHeartRate)}</td>
          </tr>`)}
        </tbody>
      </table>
    </div>
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

/** A number rounded for display, or a dash when there's no value. Units are in the headers. */
function show(value: number | null, decimals = 0): string {
  return value === null ? "–" : value.toFixed(decimals);
}

/** "2026-10-14" → "Wed, Oct 14" in the device's language. */
function formatDay(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
