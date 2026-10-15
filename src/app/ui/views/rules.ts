// Alert rules: #/rules lists them; #/rules/new and #/rules/<id> edit one.
// The form edits a draft kept here between re-renders (adding or removing a condition
// re-renders the screen); it is saved only with the Save button.
import { html } from "lit-html";
import { live } from "lit-html/directives/live.js";
import type { ReadingType } from "../../../core/readings.ts";
import { OPERATORS, type Condition, type Operator, type Rule } from "../../../core/rules.ts";
import { call } from "../../backend.ts";
import { act, refresh, route } from "../app.ts";

type Draft = Omit<Rule, "id"> & { id?: string };

/** The rule being edited, and the screen it belongs to. */
let draft: { path: string; rule: Draft } | null = null;

route(/^\/rules$/, async () => {
  draft = null;
  const [rules, types] = [await call("listRules"), await call("getReadingTypes")];
  return {
    section: "settings",
    content: html`
      <header class="page-header">
        <a class="back" href="#/settings" aria-label="Back to settings">←</a>
        <h1>Alert rules</h1>
        <a class="button" href="#/rules/new">New rule</a>
      </header>
      <p class="muted">Each rule notifies you when its conditions become true. It won't repeat while they stay true.</p>
      ${rules.map(
        (rule) => html`
          <div class="card rule-card">
            <a href="#/rules/${rule.id}">
              <span>${rule.name}</span>
              <span class="muted small">When: ${types.find((t) => t.id === rule.readingType)?.label ?? rule.readingType}</span>
            </a>
            <label class="switch">
              <input type="checkbox" aria-label="Enabled" .checked=${live(rule.enabled)}
                @change=${(event: Event) => act(() => call("saveRule", { ...rule, enabled: (event.target as HTMLInputElement).checked }))}>
              On
            </label>
          </div>
        `,
      )}
    `,
  };
});

route(/^\/rules\/([\w-]+)$/, async ([ruleId]) => {
  const path = `/rules/${ruleId}`;
  const types = await call("getReadingTypes");
  if (draft?.path !== path) {
    const rule = ruleId === "new" ? newRule(types[0]) : await call("getRule", ruleId);
    if (!rule) return { section: "settings", content: html`<p>This rule no longer exists.</p><a href="#/rules">Back</a>` };
    draft = { path, rule: structuredClone(rule) };
  }
  const rule = draft.rule;
  const type = types.find((t) => t.id === rule.readingType) ?? types[0];

  return {
    section: "settings",
    content: html`
      <header class="page-header">
        <a class="back" href="#/rules" aria-label="Back to rules">←</a>
        <h1>${rule.id ? "Edit rule" : "New rule"}</h1>
      </header>
      <form class="rule-form" @submit=${save}>
        <label>Name
          <input .value=${live(rule.name)} @input=${(e: Event) => (rule.name = value(e))}>
        </label>
        <label>When
          <select @change=${(e: Event) => changeType(value(e))}>
            ${types.map((t) => html`<option value=${t.id} ?selected=${t.id === type.id}>${t.label}</option>`)}
          </select>
        </label>

        <fieldset>
          <legend>If all of these are true</legend>
          ${rule.conditions.length === 0 ? html`<p class="muted small">No conditions: every update matches.</p>` : ""}
          ${rule.conditions.map((condition, index) => conditionRow(type, condition, index))}
          <button type="button" class="secondary" @click=${() => addCondition(type)}>Add condition</button>
        </fieldset>

        <label>Then notify
          <input .value=${live(rule.message)} @input=${(e: Event) => (rule.message = value(e))}>
        </label>
        <p class="muted small">Placeholders: {subject}${type.fields.map((f) => html`, {${f.name}}`)}</p>

        <label class="switch">
          <input type="checkbox" .checked=${live(rule.enabled)} @change=${(e: Event) => (rule.enabled = (e.target as HTMLInputElement).checked)}>
          Enabled
        </label>
        <button type="submit">Save</button>
      </form>
      ${rule.id ? html`<button class="danger" @click=${() => remove(rule.id!, rule.name)}>Delete rule</button>` : ""}
    `,
  };
});

function conditionRow(type: ReadingType, condition: Condition, index: number) {
  const field = type.fields.find((f) => f.name === condition.field) ?? type.fields[0];
  const setValue = (text: string) => (condition.value = field.type === "number" ? Number(text) : field.type === "boolean" ? text === "true" : text);
  return html`
    <div class="condition">
      <select aria-label="Field" @change=${(e: Event) => { condition.field = value(e); condition.value = ""; void refresh(); }}>
        ${type.fields.map((f) => html`<option value=${f.name} ?selected=${f.name === field.name}>${f.label}</option>`)}
      </select>
      <select aria-label="Comparison" @change=${(e: Event) => (condition.operator = value(e) as Operator)}>
        ${Object.entries(OPERATORS)
          .filter(([op]) => field.type === "number" || op === "equals" || op === "not_equals")
          .map(([op, label]) => html`<option value=${op} ?selected=${op === condition.operator}>${label}</option>`)}
      </select>
      ${field.options || field.type === "boolean"
        ? html`<select aria-label="Value" @change=${(e: Event) => setValue(value(e))}>
            <option value="" ?selected=${condition.value === ""}>choose…</option>
            ${(field.options ?? ["true", "false"]).map((option) => html`<option ?selected=${String(condition.value) === option}>${option}</option>`)}
          </select>`
        : html`<input aria-label="Value" type=${field.type === "number" ? "number" : "text"} .value=${live(String(condition.value))}
            @input=${(e: Event) => setValue(value(e))}>`}
      <button type="button" class="icon" aria-label="Remove condition" @click=${() => { draft!.rule.conditions.splice(index, 1); void refresh(); }}>×</button>
    </div>
  `;
}

function newRule(type: ReadingType): Draft {
  return { name: "", enabled: true, readingType: type.id, conditions: [], message: "{subject}: " };
}

function addCondition(type: ReadingType) {
  draft!.rule.conditions.push({ field: type.fields[0].name, operator: "equals", value: "" });
  void refresh();
}

function changeType(typeId: string) {
  draft!.rule.readingType = typeId;
  draft!.rule.conditions = []; // the old conditions name the old type's fields
  void refresh();
}

async function save(event: SubmitEvent) {
  event.preventDefault();
  try {
    await call("saveRule", draft!.rule);
  } catch (error) {
    alert((error as Error).message);
    return;
  }
  draft = null;
  location.hash = "#/rules";
}

async function remove(ruleId: string, name: string) {
  if (!confirm(`Delete the rule "${name}"?`)) return;
  await act(() => call("deleteRule", ruleId));
  draft = null;
  location.hash = "#/rules";
}

const value = (event: Event) => (event.target as HTMLInputElement | HTMLSelectElement).value;
