// Settings. Sync pairing: the desktop shows its address and sync key; the phone enters them
// and can sync on demand (it also syncs on its own when opened, see main.ts).
import { html } from "lit-html";
import { call, platform } from "../../backend.ts";
import { syncNow } from "../../sync.ts";
import { refresh, route } from "../app.ts";

interface Pairing {
  addresses: string[];
  syncKey: string;
  lanSyncOn: boolean;
}

let syncMessage = "";

route(/^\/settings$/, async () => {
  const info = await call("getAppInfo");
  return {
    section: "settings",
    content: html`
      <h1>Settings</h1>
      ${platform === "desktop" ? await desktopPairing() : await phoneSync()}
      <section class="card">
        <h2>This device</h2>
        <p class="muted">Device ID ${info.deviceId}</p>
      </section>
    `,
  };
});

async function desktopPairing() {
  const pairing: Pairing = await (await fetch("./desktop/pairing")).json();
  return html`
    <section class="card">
      <h2>Phone sync</h2>
      ${pairing.lanSyncOn
        ? html`
            <p>In the phone app's Settings, enter one of these addresses and the sync key.</p>
            <p class="label">Desktop address</p>
            ${pairing.addresses.length
              ? pairing.addresses.map((address) => html`<p class="mono">${address}</p>`)
              : html`<p class="muted">No network connection found.</p>`}
            <p class="label">Sync key</p>
            <p class="mono">${pairing.syncKey}</p>
          `
        : html`<p class="muted">LAN sync is off (LIFEBOARD_HOST=127.0.0.1).</p>`}
    </section>
  `;
}

async function phoneSync() {
  const settings = await call("getSyncSettings");
  return html`
    <section class="card">
      <h2>Desktop sync</h2>
      <form @submit=${saveAndSync}>
        <label>Desktop address
          <input name="address" type="url" placeholder="http://192.168.1.20:5180" .value=${settings.desktopAddress}>
        </label>
        <label>Sync key
          <input name="key" autocomplete="off" .value=${settings.syncKey}>
        </label>
        <button type="submit">Save and sync now</button>
      </form>
      <p class="muted">Last synced: ${settings.lastSyncedAt ? new Date(settings.lastSyncedAt).toLocaleString() : "never"}</p>
      ${syncMessage ? html`<p>${syncMessage}</p>` : ""}
    </section>
  `;
}

async function saveAndSync(event: SubmitEvent) {
  event.preventDefault();
  const form = new FormData(event.target as HTMLFormElement);
  await call("saveSyncSettings", String(form.get("address")), String(form.get("key")));
  syncMessage = "Syncing…";
  await refresh();
  try {
    const summary = await syncNow();
    syncMessage = `Synced: sent ${summary.sent}, received ${summary.received}.`;
  } catch (error) {
    syncMessage = (error as Error).message;
  }
  await refresh();
}
