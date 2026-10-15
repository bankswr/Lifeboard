// Phone version of core/http.ts's cookie session. Capacitor's native HTTP keeps cookies in
// Android's cookie store (which persists across restarts) and sends them by itself, but
// never shows Set-Cookie to JavaScript; cookie values are read back from that store.
import { CapacitorCookies } from "@capacitor/core";
import type { CookieSession } from "../core/http.ts";

export function nativeCookieSession(): CookieSession {
  return {
    fetch: (input, init) => fetch(input, init),
    async getCookie(url, name) {
      return (await CapacitorCookies.getCookies({ url }))[name];
    },
    saved: () => "", // nothing to save: Android keeps the cookies
  };
}
