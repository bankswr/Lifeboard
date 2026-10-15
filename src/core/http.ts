// HTTP with cookies for outside services that sign in with a session cookie (Cronometer).
// Desktop (Node): cookies live in a tough-cookie jar the integration saves with its sign-in.
// Phone: Capacitor's native HTTP stores and sends cookies itself and hides Set-Cookie from
// JavaScript (verified on Android 2026-10-15), so the phone app installs its own version at
// start (src/app/nativeCookies.ts) that reads the native cookie store.
import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";

export interface CookieSession {
  fetch: typeof fetch;
  /** The value of a cookie the site set, or undefined. */
  getCookie(url: string, name: string): Promise<string | undefined>;
  /** Text to save and pass back to newCookieSession to resume this session later. */
  saved(): string;
}

type Factory = (saved?: string) => CookieSession;
let factory: Factory = (saved) => jarCookieSession(saved);

export function setCookieSessionFactory(newFactory: Factory): void {
  factory = newFactory;
}

export function newCookieSession(saved?: string): CookieSession {
  return factory(saved);
}

/** A session whose cookies are kept in memory and can be saved as text. */
export function jarCookieSession(saved?: string, baseFetch: typeof fetch = fetch): CookieSession {
  const jar = saved ? CookieJar.deserializeSync(JSON.parse(saved)) : new CookieJar();
  return {
    fetch: makeFetchCookie(baseFetch, jar) as typeof fetch,
    async getCookie(url, name) {
      // A site can set the same cookie for two domains; the longest-lived one is the real
      // one (seen with Cronometer's session cookie in FitThing, 2026-09-18).
      const matches = jar.getCookiesSync(url).filter((cookie) => cookie.key === name);
      const expiry = (cookie: (typeof matches)[number]) => cookie.expiryTime() ?? 0;
      return matches.sort((a, b) => expiry(b) - expiry(a))[0]?.value;
    },
    saved: () => JSON.stringify(jar.serializeSync()),
  };
}
