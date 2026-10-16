// The repeat controls shared by the Schedule form and the Maintenance form: frequency, every
// N, weekdays, and how it ends. A Google rule the controls can't show is kept as "custom".
import { html } from "lit-html";
import { describeRepeat, mondayFirstWeekday, type Frequency, type Repeat } from "../../core/schedule/repeat.ts";

const FREQ_LABELS: Record<Frequency, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };
const UNIT_LABELS: Record<Frequency, string> = { daily: "day(s)", weekly: "week(s)", monthly: "month(s)", yearly: "year(s)" };
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The Repeat fieldset. Parts carry data-show keys; repeatVisibility says which to show. */
export function repeatFieldset(repeat: Repeat | null, options: { allowNever?: boolean } = {}) {
  const allowNever = options.allowNever ?? true;
  return html`
    <fieldset class="repeat" data-show="repeat">
      <legend>Repeat</legend>
      <select name="freq" aria-label="Repeat">
        ${allowNever ? html`<option value="" ?selected=${!repeat}>Never</option>` : ""}
        ${repeat?.custom ? html`<option value="custom" selected>${describeRepeat(repeat)}</option>` : ""}
        ${(["daily", "weekly", "monthly", "yearly"] as Frequency[]).map(
          (freq) => html`<option value=${freq} ?selected=${!repeat?.custom && repeat?.freq === freq}>${FREQ_LABELS[freq]}</option>`,
        )}
      </select>
      <label data-show="interval">Every <input type="number" name="interval" min="1" .value=${String(repeat?.interval ?? 1)}>
        <span class="interval-unit"></span></label>
      <div class="weekdays" data-show="weekly">
        ${WEEKDAY_LABELS.map(
          (label, day) => html`<label><input type="checkbox" name="weekday" value=${day}
            ?checked=${repeat?.freq === "weekly" && repeat.weekdays.includes(day)}> ${label}</label>`,
        )}
      </div>
      <label data-show="interval">Ends <select name="endKind">
        <option value="never" ?selected=${!repeat || repeat.end.kind === "never"}>Never</option>
        <option value="until" ?selected=${repeat?.end.kind === "until"}>On a date</option>
        <option value="count" ?selected=${repeat?.end.kind === "count"}>After a number of times</option>
      </select></label>
      <label data-show="until">Last date <input type="date" name="untilDate"
        .value=${repeat?.end.kind === "until" ? repeat.end.date : ""}></label>
      <label data-show="count">Times <input type="number" name="count" min="1"
        .value=${String(repeat?.end.kind === "count" ? repeat.end.count : 10)}></label>
    </fieldset>
  `;
}

/** Which repeat parts to show for the current choices (merge into the form's own map). */
export function repeatVisibility(fields: FormData): Record<string, boolean> {
  const freq = String(fields.get("freq") ?? "");
  const endKind = String(fields.get("endKind"));
  const chosen = freq !== "" && freq !== "custom";
  return {
    interval: chosen,
    weekly: freq === "weekly",
    until: chosen && endKind === "until",
    count: chosen && endKind === "count",
  };
}

/** Shows each [data-show] part per `shown`, and names the interval's unit. */
export function applyVisibility(form: HTMLFormElement, shown: Record<string, boolean>) {
  for (const element of form.querySelectorAll<HTMLElement>("[data-show]")) element.hidden = shown[element.dataset.show!] === false;
  const freq = String(new FormData(form).get("freq") ?? "");
  const unit = form.querySelector(".interval-unit");
  if (unit && freq in UNIT_LABELS) unit.textContent = UNIT_LABELS[freq as Frequency];
}

/** The repeat the form describes, or null for none. `original` is kept for a custom rule. */
export function readRepeat(fields: FormData, date: string, original: Repeat | null): Repeat | null {
  const freq = String(fields.get("freq") ?? "");
  if (!freq) return null;
  if (freq === "custom") return original;
  const endKind = String(fields.get("endKind"));
  let weekdays = fields.getAll("weekday").map(Number);
  // Weekly with no day ticked: the date's own weekday.
  if (freq === "weekly" && weekdays.length === 0 && date) weekdays = [mondayFirstWeekday(date)];
  return {
    freq: freq as Frequency,
    interval: Math.max(1, Number(fields.get("interval")) || 1),
    weekdays: freq === "weekly" ? weekdays : [],
    end:
      endKind === "until" ? { kind: "until", date: String(fields.get("untilDate")) }
      : endKind === "count" ? { kind: "count", count: Math.max(1, Number(fields.get("count")) || 1) }
      : { kind: "never" },
  };
}
