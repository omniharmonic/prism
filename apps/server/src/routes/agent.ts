/**
 * Server-side agent dispatch API (Phase 3; hardened in Arch v2 WP0.1). Lets an
 * owner/admin trigger a `claude -p` run against the ACTIVE vault from the
 * web/mobile app and watch it stream — no desktop required. Mounted under
 * /api/agent BEFORE the gateway so the owner short-circuit never proxies these.
 *
 * SECURITY: admin/owner SESSION only (never capability/anon — this spawns a host
 * process). The dispatch acts on the actor's active vault with that vault's
 * scoped token (agent-exec.ts), so it stays tenant-isolated. The argv is a fixed
 * template with no host tools; the client supplies only a prompt.
 *
 * CAPACITY: a dispatch may come back "queued" (slot busy or memory pressure —
 * see `queuedReason`); it starts on its own. Only a full queue is refused (503).
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
  runnerStatus,
  AgentBusyError,
  type Dispatch,
  type DispatchEvent,
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
  try {
    // Only prompt/skill/noteId cross from the client — never runner options.
    const d = startDispatch(entry, {
      prompt: body.prompt,
      skill: typeof body.skill === "string" ? body.skill : null,
      noteId: typeof body.noteId === "string" ? body.noteId : null,
    });
    return c.json({ id: d.id, status: d.status, queuedReason: d.queuedReason });
  } catch (e) {
    if (e instanceof AgentBusyError) return c.json({ error: "busy", detail: e.message }, 503);
    throw e;
  }
});

agentApi.get("/dispatches", (c) => {
  const actor = resolveActor(c);
  return c.json(listDispatches(actor.vaultId));
});

/** Runner capacity snapshot (running/queued counts + last admission verdict). */
agentApi.get("/runner", (c) => c.json(runnerStatus()));

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

const TERMINAL = new Set(["done", "error", "cancelled"]);
/** Dispatch metadata without the (potentially large) output body. */
const meta = (d: Dispatch) => {
  const { output, ...rest } = d;
  return { ...rest, outputLength: output.length };
};

// Live stream (SSE). Protocol:
//   event: snapshot  → the full Dispatch as of connect (output so far, once)
//   event: delta     → {text}: ONLY newly produced output (never the accumulation)
//   event: status    → dispatch metadata on each status/queuedReason change (no output)
//   event: end       → final metadata (+ outputLength), then the stream closes
// A dispatch that is already terminal gets snapshot + end.
agentApi.get("/stream/:id", (c) => {
  const actor = resolveActor(c);
  const current = getDispatch(c.req.param("id"));
  if (!current || current.vaultId !== actor.vaultId) return c.json({ error: "not_found" }, 404);
  return streamSSE(c, async (stream) => {
    // Snapshot + subscribe in the SAME tick so no chunk falls between them; writes
    // are serialized through one promise chain to preserve order.
    const snapshot = JSON.stringify(current);
    let chain: Promise<unknown> = stream.writeSSE({ event: "snapshot", data: snapshot });
    const write = (event: string, data: unknown) => {
      chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {});
    };
    if (TERMINAL.has(current.status)) {
      write("end", meta(current));
      await chain;
      return;
    }
    await new Promise<void>((doneResolve) => {
      const unsub = subscribe(current.id, (ev: DispatchEvent) => {
        if (ev.type === "output") {
          write("delta", { text: ev.text });
          return;
        }
        if (TERMINAL.has(ev.dispatch.status)) {
          write("end", meta(ev.dispatch));
          unsub();
          doneResolve();
        } else {
          write("status", meta(ev.dispatch));
        }
      });
      stream.onAbort(() => {
        unsub();
        doneResolve();
      });
    });
    await chain;
  });
});
