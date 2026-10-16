// Google sign-in (OAuth 2.0 for installed apps, with PKCE). Written with plain fetch rather
// than google-auth-library because that library only runs under Node, and this code must
// also run on the phone. Only three requests are involved: the sign-in page URL, trading
// the returned code for tokens, and refreshing the access token.
import { SignedOutError } from "../integration.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * What Lifeboard asks Google for: read-only Google Health data (steps; weight and body fat),
 * the list of calendars (to choose which the Schedule shows), editing calendar events, and
 * Google Tasks.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
];

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

/** A fresh access token (valid ~1 hour). Throws SignedOutError when the sign-in has expired or was revoked. */
export async function accessToken(client: GoogleClient, refreshToken: string): Promise<string> {
  try {
    const tokens = await tokenRequest({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    return tokens.access_token;
  } catch (error) {
    // invalid_grant: the refresh token expired (7 days while the OAuth app is in "Testing"),
    // was revoked, or the password changed.
    if ((error as Error).message.includes("invalid_grant")) {
      throw new SignedOutError("Google sign-in expired. Sign in again under Settings → Connections.");
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
