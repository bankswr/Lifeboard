/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { DESKTOP_PORT } from "./src/desktop/config.ts";

// The app's version lives only in package.json (the Android build reads it too, see
// android/app/build.gradle); the commit says exactly which code a device is running.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const commit = gitCommit();

function gitCommit(): string {
  try {
    const hash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    // Untracked files (e.g. a download left in the folder) aren't part of the build.
    const changed = execSync("git status --porcelain --untracked-files=no", { encoding: "utf8" }).trim() !== "";
    return changed ? `${hash}+changes` : hash;
  } catch {
    return "unknown"; // not built from a git checkout
  }
}

// The built app is plain static files in dist/, loaded on the phone by Capacitor and on the
// desktop by the Lifeboard server (src/desktop/server.ts), so asset paths must be relative.
export default defineConfig({
  base: "./",
  // amazon-cognito-identity-js (Whisker sign-in) refers to Node's `global`; browsers call it globalThis.
  define: {
    global: "globalThis",
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
  },
  // Agent worktrees (.claude/worktrees/) hold whole copies of the repo; their tests aren't ours.
  test: { exclude: ["**/node_modules/**", ".claude/**"] },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // During `npm run dev`, API calls go to the desktop server (`npm run server`).
    proxy: { "/api": `http://127.0.0.1:${DESKTOP_PORT}` },
  },
});
