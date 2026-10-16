// Cronometer integration: daily calories and macros into the nutrition_day table.
// Pulls at most once per calendar day per device: Cronometer allows only ~10 exports a day,
// and today is never fetched (the day isn't logged yet), so a second pull would add nothing.
import { getCredential, saveCredential } from "../credentials.ts";
import { addDays, localDate } from "../dates.ts";
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
  /** Earliest day the history pull has covered; absent until it has run. */
  historyFrom?: string;
}

/**
 * Days of history fetched once (user, 2026-10-16: 90 days, as for Google). Raising this
 * makes every device fetch the longer history at its next update.
 */
export const HISTORY_DAYS = 90;
/** Entries can be logged or fixed a few days late, so each pull re-reads this many days. */
const OVERLAP_DAYS = 3;

/** The first day of the history pull. */
export function historyStart(today: string): string {
  return addDays(today, -HISTORY_DAYS);
}

/**
 * The dates to fetch, or null if there's nothing new. Ends yesterday. Starts at the history
 * start until the history has been fetched (`historyFrom` covers it).
 */
export function rangeToFetch(latestStored: string | null, today: string, historyFrom?: string): { start: string; end: string } | null {
  const end = addDays(today, -1);
  const needsHistory = !historyFrom || historyFrom > historyStart(today);
  const start = latestStored && !needsHistory ? addDays(latestStored, -OVERLAP_DAYS) : historyStart(today);
  return start <= end ? { start, end } : null;
}

export const cronometer: Integration = {
  id: "cronometer",
  name: "Cronometer",
  signInMethod: "password",

  async isSetUp(db) {
    return Boolean(await getCredential(db, "cronometer"));
  },

  async signIn(db, email, password) {
    const client = new CronometerClient();
    await client.signIn(email.trim(), password);
    await saveCredential<CronometerCredential>(db, "cronometer", { email: email.trim(), password, cookies: client.savedCookies() });
  },

  async update(db) {
    const credential = (await getCredential<CronometerCredential>(db, "cronometer"))!;
    const today = localDate();
    const needsHistory = !credential.historyFrom || credential.historyFrom > historyStart(today);
    // One export covers the whole range, so the history pull costs one of the ~10 a day.
    if (credential.lastPulledOn === today && !needsHistory) return [];
    const range = rangeToFetch(await latestNutritionDate(db), today, credential.historyFrom);
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
    await saveCredential(db, "cronometer", {
      ...credential, cookies: client.savedCookies(), lastPulledOn: today,
      historyFrom: needsHistory ? range.start : credential.historyFrom,
    });
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

