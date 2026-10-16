// Water fountain settings (#/fountain, under Settings): when the estimate turns yellow and
// red (days left), the optional refill task, and the refills it learns from (each can be
// removed, e.g. a double press). See core/fountain.ts.
import { html } from "lit-html";
import { call } from "../../backend.ts";
import { act, refresh, route } from "../app.ts";
import { card } from "../card.ts";
import { formatTime } from "../format.ts";

let message = "";

route(/^\/fountain$/, async () => {
  const [settings, refills, { fountain }] = await Promise.all([
    call("getFountainSettings"), call("listFountainRefills"), call("getStatus"),
  ]);
  const samples = refills.filter((refill) => refill.days !== null && refill.days >= 0.25).length;
  const shownMessage = message;
  message = "";
  return {
    section: "settings",
    content: html`
      <header class="page-header">
        <a class="back" href="#/settings" aria-label="Back to settings">←</a>
        <h1>Water fountain</h1>
      </header>
      ${shownMessage ? html`<p>${shownMessage}</p>` : ""}
      <form class="card" @submit=${save}>
        <fieldset>
          <legend>Water left (days)</legend>
          <div class="field-row">
            <label>Yellow at <input type="number" name="warningDays" min="0" step="0.5" required .value=${String(settings.warningDays)}></label>
            <label>Red (alarm) at <input type="number" name="alarmDays" min="0" step="0.5" required .value=${String(settings.alarmDays)}></label>
          </div>
        </fieldset>
        <label class="check">
          <input type="checkbox" name="refillTaskAtAlarm" ?checked=${settings.refillTaskAtAlarm}>
          At alarm, add “Refill the water fountain” to today's tasks and alert me
        </label>
        <button type="submit">Save</button>
      </form>

      ${card("fountain-learning", "How long a fill lasts", html`
        <p>
          ${fountain.fillDays === null
            ? "Still learning: the first refill only sets the starting point."
            : `≈ ${fountain.fillDays.toFixed(1)} days: the median of ${samples} refill${samples === 1 ? "" : "s"}.`}
        </p>
        <p class="muted small">Each refill counts the time since the previous refill as one full fountain.</p>
        ${refills.map(
          (refill) => html`
            <div class="alert-row">
              <p>${formatTime(refill.at)}<br>
                <span class="muted small">${refill.days === null ? "Starting point" : `${refill.days.toFixed(1)} days`}</span></p>
              <button class="icon" aria-label="Remove" title="Remove"
                @click=${() => confirm("Remove this refill? Later refills keep their counts.") && act(() => call("deleteFountainRefill", refill.id))}>×</button>
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
    await call("saveFountainSettings", {
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
