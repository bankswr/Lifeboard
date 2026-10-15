// The desktop side of Lifeboard: keeps the desktop database, runs the shared core code for
// the UI (POST /api/<name>), and serves the built UI from dist/. Start with `npm run desktop`.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { api, type ApiName } from "../core/api.ts";
import { migrate } from "../core/db/schema.ts";
import { DATA_DIR, DESKTOP_HOST, DESKTOP_PORT } from "./config.ts";
import { openNodeDb } from "./db/nodeSqlite.ts";

mkdirSync(DATA_DIR, { recursive: true });
const db = openNodeDb(join(DATA_DIR, "lifeboard.db"));
await migrate(db);

const server = Fastify({ logger: { level: "warn" } });

server.post<{ Params: { name: string }; Body: { args?: unknown[] } }>("/api/:name", async (request, reply) => {
  const { name } = request.params;
  // Object.hasOwn so only the functions listed in `api` can be called, nothing inherited.
  if (!Object.hasOwn(api, name)) return reply.code(404).send({ error: `Unknown API call: ${name}` });
  const fn = api[name as ApiName] as (...args: unknown[]) => Promise<unknown>;
  return fn(db, ...(request.body?.args ?? []));
});

await server.register(fastifyStatic, { root: resolve("dist") });

await server.listen({ host: DESKTOP_HOST, port: DESKTOP_PORT });
console.log(`Lifeboard is running at http://${DESKTOP_HOST}:${DESKTOP_PORT}`);
