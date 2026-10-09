/**
 * Slice K · NP-CO-10 — what an agent writes into a shared document (Prism MCP collab tools)
 * carries the RESERVED agent colour, never the caret colour of the account it acts for; and
 * that colour is in no person's palette. Driven through the real /mcp endpoint in-process.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AGENT_COLOR, CARET_COLORS, colorFor } from "@prism/core/collab-colors";
import { createApp } from "../src/app";
import * as Y from "yjs";
import { addGrant, ensureUser, getDocState, setUserProfile } from "../src/db";
import { issuePat } from "../src/auth/pat";
import { docNameFor, hocuspocus, resetReconcileState } from "../src/collab";
import { colorFor as serverColorFor } from "../src/collab-ops";
import { stopConversionWorkers } from "../src/convert/service";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

after(async () => { await stopConversionWorkers(); });

const EDITOR = "editor@test.local";
let fv: FakeVault;
let app: ReturnType<typeof createApp>;
const saved = { debounce: hocuspocus.configuration.debounce, maxDebounce: hocuspocus.configuration.maxDebounce };

beforeEach(() => {
  resetDb();
  resetReconcileState();
  fv = installFakeVault();
  app = createApp();
  ensureUser(EDITOR);
  setUserProfile(EDITOR, { name: "Ed Itor" });
  addGrant({ subject_type: "user", subject: EDITOR, resource_type: "tag", resource: "garden", level: "view", caps: ["view", "comment", "suggest", "edit", "create"] as never, created_by: "test", vault_id: "primary" });
  fv.put({ id: "d1", tags: ["garden"], content: "<p>alpha</p><p>beta</p>", updatedAt: "2026-02-01T00:00:00.000Z" });
});
afterEach(async () => {
  hocuspocus.closeConnections();
  Object.assign(hocuspocus.configuration, saved);
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  fv.restore();
});

async function agent(email: string): Promise<Client> {
  const ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const token = issuePat({ email, vaultId: "primary", scope: "write" }).token;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = new Headers(req.headers);
    h.set("cf-connecting-ip", ip);
    h.set("x-forwarded-for", ip);
    h.set("authorization", `Bearer ${token}`);
    const u = new URL(req.url);
    return app.request(u.pathname + u.search, { method: req.method, headers: h, body: req.method === "POST" ? await req.text() : undefined });
  };
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl as typeof fetch }));
  return client;
}

test("the agent colour is reserved: not a caret colour; the server and the client share one table", () => {
  assert.ok(!CARET_COLORS.includes(AGENT_COLOR));
  for (let i = 0; i < 5000; i++) {
    const seed = `person-${i}@example.test`;
    assert.equal(serverColorFor(seed), colorFor(seed));
    assert.notEqual(colorFor(seed), AGENT_COLOR);
  }
});

test("prism_suggest_edit and prism_add_comment write the agent colour, not the account's caret colour", { timeout: 30000 }, async () => {
  const cl = await agent(EDITOR);
  const suggested: any = await cl.callTool({ name: "prism_suggest_edit", arguments: { id: "d1", find: "beta", replace: "gamma" } });
  assert.ok(!suggested.isError, JSON.stringify(suggested.content));
  const html = fv.notes.get("d1")!.content;
  const colours = [...html.matchAll(/data-suggestion="(insert|delete)"[^>]*data-color="([^"]+)"|data-color="([^"]+)"[^>]*data-suggestion="(insert|delete)"/g)].map((m) => m[2] ?? m[3]);
  assert.equal(colours.length, 2, html);
  assert.deepEqual(colours, [AGENT_COLOR, AGENT_COLOR]);
  assert.match(html, /data-user="Ed Itor \(agent\)"/);
  assert.notEqual(colorFor(EDITOR), AGENT_COLOR);
  assert.ok(!html.includes(colorFor(EDITOR)), "the account's own caret colour is not on the agent's marks");

  const commented: any = await cl.callTool({ name: "prism_add_comment", arguments: { id: "d1", quote: "alpha", text: "Check this." } });
  assert.ok(!commented.isError, JSON.stringify(commented.content));
  const listed: any = await cl.callTool({ name: "prism_list_comments", arguments: { id: "d1" } });
  assert.ok(!listed.isError, JSON.stringify(listed.content));
  assert.match(JSON.stringify(listed.structuredContent), /Ed Itor \(agent\)/);
  // The stored comment item (the loaded document, else its snapshot) carries the agent colour.
  const name = docNameFor("primary", "d1");
  const y = new Y.Doc();
  const live = hocuspocus.documents.get(name);
  const snapshot = getDocState(name)?.state;
  if (live) Y.applyUpdate(y, Y.encodeStateAsUpdate(live));
  else if (snapshot) Y.applyUpdate(y, snapshot);
  const items = JSON.stringify(y.getMap("comments").toJSON());
  assert.match(items, new RegExp(AGENT_COLOR));
});
