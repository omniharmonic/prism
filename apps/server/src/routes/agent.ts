/**
 * Server-side agent dispatch API (Phase 3). Lets an owner/admin trigger a
 * `claude -p` run against the ACTIVE vault from the web/mobile app and watch it
 * stream — no desktop required. Mounted under /api/agent BEFORE the gateway so
 * the owner short-circuit never proxies these to the vault.
 *
 * SECURITY: admin/owner SESSION only (never capability/anon — this spawns a host
 * process). The dispatch acts on the actor's active vault with that vault's
 * scoped token (agent-exec.ts), so it stays tenant-isolated. The argv is a fixed
 * template + host tools disallowed; the client supplies only a prompt.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolveActor } from "../auth/actor";
import { roleAtLeast } from "../roles";
import { resolveVaultEntry } from "../db";
import {
  startDispatch,
  getDispatch,
  listDispatches,
  cancelDispatch,
  subscribe,
  type Dispatch,
} from "../agent-exec";

export const agentApi = new Hono();

// Admin/owner session only — never a capability link or anon.
agentApi.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || !roleAtLeast(actor.role, "admin")) {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

agentApi.post("/dispatch", async (c) => {
  const actor = resolveActor(c);
  const body = await c.req
    .json<{ prompt?: string; skill?: string; noteId?: string }>()
    .catch(() => ({}) as { prompt?: string; skill?: string; noteId?: string });
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return c.json({ error: "bad_request", detail: "prompt required" }, 400);
  }
  const entry = resolveVaultEntry(actor.vaultId);
  const d = startDispatch(entry, { prompt: body.prompt, skill: body.skill ?? null, noteId: body.noteId ?? null });
  return c.json({ id: d.id, status: d.status });
});

agentApi.get("/dispatches", (c) => {
  const actor = resolveActor(c);
  return c.json(listDispatches(actor.vaultId));
});

agentApi.get("/dispatches/:id", (c) => {
  const actor = resolveActor(c);
  const d = getDispatch(c.req.param("id"));
  if (!d || d.vaultId !== actor.vaultId) return c.json({ error: "not_found" }, 404);
  return c.json(d);
});

agentApi.post("/dispatches/:id/cancel", (c) => {
  const actor = resolveActor(c);
  const d = getDispatch(c.req.param("id"));
  if (!d || d.vaultId !== actor.vaultId) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: cancelDispatch(d.id) });
});

// Live status/output stream (SSE). Sends the current state, then each update
// until the dispatch reaches a terminal state (then closes).
agentApi.get("/stream/:id", (c) => {
  const actor = resolveActor(c);
  const current = getDispatch(c.req.param("id"));
  if (!current || current.vaultId !== actor.vaultId) return c.json({ error: "not_found" }, 404);
  return streamSSE(c, async (stream) => {
    const send = (d: Dispatch) => stream.writeSSE({ event: "update", data: JSON.stringify(d) });
    await send(current);
    if (current.status !== "running") return; // already terminal — one event, then close
    await new Promise<void>((doneResolve) => {
      const unsub = subscribe(current.id, (d) => {
        void send(d);
        if (d.status !== "running") {
          unsub();
          doneResolve();
        }
      });
      stream.onAbort(() => {
        unsub();
        doneResolve();
      });
    });
  });
});
