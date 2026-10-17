/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { DESKTOP_PORT } from "./src/desktop/config.ts";

// The built app is plain static files in dist/, loaded on the phone by Capacitor and on the
// desktop by the Lifeboard server (src/desktop/server.ts), so asset paths must be relative.
export default defineConfig({
  base: "./",
  // amazon-cognito-identity-js (Whisker sign-in) refers to Node's `global`; browsers call it globalThis.
  define: { global: "globalThis" },
  // Agent worktrees (.claude/worktrees/) hold whole copies of the repo; their tests aren't ours.
  test: { exclude: ["**/node_modules/**", ".claude/**"] },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // During `npm run dev`, API calls go to the desktop server (`npm run server`).
    proxy: { "/api": `http://127.0.0.1:${DESKTOP_PORT}` },
  },
});
