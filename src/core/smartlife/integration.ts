// Smart Life integration (the pet feeders): each update reads every feeder on the account,
// keeps its latest status for the Home screen, and produces a "feeder" reading for alert rules.
// Sign-in: the user enters their Smart Life user code and scans a QR code with the app; after
// that the refresh token keeps the session going. When Smart Life ends it, the user gets a
// "signed out" alert and scans again (there is no password to sign in with silently).
import { getCredential, saveCredential } from "../credentials.ts";
import type { Db } from "../db/types.ts";
import { saveDeviceStatus } from "../devices.ts";
import { SignedOutError, type Integration } from "../integration.ts";
import { needsRefresh, qrCodeText, SmartLifeSignInError, tuyaSmartLifeApi, type SmartLifeApi, type SmartLifeTokens } from "./api.ts";
import { FEEDER_CATEGORY, feederStatus } from "./feeder.ts";

interface SmartLifeCredential {
  userCode: string;
  tokens: SmartLifeTokens;
}

export function makeSmartLifeIntegration(api: SmartLifeApi = tuyaSmartLifeApi): Integration {
  // The QR sign-in in progress on this device, if any. Kept in memory: an abandoned one
  // simply expires on Smart Life's side.
  let pending: { userCode: string; qrToken: string } | null = null;

  return {
    id: "smartlife",
    name: "Smart Life (feeders)",
    signInMethod: "qr",

    async isSetUp(db) {
      return Boolean(await getCredential(db, "smartlife"));
    },

    async startQrSignIn(_db, userCode) {
      const trimmed = userCode.trim();
      if (!trimmed) throw new Error("Enter the user code from the Smart Life app.");
      pending = { userCode: trimmed, qrToken: await api.startQrSignIn(trimmed) };
      return qrCodeText(pending.qrToken);
    },

    async finishQrSignIn(db) {
      if (!pending) throw new Error("Start the sign-in again.");
      const tokens = await api.qrSignInResult(pending.userCode, pending.qrToken);
      if (!tokens) return false;
      await saveCredential<SmartLifeCredential>(db, "smartlife", { userCode: pending.userCode, tokens });
      pending = null;
      return true;
    },

    async update(db) {
      const tokens = await currentTokens(db, api);
      const feeders = (await api.devices(tokens)).filter((d) => d.category === FEEDER_CATEGORY).map(feederStatus);
      for (const feeder of feeders) await saveDeviceStatus(db, `feeder-${feeder.id}`, "feeder", feeder.name, feeder);
      return feeders.map((feeder) => ({
        type: "feeder",
        subject: feeder.name,
        data: { online: feeder.online, feedState: feeder.feedState, lastFeedPortions: feeder.lastFeedPortions },
      }));
    },
  };
}

/** The saved tokens, refreshed (and saved again) when the access token is about to expire. */
async function currentTokens(db: Db, api: SmartLifeApi): Promise<SmartLifeTokens> {
  const credential = (await getCredential<SmartLifeCredential>(db, "smartlife"))!;
  if (!needsRefresh(credential.tokens)) return credential.tokens;
  try {
    const tokens = await api.refresh(credential.tokens);
    await saveCredential<SmartLifeCredential>(db, "smartlife", { ...credential, tokens });
    return tokens;
  } catch (error) {
    if (error instanceof SmartLifeSignInError) throw new SignedOutError(error.message);
    throw error;
  }
}

export const smartlife = makeSmartLifeIntegration();
