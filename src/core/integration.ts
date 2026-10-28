// What every outside-service integration (Cronometer, Litter-Robot, Google, ...) provides.
// The list of integrations is in integrations.ts; updates.ts runs them.
import type { Db } from "./db/types.ts";
import type { Reading } from "./readings.ts";

/** Thrown by an integration when its sign-in no longer works and the user must sign in again. */
export class SignedOutError extends Error {}

export interface Integration {
  /** Stable id, e.g. "cronometer". Also the key of its saved sign-in (credentials.ts). */
  id: string;
  /** Shown to the user, e.g. "Cronometer". */
  name: string;
  /**
   * How the user signs in: an email/password form, Google's sign-in page (desktop only for
   * now), a QR code scanned with the service's phone app (Smart Life), or no sign-in but a
   * place to look up (Weather).
   */
  signInMethod: "password" | "google" | "qr" | "location";
  /** False until the user has signed in on this device; not-set-up integrations are skipped. */
  isSetUp(db: Db): Promise<boolean>;
  /** For password sign-in: checks the email and password with the service and saves the sign-in. */
  signIn?(db: Db, email: string, password: string): Promise<void>;
  /** For QR sign-in: starts one with the user's account code; returns the text to show as a QR code. */
  startQrSignIn?(db: Db, userCode: string): Promise<string>;
  /** For QR sign-in: true (and the sign-in saved) once the code was scanned; false while waiting. */
  finishQrSignIn?(db: Db): Promise<boolean>;
  /** Its own sign-out, when that's more than forgetting the saved sign-in (Weather: the synced location). */
  signOut?(db: Db): Promise<void>;
  /** Fetches fresh data, stores it, and returns readings for the alert rules. */
  update(db: Db): Promise<Reading[]>;
}
