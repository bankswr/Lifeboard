// A card (or a group of cards) that collapses to its heading (user, 2026-10-16: all cards
// collapsible; the Lists screen's to-do and prototype sections too). The heading
// is a toggle button; actions (e.g. "Dismiss all") sit beside it and stay usable when
// collapsed. Which cards are collapsed is remembered per device in localStorage, a viewing
// preference that doesn't need syncing.
import { html, type TemplateResult } from "lit-html";

const STORAGE_KEY = "lifeboard.collapsedCards";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return new Set(); // storage unavailable or unreadable: everything starts open
  }
}

const collapsed = loadCollapsed();

function remember() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // not saved; the card still toggles for this session
  }
}

/** Opens or closes the card in place, without re-rendering the screen. */
function toggle(id: string, event: Event) {
  const isCollapsed = !collapsed.has(id);
  if (isCollapsed) collapsed.add(id);
  else collapsed.delete(id);
  remember();
  const card = (event.currentTarget as HTMLElement).closest(".collapsible")!;
  card.classList.toggle("collapsed", isCollapsed);
  card.querySelector<HTMLElement>(":scope > .card-body")!.hidden = isCollapsed;
  (event.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!isCollapsed));
}

/**
 * A collapsible card. `id` must be stable and unique across the app (it's the remembered
 * key); `extraClass` adds classes to the card (e.g. "attention"). `group: true` makes it a
 * plain section that holds other cards (no card background of its own).
 */
export function card(
  id: string,
  title: unknown,
  body: unknown,
  options: { actions?: unknown; extraClass?: string; group?: boolean } = {},
): TemplateResult {
  const isCollapsed = collapsed.has(id);
  return html`
    <section class="${options.group ? "card-group" : "card"} collapsible ${options.extraClass ?? ""} ${isCollapsed ? "collapsed" : ""}">
      <div class="card-head">
        <button type="button" class="card-toggle" aria-expanded=${String(!isCollapsed)} @click=${(event: Event) => toggle(id, event)}>
          <span class="chevron" aria-hidden="true">▾</span>
          <h2>${title}</h2>
        </button>
        ${options.actions ? html`<div class="card-actions">${options.actions}</div>` : ""}
      </div>
      <div class="card-body" ?hidden=${isCollapsed}>${body}</div>
    </section>
  `;
}
