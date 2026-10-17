// Settings. Sync pairing: the desktop shows its address and sync key; the phone enters them
// and can sync on demand (it also syncs on its own when opened, see main.ts).
import { html } from "lit-html";
import { call, platform } from "../../backend.ts";
import { allowExactAlarms, exactAlarmsAllowed } from "../../reminders.ts";
import { syncNow } from "../../sync.ts";
import { refresh, route } from "../app.ts";
import { card } from "../card.ts";

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
      <a class="card list-card" href="#/connections"><span>Connections</span><span class="muted">›</span></a>
      <a class="card list-card" href="#/rules"><span>Alert rules</span><span class="muted">›</span></a>
      <a class="card list-card" href="#/calendars"><span>Calendars</span><span class="muted">›</span></a>
      <a class="card list-card" href="#/health-settings"><span>Health</span><span class="muted">›</span></a>
      <a class="card list-card" href="#/litter"><span>Litter-Robot</span><span class="muted">›</span></a>
      <a class="card list-card" href="#/feeders"><span>Feeders</span><span class="muted">›</span></a>
      <a class="card list-card" href="#/fountain"><span>Water fountain</span><span class="muted">›</span></a>
      ${platform === "desktop" ? await desktopPairing() : html`${await phoneSync()}${await remindersCard()}`}
      ${card("settings-device", "This device", html`<p class="muted">Device ID ${info.deviceId}</p>`)}
    `,
  };
});

async function desktopPairing() {
  const pairing: Pairing = await (await fetch("./desktop/pairing")).json();
  return card("settings-phone-sync", "Phone sync", html`
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
  `);
}

async function phoneSync() {
  const settings = await call("getSyncSettings");
  return card("settings-desktop-sync", "Desktop sync", html`
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
  `);
}

/** Phone only: task reminders arrive on time only with Android's "Alarms & reminders" access. */
async function remindersCard() {
  const exact = await exactAlarmsAllowed();
  return card("settings-reminders", "Task reminders", html`
      <p class="muted small">Tasks with a time get a reminder on this phone at that time, with Done and Snooze (10 minutes).</p>
      ${exact
        ? html`<p class="small">On time to the minute.</p>`
        : html`
            <p class="small">Android may deliver them a few minutes late. Allow Lifeboard "Alarms &amp; reminders" to have them on time.</p>
            <button class="secondary" @click=${async () => { await allowExactAlarms(); await refresh(); }}>Allow exact timing</button>`}
  `);
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
