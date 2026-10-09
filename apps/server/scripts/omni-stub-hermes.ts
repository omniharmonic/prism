/**
 * Stub Hermes over HTTP — a laptop stand-in for the Hermes API server, so the Omni
 * gateway (and the Omni app behind it) can be developed without the Mac Mini.
 * The behaviour lives in `scripts/lib/hermes-stub.ts` (shared with the test suite);
 * this file only puts it on a socket. Start it through `scripts/omni-dev.sh`.
 *
 *   OMNI_STUB_PORT          port (default 18642 — NOT Hermes' own 8642)
 *   OMNI_HERMES_KEY         the dev bearer the gateway presents (≥ 16 chars; required).
 *                           `OMNI_HERMES_KEY_ENV` may name another variable, as in the server.
 *   OMNI_SERVICE_TOKEN      + OMNI_STUB_GATEWAY_URL (http://127.0.0.1:<port>): lets the
 *                           `stub:approval` / `stub:followup` scenarios play the omni-bridge
 *                           plugin against the gateway's loopback hooks. Optional.
 *   OMNI_STUB_STATE         a JSON file to keep sessions, transcripts and jobs in, so a restart
 *                           does not forget the threads the gateway still lists. Unset →
 *                           memory only. `omni-dev.sh` sets it beside the dev database.
 *   OMNI_STUB_QUIET=1       no request log.
 *
 * LOOPBACK ONLY: it binds 127.0.0.1 and refuses to start on anything else. It never
 * prints the key or the service token, and logs only `METHOD path`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import { createHermesStub, fileStubStore, httpBridge, SCENARIOS } from "./lib/hermes-stub";

const HOST = "127.0.0.1";
const MAX_BODY = 1024 * 1024;

function fail(msg: string): never {
  console.error(`[stub-hermes] ${msg}`);
  process.exit(1);
}

const host = process.env.OMNI_STUB_HOST;
if (host !== undefined && host !== "" && host !== HOST) fail(`refusing to bind ${JSON.stringify(host)}: the stub listens on ${HOST} only`);
const port = Number(process.env.OMNI_STUB_PORT ?? 18642);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("OMNI_STUB_PORT must be a port between 1024 and 65535");
if (port === 8642) fail("port 8642 is the real Hermes API server's — pick another");
const key = process.env[process.env.OMNI_HERMES_KEY_ENV || "OMNI_HERMES_KEY"] ?? "";
if (key.length < 16) fail("the dev key is missing or shorter than 16 characters (OMNI_HERMES_KEY)");

const gatewayUrl = process.env.OMNI_STUB_GATEWAY_URL;
const serviceToken = process.env.OMNI_SERVICE_TOKEN;
let bridge;
try {
  bridge = gatewayUrl && serviceToken && serviceToken.length >= 16 ? httpBridge(gatewayUrl, serviceToken) : undefined;
} catch (e) {
  fail((e as Error).message);
}

const quiet = process.env.OMNI_STUB_QUIET === "1";
const statePath = process.env.OMNI_STUB_STATE || "";
const store = statePath ? fileStubStore(statePath, fs) : undefined;
const stub = createHermesStub({
  key,
  bridge,
  store,
  keepaliveMs: 15_000,
  jobs: [
    { id: "0a1b2c3d4e5f", name: "Morning brief (stub)", schedule: "0 7 * * *", enabled: true, state: "scheduled", next_run_at: "2026-10-09T13:00:00Z", last_run_at: "2026-10-08T13:00:00Z", last_status: "ok", deliver: "omni" },
    { id: "f5e4d3c2b1a0", name: "Inbox sweep (stub)", schedule: "*/30 * * * *", enabled: false, state: "paused", next_run_at: null, last_run_at: "2026-10-07T18:30:00Z", last_status: "error", last_error: "stub: a made-up failure", deliver: "omni" },
  ],
  log: quiet ? undefined : (line) => console.log(`[stub-hermes] ${line}`),
});

async function readBody(req: IncomingMessage): Promise<string | null> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) return null;
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const text = await readBody(req);
  if (text === null) {
    res.writeHead(413, { "content-type": "application/json" }).end('{"error":{"message":"body too large","code":"too_large"}}');
    return;
  }
  // The caller hanging up is how the gateway cancels a turn: Hermes interrupts the run.
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
  const method = req.method ?? "GET";
  const r = await stub.fetch(`http://${HOST}:${port}${req.url ?? "/"}`, { method, headers, body: method === "GET" || method === "HEAD" || text === "" ? undefined : text, signal: ac.signal });
  const out: Record<string, string> = {};
  r.headers.forEach((v, k) => (out[k] = v));
  res.writeHead(r.status, out);
  if (!r.body) {
    res.end();
    return;
  }
  res.flushHeaders();
  const reader = r.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      res.write(chunk.value);
    }
    res.end();
  } catch {
    // A scripted drop (or an abort): break the connection, send no terminal frame.
    res.destroy();
  }
}

const server = createServer((req, res) => {
  serve(req, res).catch((e) => {
    console.error(`[stub-hermes] request failed: ${(e as Error).name}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end('{"error":{"message":"stub error","code":"stub_error"}}');
    else res.destroy();
  });
});
server.on("error", (e) => fail(`cannot listen on ${HOST}:${port}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`));
server.listen(port, HOST, () => {
  console.log(`[stub-hermes] listening on http://${HOST}:${port} (loopback only)${bridge ? ", omni-bridge hooks → the dev gateway" : ", no gateway hooks configured"}`);
  console.log(store ? `[stub-hermes] ${stub.sessions.size} session(s) remembered (state file beside the dev database)` : "[stub-hermes] memory only: a restart forgets every session (set OMNI_STUB_STATE)");
  if (!quiet) console.log(`[stub-hermes] scenarios (put the marker in a message): ${Object.keys(SCENARIOS).map((s) => `stub:${s}`).join(" ")}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
  store?.flush();
  server.close();
  server.closeAllConnections();
  process.exit(0);
});
