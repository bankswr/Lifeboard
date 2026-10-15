// Google sign-in on the desktop. The Connections screen links to /oauth/google/start, which
// sends the browser to Google; Google sends it back to /oauth/google/callback with a code,
// which is traded for a refresh token and saved. Both routes answer this computer only
// (see the onRequest hook in server.ts).
//
// Needs the OAuth client JSON downloaded from Google Cloud ("Desktop app" client) at
// data/google_client_secret.json; FitThing's secrets/client_secret.json is the same kind of file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { saveCredential } from "../core/credentials.ts";
import type { Db } from "../core/db/types.ts";
import type { GoogleCredential } from "../core/google/integration.ts";
import { exchangeCode, pkcePair, signInUrl, type GoogleClient } from "../core/google/oauth.ts";
import { DATA_DIR, DESKTOP_PORT } from "./config.ts";

const CLIENT_FILE = join(DATA_DIR, "google_client_secret.json");
const REDIRECT_URI = `http://127.0.0.1:${DESKTOP_PORT}/oauth/google/callback`;

/** Sign-ins in progress: state → PKCE verifier. */
const pending = new Map<string, string>();

export function registerGoogleSignIn(server: FastifyInstance, db: Db, afterSignIn: () => Promise<unknown>) {
  server.get("/oauth/google/start", async (_request, reply) => {
    const client = readClient();
    if (!client) {
      return reply.type("text/html").send(
        `<p>Google sign-in needs the OAuth client file at <code>${CLIENT_FILE}</code>.</p>
         <p>Copy FitThing's <code>secrets/client_secret.json</code> there (or download a "Desktop app"
         client from Google Cloud), then try again.</p><p><a href="/#/connections">Back</a></p>`,
      );
    }
    const { verifier, challenge } = await pkcePair();
    const state = crypto.randomUUID();
    pending.set(state, verifier);
    return reply.redirect(signInUrl(client, REDIRECT_URI, challenge, state));
  });

  server.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/oauth/google/callback", async (request, reply) => {
    const { code, state, error } = request.query;
    const verifier = state ? pending.get(state) : undefined;
    if (state) pending.delete(state);
    const client = readClient();
    if (error || !code || !verifier || !client) {
      return reply.type("text/html").send(`<p>Google sign-in didn't finish (${error ?? "missing code"}).</p><p><a href="/#/connections">Back</a></p>`);
    }
    const refreshToken = await exchangeCode(client, code, verifier, REDIRECT_URI);
    await saveCredential<GoogleCredential>(db, "google", { ...client, refreshToken });
    void afterSignIn(); // fetch data in the background; the Connections screen shows the result
    return reply.redirect("/#/connections");
  });
}

function readClient(): GoogleClient | null {
  try {
    const { installed } = JSON.parse(readFileSync(CLIENT_FILE, "utf8"));
    return { clientId: installed.client_id, clientSecret: installed.client_secret };
  } catch {
    return null;
  }
}
