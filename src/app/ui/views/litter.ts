// Litter-Robot settings (#/litter, under Settings): the drawer and litter levels at which
// their bars turn yellow (warning) and red (alarm), the optional clean-up task at alarm, and
// the clean-cycle stall alert (core/whisker/stalls.ts), and the LitterHopper estimate's
// thresholds and the refills it learns from (each can be removed; core/whisker/hopper.ts).
// Below, the cats' alerts: weight change and each cat's visits-per-day limit (core/whisker/cats.ts).
import { html } from "lit-html";
import type { CatSummary } from "../../../core/whisker/cats.ts";
import { call } from "../../backend.ts";
import { act, refresh, route } from "../app.ts";
import { card } from "../card.ts";
import { formatTime } from "../format.ts";

let message = "";

route(/^\/litter$/, async () => {
  const [settings, catSettings, cats, refills] = await Promise.all([
    call("getLitterSettings"), call("getCatSettings"), call("getCats"), call("listLitterHopperRefills"),
  ]);
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
        <fieldset>
          <legend>Clean cycles</legend>
          <label>Alert if a visit gets no clean cycle within minutes
            <input type="number" name="stallAlertMinutes" min="15" step="1" placeholder="Off"
              .value=${settings.stallAlertMinutes === null ? "" : String(settings.stallAlertMinutes)}>
          </label>
          <p class="muted small">Usually a cycle follows within half an hour. Dismissing the alert while the robot still hasn't cycled brings it back at the next update. Blank turns it off.</p>
        </fieldset>
        <fieldset>
          <legend>Litter hopper (days left)</legend>
          <div class="field-row">
            <label>Yellow at <input type="number" name="hopperWarningDays" min="0" step="0.5" required .value=${String(settings.hopperWarningDays)}></label>
            <label>Red (alarm) at <input type="number" name="hopperAlarmDays" min="0" step="0.5" required .value=${String(settings.hopperAlarmDays)}></label>
          </div>
          <label class="check">
            <input type="checkbox" name="hopperTaskAtAlarm" ?checked=${settings.hopperTaskAtAlarm}>
            At alarm, add “Refill the litter hopper” to today's tasks and alert me
          </label>
        </fieldset>
        <button type="submit">Save</button>
      </form>
      ${card("litter-hopper", "Hopper refills", html`
        <p class="muted small">Each refill counts the dispenses in the robot's activity log since the previous refill as one full hopper; the median is the hopper's size. The first refill only sets the starting point.</p>
        ${refills.length === 0 ? html`<p class="muted">No refills recorded yet. Press Refill on the Litter-Robot's card on Pets.</p>` : ""}
        ${refills.map(
          (refill) => html`
            <div class="alert-row">
              <p>${formatTime(refill.at)}<br>
                <span class="muted small">${refill.dispenses === null ? "Starting point" : `${refill.dispenses} dispenses`}</span></p>
              <button class="icon" aria-label="Remove" title="Remove"
                @click=${() => confirm("Remove this refill? Later refills keep their counts.") && act(() => call("deleteLitterHopperRefill", refill.id))}>×</button>
            </div>
          `,
        )}
      `)}
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
            <p class="muted small">Leave blank for automatic: the cat's usual visits per day over its last 2 weeks, plus 2.</p>
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
      stallAlertMinutes: String(fields.get("stallAlertMinutes") ?? "").trim() === "" ? null : level("stallAlertMinutes"),
      hopperWarningDays: level("hopperWarningDays"),
      hopperAlarmDays: level("hopperAlarmDays"),
      hopperTaskAtAlarm: fields.has("hopperTaskAtAlarm"),
    });
    message = "Saved.";
  } catch (error) {
    message = (error as Error).message;
  }
  await refresh();
}
