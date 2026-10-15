// Cronometer integration: daily calories and macros into the nutrition_day table.
// Pulls at most once per calendar day per device: Cronometer allows only ~10 exports a day,
// and today is never fetched (the day isn't logged yet), so a second pull would add nothing.
import { getCredential, saveCredential } from "../credentials.ts";
import { addDays, localDate } from "../dates.ts";
import type { Db } from "../db/types.ts";
import { saveNutritionDays, latestNutritionDate } from "../health.ts";
import { SignedOutError, type Integration } from "../integration.ts";
import { CronometerClient, CronometerSessionExpiredError, CronometerSignInError } from "./client.ts";
import { parseDailySummary } from "./parse.ts";

interface CronometerCredential {
  email: string;
  password: string;
  cookies?: string;
  /** Local date of the last successful pull. */
  lastPulledOn?: string;
}

/** Days fetched on the first pull. */
const FIRST_PULL_DAYS = 30;
/** Entries can be logged or fixed a few days late, so each pull re-reads this many days. */
const OVERLAP_DAYS = 3;

/** The dates to fetch, or null if there's nothing new. Ends yesterday. */
export function rangeToFetch(latestStored: string | null, today: string): { start: string; end: string } | null {
  const end = addDays(today, -1);
  const start = latestStored ? addDays(latestStored, -OVERLAP_DAYS) : addDays(end, -(FIRST_PULL_DAYS - 1));
  return start <= end ? { start, end } : null;
}

export const cronometer: Integration = {
  id: "cronometer",
  name: "Cronometer",
  signInMethod: "password",

  async isSetUp(db) {
    return Boolean(await getCredential(db, "cronometer"));
  },

  async update(db) {
    const credential = (await getCredential<CronometerCredential>(db, "cronometer"))!;
    const today = localDate();
    if (credential.lastPulledOn === today) return [];
    const range = rangeToFetch(await latestNutritionDate(db), today);
    if (!range) return [];

    const client = new CronometerClient(credential.cookies);
    let csv: string;
    try {
      csv = await client.exportDailySummary(range.start, range.end);
    } catch (error) {
      if (!(error instanceof CronometerSessionExpiredError)) throw error;
      await signInWithSaved(client, credential);
      csv = await client.exportDailySummary(range.start, range.end);
    }

    await saveNutritionDays(db, parseDailySummary(csv));
    await saveCredential(db, "cronometer", { ...credential, cookies: client.savedCookies(), lastPulledOn: today });
    return [];
  },
};

/** Signs in with the saved email and password; if Cronometer refuses them, the user must sign in again. */
async function signInWithSaved(client: CronometerClient, credential: CronometerCredential) {
  try {
    await client.signIn(credential.email, credential.password);
  } catch (error) {
    if (error instanceof CronometerSignInError) throw new SignedOutError(error.message);
    throw error;
  }
}

/** Signs in from the Connections screen and saves the sign-in on this device. */
export async function signInToCronometer(db: Db, email: string, password: string): Promise<void> {
  const client = new CronometerClient();
  await client.signIn(email.trim(), password);
  await saveCredential<CronometerCredential>(db, "cronometer", { email: email.trim(), password, cookies: client.savedCookies() });
}
