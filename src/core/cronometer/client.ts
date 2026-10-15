// Cronometer's unofficial Daily Summary export, ported from FitThing
// (src/fitthing/cronometer/auth.py and client.py). Flow:
//   1. Sign in with the login form; the session is the `sesnonce` cookie (lasts 14 days).
//   2. GWT-RPC `authenticate` → user id; `generateAuthorizationToken` → a 1-hour export token.
//   3. GET /export?nonce=<token>&generate=dailySummary&start=&end= → CSV.
// The request templates were captured from the live site; if Cronometer redeploys its web
// app they break. How to re-capture them: FitThing agent-notes/2026-09-17-cronometer-endpoints.md.
import { newCookieSession, type CookieSession } from "../http.ts";

const BASE_URL = "https://cronometer.com";
const LOGIN_URL = `${BASE_URL}/login`;
const RPC_URL = `${BASE_URL}/cronometer/app`;
const EXPORT_URL = `${BASE_URL}/export`;
const GWT_MODULE_BASE = `${BASE_URL}/cronometer/`;

// Values from the live site (2026-09-18). Update together if Cronometer redeploys.
const GWT_PERMUTATION = "1008F9FC280FA1C9D6FFD0C3960CC121";
const SERVICE_POLICY_HASH = "13F6CC6C06AE73A6E95DE9B0233AB365";
const SERVICE = "com.cronometer.shared.rpc.CronometerService";

const authenticateBody = (timezoneOffsetMinutes: number) =>
  `7|0|5|${GWT_MODULE_BASE}|${SERVICE_POLICY_HASH}|${SERVICE}|authenticate|` +
  `java.lang.Integer/3438268394|1|2|3|4|1|5|5|${timezoneOffsetMinutes}|`;

const generateTokenBody = (sesnonce: string, userId: string) =>
  `7|0|8|${GWT_MODULE_BASE}|${SERVICE_POLICY_HASH}|${SERVICE}|generateAuthorizationToken|` +
  `java.lang.String/2004016611|I|com.cronometer.shared.user.AuthScope/2065601159|${sesnonce}|` +
  `1|2|3|4|4|5|6|6|7|8|${userId}|3600|7|2|`;

// The login page always has this field; a CSV never does. An expired session gets the
// login page back instead of data.
const LOGIN_PAGE_MARKER = 'name="anticsrf"';

/** Cronometer didn't accept the email and password. The user must sign in again. */
export class CronometerSignInError extends Error {}
/** The saved session has expired; signing in again (with the saved password) fixes it. */
export class CronometerSessionExpiredError extends Error {}
/** Cronometer answered in an unexpected way, probably because its web app changed. */
export class CronometerChangedError extends Error {}

export class CronometerClient {
  private session: CookieSession;

  /** `savedCookies` is what savedCookies() returned last time, to reuse that session. */
  constructor(savedCookies?: string, session: CookieSession = newCookieSession(savedCookies)) {
    this.session = session;
  }

  /** The session's cookies, to save and pass to the constructor next time. */
  savedCookies(): string {
    return this.session.saved();
  }

  private fetch(input: string, init?: RequestInit): Promise<Response> {
    return this.session.fetch(input, init);
  }

  async signIn(email: string, password: string): Promise<void> {
    const loginPage = await this.text(await this.fetch(LOGIN_URL));
    const anticsrf = /<input\b(?=[^>]*name="anticsrf")(?=[^>]*value="([^"]*)")[^>]*>/.exec(loginPage)?.[1];
    if (!anticsrf) throw new CronometerChangedError("Cronometer's login page has changed; Lifeboard needs an update.");

    await this.text(
      await this.fetch(LOGIN_URL, {
        method: "POST",
        body: new URLSearchParams({ username: email, password, userCode: "", anticsrf }),
      }),
    );
    if (!(await this.sesnonce())) {
      throw new CronometerSignInError(
        "Cronometer didn't accept the email and password. (Accounts with two-step sign-in can't be used.)",
      );
    }
    await this.exportToken(); // proves the new session works
  }

  /** The Daily Summary CSV for start..end (inclusive, "YYYY-MM-DD"). */
  async exportDailySummary(start: string, end: string): Promise<string> {
    const token = await this.exportToken();
    const url = `${EXPORT_URL}?${new URLSearchParams({ nonce: token, generate: "dailySummary", start, end })}`;
    const csv = await this.text(await this.fetch(url));
    if (/export limit|too many exports/i.test(csv)) {
      throw new Error("Cronometer's daily export limit is reached; it resets tomorrow.");
    }
    if (csv.includes(LOGIN_PAGE_MARKER)) throw new CronometerSessionExpiredError("Cronometer session expired.");
    return csv;
  }

  /** Runs `authenticate` and `generateAuthorizationToken`; returns a 1-hour export token. */
  private async exportToken(): Promise<string> {
    const sesnonce = await this.sesnonce();
    if (!sesnonce) throw new CronometerSessionExpiredError("Not signed in to Cronometer.");

    // Cronometer's own app sends minutes east of UTC (e.g. -300 for US Eastern).
    const authenticated = await this.rpc(authenticateBody(-new Date().getTimezoneOffset()));
    const userId = /^\/\/OK\[(\d+),/.exec(authenticated)?.[1];
    if (!userId) throw new CronometerSessionExpiredError("Cronometer didn't accept the saved session.");

    const tokenResponse = await this.rpc(generateTokenBody(sesnonce, userId));
    const token = /"([0-9a-f]{32})"/.exec(tokenResponse)?.[1];
    if (!token) throw new CronometerChangedError("Cronometer's export has changed; Lifeboard needs an update.");
    return token;
  }

  private async rpc(body: string): Promise<string> {
    return this.text(
      await this.fetch(RPC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/x-gwt-rpc; charset=utf-8",
          "X-GWT-Module-Base": GWT_MODULE_BASE,
          "X-GWT-Permutation": GWT_PERMUTATION,
        },
        body,
      }),
    );
  }

  /** The session cookie's value; it is also sent inside the export-token request. */
  private sesnonce(): Promise<string | undefined> {
    return this.session.getCookie(BASE_URL, "sesnonce");
  }

  private async text(response: Response): Promise<string> {
    if (!response.ok) throw new Error(`Cronometer answered ${response.status}.`);
    return response.text();
  }
}
