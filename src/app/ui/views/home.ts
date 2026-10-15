// Home: the dashboard. Placeholder until the first module (docs/PLAN.md) is built.
import { html } from "lit-html";
import { call, platform } from "../../backend.ts";
import { route } from "../app.ts";

route(/^\/$/, async () => {
  const info = await call("getAppInfo");
  return {
    section: "home",
    content: html`
      <h1>Lifeboard</h1>
      <p class="muted">Running on ${platform}. Schema version ${info.schemaVersion}.</p>
    `,
  };
});
