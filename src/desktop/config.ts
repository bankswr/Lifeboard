// Desktop server settings. Overridable with environment variables.
import { resolve } from "node:path";

export const DESKTOP_PORT = Number(process.env.LIFEBOARD_PORT ?? 5180);

// Localhost only for now. LAN sync (plan phase 2) will need the phone to reach this server.
export const DESKTOP_HOST = process.env.LIFEBOARD_HOST ?? "127.0.0.1";

/** Folder for the desktop database. Gitignored; it holds personal data. */
export const DATA_DIR = resolve(process.env.LIFEBOARD_DATA_DIR ?? "data");
