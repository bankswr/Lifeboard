// Phase 1 spike (docs/PLAN.md): prove we can sign in to Whisker and read Litter-Robot 4
// status from Node. Read-only: sends no commands, saves nothing (not even the password).
//
//   node spikes/litterrobot.ts
//
// Sign-in and the LR4 GraphQL query follow @ddgold/homebridge-litter-robot (MIT) and
// pylitterbot (MIT), the unofficial clients Home Assistant/Homebridge users rely on.
// Throwaway code: the real integration will live in src/core once the spike passes.
import { createInterface } from "node:readline/promises";
import { AuthenticationDetails, CognitoUser, CognitoUserPool, type CognitoUserSession } from "amazon-cognito-identity-js";

// Whisker's public app identifiers (same values as pylitterbot and the Homebridge plugin).
const USER_POOL_ID = "us-east-1_rjhNnZVAm";
const CLIENT_ID = "4552ujeu3aic90nf8qn53levmn";
const LR4_GRAPHQL_URL = "https://lr4.iothings.site/graphql";

// Fields that matter for awareness alerts (full list: pylitterbot robot/models.py).
const LR4_FIELDS = `
  name serial isOnline lastSeen unitPowerStatus robotStatus robotCycleStatus displayCode
  DFILevelPercent isDFIFull isDFIPartialFull litterLevelPercentage litterLevelState
  catDetect catWeight isLaserDirty isBonnetRemoved isHopperRemoved hopperStatus
`;

async function signIn(email: string, password: string): Promise<CognitoUserSession> {
  const pool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });
  const user = new CognitoUser({ Username: email, Pool: pool });
  return new Promise((resolve, reject) =>
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: resolve,
      onFailure: reject,
    }),
  );
}

async function main() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const email = await prompt.question("Whisker email: ");
  const password = await prompt.question("Whisker password (shown as you type): ");
  prompt.close();

  const session = await signIn(email, password);
  const idToken = session.getIdToken();
  const userId = idToken.decodePayload().mid;
  console.log(`Signed in. ID token expires ${new Date(idToken.getExpiration() * 1000).toLocaleString()}.`);
  console.log("Refresh token received:", Boolean(session.getRefreshToken().getToken()));

  const response = await fetch(LR4_GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken.getJwtToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ($userId: String!) { getLitterRobot4ByUser(userId: $userId) { ${LR4_FIELDS} } }`,
      variables: { userId },
    }),
  });
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "));
  const robots = json.data.getLitterRobot4ByUser ?? [];
  if (robots.length === 0) {
    console.log("No Litter-Robot 4 on this account. It may be a Litter-Robot 3 or 5, which use other endpoints.");
  }
  for (const robot of robots) console.log(JSON.stringify(robot, null, 2));
}

main().catch((error) => {
  console.error("Spike failed:", error?.message ?? error);
  process.exit(1);
});
