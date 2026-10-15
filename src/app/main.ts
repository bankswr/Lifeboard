// App start: connect to the data (on-device database or desktop server) and show the app.
// On the phone, also sync with the desktop if it's reachable and update if one is due.
import "./style.css";
import { setCookieSessionFactory } from "../core/http.ts";
import { setAlertDelivery } from "../core/notify.ts";
import { isUpdateDue } from "../core/updates.ts";
import { call, initBackend, platform } from "./backend.ts";
import { nativeCookieSession } from "./nativeCookies.ts";
import { showPhoneNotifications } from "./notify.ts";
import { syncQuietly } from "./sync.ts";
import { refresh, start } from "./ui/app.ts";
import "./ui/views/connections.ts";
import "./ui/views/health.ts";
import "./ui/views/home.ts";
import "./ui/views/lists.ts";
import "./ui/views/rules.ts";
import "./ui/views/settings.ts";

async function main() {
  await initBackend();
  start();
  if (platform === "android") {
    setAlertDelivery(showPhoneNotifications);
    setCookieSessionFactory(nativeCookieSession);
    await syncQuietly();
    const { lastUpdateAt } = await call("getStatus");
    if (isUpdateDue(lastUpdateAt)) await call("updateNow");
    await refresh();
  }
}

main().catch((error) => {
  console.error(error);
  document.getElementById("app")!.textContent = `Lifeboard couldn’t start: ${error?.message ?? error}`;
});
