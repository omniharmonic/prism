/**
 * A FAKE vault MCP — a tiny MCP server (streamable HTTP, JSON answers) with the Parachute
 * vault's tool names (`query-notes`, `create-note`, `update-note`, `delete-note`,
 * `vault-info`), keeping notes in memory. DEV ONLY: it lets a dev Hermes on the fake model
 * exercise real MCP tool calls — through Hermes' tool-search bridge, with real results —
 * without a vault. docs/omni-module.md "Testing against a real Hermes".
 *
 *   OMNI_FAKE_MCP_PORT   port (default 18663)
 *   OMNI_FAKE_MCP_QUIET=1
 *
 * In the dev Hermes' config.yaml:
 *   mcp_servers:
 *     parachute: {url: "http://127.0.0.1:18663/mcp", headers: {Authorization: "Bearer fake-vault-token"}}
 *
 * LOOPBACK ONLY. The bearer is a fixed dev string, not a secret; nothing here leaves the machine.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

const HOST = "127.0.0.1";
const port = Number(process.env.OMNI_FAKE_MCP_PORT ?? 18663);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("[fake-mcp] OMNI_FAKE_MCP_PORT must be a port between 1024 and 65535");
  process.exit(1);
}
const quiet = process.env.OMNI_FAKE_MCP_QUIET === "1";
const log = (line: string) => void (quiet || console.log(`[fake-mcp] ${line}`));

interface Note {
  id: string;
  path: string | null;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
const notes = new Map<string, Note>();
const seed = (path: string, content: string, tags: string[], metadata: Record<string, unknown> = {}) => {
  const id = `fake-${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  notes.set(id, { id, path, content, tags, metadata, createdAt: now, updatedAt: now });
};
seed("vault/meetings/buoy-sync", "Buoy sync with Dana. Agenda: spec review.", ["meeting"], { title: "Buoy sync", date: "2026-10-10" });
seed("vault/tasks/call-dana", "Call Dana about Friday.", ["task"], { title: "Call Dana Friday", status: "pending" });

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const TOOLS = [
  { name: "query-notes", description: "Find notes by tag, text search, or id.", inputSchema: obj({ tag: { type: "string" }, search: { type: "string" }, id: { type: "string" }, limit: { type: "number" } }) },
  { name: "create-note", description: "Create a note.", inputSchema: obj({ path: { type: "string" }, content: { type: "string" }, tags: { type: "array", items: { type: "string" } }, metadata: { type: "object" } }, ["content"]) },
  { name: "update-note", description: "Update a note's content, tags or metadata.", inputSchema: obj({ id: { type: "string" }, content: { type: "string" }, metadata: { type: "object" } }, ["id"]) },
  { name: "delete-note", description: "Delete a note.", inputSchema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "vault-info", description: "The vault's name and note count.", inputSchema: obj({}) },
];

function call(name: string, a: Record<string, unknown>): { text: string; isError?: boolean } {
  const fail = (m: string) => ({ text: JSON.stringify({ error: m }), isError: true });
  switch (name) {
    case "vault-info":
      return { text: JSON.stringify({ name: "fake", notes: notes.size }) };
    case "query-notes": {
      let rows = [...notes.values()];
      if (typeof a.id === "string") rows = rows.filter((n) => n.id === a.id || n.path === a.id);
      if (typeof a.tag === "string") rows = rows.filter((n) => n.tags.includes(a.tag as string));
      if (typeof a.search === "string") rows = rows.filter((n) => `${n.content} ${JSON.stringify(n.metadata)}`.toLowerCase().includes((a.search as string).toLowerCase()));
      return { text: JSON.stringify({ notes: rows.slice(0, Number(a.limit) || 20) }) };
    }
    case "create-note": {
      if (typeof a.content !== "string") return fail("content is required");
      const id = `fake-${randomBytes(6).toString("hex")}`;
      const now = new Date().toISOString();
      const note: Note = { id, path: typeof a.path === "string" ? a.path : null, content: a.content, tags: Array.isArray(a.tags) ? (a.tags as string[]) : [], metadata: (a.metadata as Record<string, unknown>) ?? {}, createdAt: now, updatedAt: now };
      notes.set(id, note);
      return { text: JSON.stringify(note) };
    }
    case "update-note": {
      const n = typeof a.id === "string" ? notes.get(a.id) : undefined;
      if (!n) return fail(`note not found: ${String(a.id)}`);
      if (typeof a.content === "string") n.content = a.content;
      if (a.metadata && typeof a.metadata === "object") Object.assign(n.metadata, a.metadata);
      n.updatedAt = new Date().toISOString();
      return { text: JSON.stringify(n) };
    }
    case "delete-note": {
      if (typeof a.id !== "string" || !notes.delete(a.id)) return fail(`note not found: ${String(a.id)}`);
      return { text: JSON.stringify({ deleted: a.id }) };
    }
    default:
      return fail(`unknown tool: ${name}`);
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    return null;
  }
}

function answer(msg: Record<string, unknown>): Record<string, unknown> | null {
  const id = msg.id;
  const method = String(msg.method ?? "");
  const params = (msg.params ?? {}) as Record<string, unknown>;
  if (id === undefined || id === null) return null; // a notification
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({ protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "omni-fake-vault", version: "1.0.0" } });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(params.name ?? "");
      log(`tools/call ${name}`);
      const r = call(name, (params.arguments ?? {}) as Record<string, unknown>);
      return ok({ content: [{ type: "text", text: r.text }], isError: !!r.isError });
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/mcp") return void res.writeHead(404).end();
    if ((req.headers.authorization ?? "") !== "Bearer fake-vault-token") return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
    if (req.method === "DELETE") return void res.writeHead(200).end();
    // No server-initiated stream: a client that asks for one is told so and carries on.
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    const msg = await body(req);
    const list = Array.isArray(msg) ? msg : [msg];
    const out = list.map((m) => (m && typeof m === "object" ? answer(m as Record<string, unknown>) : null)).filter(Boolean);
    if (!out.length) return void res.writeHead(202).end();
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake-session" }).end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
  })().catch(() => {
    if (!res.headersSent) res.writeHead(500).end();
  });
});
server.on("error", (e) => {
  console.error(`[fake-mcp] cannot listen on ${HOST}:${port}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`);
  process.exit(1);
});
server.listen(port, HOST, () => console.log(`[fake-mcp] listening on http://${HOST}:${port}/mcp (loopback only, ${notes.size} seeded notes)`));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
