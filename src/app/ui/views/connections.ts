// Connections (#/connections, under Settings): how each connection is doing, sign in to
// outside services on this device, or sign out. Sign-ins are kept on this device only; the
// other device signs in separately.
import { html } from "lit-html";
import QRCode from "qrcode";
import { authorizeOnPhone } from "../../../core/google/token.ts";
import { HEALTH_SCOPES, SCHEDULE_SCOPES } from "../../../core/google/oauth.ts";
import { call, platform } from "../../backend.ts";
import { revokeNativeGoogle } from "../../googleAuth.ts";
import type { ConnectionInfo } from "../../../core/updates.ts";
import { act, refresh, route } from "../app.ts";
import { card } from "../card.ts";
import { formatTime } from "../format.ts";

let message = "";
/** The QR code of a sign-in in progress, as an image URL, and whose it is. */
let qrSignIn: { integrationId: string; image: string } | null = null;

/** How often to ask whether the QR code was scanned, and for how long (Smart Life's codes expire). */
const QR_POLL_MS = 2000;
const QR_WAIT_MS = 3 * 60 * 1000;

route(/^\/connections$/, async () => {
  const [integrations, { connections }] = await Promise.all([call("listIntegrations"), call("getStatus")]);
  const connectionOf = (id: string) => connections.find((connection) => connection.id === id);
  const shownMessage = message;
  message = "";
  return {
    section: "settings",
    content: html`
      <header class="page-header">
        <a class="back" href="#/settings" aria-label="Back to settings">←</a>
        <h1>Connections</h1>
      </header>
      <p class="muted">Sign-ins are saved on this device only.</p>
      ${shownMessage ? html`<p>${shownMessage}</p>` : ""}
      ${integrations.map((integration) =>
        integration.signedIn
          ? card(`connection-${integration.id}`, integration.name, connectionStatus(connectionOf(integration.id)), {
              actions: html`<button class="secondary" @click=${() => signOut(integration.id, integration.name)}>Sign out</button>`,
            })
          : integration.signInMethod === "google"
            ? googleSignIn(integration.id, integration.name)
            : integration.signInMethod === "qr"
              ? qrSignInCard(integration.id, integration.name)
              : card(`connection-${integration.id}`, integration.name, html`
                  <form @submit=${(event: SubmitEvent) => signIn(event, integration.id)}>
                    <label>Email <input name="email" type="email" autocomplete="username" required></label>
                    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
                    <button type="submit">Sign in</button>
                  </form>
                `),
      )}
    `,
  };
});

const STATUS_TEXT: Record<ConnectionInfo["status"], string> = {
  connected: "Connected",
  signed_out: "Signed out: sign in again",
  error: "Problem",
};

/** The connection's result at the last update; nothing before its first update. */
function connectionStatus(connection: ConnectionInfo | undefined) {
  if (!connection) return html`<p class="muted small">Not checked yet.</p>`;
  return html`
    <p class="small"><span class="status ${connection.status}">${STATUS_TEXT[connection.status]}</span></p>
    ${connection.message ? html`<p class="muted small">${connection.message}</p>` : ""}
    <p class="muted small">Last success: ${formatTime(connection.lastSuccessAt) ?? "never"}</p>
  `;
}

function googleSignIn(integrationId: string, name: string) {
  return card(
    `connection-${integrationId}`,
    name,
    platform === "desktop"
      ? html`<a class="button" href="/oauth/google/start">Sign in with Google</a>`
      : html`
          <p class="muted small">
            The desktop's Google data reaches this phone when they sync. As a backup, this phone
            can sign in too: it then reads and updates Google itself, but only when it hasn't
            synced with the desktop for 12 hours or more.
          </p>
          <button @click=${signInOnPhone}>Sign in with Google</button>`,
  );
}

/** Asks Android for Google access (the consent screens), then records the sign-in. */
async function signInOnPhone() {
  try {
    // Two grants: the Health API refuses tokens that also carry Calendar or Tasks scopes.
    await authorizeOnPhone([HEALTH_SCOPES, SCHEDULE_SCOPES]);
    await call("savePhoneGoogleSignIn");
    message = "Signed in to Google on this phone (used while away from the desktop).";
  } catch (error) {
    message = (error as Error).message;
  }
  await refresh();
}

function qrSignInCard(integrationId: string, name: string) {
  if (qrSignIn?.integrationId === integrationId) {
    return card(`connection-${integrationId}`, name, html`
      <p>In the Smart Life app, tap <strong>+</strong> → <strong>Scan</strong>, scan this code, and confirm.</p>
      <img class="qr-code" src=${qrSignIn.image} alt="Smart Life sign-in QR code">
      <p class="muted small">Waiting for the scan…</p>
    `);
  }
  return card(`connection-${integrationId}`, name, html`
    <p class="muted small">
      Your user code is in the Smart Life app under Me → Settings → Account and Security → User Code.
      ${platform === "android" ? "On the phone, the QR code has to be scanned from another screen." : ""}
    </p>
    <form @submit=${(event: SubmitEvent) => startQrSignIn(event, integrationId)}>
      <label>User code <input name="userCode" autocomplete="off" required></label>
      <button type="submit">Show QR code</button>
    </form>
  `);
}

async function startQrSignIn(event: SubmitEvent, integrationId: string) {
  event.preventDefault();
  const userCode = String(new FormData(event.target as HTMLFormElement).get("userCode"));
  try {
    const text = await call("startQrSignIn", integrationId, userCode);
    const svg = await QRCode.toString(text, { type: "svg", margin: 4 });
    qrSignIn = { integrationId, image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
  } catch (error) {
    message = (error as Error).message;
  }
  await refresh();
  if (qrSignIn) await waitForScan(integrationId);
}

async function waitForScan(integrationId: string) {
  const deadline = Date.now() + QR_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, QR_POLL_MS));
      if (await call("finishQrSignIn", integrationId)) {
        qrSignIn = null;
        message = "Signed in. Fetching data…";
        await refresh();
        await call("updateNow");
        message = "Signed in and up to date.";
        return;
      }
    }
    message = "The QR code wasn't scanned in time. Try again.";
  } catch (error) {
    message = (error as Error).message;
  } finally {
    qrSignIn = null;
    await refresh();
  }
}

async function signIn(event: SubmitEvent, integrationId: string) {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const fields = new FormData(form);
  const button = form.querySelector("button")!;
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    await call("signInWithPassword", integrationId, String(fields.get("email")), String(fields.get("password")));
    message = "Signed in. Fetching data…";
    await refresh();
    await call("updateNow");
    message = "Signed in and up to date.";
  } catch (error) {
    message = (error as Error).message;
  }
  await refresh();
}

async function signOut(integrationId: string, name: string) {
  if (!confirm(`Sign out of ${name} on this device? Data already fetched is kept.`)) return;
  if (platform === "android" && integrationId === "google") {
    // On the phone, also withdraw Android's grant; sign out of Lifeboard even if that fails.
    try {
      await revokeNativeGoogle();
    } catch (error) {
      message = `Signed out, but Google's access wasn't withdrawn (${(error as Error).message}). Remove it under myaccount.google.com → Security → Third-party connections.`;
    }
  }
  await act(() => call("signOut", integrationId));
}
