// Health (#/health): the data fetched so far, one row per day. Charts and other refinements
// come later (user, 2026-10-15: "for now, let's just get the data").
import { html } from "lit-html";
import type { HealthDay } from "../../../core/health.ts";
import { call } from "../../backend.ts";
import { route } from "../app.ts";

route(/^\/health$/, async () => {
  const days = await call("dailyHealth", 14);
  const hasAny = (pick: (day: HealthDay) => number | null) => days.some((day) => pick(day) !== null);
  const signInHint = html`<p class="muted">No data yet. Sign in under Settings → Connections.</p>`;
  return {
    section: "health",
    content: html`
      <h1>Health</h1>
      <section class="card">
        <h2>Nutrition</h2>
        ${hasAny((d) => d.calories)
          ? html`
              <table class="data">
                <thead><tr><th>Day</th><th>kcal</th><th>Protein</th><th>Carbs</th><th>Fat</th></tr></thead>
                <tbody>
                  ${days.map((day) => html`<tr>
                    <td>${formatDay(day.date)}</td><td>${show(day.calories)}</td>
                    <td>${show(day.proteinG, " g")}</td><td>${show(day.carbsG, " g")}</td><td>${show(day.fatG, " g")}</td>
                  </tr>`)}
                </tbody>
              </table>
            `
          : signInHint}
      </section>
      <section class="card">
        <h2>Body and steps</h2>
        ${hasAny((d) => d.weightLbs ?? d.bodyFatPercent ?? d.steps)
          ? html`
              <table class="data">
                <thead><tr><th>Day</th><th>Weight</th><th>Body fat</th><th>Steps</th></tr></thead>
                <tbody>
                  ${days.map((day) => html`<tr>
                    <td>${formatDay(day.date)}</td><td>${show(day.weightLbs, " lb", 1)}</td>
                    <td>${show(day.bodyFatPercent, "%", 1)}</td><td>${day.steps === null ? "–" : day.steps.toLocaleString()}</td>
                  </tr>`)}
                </tbody>
              </table>
            `
          : signInHint}
      </section>
    `,
  };
});

/** A number rounded for display, or a dash when there's no value. */
function show(value: number | null, unit = "", decimals = 0): string {
  return value === null ? "–" : `${value.toFixed(decimals)}${unit}`;
}

/** "2026-10-14" → "Wed, Oct 14" in the device's language. */
function formatDay(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
