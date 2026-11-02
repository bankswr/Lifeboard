// Settings. Sync pairing: the desktop shows its address and sync key, also as a QR code; the
// phone scans or enters them and can sync on demand (it also syncs on its own when opened, see
// main.ts). Any number of phones can pair with the same desktop.
import { html } from "lit-html";
import QRCode from "qrcode";
import { firstWorkingAddress, pairingCodeText, parsePairingCode } from "../../../core/sync/pairing.ts";
import { call, platform } from "../../backend.ts";
import { allowExactAlarms, exactAlarmsAllowed } from "../../reminders.ts";
import { scanQrCode } from "../../scanner.ts";
import { syncNow } from "../../sync.ts";
import { refresh, route } from "../app.ts";
import { card } from "../card.ts";

interface Pairing {
  addresses: string[];
  syncKey: string;
  lanSyncOn: boolean;
}

let syncMessage = "";
let pairingBusy = false;

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
      ${card("settings-device", "This device", html`
        <p>Lifeboard ${__APP_VERSION__} <span class="muted">(build ${__APP_COMMIT__})</span></p>
        <p class="muted">Database schema ${info.databaseVersion}${info.databaseVersion === info.schemaVersion ? "" : ` (this build expects ${info.schemaVersion})`}</p>
        <p class="muted">Device ID ${info.deviceId}</p>`)}
    `,
  };
});

async function desktopPairing() {
  const pairing: Pairing = await (await fetch("./desktop/pairing")).json();
  const svg = await QRCode.toString(pairingCodeText(pairing), { type: "svg", margin: 4 });
  return card("settings-phone-sync", "Phone sync", html`
      ${pairing.lanSyncOn
        ? html`
            <p>In the phone app's Settings, under Desktop sync, tap Scan and point it at this code.</p>
            <img class="qr-code" src=${`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt="Phone pairing QR code">
            <p>Or enter one of these addresses and the sync key.</p>
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
      <button class="secondary" ?disabled=${pairingBusy} @click=${scanAndPair}>Scan the desktop's code</button>
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

async function scanAndPair() {
  pairingBusy = true;
  syncMessage = "";
  await refresh();
  try {
    const text = await scanQrCode();
    if (text !== null) {
      const { addresses, syncKey } = parsePairingCode(text);
      syncMessage = "Syncing…";
      await refresh();
      let summary = { sent: 0, received: 0 };
      await firstWorkingAddress(addresses, async (address) => {
        await call("saveSyncSettings", address, syncKey);
        summary = await syncNow();
      }).catch(async (error) => {
        // Left on the first address, so the fields show what was scanned.
        await call("saveSyncSettings", addresses[0], syncKey);
        throw error;
      });
      syncMessage = `Paired. Synced: sent ${summary.sent}, received ${summary.received}.`;
    }
  } catch (error) {
    syncMessage = (error as Error).message;
  }
  pairingBusy = false;
  await refresh();
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
