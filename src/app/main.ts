// App start: connect to the data (on-device database or desktop server), then show the app.
import "./style.css";
import { html, render } from "lit-html";
import { call, initBackend, platform } from "./backend.ts";

async function main() {
  await initBackend();
  const info = await call("getAppInfo");
  render(
    html`
      <main class="screen">
        <h1>Lifeboard</h1>
        <p class="muted">Running on ${platform}. Schema version ${info.schemaVersion}.</p>
        <p class="muted">Device ${info.deviceId}</p>
      </main>
    `,
    document.getElementById("app")!,
  );
}

main().catch((error) => {
  console.error(error);
  document.getElementById("app")!.textContent = `Lifeboard couldn’t start: ${error?.message ?? error}`;
});
