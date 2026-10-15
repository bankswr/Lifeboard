// App start: connect to the data (on-device database or desktop server), show the app, and
// on the phone sync with the desktop if it's reachable.
import "./style.css";
import { initBackend, platform } from "./backend.ts";
import { syncQuietly } from "./sync.ts";
import { refresh, start } from "./ui/app.ts";
import "./ui/views/home.ts";
import "./ui/views/settings.ts";

async function main() {
  await initBackend();
  start();
  if (platform === "android" && (await syncQuietly())) await refresh();
}

main().catch((error) => {
  console.error(error);
  document.getElementById("app")!.textContent = `Lifeboard couldn’t start: ${error?.message ?? error}`;
});
