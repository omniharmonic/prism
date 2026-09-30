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
 *
 * SESSIONS (Arch v2 WP3.1): `/sessions*` + `/turns/:id/cancel` — durable
 * multi-turn conversations over the SAME runner (agent-sessions.ts). The one-shot
 * `/dispatch*` endpoints stay as the "skill run" alias.
 */
import { Hono, type Context } from "hono";
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
import {
  createSession,
  listSessions,
  getOwnedSession,
  listTurns,
  turnEvents,
  finalText,
  turnActivity,
  startTurn,
  getTurn,
  cancelTurn,
  archiveSession,
  activeTurn,
  eventsAfter,
  subscribeSession,
  isTerminal,
  isProfile,
  TurnConflictError,
  SessionArchivedError,
  SessionNotFoundError,
  type LiveMessage,
  type SessionRow,
} from "../agent-sessions";

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

// ── Durable sessions (Arch v2 WP3.1) ─────────────────────────────────────────
// Same admin/owner-session gate as above (the router-wide middleware). A session
// is visible only to its creator, in the vault it was created in.

const ownedSession = (c: Context): SessionRow | null => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return null;
  return getOwnedSession(c.req.param("id") ?? "", actor.vaultId, actor.email);
};

/** Session + its turns (each with the final reply text + tool/touched summary). */
function sessionDetail(s: SessionRow) {
  const turns = listTurns(s.id).map((t) => {
    const evs = turnEvents(t.id);
    return { ...t, finalText: finalText(evs), ...turnActivity(evs) };
  });
  return { session: s, turns };
}

type SessionBody = { title?: unknown; noteId?: unknown; profile?: unknown };
agentApi.post("/sessions", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<SessionBody>().catch(() => ({}) as SessionBody);
  if (body.profile !== undefined && !isProfile(body.profile)) {
    return c.json({ error: "bad_request", detail: "profile must be vault-ro or vault-rw" }, 400);
  }
  const s = createSession({
    vaultId: actor.vaultId,
    ownerEmail: actor.email,
    title: typeof body.title === "string" ? body.title : null,
    noteId: typeof body.noteId === "string" && body.noteId ? body.noteId : null,
    profile: isProfile(body.profile) ? body.profile : "vault-rw",
  });
  return c.json({ sessionId: s.id, session: s });
});

agentApi.get("/sessions", (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  const limit = Number(c.req.query("limit") ?? 50);
  const rows = listSessions(actor.vaultId, actor.email, limit, c.req.query("archived") === "1");
  return c.json(
    rows.map((s) => {
      const turns = listTurns(s.id);
      const last = turns[turns.length - 1];
      return { ...s, turnCount: turns.length, lastTurnAt: last?.started_at ?? null, lastTurnStatus: last?.status ?? null };
    }),
  );
});

agentApi.get("/sessions/:id", (c) => {
  const s = ownedSession(c);
  if (!s) return c.json({ error: "not_found" }, 404);
  return c.json(sessionDetail(s));
});

type TurnBody = { prompt?: unknown; noteId?: unknown };
agentApi.post("/sessions/:id/turns", async (c) => {
  const s = ownedSession(c);
  if (!s) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<TurnBody>().catch(() => ({}) as TurnBody);
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return c.json({ error: "bad_request", detail: "prompt required" }, 400);
  }
  if (body.prompt.length > 50_000) return c.json({ error: "bad_request", detail: "prompt too long" }, 400);
  try {
    // Only prompt/noteId cross from the client — never runner options.
    const t = await startTurn(s.id, resolveVaultEntry(s.vault_id), {
      prompt: body.prompt,
      noteId: typeof body.noteId === "string" && body.noteId ? body.noteId : null,
    });
    return c.json({ turnId: t.id, status: t.status });
  } catch (e) {
    if (e instanceof TurnConflictError) return c.json({ error: "conflict", detail: e.message, turnId: e.turnId }, 409);
    if (e instanceof SessionArchivedError) return c.json({ error: "conflict", detail: e.message }, 409);
    if (e instanceof SessionNotFoundError) return c.json({ error: "not_found" }, 404);
    if (e instanceof AgentBusyError) return c.json({ error: "busy", detail: e.message }, 503);
    throw e;
  }
});

agentApi.post("/turns/:id/cancel", (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  const t = getTurn(c.req.param("id"));
  if (!t || !getOwnedSession(t.session_id, actor.vaultId, actor.email)) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: cancelTurn(t.id) });
});

agentApi.delete("/sessions/:id", (c) => {
  const s = ownedSession(c);
  if (!s) return c.json({ error: "not_found" }, 404);
  archiveSession(s.id);
  return c.json({ ok: true });
});

const SSE_PING_MS = 25_000;
const seqParam = (v: string | undefined) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
};

// Session stream (SSE). Protocol:
//   id: <seq>  event: <AgentEvent.t>  data: {seq, turnId, ...event}  — persisted events
//              event: text_delta      data: {turnId, blockId, text}  — live only, NO id
// Replays every persisted event with seq > max(?after, Last-Event-ID), then — if
// a turn is queued/running — streams live until that turn's terminal `status`
// event and closes. With nothing in flight it closes right after the replay.
agentApi.get("/sessions/:id/stream", (c) => {
  const s = ownedSession(c);
  if (!s) return c.json({ error: "not_found" }, 404);
  const after = Math.max(seqParam(c.req.query("after")), seqParam(c.req.header("last-event-id")));
  return streamSSE(c, async (stream) => {
    let chain: Promise<unknown> = Promise.resolve();
    let lastSeq = after;
    let finished = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => (resolveDone = r));
    const finish = () => {
      finished = true;
      resolveDone();
    };
    const writeMsg = (m: LiveMessage) => {
      if (finished) return;
      if (m.seq != null) {
        if (m.seq <= lastSeq) return; // already replayed
        lastSeq = m.seq;
        const data = JSON.stringify({ seq: m.seq, turnId: m.turnId, ...m.event });
        chain = chain.then(() => stream.writeSSE({ id: String(m.seq), event: m.event.t, data })).catch(() => {});
        if (m.event.t === "status" && isTerminal(m.event.status) && !activeTurn(s.id)) finish();
      } else {
        const data = JSON.stringify({ turnId: m.turnId, ...m.event });
        chain = chain.then(() => stream.writeSSE({ event: m.event.t, data })).catch(() => {});
      }
    };
    // Subscribe BEFORE reading the backlog; buffer live messages until the replay
    // is written, then drain (the seq dedupe makes any overlap harmless).
    const buffered: LiveMessage[] = [];
    let replaying = true;
    const unsub = subscribeSession(s.id, (m) => (replaying ? buffered.push(m) : writeMsg(m)));
    for (const e of eventsAfter(s.id, after)) writeMsg({ seq: e.seq, turnId: e.turnId, event: e.event });
    replaying = false;
    for (const m of buffered) writeMsg(m);
    if (!finished && !activeTurn(s.id)) finish();
    const ping = setInterval(() => {
      chain = chain.then(() => stream.write(": ping\n\n")).catch(() => {});
    }, SSE_PING_MS);
    ping.unref();
    stream.onAbort(finish);
    await done;
    clearInterval(ping);
    unsub();
    await chain;
  });
});
