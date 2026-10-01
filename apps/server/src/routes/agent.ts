/**
 * Server-side agent dispatch API (Phase 3; hardened in Arch v2 WP0.1). Lets an
 * the server owner trigger a `claude -p` run against the ACTIVE vault from the
 * web/mobile app and watch it stream — no desktop required. Mounted under
 * /api/agent BEFORE the gateway so the owner short-circuit never proxies these.
 *
 * SECURITY: SERVER-OWNER session/device only (decision D3 — never admin, capability
 * or anon: this spawns a host process whose vault token bypasses per-note grants). The dispatch acts on the actor's active vault with that vault's
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
import { resolveVaultEntry } from "../db";
import { getBillingMode } from "../agent-billing";
import { profileAllowedTools } from "../agent-profiles";
import {
  startDispatch,
  startExternalDispatch,
  getDispatch,
  listDispatches,
  cancelDispatch,
  subscribe,
  runnerStatus,
  isClaudeModel,
  AgentBusyError,
  type Dispatch,
  type DispatchEvent,
} from "../agent-exec";
import { config } from "../config";
import { csrfRefusal } from "./actions";
import { consumeRateLimit } from "../middleware/ratelimit";

let ROUTING_TEST_PER_MIN = 6;
let routingTestGen = 0;
/** Tests: set the /routing/test per-minute limit (also starts a fresh bucket). */
export function _setRoutingTestLimitForTests(n: number): void {
  ROUTING_TEST_PER_MIN = n;
  routingTestGen++;
}
const MAX_DISPATCH_PROMPT = 120_000;
import { requestVia } from "../auth/actor";
import { cancelSkillRun, listRunningSkills } from "../worker/skills";
import {
  INTERACTIVE_SKILLS,
  isInteractiveSkill,
  listLocalModels,
  mergeRouting,
  modelsOverview,
  readRouting,
  routeFor,
  runLocalInteractive,
  testRoute,
  validateRoute,
  writeRouting,
} from "../local-ai";
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
  budgetStatus,
  isSessionProfile,
  availableSessionProfiles,
  DailyBudgetError,
  ProfileUnavailableError,
  TurnConflictError,
  SessionArchivedError,
  SessionNotFoundError,
  SessionBudgetError,
  NoteForbiddenError,
  ReadTokenError,
  type LiveMessage,
  type SessionRow,
} from "../agent-sessions";

export const agentApi = new Hono();

// SERVER OWNER only (program decision D3: "owner-only until per-actor tokens").
// The runner acts with the VAULT token, which bypasses per-note grants and
// private-note rules — so a non-owner admin must never drive it. A signed-in
// owner session or an owner native-device token (kind "user") passes; admins,
// members, guests, capability links and anon are all 403.
agentApi.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.role !== "owner") {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

/**
 * The tool allowlist a one-shot dispatch may ask for. A client may only NARROW
 * the default (the whole vault MCP server): `profile: "vault-ro"` = the read-only
 * vault tools (WP4.3: the client's inline edit / transform, which only needs
 * text back). Anything else → undefined = the unchanged default. Never widens.
 */
export function dispatchAllowedTools(profile: unknown): string[] | undefined {
  return profile === "vault-ro" ? profileAllowedTools("vault-ro") : undefined;
}

agentApi.post("/dispatch", async (c) => {
  const actor = resolveActor(c);
  const body = await c.req
    .json<{ prompt?: string; skill?: string; noteId?: string; profile?: string }>()
    .catch(() => ({}) as { prompt?: string; skill?: string; noteId?: string; profile?: string });
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return c.json({ error: "bad_request", detail: "prompt required" }, 400);
  }
  // L5: bounded prompt (a transform carries ≤60k chars of note + the template).
  if (body.prompt.length > MAX_DISPATCH_PROMPT) return c.json({ error: "bad_request", detail: "prompt too long" }, 400);
  if (body.profile !== undefined && body.profile !== "vault-ro") {
    return c.json({ error: "bad_request", detail: "profile may only be \"vault-ro\"" }, 400);
  }
  const entry = resolveVaultEntry(actor.vaultId);
  const skill = typeof body.skill === "string" ? body.skill : null;
  const noteId = typeof body.noteId === "string" ? body.noteId : null;
  // Interactive routing (parity A): the client's read-only inline AI (edit /
  // transform / generate / chat) follows the server-side per-skill routing.
  // Only the narrowed `vault-ro` one-shot is routed — a full-tools dispatch
  // always stays on claude.
  const route = body.profile === "vault-ro" && isInteractiveSkill(skill) ? routeFor(skill) : null;
  if (route?.provider === "local") {
    const prompt = body.prompt;
    const d = startExternalDispatch(entry, { skill, noteId }, (signal) => runLocalInteractive(route.model, prompt, signal));
    return c.json({ id: d.id, status: d.status, queuedReason: d.queuedReason, provider: "local", model: route.model });
  }
  try {
    // Only prompt/skill/noteId (+ an optional NARROWING profile) cross from the
    // client — never runner options.
    const allowedTools = dispatchAllowedTools(body.profile);
    const d = startDispatch(
      entry,
      { prompt: body.prompt, skill, noteId },
      {
        ...(allowedTools ? { allowedTools } : {}),
        ...(route?.provider === "claude" && isClaudeModel(route.model) ? { model: route.model } : {}),
      },
    );
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
agentApi.get("/runner", (c) => c.json({ ...runnerStatus(), billing: getBillingMode() }));

/** Billing mode + budgets + selectable profiles (WP3.4). Budgets are server
 *  config; the UI shows them read-only. `billing` says how to label cost figures:
 *  "subscription" = API-equivalent estimate, not a charge. */
agentApi.get("/limits", (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  c.header("Cache-Control", "no-store");
  return c.json({
    billing: getBillingMode(),
    ...budgetStatus(actor.email),
    profiles: availableSessionProfiles(),
    defaultProfile: "vault-ro",
  });
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

// ── Server skills + interactive model routing (parity A) ─────────────────────
// Stricter than the router gate: the SERVER owner by email (like live actions),
// never a vault-role owner of another vault — skills run on the primary vault
// and routing is server-wide. Mutations also pass the live-actions CSRF guard
// (JSON content type; no cross-/same-site browser fetch; Origin allowlist).

const isServerOwner = (c: Context): boolean => {
  const a = resolveActor(c);
  return a.kind === "user" && a.email === config.ownerEmail;
};
const ownerOnly = (c: Context): Response | null => (isServerOwner(c) ? null : c.json({ error: "forbidden" }, 403));
const ownerMutation = (c: Context): Response | null => ownerOnly(c) ?? csrfRefusal(c, requestVia(c));

/** In-flight server skill runs (the AgentActivity "running" list + Stop). */
agentApi.get("/skills/running", (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  c.header("Cache-Control", "no-store");
  return c.json({ running: listRunningSkills() });
});

/** Stop a running server skill run (local: between notes + abort the in-flight
 *  LM Studio request; claude: kill through the run queue). Recorded as a
 *  `cancelled` dispatch note. 404 when nothing by that name is running. */
agentApi.post("/skills/:skillName/cancel", (c) => {
  const denied = ownerMutation(c);
  if (denied) return denied;
  const name = c.req.param("skillName");
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,99}$/.test(name)) return c.json({ error: "bad_request", detail: "invalid skill name" }, 400);
  const r = cancelSkillRun(name);
  if (r === "not_running") return c.json({ error: "not_running", detail: `no run of '${name}' is in progress` }, 404);
  if (r === "not_cancellable") return c.json({ error: "not_cancellable", detail: `the run of '${name}' has no cancel handle` }, 409);
  console.log(`[skills] '${name}' cancelled by the owner`);
  return c.json({ ok: true, skill: name });
});

/** Local models on the server's LM Studio + whether claude is available. */
agentApi.get("/models", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  c.header("Cache-Control", "no-store");
  return c.json(await modelsOverview());
});

/** Per-skill interactive routing (edit | chat | transform | generate). */
agentApi.get("/routing", (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  c.header("Cache-Control", "no-store");
  return c.json({ skills: INTERACTIVE_SKILLS, routing: readRouting() });
});

agentApi.put("/routing", async (c) => {
  const denied = ownerMutation(c);
  if (denied) return denied;
  const body = await c.req.json<{ routing?: unknown }>().catch(() => null);
  let next: ReturnType<typeof readRouting>;
  try {
    next = mergeRouting(readRouting(), body?.routing);
  } catch (e) {
    return c.json({ error: "bad_request", detail: (e as Error).message }, 400);
  }
  // L4: a NEWLY chosen local model must be one the server's LM Studio lists.
  const before = readRouting();
  const newLocal = INTERACTIVE_SKILLS.filter((k) => next[k].provider === "local" && (before[k].provider !== "local" || before[k].model !== next[k].model));
  if (newLocal.length) {
    const models = await listLocalModels();
    if (!models.reachable) return c.json({ error: "local_unavailable", detail: "the server's local model server is not reachable, so the model can't be checked" }, 409);
    const known = new Set(models.models.map((m) => m.id));
    const bad = newLocal.find((k) => !known.has(next[k].model));
    if (bad) return c.json({ error: "bad_request", detail: `${bad}: '${next[bad].model}' is not a model on the server's LM Studio` }, 400);
  }
  try {
    writeRouting(next);
    return c.json({ skills: INTERACTIVE_SKILLS, routing: next });
  } catch (e) {
    return c.json({ error: "bad_request", detail: (e as Error).message }, 400);
  }
});

/** Settings "Test": a tiny server-side round trip on a route (local = one short
 *  completion behind the admission guard; claude = the CLI is present). */
agentApi.post("/routing/test", async (c) => {
  const denied = ownerMutation(c);
  if (denied) return denied;
  // L4: each test may run a local completion — rate-limited per owner.
  const retry = consumeRateLimit(`agent-routing-test:${routingTestGen}:${config.ownerEmail}`, ROUTING_TEST_PER_MIN, 60_000);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "rate_limited", retryAfter: retry }, 429);
  }
  const body = await c.req.json<{ skill?: unknown; route?: unknown }>().catch(() => null);
  try {
    const route = body?.route !== undefined ? validateRoute("route", body.route) : isInteractiveSkill(body?.skill) ? routeFor(body.skill) : null;
    if (!route) return c.json({ error: "bad_request", detail: "send {skill} or {route: {provider, model}}" }, 400);
    return c.json(await testRoute(route));
  } catch (e) {
    return c.json({ error: "bad_request", detail: (e as Error).message }, 400);
  }
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
// Same SERVER-OWNER gate as above (the router-wide middleware). A session
// is visible only to its creator, in the vault it was created in.

const ownedSession = (c: Context): SessionRow | null => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return null;
  return getOwnedSession(c.req.param("id") ?? "", actor.vaultId, actor.email);
};

/** Session + its turns (each with the final reply text + tool/touched summary).
 *  `firstSeq`/`lastSeq` (per turn, null when it has no persisted events) and the
 *  session-wide `lastSeq` let a reconnecting client resume the stream exactly:
 *  it replays the in-flight turn from `firstSeq - 1` and everything else from
 *  `lastSeq` (WP3.2). */
function sessionDetail(s: SessionRow) {
  let lastSeq = 0;
  const turns = listTurns(s.id).map((t) => {
    const evs = turnEvents(t.id);
    const firstSeq = evs.length ? evs[0]!.seq : null;
    const turnLast = evs.length ? evs[evs.length - 1]!.seq : null;
    if (turnLast != null && turnLast > lastSeq) lastSeq = turnLast;
    return { ...t, finalText: finalText(evs), ...turnActivity(evs), firstSeq, lastSeq: turnLast };
  });
  return { session: s, turns, lastSeq };
}

type SessionBody = { title?: unknown; noteId?: unknown; profile?: unknown };
agentApi.post("/sessions", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<SessionBody>().catch(() => ({}) as SessionBody);
  if (body.profile !== undefined && !isSessionProfile(body.profile)) {
    return c.json({ error: "bad_request", detail: `profile must be one of ${availableSessionProfiles().join(", ")}` }, 400);
  }
  const s = createSession({
    vaultId: actor.vaultId,
    ownerEmail: actor.email,
    title: typeof body.title === "string" ? body.title : null,
    noteId: typeof body.noteId === "string" && body.noteId ? body.noteId : null,
    profile: isSessionProfile(body.profile) ? body.profile : "vault-rw",
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
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  try {
    // Only prompt/noteId cross from the client — never runner options. The
    // actor's grants gate the open-note context (defense in depth under D3).
    const t = await startTurn(
      s.id,
      resolveVaultEntry(s.vault_id),
      { prompt: body.prompt, noteId: typeof body.noteId === "string" && body.noteId ? body.noteId : null },
      { grants: actor.grants, role: actor.role, subject: actor.email },
    );
    return c.json({ turnId: t.id, status: t.status });
  } catch (e) {
    if (e instanceof TurnConflictError) return c.json({ error: "conflict", detail: e.message, turnId: e.turnId }, 409);
    if (e instanceof SessionArchivedError) return c.json({ error: "conflict", detail: e.message }, 409);
    if (e instanceof SessionBudgetError) return c.json({ error: "budget_exceeded", detail: e.message }, 409);
    if (e instanceof DailyBudgetError) return c.json({ error: "daily_budget_exceeded", detail: e.message }, 409);
    if (e instanceof ProfileUnavailableError) return c.json({ error: "profile_unavailable", detail: e.message }, 409);
    if (e instanceof NoteForbiddenError) return c.json({ error: "forbidden", detail: e.message }, 403);
    if (e instanceof SessionNotFoundError) return c.json({ error: "not_found" }, 404);
    if (e instanceof AgentBusyError) return c.json({ error: "busy", detail: e.message }, 503);
    if (e instanceof ReadTokenError) return c.json({ error: "unavailable", detail: e.message }, 503);
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
