// Desktop server settings. Overridable with environment variables.
import { resolve } from "node:path";

export const DESKTOP_PORT = Number(process.env.LIFEBOARD_PORT ?? 5180);

// Listens on every network interface so the phone can sync over the LAN. Only POST /sync,
// which needs the sync key, answers other machines; the UI and its API answer this computer
// only (see server.ts). Set LIFEBOARD_HOST=127.0.0.1 to turn LAN sync off.
export const DESKTOP_HOST = process.env.LIFEBOARD_HOST ?? "0.0.0.0";

/** Folder for the desktop database. Gitignored; it holds personal data. */
export const DATA_DIR = resolve(process.env.LIFEBOARD_DATA_DIR ?? "data");
