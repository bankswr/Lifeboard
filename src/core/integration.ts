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
  /** False until the user has signed in on this device; not-set-up integrations are skipped. */
  isSetUp(db: Db): Promise<boolean>;
  /** Fetches fresh data, stores it, and returns readings for the alert rules. */
  update(db: Db): Promise<Reading[]>;
}
