// Litter-Robot settings (#/litter, under Settings): the drawer and litter levels at which
// their bars turn yellow (warning) and red (alarm), and the optional clean-up task at alarm.
import { html } from "lit-html";
import { call } from "../../backend.ts";
import { refresh, route } from "../app.ts";

let message = "";

route(/^\/litter$/, async () => {
  const settings = await call("getLitterSettings");
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
    `,
  };
});

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
