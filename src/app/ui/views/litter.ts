// Litter-Robot settings (#/litter, under Settings): the drawer and litter levels at which
// their bars turn yellow (warning) and red (alarm), and the optional clean-up task at alarm.
// Below, the cats' alerts: weight change and each cat's visits-per-day limit (core/whisker/cats.ts).
import { html } from "lit-html";
import type { CatSummary } from "../../../core/whisker/cats.ts";
import { call } from "../../backend.ts";
import { refresh, route } from "../app.ts";

let message = "";

route(/^\/litter$/, async () => {
  const [settings, catSettings, cats] = await Promise.all([call("getLitterSettings"), call("getCatSettings"), call("getCats")]);
  const shownMessage = message;
  message = "";
  const percent = (name: string, label: string, value: number) =>
    html`<label>${label} <input type="number" name=${name} min="0" max="100" step="1" required .value=${String(value)}></label>`;
  return {
    section: "settings",
    content: html`
      <header class="page-header">
        <a class="back" href="#/settings" aria-label="Back to settings">←</a>
        <h1>Litter-Robot</h1>
      </header>
      ${shownMessage ? html`<p>${shownMessage}</p>` : ""}
      <form class="card" @submit=${save}>
        <fieldset>
          <legend>Waste drawer (% full)</legend>
          <div class="field-row">
            ${percent("drawerWarning", "Yellow at", settings.drawerWarning)}
            ${percent("drawerAlarm", "Red (alarm) at", settings.drawerAlarm)}
          </div>
        </fieldset>
        <fieldset>
          <legend>Litter (% left)</legend>
          <div class="field-row">
            ${percent("litterWarning", "Yellow at", settings.litterWarning)}
            ${percent("litterAlarm", "Red (alarm) at", settings.litterAlarm)}
          </div>
        </fieldset>
        <label class="check">
          <input type="checkbox" name="cleanTaskAtAlarm" ?checked=${settings.cleanTaskAtAlarm}>
          At alarm, add “Clean the litter box” to today's tasks and alert me
        </label>
        <p class="muted small">Happens once each time a level reaches its alarm, not on every update.</p>
        <button type="submit">Save</button>
      </form>
      ${cats.length > 0 ? html`
        <form class="card" @submit=${(event: SubmitEvent) => saveCats(event, cats)}>
          <fieldset>
            <legend>Cats: weight</legend>
            <div class="field-row">
              <label>Alert at a change of % <input type="number" name="weightChangePercent" min="0.5" step="0.5" required .value=${String(catSettings.weightChangePercent)}></label>
              <label>Compared with days earlier <input type="number" name="weightCompareDays" min="7" step="1" required .value=${String(catSettings.weightCompareDays)}></label>
            </div>
            <p class="muted small">The median of the last 7 days against the 7 days that ended that many days earlier. Gains and losses both alert.</p>
          </fieldset>
          <fieldset>
            <legend>Cats: visits per day</legend>
            ${cats.map((cat) => html`
              <label>${cat.name}: alert above
                <input type="number" name="visits-${cat.id}" min="1" step="1"
                  placeholder=${cat.visitLimitIsAuto && cat.visitLimit !== null ? `Automatic (${cat.visitLimit})` : "Automatic"}
                  .value=${cat.visitLimitIsAuto ? "" : String(cat.visitLimit)}>
              </label>`)}
            <p class="muted small">Leave blank for automatic: twice the cat's usual visits per day over its last 2 weeks (at least 3 more than usual).</p>
          </fieldset>
          <button type="submit">Save</button>
        </form>` : ""}
    `,
  };
});

async function saveCats(event: SubmitEvent, cats: CatSummary[]) {
  event.preventDefault();
  const fields = new FormData(event.target as HTMLFormElement);
  const visitLimits: Record<string, number | null> = {};
  for (const cat of cats) {
    const value = String(fields.get(`visits-${cat.id}`) ?? "").trim();
    visitLimits[cat.id] = value === "" ? null : Number(value);
  }
  try {
    await call("saveCatSettings", {
      weightChangePercent: Number(fields.get("weightChangePercent")),
      weightCompareDays: Number(fields.get("weightCompareDays")),
      visitLimits,
    });
    message = "Saved.";
  } catch (error) {
    message = (error as Error).message;
  }
  await refresh();
}

async function save(event: SubmitEvent) {
  event.preventDefault();
  const fields = new FormData(event.target as HTMLFormElement);
  const level = (name: string) => Number(fields.get(name));
  try {
    await call("saveLitterSettings", {
      drawerWarning: level("drawerWarning"),
      drawerAlarm: level("drawerAlarm"),
      litterWarning: level("litterWarning"),
      litterAlarm: level("litterAlarm"),
      cleanTaskAtAlarm: fields.has("cleanTaskAtAlarm"),
    });
    message = "Saved.";
  } catch (error) {
    message = (error as Error).message;
  }
  await refresh();
}
