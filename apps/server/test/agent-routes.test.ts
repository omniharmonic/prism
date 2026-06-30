/**
 * Agent dispatch API gating (Phase 3) — the security boundary of the host-process
 * executor: only an owner/admin SESSION may reach it, and validation rejects a
 * missing prompt before anything spawns. (The happy-path dispatch spawns the real
 * claude CLI — covered by scripts/verify-agent-exec.ts, not here, so this suite
 * stays offline and never launches a process.)
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { agentApi } from "../src/routes/agent";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";

const J = { "content-type": "application/json" };
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

beforeEach(() => resetDb());

test("dispatch: no session → 403 (never spawns)", async () => {
  const r = await agentApi.request("/dispatch", { method: "POST", headers: J, body: JSON.stringify({ prompt: "hi" }) });
  assert.equal(r.status, 403);
});

test("dispatch: a capability link is forbidden (admin SESSION only)", async () => {
  const tok = makeCapability("note", "n1", "edit");
  const r = await agentApi.request("/dispatch", {
    method: "POST",
    headers: { ...J, authorization: `Capability ${tok}` },
    body: JSON.stringify({ prompt: "hi" }),
  });
  assert.equal(r.status, 403);
});

test("dispatch: owner session but no prompt → 400 (validated before spawn)", async () => {
  const r = await agentApi.request("/dispatch", {
    method: "POST",
    headers: { ...J, cookie: ownerCookie() },
    body: JSON.stringify({ skill: "summarize" }),
  });
  assert.equal(r.status, 400);
});

test("list/stream/cancel require a session", async () => {
  assert.equal((await agentApi.request("/dispatches")).status, 403);
  assert.equal((await agentApi.request("/dispatches/abc")).status, 403);
  assert.equal((await agentApi.request("/stream/abc")).status, 403);
  assert.equal((await agentApi.request("/dispatches/abc/cancel", { method: "POST" })).status, 403);
});

test("get an unknown dispatch (owner) → 404, not a leak", async () => {
  const r = await agentApi.request("/dispatches/does-not-exist", { headers: { cookie: ownerCookie() } });
  assert.equal(r.status, 404);
});
