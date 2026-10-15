// The app shell: hash routing (#/, #/settings, ...) and rendering a screen with the bottom
// bar. Pattern adapted from FitApp's ui/app.ts. Each navigation or refresh renders the
// screen from scratch; screens attach event handlers in their lit-html templates.
import { html, render, type TemplateResult } from "lit-html";

export interface View {
  /** Which bottom-bar item is current. */
  section: "home" | "settings";
  content: TemplateResult;
}

type Handler = (params: string[]) => Promise<View>;
const routes: [RegExp, Handler][] = [];

/** Registers a screen for paths matching `pattern`; capture groups become `params`. */
export function route(pattern: RegExp, handler: Handler) {
  routes.push([pattern, handler]);
}

const currentPath = () => location.hash.slice(1) || "/";

/** Re-renders the current screen, e.g. after its data changed. */
export async function refresh() {
  const path = currentPath();
  const match = routes.map(([pattern, handler]) => [pattern.exec(path), handler] as const).find(([m]) => m);
  const root = document.getElementById("app")!;
  if (!match) {
    render(html`<main class="screen"><p>Page not found.</p><a href="#/">Home</a></main>`, root);
    return;
  }
  const [result, handler] = match;
  const view = await handler(result!.slice(1));
  render(html`<main class="screen">${view.content}</main>${bottomBar(view.section)}`, root);
}

function bottomBar(current: View["section"]) {
  const item = (section: View["section"], href: string, label: string) =>
    html`<a class="tab ${section === current ? "current" : ""}" href=${href}>${label}</a>`;
  return html`<nav class="tabbar">${item("home", "#/", "Home")}${item("settings", "#/settings", "Settings")}</nav>`;
}

export function start() {
  window.addEventListener("hashchange", () => void refresh());
  void refresh();
}
