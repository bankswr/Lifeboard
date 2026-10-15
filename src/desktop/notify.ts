// Desktop pop-up notifications through the desktop's own notifier (notify-send on Linux).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NewAlert } from "../core/rules.ts";

const run = promisify(execFile);

export async function showDesktopNotifications(alerts: NewAlert[]): Promise<void> {
  for (const alert of alerts) await run("notify-send", ["--app-name=Lifeboard", "Lifeboard", alert.message]);
}
