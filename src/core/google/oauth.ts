// Google sign-in (OAuth 2.0 for installed apps, with PKCE). Written with plain fetch rather
// than google-auth-library because that library only runs under Node, and this code must
// also run on the phone. Only three requests are involved: the sign-in page URL, trading
// the returned code for tokens, and refreshing the access token.
import { SignedOutError } from "../integration.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Read-only access to the Google Health data Lifeboard uses (steps; weight and body fat). */
export const HEALTH_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
];

/** The Schedule: the list of calendars (to choose which are shown), editing events, and Google Tasks. */
export const SCHEDULE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
];

/**
 * One sign-in asks for everything. Each access token is narrowed to one API's scopes,
 * though: the Google Health API refuses a token that also carries other scopes ("Request
 * contains disallowed OAuth scope(s)", seen 2026-10-16).
 */
export const GOOGLE_SCOPES = [...HEALTH_SCOPES, ...SCHEDULE_SCOPES];

/** The OAuth client from Google Cloud ("Desktop app" type: the downloaded JSON's `installed` part). */
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** A random code verifier and its S256 challenge (PKCE). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function signInUrl(client: GoogleClient, redirectUri: string, challenge: string, state: string): string {
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // so a refresh token is returned even on a repeat sign-in
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })}`;
}

/** Trades the code from the sign-in redirect for a refresh token. */
export async function exchangeCode(client: GoogleClient, code: string, verifier: string, redirectUri: string): Promise<string> {
  const tokens = await tokenRequest({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (!tokens.refresh_token) throw new Error("Google didn't return a refresh token. Try signing in again.");
  return tokens.refresh_token;
}

/**
 * A fresh access token (valid ~1 hour) limited to `scopes`, which must be among those the
 * user granted. Throws SignedOutError when the sign-in has expired or was revoked, or
 * predates some of these scopes.
 */
export async function accessToken(client: GoogleClient, refreshToken: string, scopes: string[]): Promise<string> {
  try {
    const tokens = await tokenRequest({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: scopes.join(" "),
    });
    return tokens.access_token;
  } catch (error) {
    // invalid_grant: the refresh token expired (7 days while the OAuth app is in "Testing"),
    // was revoked, or the password changed.
    if ((error as Error).message.includes("invalid_grant")) {
      throw new SignedOutError("Google sign-in expired. Sign in again under Settings → Connections.");
    }
    // Asking for a scope the sign-in never granted (a sign-in from before Calendar and Tasks).
    if ((error as Error).message.includes("invalid_scope")) {
      throw new SignedOutError("Google needs a new sign-in to allow Calendar and Tasks. Sign in again under Settings → Connections.");
    }
    throw error;
  }
}

async function tokenRequest(fields: Record<string, string>): Promise<Record<string, string>> {
  const response = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams(fields) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google sign-in failed: ${body.error ?? response.status} ${body.error_description ?? ""}`.trim());
  return body;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
