import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getCredential, saveCredential } from "../src/core/credentials.ts";
import { CronometerClient } from "../src/core/cronometer/client.ts";
import { jarCookieSession, setCookieSessionFactory } from "../src/core/http.ts";
import { cronometer, rangeToFetch } from "../src/core/cronometer/integration.ts";
import { parseDailySummary } from "../src/core/cronometer/parse.ts";
import { migrate } from "../src/core/db/schema.ts";
import { recentNutrition } from "../src/core/health.ts";
import { runUpdate } from "../src/core/updates.ts";
import { openNodeDb } from "../src/desktop/db/nodeSqlite.ts";

// Made-up numbers with the real export's header row (copied from FitThing's fixture).
const FIXTURE = readFileSync(new URL("./fixtures/cronometer_daily_summary.csv", import.meta.url), "utf8");

describe("parseDailySummary", () => {
  it("reads date, calories and macros from the real header layout", () => {
    const days = parseDailySummary(FIXTURE);
    expect(days.length).toBe(3);
    for (const day of days) {
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof day.calories).toBe("number");
      expect(typeof day.proteinG).toBe("number");
    }
  });

  it("converts kJ to kcal and keeps blanks as null", () => {
    const days = parseDailySummary("Date,Energy (kJ),Protein (g),Carbs (g),Fat (g)\n2026-10-01,4184,,50,20\n");
    expect(days).toEqual([{ date: "2026-10-01", calories: 1000, proteinG: null, carbsG: 50, fatG: 20 }]);
  });

  it("refuses an export without a required column", () => {
    expect(() => parseDailySummary("Date,Energy (kcal),Carbs (g),Fat (g)\n2026-10-01,1,2,3\n")).toThrow(/protein/);
  });
});

describe("rangeToFetch", () => {
  it("fetches 90 days up to yesterday the first time", () => {
    expect(rangeToFetch(null, "2026-10-15")).toEqual({ start: "2026-07-17", end: "2026-10-14" });
  });
  it("re-reads 3 days before the newest stored day after that", () => {
    expect(rangeToFetch("2026-10-14", "2026-10-15", "2026-07-17")).toEqual({ start: "2026-10-11", end: "2026-10-14" });
    // Stored data but no history pull yet (an install from before it): fetch the history once.
    expect(rangeToFetch("2026-10-14", "2026-10-15")).toEqual({ start: "2026-07-17", end: "2026-10-14" });
  });
});

/**
 * A pretend cronometer.com: just enough of the login form, the two GWT-RPC calls and the
 * export to exercise the client. `password` is the one it accepts; `sessions` are valid nonces.
 */
function fakeCronometer(password: string) {
  const sessions = new Set<string>();
  const calls: string[] = [];
  const respond = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });
  const loginPage = '<form><input type="hidden" name="anticsrf" value="abc123"></form>';

  // Real fetch responses carry their URL, which fetch-cookie needs to store cookies.
  const server = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await handle(new Request(input, init));
    Object.defineProperty(response, "url", { value: new Request(input).url });
    return response;
  };
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const session = /sesnonce=(\w+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/login" && request.method === "GET") return respond(loginPage);
    if (url.pathname === "/login") {
      const form = new URLSearchParams(await request.text());
      if (form.get("password") !== password || form.get("anticsrf") !== "abc123") return respond(loginPage);
      const nonce = `s${sessions.size + 1}`;
      sessions.add(nonce);
      return respond("<html>welcome</html>", { "Set-Cookie": `sesnonce=${nonce}; Path=/; Max-Age=1209600; Secure` });
    }
    if (url.pathname === "/cronometer/app") {
      const body = await request.text();
      if (!session || !sessions.has(session)) return respond("//EX[1,0]");
      // As on the live site since 2026-10: authenticate's string table carries the session
      // value that generateAuthorizationToken wants (alongside other hex strings); the
      // cookie value itself is rejected.
      const sessionValue = session.replace("s", "").padStart(32, "f");
      if (body.includes("|authenticate|")) {
        return respond(`//OK[4242,0,["com.example.User/1","${"1".repeat(32)}","${sessionValue}","x"],0,7]`);
      }
      if (body.includes(`|${sessionValue}|`)) return respond('//OK[1,["0123456789abcdef0123456789abcdef"],0,7]');
      return respond('//EX[2,1,["NotLoggedInException/1","Invalid or expired session"],0,7]');
    }
    if (url.pathname === "/export" && url.searchParams.get("nonce") === "0123456789abcdef0123456789abcdef") {
      return respond(`Date,Energy (kcal),Protein (g),Carbs (g),Fat (g)\n${url.searchParams.get("end")},2100,150,200,70\n`);
    }
    return respond(loginPage);
  };
  return { fetch: server as typeof fetch, sessions, calls };
}

describe("CronometerClient", () => {
  it("signs in, exports, and reuses the saved session", async () => {
    const site = fakeCronometer("right");
    const client = new CronometerClient(undefined, jarCookieSession(undefined, site.fetch));
    await client.signIn("me@example.com", "right");
    expect(await client.exportDailySummary("2026-10-01", "2026-10-02")).toContain("2026-10-02,2100");

    const again = new CronometerClient(undefined, jarCookieSession(client.savedCookies(), site.fetch));
    await again.exportDailySummary("2026-10-01", "2026-10-02");
    expect(site.sessions.size).toBe(1); // no second sign-in
  });

  it("rejects a wrong password", async () => {
    const client = new CronometerClient(undefined, jarCookieSession(undefined, fakeCronometer("right").fetch));
    await expect(client.signIn("me@example.com", "wrong")).rejects.toThrow(/didn't accept the email and password/);
  });
});

describe("Cronometer integration", () => {
  // The integration makes its own cookie sessions, so these tests point them at the fake site.
  async function withFakeSite(password: string, test: (site: ReturnType<typeof fakeCronometer>) => Promise<void>) {
    const site = fakeCronometer(password);
    setCookieSessionFactory((saved) => jarCookieSession(saved, site.fetch));
    try {
      await test(site);
    } finally {
      setCookieSessionFactory((saved) => jarCookieSession(saved));
    }
  }

  async function signedInDb(password: string) {
    const db = openNodeDb(":memory:");
    await migrate(db);
    await saveCredential(db, "cronometer", { email: "me@example.com", password });
    return db;
  }

  it("signs in with the saved password when the session is missing or expired, and pulls once a day", async () => {
    await withFakeSite("right", async (site) => {
      const db = await signedInDb("right");
      const result = await runUpdate(db, [cronometer]);
      expect(result.connections[0]).toMatchObject({ name: "Cronometer", status: "connected" });
      expect((await recentNutrition(db))[0]).toMatchObject({ calories: 2100, proteinG: 150 });

      const callsBefore = site.calls.length;
      await runUpdate(db, [cronometer]);
      expect(site.calls.length).toBe(callsBefore); // already pulled today
      expect((await getCredential<{ lastPulledOn: string }>(db, "cronometer"))!.lastPulledOn).toMatch(/^\d{4}-/);
    });
  });

  it("reports signed out (and alerts) when the saved password stops working", async () => {
    await withFakeSite("changed", async () => {
      const db = await signedInDb("old password");
      const result = await runUpdate(db, [cronometer]);
      expect(result.connections[0]).toMatchObject({ status: "signed_out" });
      expect(result.alerts.map((a) => a.message)[0]).toMatch(/^Cronometer: signed_out\. Cronometer didn't accept/);
    });
  });
});
