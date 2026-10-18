// Whisker's cloud API for the Litter-Robot 4, read-only. Sign-in is AWS Cognito, through
// AWS's own amazon-cognito-identity-js (runs in Node and in the phone's WebView). Status is
// read from the LR4 GraphQL API, the cats' weigh-ins from the pet profile API. Field names and status rules follow pylitterbot (MIT, used
// by Home Assistant) and @ddgold/homebridge-litter-robot (MIT); see
// agent-notes/2026-10-15-pet-api-research.md. Lifeboard never sends commands to the robot.
import {
  AuthenticationDetails,
  CognitoRefreshToken,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";

// Whisker's public app identifiers (the same values pylitterbot uses).
const USER_POOL_ID = "us-east-1_rjhNnZVAm";
const CLIENT_ID = "4552ujeu3aic90nf8qn53levmn";
const LR4_GRAPHQL_URL = "https://lr4.iothings.site/graphql";
const PET_PROFILE_URL = "https://pet-profile.iothings.site/graphql/";

/** The LR4 fields Lifeboard reads (full list: pylitterbot robot/models.py). */
const LR4_FIELDS = `
  name serial isOnline lastSeen unitPowerStatus robotStatus robotCycleState displayCode
  DFILevelPercent isDFIFull litterLevelPercentage catWeight isLaserDirty isBonnetRemoved
`;

export type RawRobot = Record<string, any>;

/** A pet profile with its weigh-ins (Whisker keeps about the last 7 days; pylitterbot pet.py). */
export interface RawPet {
  petId: string;
  name: string;
  weightHistory: { weight: number; timestamp: string }[] | null;
}

/** One entry of a robot's activity log, e.g. value "catWeight" or "robotCycleStatusDump". */
export interface ActivityEntry {
  /** UTC, "YYYY-MM-DD HH:MM:SS" plus fractions of a second. */
  timestamp: string;
  value: string;
}

export interface WhiskerTokens {
  idToken: string;
  refreshToken: string;
}

/** Cognito refused the email and password. */
export class WhiskerSignInError extends Error {}

/** The calls the integration makes; tests swap in a fake. */
export interface WhiskerApi {
  signIn(email: string, password: string): Promise<WhiskerTokens>;
  /** A fresh ID token from a refresh token; throws when the refresh token no longer works. */
  refresh(email: string, refreshToken: string): Promise<string>;
  robots(idToken: string): Promise<RawRobot[]>;
  pets(idToken: string): Promise<RawPet[]>;
  /** An LR4's activity log from `since` (UTC) to now. */
  activity(idToken: string, serial: string, since: Date): Promise<ActivityEntry[]>;
}

// Cognito's library keeps tokens in browser storage by default; Lifeboard saves its own
// copy with the sign-in, so the library gets a throwaway in-memory store.
const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  };
};

function cognitoUser(email: string): CognitoUser {
  const Storage = memoryStorage();
  const pool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID, Storage });
  return new CognitoUser({ Username: email, Pool: pool, Storage });
}

export const cognitoWhiskerApi: WhiskerApi = {
  signIn(email, password) {
    return new Promise((resolve, reject) =>
      cognitoUser(email).authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
        onSuccess: (session) => resolve(tokensOf(session)),
        onFailure: (error) =>
          reject(
            error?.code === "NotAuthorizedException" || error?.code === "UserNotFoundException"
              ? new WhiskerSignInError("Whisker didn't accept the email and password.")
              : error,
          ),
      }),
    );
  },

  refresh(email, refreshToken) {
    return new Promise((resolve, reject) =>
      cognitoUser(email).refreshSession(new CognitoRefreshToken({ RefreshToken: refreshToken }), (error, session) =>
        error ? reject(error) : resolve(session.getIdToken().getJwtToken()),
      ),
    );
  },

  async robots(idToken) {
    const data = await graphql(LR4_GRAPHQL_URL, idToken,
      `query ($userId: String!) { getLitterRobot4ByUser(userId: $userId) { ${LR4_FIELDS} } }`);
    return data.getLitterRobot4ByUser ?? [];
  },

  async pets(idToken) {
    const data = await graphql(PET_PROFILE_URL, idToken,
      "query ($userId: String!) { getPetsByUser(userId: $userId) { petId name weightHistory { weight timestamp } } }");
    return data.getPetsByUser ?? [];
  },

  async activity(idToken, serial, since) {
    // Without a start Whisker returns only about the last 6 days
    // (agent-notes/2026-10-17-cat-weights.md); the limit is far above an hour's worth.
    const data = await graphql(LR4_GRAPHQL_URL, idToken,
      `query ($serial: String!, $start: String) {
        getLitterRobot4Activity(serial: $serial, startTimestamp: $start, limit: 2000, consumer: "app") { timestamp value } }`,
      { serial, start: since.toISOString().slice(0, 19).replace("T", " ") });
    return data.getLitterRobot4Activity ?? [];
  },
};

/** Runs a query for the signed-in user (its id is the ID token's `mid` claim). */
async function graphql(url: string, idToken: string, query: string, variables: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const userId = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).mid;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { userId, ...variables } }),
  });
  if (!response.ok) throw new Error(`Whisker answered ${response.status}.`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`Whisker: ${body.errors.map((e: { message: string }) => e.message).join("; ")}`);
  return body.data;
}

function tokensOf(session: CognitoUserSession): WhiskerTokens {
  return { idToken: session.getIdToken().getJwtToken(), refreshToken: session.getRefreshToken().getToken() };
}
