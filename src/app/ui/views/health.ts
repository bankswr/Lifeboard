// Health (#/health, in the Details menu): the data fetched so far, one row per day with Cronometer and Google
// columns side by side. Charts and other refinements
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
    wide: true,
    content: html`
      <header class="page-header">
        <h1>Health</h1>
      </header>
      <section class="card">
        ${hasAny((d) => d.calories ?? d.weightLbs ?? d.bodyFatPercent ?? d.steps)
          ? html`
              <div class="table-scroll">
                <table class="data">
                  <thead><tr>
                    <th>Day</th><th>kcal</th><th>Protein g</th><th>Carbs g</th><th>Fat g</th>
                    <th>Weight lb</th><th>Body fat %</th><th>Steps</th>
                  </tr></thead>
                  <tbody>
                    ${days.map((day) => html`<tr>
                      <td>${formatDay(day.date)}</td><td>${show(day.calories)}</td>
                      <td>${show(day.proteinG)}</td><td>${show(day.carbsG)}</td><td>${show(day.fatG)}</td>
                      <td>${show(day.weightLbs, 1)}</td><td>${show(day.bodyFatPercent, 1)}</td>
                      <td>${day.steps === null ? "–" : day.steps.toLocaleString()}</td>
                    </tr>`)}
                  </tbody>
                </table>
              </div>
            `
          : signInHint}
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
