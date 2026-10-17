// Litter-Robot (Whisker) integration: each update reads every LR4 on the account, keeps its
// latest status for the Hub and Pets screens, and produces a "litter_robot" reading for alert rules.
// It also stores the cats' weigh-ins and checks their weight and visit alerts (cats.ts).
// Sign-in: the Cognito refresh token is reused; when it stops working, Lifeboard signs in
// again with the saved password, and only if that fails does the user get a "signed out" alert.
import { getCredential, saveCredential } from "../credentials.ts";
import type { Db } from "../db/types.ts";
import { saveDeviceStatus } from "../devices.ts";
import { SignedOutError, type Integration } from "../integration.ts";
import { deliverAlerts } from "../notify.ts";
import { cognitoWhiskerApi, WhiskerSignInError, type WhiskerApi } from "./api.ts";
import { checkCatAlerts, saveCats } from "./cats.ts";
import { recordLitterLevels } from "./estimates.ts";
import { checkLitterAlarms } from "./levels.ts";
import { litterRobotStatus } from "./status.ts";

interface WhiskerCredential {
  email: string;
  password: string;
  refreshToken: string;
}

export function makeWhiskerIntegration(api: WhiskerApi = cognitoWhiskerApi): Integration {
  return {
    id: "whisker",
    name: "Whisker (Litter-Robot)",
    signInMethod: "password",

    async isSetUp(db) {
      return Boolean(await getCredential(db, "whisker"));
    },

    async signIn(db, email, password) {
      const tokens = await api.signIn(email.trim(), password);
      await saveCredential<WhiskerCredential>(db, "whisker", { email: email.trim(), password, refreshToken: tokens.refreshToken });
    },

    async update(db) {
      const credential = (await getCredential<WhiskerCredential>(db, "whisker"))!;
      const idToken = await currentIdToken(db, api, credential);
      const robots = (await api.robots(idToken)).map(litterRobotStatus);
      for (const robot of robots) await saveDeviceStatus(db, `litter-robot-${robot.serial}`, "litter_robot", robot.name, robot);
      await checkLitterAlarms(db, robots);
      await recordLitterLevels(db, robots);
      await saveCats(db, await api.pets(idToken));
      await deliverAlerts(await checkCatAlerts(db));
      return robots.map((robot) => ({
        type: "litter_robot",
        subject: robot.name,
        data: {
          status: robot.status,
          online: robot.online,
          drawerLevel: robot.drawerLevel,
          drawerFull: robot.drawerFull,
          litterLevel: robot.litterLevel,
          catWeight: robot.catWeight,
          laserDirty: robot.laserDirty,
        },
      }));
    },
  };
}

async function currentIdToken(db: Db, api: WhiskerApi, credential: WhiskerCredential): Promise<string> {
  try {
    return await api.refresh(credential.email, credential.refreshToken);
  } catch {
    // Refresh token expired or revoked: sign in again with the saved password.
    try {
      const tokens = await api.signIn(credential.email, credential.password);
      await saveCredential<WhiskerCredential>(db, "whisker", { ...credential, refreshToken: tokens.refreshToken });
      return tokens.idToken;
    } catch (error) {
      if (error instanceof WhiskerSignInError) throw new SignedOutError(error.message);
      throw error;
    }
  }
}

export const whisker = makeWhiskerIntegration();
