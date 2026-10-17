// The desktop side of Lifeboard: keeps the desktop database, runs the shared core code for
// the UI (POST /api/<name>), serves the built UI from dist/, and answers the phone's LAN
// sync (POST /sync). Start with `npm run desktop`.
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { api, type ApiName } from "../core/api.ts";
import { getMeta, setMeta } from "../core/db/meta.ts";
import { setAlertDelivery } from "../core/notify.ts";
import { migrate } from "../core/db/schema.ts";
import { hasQueuedChanges, syncScheduleQuietly } from "../core/schedule/push.ts";
import { answerSync, type SyncRequest } from "../core/sync/sync.ts";
import { DATA_DIR, DESKTOP_HOST, DESKTOP_PORT } from "./config.ts";
import { openNodeDb } from "./db/nodeSqlite.ts";
import { registerGoogleSignIn } from "./googleSignIn.ts";
import { showDesktopNotifications } from "./notify.ts";

mkdirSync(DATA_DIR, { recursive: true });
const db = openNodeDb(join(DATA_DIR, "lifeboard.db"));
await migrate(db);

// The secret the phone must send to sync. Made once; shown in the desktop app's settings.
if (!(await getMeta(db, "sync_key"))) await setMeta(db, "sync_key", crypto.randomUUID());
const syncKey = (await getMeta(db, "sync_key"))!;

const server = Fastify({ logger: { level: "warn" }, bodyLimit: 50 * 1024 * 1024 });

// Other machines may only reach /sync, and only with the key. Everything else (the UI and
// its API, which can read and change all data) answers this computer only.
server.addHook("onRequest", async (request, reply) => {
  if (request.url === "/sync") {
    if (!hasSyncKey(request.headers.authorization)) return reply.code(401).send({ error: "Wrong or missing sync key" });
  } else if (!isThisComputer(request.ip)) {
    return reply.code(403).send({ error: "Only available on the desktop itself" });
  }
});

function hasSyncKey(header: string | undefined): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(syncKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function isThisComputer(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

server.post<{ Params: { name: string }; Body: { args?: unknown[] } }>("/api/:name", async (request, reply) => {
  const { name } = request.params;
  // Object.hasOwn so only the functions listed in `api` can be called, nothing inherited.
  if (!Object.hasOwn(api, name)) return reply.code(404).send({ error: `Unknown API call: ${name}` });
  const fn = api[name as ApiName] as (...args: unknown[]) => Promise<unknown>;
  try {
    // Always JSON: Fastify would send a plain string as text, which the UI can't parse, and
    // null stands in for functions that return nothing.
    const result = (await fn(db, ...(request.body?.args ?? []))) ?? null;
    return reply.type("application/json").send(JSON.stringify(result));
  } catch (error) {
    // Core errors are messages meant for the user ("List name can't be empty.").
    request.log.warn(error);
    return reply.code(400).send({ error: (error as Error).message });
  }
});

server.post<{ Body: SyncRequest }>("/sync", async (request) => {
  const answer = await answerSync(db, request.body);
  // Schedule edits made on the phone arrive here; send them on to Google straight away.
  if (await hasQueuedChanges(db)) void syncScheduleQuietly(db);
  return answer;
});

/** What the phone needs to pair with this desktop, for the desktop's settings screen. */
server.get("/desktop/pairing", async () => ({
  addresses: lanAddresses().map((ip) => `http://${ip}:${DESKTOP_PORT}`),
  syncKey,
  lanSyncOn: DESKTOP_HOST !== "127.0.0.1",
}));

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((address) => address && address.family === "IPv4" && !address.internal)
    .map((address) => address!.address);
}

registerGoogleSignIn(server, db, () => api.updateNow(db));

await server.register(fastifyStatic, { root: resolve("dist") });

await server.listen({ host: DESKTOP_HOST, port: DESKTOP_PORT });
console.log(`Lifeboard is running at http://127.0.0.1:${DESKTOP_PORT}`);

// Updates: once at start, then every hour while the server runs (docs/PLAN.md).
const UPDATE_EVERY_HOURS = 1;
setAlertDelivery(showDesktopNotifications);
async function scheduledUpdate() {
  try {
    await api.updateNow(db);
  } catch (error) {
    console.error("Update failed:", error);
  }
}
void scheduledUpdate();
setInterval(scheduledUpdate, UPDATE_EVERY_HOURS * 60 * 60 * 1000);
