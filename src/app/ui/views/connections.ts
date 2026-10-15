// Connections (#/connections): sign in to outside services on this device, or sign out.
// Sign-ins are kept on this device only; the other device signs in separately.
import { html } from "lit-html";
import { call } from "../../backend.ts";
import { act, refresh, route } from "../app.ts";

let message = "";

route(/^\/connections$/, async () => {
  const integrations = await call("listIntegrations");
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
          ? html`
              <section class="card status-row">
                <span>${integration.name}</span>
                <button class="secondary" @click=${() => signOut(integration.id, integration.name)}>Sign out</button>
              </section>
            `
          : html`
              <section class="card">
                <h2>${integration.name}</h2>
                <form @submit=${(event: SubmitEvent) => signIn(event, integration.id)}>
                  <label>Email <input name="email" type="email" autocomplete="username" required></label>
                  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
                  <button type="submit">Sign in</button>
                </form>
              </section>
            `,
      )}
    `,
  };
});

async function signIn(event: SubmitEvent, integrationId: string) {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const fields = new FormData(form);
  const button = form.querySelector("button")!;
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    if (integrationId === "cronometer") {
      await call("signInToCronometer", String(fields.get("email")), String(fields.get("password")));
    }
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
  await act(() => call("signOut", integrationId));
}
