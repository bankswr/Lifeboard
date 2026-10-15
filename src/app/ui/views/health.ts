// Health (#/health): the data fetched so far. Charts and other refinements come later
// (user, 2026-10-15: "for now, let's just get the data").
import { html } from "lit-html";
import { call } from "../../backend.ts";
import { route } from "../app.ts";

route(/^\/health$/, async () => {
  const nutrition = await call("recentNutrition", 14);
  const round = (value: number | null) => (value === null ? "–" : Math.round(value));
  return {
    section: "health",
    content: html`
      <h1>Health</h1>
      <section class="card">
        <h2>Nutrition (Cronometer)</h2>
        ${nutrition.length === 0
          ? html`<p class="muted">No data yet. Sign in under Settings → Connections.</p>`
          : html`
              <table class="data">
                <thead><tr><th>Day</th><th>kcal</th><th>Protein</th><th>Carbs</th><th>Fat</th></tr></thead>
                <tbody>
                  ${nutrition.map(
                    (day) => html`<tr>
                      <td>${formatDay(day.date)}</td><td>${round(day.calories)}</td>
                      <td>${round(day.proteinG)} g</td><td>${round(day.carbsG)} g</td><td>${round(day.fatG)} g</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            `}
      </section>
    `,
  };
});

/** "2026-10-14" → "Wed Oct 14" in the device's language. */
function formatDay(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
