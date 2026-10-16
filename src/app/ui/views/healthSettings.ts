// Health settings (#/health-settings, under Settings): the goal, macro targets, the fit
// window and energy model, the goal-rate limits, and the thresholds that flag suspicious
// data. See core/healthTargets.ts and docs/PLAN.md phase 7a.
import { html } from "lit-html";
import type { HealthSettings } from "../../../core/healthTargets.ts";
import { call } from "../../backend.ts";
import { refresh, route } from "../app.ts";

let message = "";

route(/^\/health-settings$/, async () => {
  const settings = await call("getHealthSettings");
  const shownMessage = message;
  message = "";
  const number = (name: keyof HealthSettings, label: string, step: string) =>
    html`<label>${label} <input type="number" name=${name} step=${step} required .value=${String(settings[name])}></label>`;
  return {
    section: "settings",
    content: html`
      <header class="page-header">
        <a class="back" href="#/settings" aria-label="Back to settings">←</a>
        <h1>Health</h1>
      </header>
      ${shownMessage ? html`<p>${shownMessage}</p>` : ""}
      <form class="card" @submit=${save}>
        <fieldset>
          <legend>Goal and targets</legend>
          ${number("goalLbsPerWeek", "Goal, lb/week (negative to lose)", "0.05")}
          <div class="field-row">
            ${number("proteinPerLbLean", "Protein, g per lb lean mass", "0.05")}
            ${number("fatPerLbLean", "Fat, g per lb lean mass", "0.05")}
          </div>
          <p class="muted small">Carbs fill the calories left after protein and fat.</p>
        </fieldset>
        <fieldset>
          <legend>Goal rate warnings (% of body weight per week)</legend>
          <div class="field-row">
            ${number("lossWarnPercent", "Loss over", "0.05")}
            ${number("gainWarnPercent", "Gain over", "0.05")}
          </div>
        </fieldset>
        <fieldset>
          <legend>Expenditure estimate</legend>
          ${number("windowDays", "Fit window, days", "1")}
          <label class="check">
            <input type="checkbox" name="splitModel" ?checked=${settings.energyModel === "split"}>
            Advanced: count fat and lean mass changes separately instead of 3,500 kcal per lb
          </label>
          ${number("fallbackActivityFactor", "Activity factor while history is short (× BMR)", "0.025")}
        </fieldset>
        <fieldset>
          <legend>Flag as suspicious</legend>
          <div class="field-row">
            ${number("lowCaloriesPercent", "Calories under % of estimated burn", "1")}
            ${number("lowCaloriesFloor", "or under kcal", "50")}
          </div>
          ${number("maxSteps", "Steps over", "1000")}
          <div class="field-row">
            ${number("weightJumpLbs", "Weigh-in off the 7-day average by lb", "0.5")}
            ${number("bodyFatJumpPoints", "Body fat off by points", "0.5")}
          </div>
          <p class="muted small">Flagged items appear in the alerts and are left out of the calculations until accepted on the Health page.</p>
        </fieldset>
        <button type="submit">Save</button>
      </form>
    `,
  };
});

async function save(event: SubmitEvent) {
  event.preventDefault();
  const fields = new FormData(event.target as HTMLFormElement);
  const value = (name: keyof HealthSettings) => Number(fields.get(name));
  try {
    await call("saveHealthSettings", {
      goalLbsPerWeek: value("goalLbsPerWeek"),
      proteinPerLbLean: value("proteinPerLbLean"),
      fatPerLbLean: value("fatPerLbLean"),
      windowDays: value("windowDays"),
      energyModel: fields.has("splitModel") ? "split" : "simple",
      lossWarnPercent: value("lossWarnPercent"),
      gainWarnPercent: value("gainWarnPercent"),
      fallbackActivityFactor: value("fallbackActivityFactor"),
      lowCaloriesPercent: value("lowCaloriesPercent"),
      lowCaloriesFloor: value("lowCaloriesFloor"),
      maxSteps: value("maxSteps"),
      weightJumpLbs: value("weightJumpLbs"),
      bodyFatJumpPoints: value("bodyFatJumpPoints"),
    });
    message = "Saved.";
  } catch (error) {
    message = (error as Error).message;
  }
  await refresh();
}
