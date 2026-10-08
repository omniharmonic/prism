/**
 * The vault refusing the SERVER's token (401) must never reach a client as a 401.
 * Seen 2026-10-08 on vault 0.7.9: a valid token was refused about once in 40 requests; the
 * owner passthrough forwarded it, the iOS app read it as "signed out", started a new sign-in
 * and minted another device. Now the request is sent once more, and a second refusal is a
 * 502 (a server-side problem), for the passthrough and for the server's own vault client.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { vaultClient } from "../src/parachute";
import { resetTreeForTests } from "../src/tree";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

let fv: FakeVault;
const OWNER = "owner@test.local";
let realFetch: typeof fetch;
let refuse = 0;
let vaultHits = 0;

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  fv = installFakeVault();
  process.env.TREE_SUBSCRIBE = "0";
  realFetch = globalThis.fetch;
  refuse = 0;
  vaultHits = 0;
  const inner = globalThis.fetch;
  // Refuse the next `refuse` vault calls the way the vault does: before doing anything.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes("/vault/")) {
      vaultHits++;
      if (refuse > 0) {
        refuse--;
        return new Response(JSON.stringify({ error: "Unauthorized", message: "Invalid API key" }), { status: 401, headers: { "content-type": "application/json" } });
      }
    }
    return inner(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  fv.restore();
  resetTreeForTests();
});

const ownerReq = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", sessionCookie(makeSession(OWNER)));
  if (init.body) headers.set("content-type", "application/json");
  return api.request(path, { ...init, headers });
};

test("passthrough read: one refusal is retried and the caller never sees it", async () => {
  fv.put({ id: "n1", path: "n1", content: "hello", tags: [] });
  refuse = 1;
  const r = await ownerReq("/notes/n1");
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { content: string }).content, "hello");
});

test("passthrough write: one refusal is retried and the write lands exactly once", async () => {
  refuse = 1;
  const r = await ownerReq("/notes", { method: "POST", body: JSON.stringify({ path: "made-once", content: "x" }) });
  assert.ok(r.status >= 200 && r.status < 300, `status ${r.status}`);
  assert.equal(fv.calls.filter((c) => c.method === "POST" && c.path.endsWith("/notes")).length, 1, "the refused attempt never reached the vault's handler");
});

test("passthrough: two refusals in a row are a 502 about the server, never a 401 about the caller", async () => {
  fv.put({ id: "n1", path: "n1", content: "hello", tags: [] });
  refuse = 2;
  const r = await ownerReq("/notes/n1");
  assert.equal(r.status, 502);
  assert.equal(((await r.json()) as { error: string }).error, "vault_auth");
});

test("the server's own vault client retries a refusal once", async () => {
  fv.put({ id: "n1", path: "n1", content: "hello", tags: [] });
  refuse = 1;
  const before = vaultHits;
  const note = await vaultClient().getNote("n1");
  assert.equal(note.content, "hello");
  assert.equal(vaultHits - before, 2, "one refused attempt, one retry");
  refuse = 2;
  await assert.rejects(vaultClient().getNote("n1"));
});
