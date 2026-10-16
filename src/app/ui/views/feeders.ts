// Feeder settings (#/feeders, under Settings): when the food estimate turns yellow and red
// (days left), the optional refill task, and the refills the hopper size is learned from
// (each can be removed, e.g. a double press). See core/smartlife/food.ts.
import { html } from "lit-html";
import { call } from "../../backend.ts";
import { act, refresh, route } from "../app.ts";
import { card } from "../card.ts";
import { formatTime } from "../format.ts";

let message = "";

route(/^\/feeders$/, async () => {
  const [settings, refills, capacity] = await Promise.all([
    call("getFeederSettings"), call("listFeederRefills"), call("getHopperCapacity"),
  ]);
  const samples = refills.filter((refill) => refill.portions !== null && refill.portions >= 1).length;
  const shownMessage = message;
  message = "";
  return {
    section: "settings",
    content: html`
      <header class="page-header">
        <a class="back" href="#/settings" aria-label="Back to settings">←</a>
        <h1>Feeders</h1>
      </header>
      ${shownMessage ? html`<p>${shownMessage}</p>` : ""}
      <form class="card" @submit=${save}>
        <fieldset>
          <legend>Food left (days)</legend>
          <div class="field-row">
            <label>Yellow at <input type="number" name="warningDays" min="0" step="0.5" required .value=${String(settings.warningDays)}></label>
            <label>Red (alarm) at <input type="number" name="alarmDays" min="0" step="0.5" required .value=${String(settings.alarmDays)}></label>
          </div>
        </fieldset>
        <label class="check">
          <input type="checkbox" name="refillTaskAtAlarm" ?checked=${settings.refillTaskAtAlarm}>
          At alarm, add “Refill the feeders” to today's tasks and alert me
        </label>
        <button type="submit">Save</button>
      </form>

      ${card("feeder-hopper", "Hopper size", html`
        <p>
          ${capacity === null
            ? "Still learning: the first refill of each feeder only sets its starting point."
            : `≈ ${Math.round(capacity)} portions: the median of ${samples} refill${samples === 1 ? "" : "s"}.`}
        </p>
        <p class="muted small">Each refill counts the portions the schedule dispensed since that feeder's previous refill as one full hopper.</p>
        ${refills.map(
          (refill) => html`
            <div class="alert-row">
              <p>${refill.feederName} · ${formatTime(refill.at)}<br>
                <span class="muted small">${refill.portions === null ? "Starting point" : `${refill.portions} portions`}</span></p>
              <button class="icon" aria-label="Remove" title="Remove"
                @click=${() => confirm("Remove this refill? Later refills keep their counts.") && act(() => call("deleteFeederRefill", refill.id))}>×</button>
            </div>
          `,
        )}
      `)}
    `,
  };
});

async function save(event: SubmitEvent) {
  event.preventDefault();
  const fields = new FormData(event.target as HTMLFormElement);
  try {
    await call("saveFeederSettings", {
      warningDays: Number(fields.get("warningDays")),
      alarmDays: Number(fields.get("alarmDays")),
      refillTaskAtAlarm: fields.has("refillTaskAtAlarm"),
    });
    message = "Saved.";
  } catch (error) {
    message = (error as Error).message;
  }
  await refresh();
}
