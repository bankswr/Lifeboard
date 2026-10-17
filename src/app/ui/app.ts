// The app shell: hash routing (#/monitor, #/settings, ...) and rendering a screen with the
// bottom bar. Pattern adapted from FitApp's ui/app.ts, including the bottom bar's pop-up
// menus (Hub, Details; FitApp's Tracking, Library) and gear icon. Each navigation or refresh renders the
// screen from scratch; screens attach event handlers in their lit-html templates.
import { html, nothing, render, type TemplateResult } from "lit-html";

export interface View {
  /** Which screen this is, for marking it current in the bottom bar. */
  section: Section;
  content: TemplateResult;
  /** Use the full width on a wide screen (tables); others stay phone-width. */
  wide?: boolean;
  /**
   * Runs after the screen is on the page, for behavior a template can't express (scrolling,
   * observers). Listeners added with `{ signal }` are removed before the next render.
   */
  mount?(signal: AbortSignal): void;
}

type Section = "monitor" | "lists" | "pets" | "health" | "schedule" | "maintenance" | "settings";

type Handler = (params: string[]) => Promise<View>;
const routes: [RegExp, Handler][] = [];

/** Registers a screen for paths matching `pattern`; capture groups become `params`. */
export function route(pattern: RegExp, handler: Handler) {
  routes.push([pattern, handler]);
}

const currentPath = () => location.hash.slice(1) || "/monitor";

let renderedPath = "";
let newVisit = true;
let controller = new AbortController();

/** True while rendering a screen the user just went to, false when re-rendering the same one. */
export function isNewVisit(): boolean {
  return newVisit;
}

/** Re-renders the current screen, e.g. after its data changed. */
export async function refresh() {
  const path = currentPath();
  newVisit = path !== renderedPath;
  const match = routes.map(([pattern, handler]) => [pattern.exec(path), handler] as const).find(([m]) => m);
  const root = document.getElementById("app")!;
  if (!match) {
    render(html`<main class="screen"><p>Page not found.</p><a href="#/monitor">Monitor</a></main>`, root);
    return;
  }
  const [result, handler] = match;
  const view = await handler(result!.slice(1).map((param) => (param === undefined ? param : decodeURIComponent(param))));
  controller.abort();
  controller = new AbortController();
  render(html`<main class="screen ${view.wide ? "wide" : ""}">${view.content}</main>${bottomBar(view.section)}`, root);
  renderedPath = path;
  view.mount?.(controller.signal);
}

const HUB_MENU = [["monitor", "Monitor"], ["lists", "Lists"]] as const;
const DETAILS_MENU = [["pets", "Pets"], ["health", "Health"], ["schedule", "Schedule"], ["maintenance", "Maintenance"]] as const;

const gearIcon = html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

function bottomBar(current: Section) {
  const currentAttr = (section: Section) => (section === current ? "page" : nothing);
  // A pop-up menu button: the label stays fixed and turns accent-colored on any of its screens (as in FitApp).
  const menu = (id: string, label: string, items: readonly (readonly [Section, string])[]) => html`
    <div class="tab-menu">
      <button type="button" class="tab-menu-btn" aria-expanded="false" aria-controls="${id}-menu"
              ?data-current=${items.some(([section]) => section === current)}>${label} <span aria-hidden="true">&#9652;</span></button>
      <div class="tab-menu-list" id="${id}-menu" hidden>
        ${items.map(([section, text]) => html`<a href="#/${section}" aria-current=${currentAttr(section)}>${text}</a>`)}
      </div>
    </div>`;
  return html`<nav class="tabbar" aria-label="Main">
    ${menu("hub", "Hub", HUB_MENU)}
    ${menu("details", "Details", DETAILS_MENU)}
    <a href="#/settings" class="tab-icon" aria-label="Settings" aria-current=${currentAttr("settings")}>${gearIcon}</a>
  </nav>`;
}

/** Opens or closes a bottom-bar menu. */
function setMenuOpen(button: HTMLButtonElement, open: boolean) {
  document.getElementById(button.getAttribute("aria-controls")!)!.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeMenus(except?: Element) {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".tab-menu-btn[aria-expanded='true']")) {
    if (button !== except) setMenuOpen(button, false);
  }
}

/**
 * The menus' behavior, wired once for the whole app: a menu button toggles its menu; a click
 * anywhere else (including the other menu's button) or Escape closes it.
 */
function wireMenus() {
  document.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(".tab-menu-btn");
    closeMenus(button ?? undefined);
    if (!button) return;
    const open = button.getAttribute("aria-expanded") !== "true";
    setMenuOpen(button, open);
    if (open) document.getElementById(button.getAttribute("aria-controls")!)!.querySelector("a")!.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = document.querySelector<HTMLButtonElement>(".tab-menu-btn[aria-expanded='true']");
    if (!open) return;
    setMenuOpen(open, false);
    open.focus();
  });
}

/**
 * Runs a change the user asked for, then re-renders the screen. If it fails, the error's
 * message (core errors are written for the user) is shown instead.
 */
export async function act(change: () => Promise<unknown>) {
  try {
    await change();
  } catch (error) {
    alert((error as Error).message);
  }
  await refresh();
}

/**
 * A banner at the top while the app does slow work of its own (on the phone, the sync and
 * update when it opens). Screens wait for that work to finish before they can load, so
 * the banner says why a tap seems to do nothing. Pass null to hide it.
 */
export function showBusy(message: string | null) {
  let banner = document.getElementById("busy");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "busy";
    banner.className = "busy";
    banner.setAttribute("role", "status");
    document.body.append(banner);
  }
  banner.textContent = message ?? "";
  banner.hidden = message === null;
}

export function start() {
  wireMenus();
  window.addEventListener("hashchange", () => {
    // lit-html leaves the menu's open state alone on re-render, so close it on navigation.
    closeMenus();
    void refresh();
  });
  void refresh();
}
