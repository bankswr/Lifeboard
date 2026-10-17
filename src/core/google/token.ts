// Where Google access tokens come from, and whether this device talks to Google at all.
// - Desktop: a refresh token from the browser sign-in (oauth.ts), as before.
// - Phone (user, 2026-10-17; docs/PLAN.md phase 7): Android's own Google authorization
//   (Google Play services), installed by the phone app at start like the cookie session in
//   core/http.ts. Play services keeps the grant, so nothing secret is saved here.
// The phone's sign-in is a backup: it uses Google only when it hasn't synced with the desktop
// for 12 hours or more (away from home). Otherwise the desktop is the only device talking to
// Google, so the two never push the same Calendar or Tasks change.
import { getCredential } from "../credentials.ts";
import { get, type Db } from "../db/types.ts";
import { SignedOutError } from "../integration.ts";
import { accessToken, type GoogleClient } from "./oauth.ts";

/** What both kinds of sign-in keep besides how to get a token. */
interface GoogleProgress {
  /** Earliest day the history pull has covered; absent until it has run. */
  historyFrom?: string;
  /** Local date of the last successful health pull. */
  healthPulledOn?: string;
}

/** The desktop's sign-in: the OAuth client and the refresh token from the browser sign-in. */
export interface DesktopGoogleCredential extends GoogleClient, GoogleProgress {
  refreshToken: string;
}

/** The phone's sign-in: Android keeps the grant; Lifeboard only records that it was given. */
export interface PhoneGoogleCredential extends GoogleProgress {
  android: true;
}

export type GoogleCredential = DesktopGoogleCredential | PhoneGoogleCredential;

/**
 * Asks Android for an access token for `scopes`. With `interactive` false it must not show
 * anything and fails with NativeGoogleConsentNeeded if the user has to agree first.
 */
export type NativeGoogleAuthorizer = (scopes: string[], interactive: boolean) => Promise<string>;

/** Android needs the user to agree (again) before giving a token. */
export class NativeGoogleConsentNeeded extends Error {}

let nativeAuthorizer: NativeGoogleAuthorizer | null = null;

/** Installed by the phone app at start (src/app/googleAuth.ts). */
export function setNativeGoogleAuthorizer(authorizer: NativeGoogleAuthorizer | null): void {
  nativeAuthorizer = authorizer;
}

/** Signs this phone in with Android's authorization: asks for each scope set, showing consent if needed. */
export async function authorizeOnPhone(scopeSets: string[][]): Promise<void> {
  if (!nativeAuthorizer) throw new Error("Google sign-in on this device isn't available.");
  for (const scopes of scopeSets) await nativeAuthorizer(scopes, true);
}

/** Hours without a desktop sync after which the phone uses its own Google sign-in. */
export const AWAY_AFTER_HOURS = 12;

export async function getGoogleCredential(db: Db): Promise<GoogleCredential | undefined> {
  return getCredential<GoogleCredential>(db, "google");
}

export function isPhoneCredential(credential: GoogleCredential): credential is PhoneGoogleCredential {
  return "android" in credential && credential.android === true;
}

/**
 * Whether this device should talk to Google now. The desktop always does; the phone only
 * when its last sync with a desktop is 12+ hours old (or it has never synced with one).
 */
export async function googleActiveHere(db: Db, credential: GoogleCredential, now = new Date()): Promise<boolean> {
  if (!isPhoneCredential(credential)) return true;
  const lastSync = await lastDesktopSync(db);
  return lastSync === null || now.getTime() - new Date(lastSync).getTime() >= AWAY_AFTER_HOURS * 3_600_000;
}

async function lastDesktopSync(db: Db): Promise<string | null> {
  return (await get(db, "SELECT MAX(last_synced_at) AS at FROM sync_peer"))?.at ?? null;
}

/** An access token for `scopes`, from whichever sign-in this device has. */
export async function googleAccessToken(credential: GoogleCredential, scopes: string[]): Promise<string> {
  if (!isPhoneCredential(credential)) return accessToken(credential, credential.refreshToken, scopes);
  if (!nativeAuthorizer) throw new Error("Google sign-in on this device isn't available.");
  try {
    return await nativeAuthorizer(scopes, false);
  } catch (error) {
    if (error instanceof NativeGoogleConsentNeeded) {
      throw new SignedOutError("Google needs you to sign in again on this phone. Sign in under Settings → Connections.");
    }
    throw error;
  }
}
