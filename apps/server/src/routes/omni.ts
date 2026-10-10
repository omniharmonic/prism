/**
 * Omni gateway — `/api/omni/*` (docs/omni-module.md; spec:
 * omniharmonicagent/docs/omni/integration-contract.md § 4–6). The OWNER-ONLY bridge
 * between the Omni app (iPhone/iPad/Mac) and Hermes (the agent on the Mac Mini, the
 * canonical thread store). Mounted BEFORE the gateway so the owner passthrough never
 * proxies these to the vault.
 *
 * GATES
 *  - `OMNI_ENABLED` (default off): every route, hooks included, answers 404.
 *  - App routes: the SERVER OWNER (OWNER_EMAIL) authenticated by a browser SESSION or a
 *    native DEVICE token (`pd_…`). An in-process MCP dispatch, the loopback owner token, a
 *    capability link or another account → 403; anonymous → 401. Mutations also pass the
 *    live-actions CSRF guard (JSON content type; Origin / Sec-Fetch-Site unless device).
 *  - Hook routes (`/hooks/*`, Hermes' omni-bridge plugin + the sweeps): loopback only
 *    (`isLocalRequest`) AND `Authorization: Bearer <OMNI_SERVICE_TOKEN>` (constant-time).
 *    They can PROPOSE and announce; they can never decide or execute anything.
 *  - Approval decisions additionally need a HUMAN origin (session/device; a client's
 *    `X-Prism-Action-Origin: agent` downgrade is honoured), the digest the person saw and
 *    an `Idempotency-Key`; execution goes only through Prism's live-action routes.
 */
import { apnsApplicationForDevice, apnsEnabled, isApnsToken, isApnsEnvironment, saveApnsToken, removeApnsTokenForDevice } from "../apns";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { resolveActor, requestVia } from "../auth/actor";
import { isLocalRequest } from "../auth/local";
import { consumeRateLimit } from "../middleware/ratelimit";
import { csrfRefusal, readCapped } from "./actions";
import { IDEMPOTENCY_KEY_RE } from "../actions/store";
import { omniConfig, OMNI_API_VERSION, OMNI_MIN_CLIENT } from "../omni/config";
import { hermes, HermesError, SESSION_ID_RE, JOB_ID_RE, type HermesSession, type HermesMessage } from "../omni/hermes-client";
import {
  sha256,
  THREAD_STATES,
  bumpUnread,
  ensureThread,
  eventsAfter,
  getThread,
  getTurn,
  activeTurn,
  listThreads,
  newId,
  sweepRunningTurns,
  runningRunIds,
  omniAudit,
  threadCards,
  updateThread,
  type ThreadRow,
  type ThreadState,
} from "../omni/store";
import { cancelTurn, emit, liveTurnCount, startTurn, stopOrphanedRuns } from "../omni/turns";
import { config } from "../config";
import { bareToolName } from "../omni/stream";
import { publishNotice, pushOmni, subscribeNotices, subscribeThread, type ThreadMessage } from "../omni/bus";
import {
  APPROVAL_KINDS,
  ApprovalInputError,
  approvalView,
  claimApproval,
  closeApproval,
  createApproval,
  executorFor,
  expireApprovals,
  finishApproval,
  getApproval,
  listApprovals,
  liveActionRequest,
  rawIdemKey,
  threadApprovals,
  unclaimApproval,
  validatePayload,
  type ApprovalStatus,
  type ExecOutcome,
  type Executor,
} from "../omni/approvals";
import { buildToday, localDate, validDate, type Dispatch } from "../omni/today";
import { runProtonSend } from "../omni/proton-send";

import { DIALS, type InterruptContext } from "../omni/nudge-policy";
import { priorNudgeSources, resolveNudgeSource, nudgeWeeklyAudit, latestNudgeAudit, FRESHNESS_SUBSYSTEMS, NUDGE_KINDS, upsertNudge, listNudges, getNudge, nudgeAction, nudgeSettings, setNudgeSettings, bindNudgeThread, type Candidate } from "../omni/nudges";
import { startNudgeDelivery } from "../omni/nudge-delivery";
import { resolveNote } from "../omni/records";

export const omniApi = new Hono();

// ── wiring ──────────────────────────────────────────────────────────────────

type AppLike = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
let appRef: AppLike | null = null;

/** Mount under `/api/omni` and keep the app for in-process calls (executor, Today). */
export function mountOmni(app: Hono): void {
  appRef = app as unknown as AppLike;
  // No in-memory stream survives a restart: a turn left `running` is interrupted — and the
  // Hermes run it was following is asked to stop (nobody is listening to it any more).
  const orphans = omniConfig.enabled() ? runningRunIds() : [];
  sweepRunningTurns();
  if (orphans.length) stopOrphanedRuns(orphans);
  app.route("/api/omni", omniApi);
  if (omniConfig.enabled()) startNudgeDelivery();
}

/** The person's own credential + CSRF-relevant headers, for an in-process call made on
 *  their behalf (so the inner route judges the SAME person and origin). */
function forwardHeaders(c: Context, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", ...extra };
  for (const k of ["cookie", "authorization", "origin", "sec-fetch-site"]) {
    const v = c.req.header(k);
    if (v) h[k] = v;
  }
  return h;
}
function dispatcherFor(c: Context): Dispatch {
  return async (path, init) => {
    if (!appRef) throw new Error("omni_not_mounted");
    return appRef.request(path, { method: init.method, headers: forwardHeaders(c), body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  };
}

/** Default executor: the live-action route, in process, with the decider's credential. */
const liveActionExecutor: Executor = async ({ kind, payload, approvalId, headers }) => {
  const exec = executorFor(kind);
  if (!exec.available) return { status: "disabled", detail: { error: "executor_unavailable", executor: exec.name } };
  if (!exec.enabled) return { status: "disabled", detail: { error: "executor_disabled", executor: exec.name } };
  const req = liveActionRequest(kind, payload);
  if (!req || !appRef) return { status: "disabled", detail: { error: "executor_unavailable", executor: exec.name } };
  let res: Response;
  try {
    res = await appRef.request(req.path, { method: "POST", headers: { ...headers, "idempotency-key": `omni-${approvalId}` }, body: JSON.stringify(req.body) });
  } catch {
    return { status: "unknown", detail: { error: "executor_error" } };
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const out: Record<string, unknown> = { executor: exec.name, httpStatus: res.status };
  for (const k of ["error", "detail", "sent", "messageId", "eventId", "id"]) if (j[k] !== undefined) out[k] = j[k];
  if (res.ok) return { status: "sent", detail: out };
  if (res.status === 503 && j.error === "actions_disabled") return { status: "disabled", detail: { ...out, error: "executor_disabled" } };
  // Live actions say `sent: false` when nothing provably left the server; anything else may have.
  if (j.sent === false || res.status === 400 || res.status === 403 || res.status === 404 || res.status === 409 || res.status === 415 || res.status === 422 || res.status === 429) {
    return { status: "failed", detail: out };
  }
  return { status: "unknown", detail: out };
};
/** Approved emails go to proton_send.py unless OMNI_EMAIL_EXECUTOR=live-actions (option B). */
const defaultExecutor: Executor = (o) =>
  (o.kind === "email" || o.kind === "email-reply") && omniConfig.emailExecutor() === "proton-send"
    ? runProtonSend(o.kind, o.payload)
    : liveActionExecutor(o);
let executor: Executor = defaultExecutor;
export function setOmniExecutorForTests(e: Executor | null): void {
  executor = e ?? defaultExecutor;
}

// ── gates ───────────────────────────────────────────────────────────────────

omniApi.use("*", async (c, next) => {
  if (!omniConfig.enabled()) return c.json({ error: "not_found" }, 404);
  await next();
});

const hookAuthorized = (c: Context): boolean => {
  const want = omniConfig.serviceToken();
  if (!want || want.length < 16) return false;
  if (!isLocalRequest((k) => c.req.header(k))) return false;
  const h = c.req.header("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return false;
  const a = Buffer.from(h.slice(7));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

omniApi.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/omni/hooks/") || c.req.path.startsWith("/hooks/")) {
    if (!hookAuthorized(c)) return c.json({ error: "forbidden" }, 403);
    return next();
  }
  const via = requestVia(c);
  if (via === "anon") return c.json({ error: "unauthorized" }, 401);
  if (via !== "session" && via !== "device") return c.json({ error: "forbidden", detail: "sign in on the device (session or device token)" }, 403);
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.email.toLowerCase() !== omniConfig.ownerEmail()) return c.json({ error: "forbidden" }, 403);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const csrf = csrfRefusal(c, via);
    if (csrf) return csrf;
  }
  await next();
});

/** Omni's own registration; browser credentials and Prism device credentials cannot claim it. */
omniApi.post("/push", async c => {
  const actor = resolveActor(c);
  if (requestVia(c) !== "device" || actor.kind !== "user" || !actor.deviceId || apnsApplicationForDevice(actor.deviceId) !== "omni") return c.json({ error: "omni_device_token_required" }, 403);
  const retry = consumeRateLimit(`omni-push:${actor.deviceId}`, 20, 60_000);
  if (retry !== null) { c.header("Retry-After", String(retry)); return c.json({ error: "rate_limited", retryAfter: retry }, 429); }
  const b = await jsonBody(c);
  if (!b) return c.json({ error: "bad_request", detail: "bounded JSON body required" }, 400);
  if (!isApnsToken(b.token) || !isApnsEnvironment(b.environment)) return c.json({ error: "bad_request", detail: "token (hex) and environment (sandbox|production) required" }, 400);
  saveApnsToken({ deviceId: actor.deviceId, email: actor.email, vaultId: actor.vaultId, token: b.token, environment: b.environment, application: "omni" });
  return c.json({ ok: true, apnsEnabled: apnsEnabled() });
});
omniApi.delete("/push", c => {
  const actor = resolveActor(c);
  if (requestVia(c) !== "device" || actor.kind !== "user" || !actor.deviceId || apnsApplicationForDevice(actor.deviceId) !== "omni") return c.json({ error: "omni_device_token_required" }, 403);
  return c.json({ ok: removeApnsTokenForDevice(actor.deviceId) });
});

const MAX_BODY = 512 * 1024;
async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const text = await readCapped(c.req.raw, MAX_BODY);
  if (text === null) return null;
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const bad = (c: Context, detail: string) => c.json({ error: "bad_request", detail }, 400);
function hermesFailure(c: Context, e: unknown): Response {
  if (e instanceof HermesError) return c.json({ error: e.code }, e.status as 400);
  console.error(`[omni] ${(e as Error)?.message}`);
  return c.json({ error: "internal_error" }, 500);
}
const iso = (v: number | null | undefined) => (v ? new Date(v).toISOString() : null);
const tsIso = (v: number | string | null | undefined): string | null => {
  if (v == null) return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  return Number.isNaN(Date.parse(v)) ? null : new Date(v).toISOString();
};

// ── threads ─────────────────────────────────────────────────────────────────

/**
 * @param gone Hermes — the canonical thread store — answered with its COMPLETE session list
 *   and this thread is not in it: only the gateway's own row is left (Hermes pruned or reset
 *   its sessions; the dev stub lost its memory). The transcript cannot be read any more, so
 *   the app shows it as "no longer available" and offers to remove it (`PATCH {archived}`).
 */
function threadView(t: ThreadRow | null, s: HermesSession | null, gone = false): Record<string, unknown> {
  const id = t?.id ?? s!.id;
  const running = !!activeTurn(id);
  const hermesActive = s?.last_active ? s.last_active * 1000 : 0;
  const pending = threadApprovals(id).some((a) => a.status === "pending");
  const state: ThreadState = running ? "working" : pending ? "needs-you" : (t?.state ?? "waiting");
  return {
    id,
    title: t?.title ?? s?.title ?? null,
    state,
    objective: t?.objective ?? null,
    taskNoteId: t?.taskNoteId ?? null,
    lastActivityAt: iso(Math.max(t?.lastActivityAt ?? 0, hermesActive)) ,
    unread: t?.unread ?? 0,
    pinned: s?.pinned ?? t?.pinned ?? false,
    archived: s?.archived ?? t?.archived ?? false,
    nextCheckAt: null,
    waitingOn: null,
    model: s?.model ?? null,
    preview: s?.preview ?? null,
    messageCount: s?.message_count ?? null,
    running,
    lastSeq: t?.eventSeq ?? 0,
    source: t?.source ?? (s ? "hermes" : null),
    gone,
  };
}

/** How many unlisted threads one list request asks Hermes about. */
const GONE_LOOKUPS = 40;
const PRESENCE_TTL_MS = 5 * 60_000;
const presence = new Map<string, { at: number; v: HermesSession | "gone" }>();
/** Does Hermes still have this session? Its own answer, remembered for a few minutes so a
 *  list that is polled does not ask again for every archived thread. `unknown` = could not ask. */
async function sessionPresence(id: string): Promise<HermesSession | "gone" | "unknown"> {
  const hit = presence.get(id);
  if (hit && Date.now() - hit.at < PRESENCE_TTL_MS) return hit.v;
  let v: HermesSession | "gone";
  try {
    v = await hermes.getSession(id);
  } catch (e) {
    if (!(e instanceof HermesError && e.code === "not_found")) return "unknown";
    v = "gone";
  }
  if (presence.size > 2000) presence.clear();
  presence.set(id, { at: Date.now(), v });
  return v;
}
export function resetOmniPresenceForTests(): void {
  presence.clear();
}

omniApi.get("/version", (c) => c.json({ api: OMNI_API_VERSION, minClient: OMNI_MIN_CLIENT }));

/**
 * Is the whole chain up? Asked on demand (one cheap Hermes call); nothing here is a secret.
 *  - `hermes`: `ok`, or the error code a turn would end with (`hermes_unavailable`,
 *    `hermes_auth`, `hermes_timeout`, `hermes_not_configured`).
 *  - `hooks.ready`: the omni-bridge plugin CAN reach the hook routes — a service token is
 *    set and the server trusts loopback (`TRUST_LOCAL`). False → proposals are refused.
 *  - `executors`: who would send an approved draft of each kind, and whether it is on.
 */
omniApi.get("/health", async (c) => {
  let state = "ok";
  try {
    await hermes.listSessions({ limit: 1 });
  } catch (e) {
    state = e instanceof HermesError ? e.code : "internal_error";
  }
  const token = omniConfig.serviceToken();
  const hooks = { serviceToken: !!token && token.length >= 16, trustLocal: config.trustLocal };
  return c.json({
    api: OMNI_API_VERSION,
    hermes: state,
    hooks: { ...hooks, ready: hooks.serviceToken && hooks.trustLocal },
    executors: Object.fromEntries(APPROVAL_KINDS.map((k) => [k, executorFor(k)])),
    runningTurns: liveTurnCount(),
    checkedAt: new Date().toISOString(),
  });
});

omniApi.get("/threads", async (c) => {
  const states = (c.req.query("state") ?? "").split(",").filter(Boolean);
  if (states.some((s) => !(THREAD_STATES as readonly string[]).includes(s))) return bad(c, `state: ${THREAD_STATES.join(",")}`);
  const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 200);
  const local = new Map(listThreads(500).map((t) => [t.id, t]));
  let sessions: HermesSession[] = [];
  let hermesState: "ok" | "unavailable" = "ok";
  // Only a COMPLETE list proves a session is missing; a truncated one (or none) proves nothing.
  let complete = false;
  try {
    const l = await hermes.listSessions({ limit: 200 });
    sessions = l.sessions;
    complete = !l.hasMore;
  } catch (e) {
    if (e instanceof HermesError && e.code === "hermes_not_configured") return hermesFailure(c, e);
    hermesState = "unavailable";
  }
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const s of sessions) {
    if (!s?.id || !SESSION_ID_RE.test(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(threadView(local.get(s.id) ?? null, s));
  }
  // The gateway's own threads that Hermes did not list. Its list leaves out ARCHIVED sessions
  // (and Hermes archives old ones by itself), so absence proves nothing: each is asked for by
  // id, and only Hermes' own "no such session" makes it `gone`. A thread with a turn running
  // in this process is alive whatever Hermes says. Without a complete list nothing is asked.
  const wantArchived = c.req.query("archived") === "1";
  const missing = [...local.values()].filter((t) => !seen.has(t.id));
  const ask = complete ? missing.filter((t) => !activeTurn(t.id) && (wantArchived || !t.archived)).slice(0, GONE_LOOKUPS) : [];
  const found = new Map(await Promise.all(ask.map(async (t) => [t.id, await sessionPresence(t.id)] as const)));
  for (const t of missing) {
    const p = found.get(t.id);
    out.push(threadView(t, p && p !== "gone" && p !== "unknown" ? p : null, p === "gone"));
  }
  const filtered = out
    .filter((t) => !t.archived || c.req.query("archived") === "1")
    .filter((t) => !states.length || states.includes(t.state as string))
    .filter((t) => !q || `${t.title ?? ""} ${t.preview ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")));
  return c.json({ threads: filtered, next: null, hermes: hermesState });
});

const SOURCES = ["text", "voice", "nudge", "prism"] as const;
const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function noteIdsOf(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20 || v.some((x) => typeof x !== "string" || !NOTE_ID_RE.test(x))) return null;
  return v as string[];
}
/** The message Hermes receives: the person's text, then referenced note ids as data. */
const withNotes = (text: string, ids: string[]) => (ids.length ? `${text}\n\n[Prism notes referenced (read them with your Prism tools): ${ids.join(", ")}]` : text);
function idemKeyOf(c: Context): string | null | false {
  const k = c.req.header("idempotency-key");
  if (k === undefined) return null;
  return IDEMPOTENCY_KEY_RE.test(k) ? k : false;
}

omniApi.post("/threads", async (c) => {
  const b = await jsonBody(c);
  if (!b) return bad(c, "a JSON object body is required");
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt || prompt.length > 100_000) return bad(c, "prompt: 1–100000 characters");
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 200) : prompt.replace(/\s+/g, " ").slice(0, 80);
  const objective = typeof b.objective === "string" ? b.objective.slice(0, 2000) : null;
  const taskNoteId = typeof b.taskNoteId === "string" && NOTE_ID_RE.test(b.taskNoteId) ? b.taskNoteId : b.taskNoteId == null ? null : undefined;
  if (taskNoteId === undefined) return bad(c, "taskNoteId: a note id");
  const source = b.source === undefined ? "text" : b.source;
  if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) return bad(c, `source: ${SOURCES.join("|")}`);
  const ids = noteIdsOf(b.noteIds);
  if (!ids) return bad(c, "noteIds: up to 20 note ids");
  const id = newId("omni");
  try {
    await hermes.createSession({ id, title });
  } catch (e) {
    return hermesFailure(c, e);
  }
  const thread = ensureThread({ id, title, objective, taskNoteId, source });
  const r = startTurn(id, withNotes(prompt, taskNoteId ? [taskNoteId, ...ids] : ids), null);
  publishNotice({ type: "thread", id, op: "created" });
  return c.json({ thread: threadView(getThread(id) ?? thread, null), turnId: "turn" in r ? r.turn.id : null }, 201);
});

function threadIdParam(c: Context): string | null {
  const id = c.req.param("id") ?? "";
  return SESSION_ID_RE.test(id) ? id : null;
}

/** A Hermes message for the app: role + text + time; tool rows keep only the tool name.
 *  Left out: Hermes' model-only rows (`display_kind: hidden`), and assistant rows with no
 *  text — the carrier of a tool call, or Hermes' `(empty)` placeholder for a blank answer. */
function messageView(m: HermesMessage): Record<string, unknown> | null {
  if (!m || typeof m.role !== "string" || m.display_kind === "hidden") return null;
  const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("") : "";
  if (m.role === "tool") return { id: m.id ?? null, role: "tool", toolName: typeof m.tool_name === "string" ? bareToolName(m.tool_name) : null, at: tsIso(m.timestamp ?? null) };
  if (m.role !== "user" && m.role !== "assistant") return null;
  if (m.role === "assistant" && (!text.trim() || text.trim() === "(empty)")) return null;
  return { id: m.id ?? null, role: m.role, text, at: tsIso(m.timestamp ?? null) };
}

omniApi.get("/threads/:id", async (c) => {
  const id = threadIdParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  let session: HermesSession;
  let messages: HermesMessage[];
  try {
    [session, messages] = await Promise.all([hermes.getSession(id), hermes.getMessages(id, { limit: 200 })]);
  } catch (e) {
    // The gateway still has its row but Hermes has no such session: say so (the app shows
    // "no longer available" and can remove it), still as the documented 404 `not_found`.
    if (e instanceof HermesError && e.code === "not_found" && getThread(id)) return c.json({ error: "not_found", detail: "the agent no longer has this conversation", gone: true }, 404);
    return hermesFailure(c, e);
  }
  const t = getThread(id);
  if (t && t.unread) updateThread(id, { unread: 0 });
  expireApprovals();
  return c.json({
    thread: threadView(getThread(id), session),
    messages: messages.map(messageView).filter(Boolean),
    cards: threadCards(id),
    approvals: threadApprovals(id).map(approvalView),
    activeTurnId: activeTurn(id)?.id ?? null,
  });
});

omniApi.patch("/threads/:id", async (c) => {
  const id = threadIdParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const b = await jsonBody(c);
  if (!b) return bad(c, "a JSON object body is required");
  const unknown = Object.keys(b).filter((k) => !["title", "pinned", "archived", "state", "unread"].includes(k));
  if (unknown.length) return bad(c, `unsupported fields: ${unknown.join(", ")}`);
  if (b.title !== undefined && (typeof b.title !== "string" || b.title.length > 200)) return bad(c, "title: ≤200 characters");
  for (const f of ["pinned", "archived", "unread"]) if (b[f] !== undefined && typeof b[f] !== "boolean") return bad(c, `${f}: boolean`);
  if (b.state !== undefined && (typeof b.state !== "string" || !(THREAD_STATES as readonly string[]).includes(b.state))) return bad(c, `state: ${THREAD_STATES.join("|")}`);
  let session: HermesSession | null = null;
  try {
    session = await hermes.getSession(id);
    const hp: { title?: string; pinned?: boolean; archived?: boolean } = {};
    if (typeof b.title === "string") hp.title = b.title;
    if (typeof b.pinned === "boolean") hp.pinned = b.pinned;
    if (typeof b.archived === "boolean") hp.archived = b.archived;
    // A title Hermes will not take (it wants them unique, ≤ 100 characters) stays the
    // gateway's own: the app's title is the row here, not Hermes'.
    if (Object.keys(hp).length) session = (await hermes.patchSession(id, hp)).session ?? session;
    presence.delete(id);
  } catch (e) {
    // Hermes no longer has the session but the gateway has its own row: the change is made
    // to that row only — this is how the app removes a dead thread from its list
    // (`{archived: true}`). Nothing is created for an id neither side knows.
    const gone = e instanceof HermesError && e.code === "not_found" && !!getThread(id);
    if (!gone) return hermesFailure(c, e);
    session = null;
  }
  const gone = session === null;
  if (!gone) ensureThread({ id, title: session?.title ?? null, source: "hermes" });
  const t = updateThread(id, {
    title: typeof b.title === "string" ? b.title : undefined,
    pinned: b.pinned as boolean | undefined,
    archived: b.archived as boolean | undefined,
    state: b.state as ThreadState | undefined,
    unread: b.unread === false ? 0 : b.unread === true ? 1 : undefined,
  });
  return c.json({ thread: threadView(t, session, gone) });
});

omniApi.post("/threads/:id/turns", async (c) => {
  const id = threadIdParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const key = idemKeyOf(c);
  if (key === false) return bad(c, "Idempotency-Key: 8–200 characters of [A-Za-z0-9._:-]");
  const b = await jsonBody(c);
  if (!b) return bad(c, "a JSON object body is required");
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text || text.length > 100_000) return bad(c, "text: 1–100000 characters");
  const ids = noteIdsOf(b.noteIds);
  if (!ids) return bad(c, "noteIds: up to 20 note ids");
  if (!getThread(id)) {
    // A Hermes session started elsewhere (Telegram, Buzz, the Hermes desktop): adopt it.
    try {
      const s = await hermes.getSession(id);
      ensureThread({ id, title: s.title ?? null, source: "hermes" });
    } catch (e) {
      return hermesFailure(c, e);
    }
  }
  const r = startTurn(id, withNotes(text, ids), key);
  if ("active" in r) return c.json({ error: "conflict", detail: "a turn is already running", turnId: r.active.id }, 409);
  if ("replay" in r) {
    c.header("Idempotent-Replayed", "true");
    return c.json({ turnId: r.replay.id, status: r.replay.status });
  }
  return c.json({ turnId: r.turn.id, status: "running" }, 202);
});

const seqParam = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};
let openStreams = 0;

omniApi.get("/threads/:id/stream", (c) => {
  const id = threadIdParam(c);
  if (!id || !getThread(id)) return c.json({ error: "not_found" }, 404);
  if (openStreams >= omniConfig.maxStreams()) return c.json({ error: "too_many_streams" }, 429);
  const after = Math.max(seqParam(c.req.query("after")), seqParam(c.req.header("last-event-id")));
  openStreams++;
  return streamSSE(c, async (stream) => {
    let chain: Promise<unknown> = Promise.resolve();
    let lastSeq = after;
    let finished = false;
    let replaying = true;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => (resolveDone = r));
    const finish = () => {
      finished = true;
      resolveDone();
    };
    const write = (m: ThreadMessage) => {
      if (finished) return;
      if (m.seq != null) {
        if (m.seq <= lastSeq) return;
        lastSeq = m.seq;
        const data = JSON.stringify({ seq: m.seq, turnId: m.turnId, ...m.event });
        chain = chain.then(() => stream.writeSSE({ id: String(m.seq), event: m.event.t, data })).catch(() => {});
        // The turn's last event is the `status` that follows its `result`. Only a LIVE
        // event may end the stream: while replaying, an earlier turn's `status` is history,
        // and closing on it would cut the replay short (the end of the replay is judged
        // once, below).
        if (!replaying && m.event.t === "status" && m.turnId && getTurn(m.turnId)?.status !== "running" && !activeTurn(id)) finish();
      } else {
        chain = chain.then(() => stream.writeSSE({ event: m.event.t, data: JSON.stringify({ turnId: m.turnId, ...m.event }) })).catch(() => {});
      }
    };
    const buffered: ThreadMessage[] = [];
    const unsub = subscribeThread(id, (m) => (replaying ? buffered.push(m) : write(m)));
    for (const e of eventsAfter(id, after)) write({ seq: e.seq, turnId: e.turnId, event: e.payload as unknown as ThreadMessage["event"] });
    replaying = false;
    for (const m of buffered) write(m);
    if (!finished && !activeTurn(id)) finish();
    const ping = setInterval(() => {
      chain = chain.then(() => stream.write(": ping\n\n")).catch(() => {});
    }, 25_000);
    ping.unref?.();
    stream.onAbort(finish);
    await done;
    clearInterval(ping);
    unsub();
    openStreams--;
    await chain;
  });
});

omniApi.post("/turns/:id/cancel", (c) => {
  const t = getTurn(c.req.param("id") ?? "");
  if (!t) return c.json({ error: "not_found" }, 404);
  if (t.status !== "running") return c.json({ turnId: t.id, status: t.status });
  if (!cancelTurn(t.id)) return c.json({ error: "conflict", detail: "the turn is not running in this server process" }, 409);
  return c.json({ turnId: t.id, status: "cancelling" }, 202);
});

// ── owner-wide change channel ──────────────────────────────────────────────

omniApi.get("/events", (c) => {
  if (openStreams >= omniConfig.maxStreams()) return c.json({ error: "too_many_streams" }, 429);
  openStreams++;
  return streamSSE(c, async (stream) => {
    let chain: Promise<unknown> = stream.write(": connected\n\n");
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => (resolveDone = r));
    const unsub = subscribeNotices((n) => {
      chain = chain.then(() => stream.writeSSE({ event: n.type, data: JSON.stringify(n) })).catch(() => {});
    });
    const ping = setInterval(() => {
      chain = chain.then(() => stream.write(": ping\n\n")).catch(() => {});
    }, 25_000);
    ping.unref?.();
    // Connections are recycled (like /api/events) so a revoked device does not keep a channel open.
    const recycle = setTimeout(resolveDone, 15 * 60_000);
    recycle.unref?.();
    stream.onAbort(() => resolveDone());
    await done;
    clearInterval(ping);
    clearTimeout(recycle);
    unsub();
    openStreams--;
    await chain;
  });
});

// ── approvals ───────────────────────────────────────────────────────────────

const STATUSES: ApprovalStatus[] = ["pending", "approved", "sent", "failed", "unknown", "expired", "cancelled", "revised"];

omniApi.get("/approvals", (c) => {
  const st = c.req.query("status");
  if (st && !STATUSES.includes(st as ApprovalStatus)) return bad(c, `status: ${STATUSES.join("|")}`);
  expireApprovals();
  return c.json({ approvals: listApprovals(omniConfig.ownerEmail(), (st as ApprovalStatus) ?? null).map(approvalView) });
});

omniApi.get("/approvals/:id", (c) => {
  expireApprovals();
  const a = getApproval(omniConfig.ownerEmail(), c.req.param("id") ?? "");
  return a ? c.json({ approval: approvalView(a) }) : c.json({ error: "not_found" }, 404);
});

/** Human origin = a session or device credential, not self-downgraded to agent. */
function humanOrigin(c: Context): { via: string; human: boolean; device: string | null } {
  const via = requestVia(c);
  const downgrade = (c.req.header("x-prism-action-origin") ?? "").toLowerCase() === "agent";
  const actor = resolveActor(c);
  return { via, human: (via === "session" || via === "device") && !downgrade, device: actor.kind === "user" ? (actor.deviceId ?? null) : null };
}
const DIGEST_RE = /^[a-f0-9]{64}$/;

/** Edit: replace the payload (the person saw `digest`) → a NEW pending approval with a new digest. */
omniApi.put("/approvals/:id", async (c) => {
  const owner = omniConfig.ownerEmail();
  const o = humanOrigin(c);
  if (!o.human) return c.json({ error: "human_origin_required" }, 403);
  const b = await jsonBody(c);
  if (!b) return bad(c, "a JSON object body is required");
  expireApprovals();
  const a = getApproval(owner, c.req.param("id") ?? "");
  if (!a) return c.json({ error: "not_found" }, 404);
  const seen = typeof b.digest === "string" ? b.digest : b.payloadHash;
  if (typeof seen !== "string" || !DIGEST_RE.test(seen)) return bad(c, "digest: the 64-hex digest of the draft you edited");
  if (a.status !== "pending") return c.json({ error: a.status === "expired" ? "expired" : "already_decided", status: a.status }, a.status === "expired" ? 410 : 409);
  if (seen !== a.digest) return c.json({ error: "digest_mismatch", detail: "the draft changed since it was shown" }, 409);
  // A paused tool call is approved as written or not at all: Hermes is holding that exact call.
  if (a.kind === "command") return bad(c, "a command cannot be edited: deny it and ask for another");
  let v;
  try {
    v = validatePayload(a.kind, b.payload);
  } catch (e) {
    if (e instanceof ApprovalInputError) return bad(c, e.message);
    throw e;
  }
  const next = createApproval({ owner, threadId: a.threadId, kind: v.kind, payload: v.payload, summary: a.summary, ttlMs: omniConfig.approvalTtlMs(), revises: a.id });
  if (!closeApproval(a.id, "revised", o.via, o.device, null, next.id)) return c.json({ error: "already_decided" }, 409);
  omniAudit({ actor: owner, via: o.via, action: "approval.edit", approvalId: a.id, threadId: a.threadId, digest: next.digest, status: "ok" });
  publishNotice({ type: "approval", id: next.id, op: "pending", threadId: a.threadId ?? undefined });
  return c.json({ approval: approvalView(next), replaced: a.id }, 201);
});

async function decide(c: Context): Promise<Response> {
  const owner = omniConfig.ownerEmail();
  const id = c.req.param("id") ?? "";
  const o = humanOrigin(c);
  if (!o.human) {
    omniAudit({ actor: owner, via: o.via, action: "approval.decide", approvalId: id, status: "refused", error: "human_origin_required" });
    return c.json({ error: "human_origin_required", detail: "decide on the device (session or device token)" }, 403);
  }
  const key = idemKeyOf(c);
  if (!key) return bad(c, "Idempotency-Key header: 8–200 characters of [A-Za-z0-9._:-] (required)");
  const b = await jsonBody(c);
  if (!b) return bad(c, "a JSON object body is required");
  const decision = b.decision === "approve" ? "send" : b.decision === "reject" ? "cancel" : b.decision;
  if (decision !== "send" && decision !== "cancel" && decision !== "revise") return bad(c, "decision: send|cancel|revise");
  const digest = typeof b.digest === "string" ? b.digest : b.payloadHash;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) return bad(c, "digest: the 64-hex digest of the draft shown");
  expireApprovals();
  const a = getApproval(owner, id);
  if (!a) return c.json({ error: "not_found" }, 404);
  // Replay: the same key on an already-decided approval answers the stored outcome.
  if (a.status !== "pending") {
    if (rawIdemKey(owner, id) === key) {
      c.header("Idempotent-Replayed", "true");
      return c.json({ approval: approvalView(a) });
    }
    if (a.status === "expired") {
      omniAudit({ actor: owner, via: o.via, action: "approval.decide", approvalId: id, threadId: a.threadId, digest, status: "refused", error: "expired" });
      return c.json({ error: "expired" }, 410);
    }
    return c.json({ error: a.status === "approved" ? "in_progress" : "already_decided", status: a.status }, 409);
  }
  if (digest !== a.digest) {
    omniAudit({ actor: owner, via: o.via, action: "approval.decide", approvalId: id, threadId: a.threadId, digest, status: "refused", error: "digest_mismatch" });
    return c.json({ error: "digest_mismatch", detail: "the draft changed since it was shown — review it again" }, 409);
  }
  if (decision === "cancel" || decision === "revise") {
    if (!closeApproval(id, decision === "cancel" ? "cancelled" : "revised", o.via, o.device, key)) return c.json({ error: "already_decided" }, 409);
    omniAudit({ actor: owner, via: o.via, action: `approval.${decision}`, approvalId: id, threadId: a.threadId, digest, status: "ok" });
    publishNotice({ type: "approval", id, op: decision === "cancel" ? "cancelled" : "revised", threadId: a.threadId ?? undefined });
    let turnId: string | null = null;
    const feedback = typeof b.feedback === "string" ? b.feedback.trim().slice(0, 20_000) : "";
    // A denied tool call: the thread shows it (the turn that asked is still running).
    if (a.kind === "command" && a.threadId && getThread(a.threadId)) emit(a.threadId, null, { t: "approval", approval: approvalView(getApproval(owner, id)!) });
    if (decision === "revise" && a.kind !== "command" && a.threadId && getThread(a.threadId) && feedback) {
      // The feedback goes back into the thread as a turn; Hermes proposes a new draft.
      const r = startTurn(a.threadId, `Revise the ${a.kind} draft (approval ${a.id}) as follows. Propose the new draft with omni_propose; do not send anything.\n\n${feedback}`, `revise-${key}`.slice(0, 200));
      turnId = "turn" in r ? r.turn.id : "active" in r ? r.active.id : r.replay.id;
    }
    return c.json({ approval: approvalView(getApproval(owner, id)!), turnId });
  }
  // send: pre-check the executor so a disabled one costs nothing and keeps the approval pending.
  const exec = executorFor(a.kind);
  if (!exec.available || !exec.enabled) {
    const error = exec.available ? "executor_disabled" : "executor_unavailable";
    omniAudit({ actor: owner, via: o.via, action: "approval.send", approvalId: id, threadId: a.threadId, digest, status: "refused", error });
    return c.json({ error, executor: exec.name, detail: exec.available ? "this kind of action is switched off on the server (ACTIONS_*_ENABLED)" : "no executor is wired for this kind yet" }, 503);
  }
  if (!claimApproval(id, digest, o.via, o.device, key)) return c.json({ error: "already_decided" }, 409);
  omniAudit({ actor: owner, via: o.via, action: "approval.approve", approvalId: id, threadId: a.threadId, digest, status: "ok" });
  if (a.kind === "command") {
    // Nothing is executed here. The approval is now `approved`; the plugin that paused the
    // call sees it on its next poll, lets that exact call run, and reports how it ended.
    const approved = getApproval(owner, id)!;
    publishNotice({ type: "approval", id, op: "approved", threadId: a.threadId ?? undefined });
    if (a.threadId && getThread(a.threadId)) emit(a.threadId, null, { t: "approval", approval: approvalView(approved) });
    return c.json({ approval: approvalView(approved) });
  }
  let out: ExecOutcome;
  try {
    out = await executor({ kind: a.kind, payload: a.payload, approvalId: id, headers: forwardHeaders(c) });
  } catch {
    out = { status: "unknown", detail: { error: "executor_error" } };
  }
  if (out.status === "disabled") {
    unclaimApproval(id);
    omniAudit({ actor: owner, via: o.via, action: "approval.send", approvalId: id, threadId: a.threadId, digest, status: "refused", error: String(out.detail.error ?? "executor_disabled") });
    return c.json({ error: out.detail.error ?? "executor_disabled", executor: exec.name }, 503);
  }
  finishApproval(id, out.status, out.detail);
  omniAudit({ actor: owner, via: o.via, action: "approval.send", approvalId: id, threadId: a.threadId, digest, status: out.status, error: out.status === "sent" ? null : String(out.detail.error ?? "") || null });
  const done = getApproval(owner, id)!;
  publishNotice({ type: "approval", id, op: out.status, threadId: a.threadId ?? undefined });
  if (a.threadId && getThread(a.threadId)) {
    emit(a.threadId, null, { t: "approval", approval: approvalView(done) });
  }
  return c.json({ approval: approvalView(done) }, out.status === "sent" ? 200 : out.status === "failed" ? 422 : 502);
}
omniApi.post("/approvals/:id/decision", decide);
omniApi.post("/approvals/:id/decide", decide);

// ── jobs (Hermes cron) ──────────────────────────────────────────────────────

function jobView(j: Record<string, unknown>): Record<string, unknown> {
  const keep = ["id", "name", "schedule", "enabled", "paused", "next_run_at", "last_run_at", "last_status", "last_error", "deliver", "skill", "skills", "repeat", "state"];
  return Object.fromEntries(keep.filter((k) => j[k] !== undefined).map((k) => [k, k === "last_error" && typeof j[k] === "string" ? (j[k] as string).slice(0, 300) : j[k]]));
}
omniApi.get("/jobs", async (c) => {
  try {
    return c.json({ jobs: (await hermes.listJobs(true)).map((j) => jobView(j as Record<string, unknown>)) });
  } catch (e) {
    return hermesFailure(c, e);
  }
});
omniApi.post("/jobs", async (c) => {
  const b = await jsonBody(c);
  if (!b) return bad(c, "a JSON object body is required");
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const schedule = typeof b.schedule === "string" ? b.schedule.trim() : "";
  const prompt = typeof b.prompt === "string" ? b.prompt : "";
  const skill = typeof b.skill === "string" && b.skill.trim() ? b.skill.trim().slice(0, 200) : undefined;
  if (!name || name.length > 200) return bad(c, "name: 1–200 characters");
  if (!schedule || schedule.length > 200) return bad(c, "schedule: required");
  if (!prompt && !skill) return bad(c, "prompt or skill: required");
  if (prompt.length > 5000) return bad(c, "prompt: ≤5000 characters");
  // Hermes' route reads `skills` (a list); a lone `skill` key is ignored there and the job
  // is then refused as having nothing to run.
  const body: Record<string, unknown> = { name, schedule, ...(prompt ? { prompt } : {}), ...(skill ? { skills: [skill] } : {}) };
  if (typeof b.deliver === "string" && b.deliver.length <= 200) body.deliver = b.deliver;
  try {
    const job = await hermes.createJob(body);
    omniAudit({ actor: omniConfig.ownerEmail(), via: requestVia(c), action: "job.create", status: "ok" });
    return c.json({ job: jobView(job as Record<string, unknown>) }, 201);
  } catch (e) {
    return hermesFailure(c, e);
  }
});
omniApi.post("/jobs/:id/:action", async (c) => {
  const id = c.req.param("id") ?? "";
  const action = c.req.param("action");
  if (!JOB_ID_RE.test(id)) return c.json({ error: "not_found" }, 404);
  if (action !== "pause" && action !== "resume" && action !== "run") return c.json({ error: "not_found" }, 404);
  try {
    const job = await hermes.jobAction(id, action);
    omniAudit({ actor: omniConfig.ownerEmail(), via: requestVia(c), action: `job.${action}`, status: "ok" });
    return c.json({ job: jobView(job as Record<string, unknown>) });
  } catch (e) {
    return hermesFailure(c, e);
  }
});

// ── today ───────────────────────────────────────────────────────────────────

omniApi.get("/today", async (c) => {
  const q = c.req.query("date");
  if (q !== undefined && !validDate(q)) return bad(c, "date: YYYY-MM-DD");
  return c.json(await buildToday(dispatcherFor(c), q ?? localDate()));
});

// ── hooks (Hermes omni-bridge plugin, sweeps): loopback + service token ────

/** `omni_propose`: a draft for Benjamin's review. Stores it; sends NOTHING. */
omniApi.post("/hooks/propose", async (c) => {
  const owner = omniConfig.ownerEmail();
  const b = await jsonBody(c);
  if (!b) return bad(c, "a JSON object body is required");
  let threadId: string | null = null;
  if (b.threadId !== undefined && b.threadId !== null) {
    if (typeof b.threadId !== "string" || !SESSION_ID_RE.test(b.threadId)) return bad(c, "threadId: a thread (Hermes session) id");
    threadId = b.threadId;
  }
  let v;
  try {
    v = validatePayload(b.kind, b.payload);
  } catch (e) {
    if (e instanceof ApprovalInputError) return bad(c, e.message);
    throw e;
  }
  const ttl = typeof b.expiresInSec === "number" && b.expiresInSec >= 60 && b.expiresInSec <= 7 * 86_400 ? b.expiresInSec * 1000 : omniConfig.approvalTtlMs();
  const a = createApproval({ owner, threadId, kind: v.kind, payload: v.payload, summary: typeof b.summary === "string" ? b.summary : null, ttlMs: ttl });
  omniAudit({ actor: "hermes", via: "service-token", action: "approval.propose", approvalId: a.id, threadId, digest: a.digest, status: "ok" });
  if (threadId) {
    ensureThread({ id: threadId, source: "hermes" });
    emit(threadId, null, { t: "approval", approval: approvalView(a) });
    // A paused tool call: the turn is waiting for the person, and the thread says so.
    if (a.kind === "command" && activeTurn(threadId)) emit(threadId, activeTurn(threadId)!.id, { t: "status", state: "needs-you", reason: "approval_requested" });
  }
  publishNotice({ type: "approval", id: a.id, op: "pending", threadId: threadId ?? undefined });
  pushOmni("OMNI_APPROVAL", a.id);
  return c.json({ id: a.id, digest: a.digest, status: a.status, expiresAt: new Date(a.expiresAt).toISOString() }, 201);
});

/**
 * The plugin, while it holds a paused tool call: has the person decided? Only the status —
 * never the payload (the plugin has it) and nothing that would let it decide for them.
 */
omniApi.get("/hooks/approvals/:id", (c) => {
  expireApprovals();
  const a = getApproval(omniConfig.ownerEmail(), c.req.param("id") ?? "");
  if (!a || a.kind !== "command") return c.json({ error: "not_found" }, 404);
  return c.json({ id: a.id, status: a.status, digest: a.digest, decidedVia: a.decidedVia });
});

/** The approved call ran: how it ended (`sent` = it ran, `failed` = it ran and failed). */
omniApi.post("/hooks/approvals/:id/result", async (c) => {
  const b = await jsonBody(c);
  if (!b || typeof b.ok !== "boolean") return bad(c, "{ok: boolean} is required");
  const owner = omniConfig.ownerEmail();
  const a = getApproval(owner, c.req.param("id") ?? "");
  if (!a || a.kind !== "command") return c.json({ error: "not_found" }, 404);
  if (a.status !== "approved") return c.json({ error: "conflict", status: a.status }, 409);
  finishApproval(a.id, b.ok ? "sent" : "failed", { executor: "hermes-turn", ran: true, ok: b.ok });
  omniAudit({ actor: "hermes", via: "service-token", action: "approval.ran", approvalId: a.id, threadId: a.threadId, digest: a.digest, status: b.ok ? "sent" : "failed" });
  const done = getApproval(owner, a.id)!;
  publishNotice({ type: "approval", id: a.id, op: b.ok ? "sent" : "failed", threadId: a.threadId ?? undefined });
  if (a.threadId && getThread(a.threadId)) emit(a.threadId, null, { t: "approval", approval: approvalView(done) });
  return c.json({ id: a.id, status: done.status });
});

/** The plugin stopped waiting (nobody answered): the question is taken back. */
omniApi.post("/hooks/approvals/:id/withdraw", async (c) => {
  const owner = omniConfig.ownerEmail();
  const a = getApproval(owner, c.req.param("id") ?? "");
  if (!a || a.kind !== "command") return c.json({ error: "not_found" }, 404);
  if (a.status === "pending" && closeApproval(a.id, "cancelled", "withdrawn", null, null)) {
    omniAudit({ actor: "hermes", via: "service-token", action: "approval.withdraw", approvalId: a.id, threadId: a.threadId, digest: a.digest, status: "ok" });
    publishNotice({ type: "approval", id: a.id, op: "cancelled", threadId: a.threadId ?? undefined });
    if (a.threadId && getThread(a.threadId)) emit(a.threadId, null, { t: "approval", approval: approvalView(getApproval(owner, a.id)!) });
  }
  return c.json({ id: a.id, status: getApproval(owner, a.id)!.status });
});

/** Post-turn hook: Hermes finished a turn the app did not start (heartbeat, cron, /goal). */
omniApi.post("/hooks/turn", async (c) => {
  const b = await jsonBody(c);
  if (!b) return bad(c, "a JSON object body is required");
  const sessionId = b.sessionId;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return bad(c, "sessionId: a Hermes session id");
  // While the app's own turn runs on this thread there is no news to announce: the turn is
  // being streamed, and its end is announced by the turn runner. (A notice here would push
  // "new message" for a turn the person is watching.)
  if (activeTurn(sessionId)) return c.json({ ok: true, threadId: sessionId, ignored: "turn_running" }, 202);
  const t = getThread(sessionId) ?? ensureThread({ id: sessionId, source: "hermes" });
  bumpUnread(t.id);
  emit(t.id, null, { t: "status", state: t.state, reason: "agent_message" });
  publishNotice({ type: "thread", id: t.id, op: "message" });
  pushOmni("OMNI_THREAD", t.id);
  return c.json({ ok: true, threadId: t.id }, 202);
});


// ── M3 nudges: hooks only propose, app presses only start private work ─────────
omniApi.get("/nudges", c => c.json({nudges:listNudges(omniConfig.ownerEmail(),c.req.query("later")==="1")}));
omniApi.get("/nudges/settings", c => { const {dial,killed}=nudgeSettings(omniConfig.ownerEmail());return c.json({dial,killed}); });
omniApi.patch("/nudges/settings",async c=>{
 if(!humanOrigin(c).human)return c.json({error:"human_origin_required"},403);
 const b=await jsonBody(c);if(!b)return bad(c,"JSON object required");
 if(b.dial!==undefined&&!(DIALS as readonly unknown[]).includes(b.dial))return bad(c,"invalid dial");
 if(b.killed!==undefined&&typeof b.killed!=="boolean")return bad(c,"killed: boolean");
 setNudgeSettings(omniConfig.ownerEmail(),{...(b.dial!==undefined?{dial:b.dial as typeof DIALS[number]}:{}),...(b.killed!==undefined?{killed:b.killed as boolean}:{})});
 const {dial,killed}=nudgeSettings(omniConfig.ownerEmail());return c.json({dial,killed});
});
omniApi.get("/nudges/audit",c=>c.json({report:latestNudgeAudit(omniConfig.ownerEmail())}));
omniApi.get("/nudges/:id",c=>{const n=getNudge(omniConfig.ownerEmail(),c.req.param("id"));return n?c.json(n):c.json({error:"not_found"},404);});
omniApi.post("/hooks/nudges",async c=>{
 const b=await jsonBody(c);if(!b)return bad(c,"JSON object required");
 const finite=(x:unknown):x is number=>typeof x==="number"&&Number.isFinite(x);
 const text=(x:unknown,max:number):x is string=>typeof x==="string"&&x.trim().length>0&&x.length<=max;
 if(b.operationalSource!==undefined)return bad(c,"operational source requires its dedicated hook");
 if(!text(b.sourceId,128)||!NOTE_ID_RE.test(b.sourceId)||!(NUDGE_KINDS as readonly unknown[]).includes(b.kind)||!text(b.title,200)||!text(b.summary,1000)||!Array.isArray(b.reasons)||b.reasons.length>8||b.reasons.some(x=>!text(x,300))||!finite(b.baseScore)||b.baseScore<0||b.baseScore>1||!finite(b.priority)||b.priority<0||b.priority>1||typeof b.commitment!=="boolean")return bad(c,"invalid nudge candidate");
 for(const field of ["deadline","urgentAt"])if(b[field]!==null&&(!finite(b[field])||!Number.isSafeInteger(b[field] as number)||Number(b[field])<0))return bad(c,`${field}: timestamp or null`);
 if(b.senderId!==null&&(!text(b.senderId,128)||!NOTE_ID_RE.test(b.senderId)))return bad(c,"senderId: note id or null");
 const source=await resolveNote({id:b.sourceId,fresh:true});if(!source?.path||source.tags?.includes("prism-trashed")||source.trashed)return c.json({error:"source_unavailable"},422);
 const n=upsertNudge(omniConfig.ownerEmail(),{...b,sourcePath:source.path} as unknown as Candidate);
 publishNotice({type:"card",id:n.id,op:"nudge"});return c.json(n,201);
});
omniApi.post("/hooks/nudges/operational",async c=>{
 const b=await jsonBody(c),now=Date.now();if(!b)return bad(c,"JSON required");
 let source:Candidate["operationalSource"],sourceId:string,title:string,summary:string,baseScore:number;
 if(b.kind==="job"){
  if(typeof b.jobId!=="string"||!/^[a-f0-9]{12}$/.test(b.jobId)||typeof b.runAt!=="number"||!Number.isSafeInteger(b.runAt)||b.runAt<now-7*86400000||b.runAt>now)return bad(c,"verified job run required");
  try{const job=await hermes.getJob(b.jobId);if(job.last_status!=="error"||Date.parse(String(job.last_run_at))!==b.runAt)return c.json({error:"job_run_changed"},409);}catch(e){return hermesFailure(c,e);}
  source={kind:"job",jobId:b.jobId,runAt:b.runAt};sourceId=`ops_job_${b.jobId}_${b.runAt}`;title="Scheduled job needs attention";summary="The latest run failed. Open Recurring to inspect its status. No automatic retry or outward action has been taken.";baseScore=.7;
 }else if(b.kind==="freshness"){
  if(typeof b.subsystem!=="string"||!Object.hasOwn(FRESHNESS_SUBSYSTEMS,b.subsystem)||typeof b.lastSeen!=="number"||!Number.isSafeInteger(b.lastSeen)||b.lastSeen<0||b.lastSeen>now)return bad(c,"verified freshness subsystem required");
  const subsystem=b.subsystem as keyof typeof FRESHNESS_SUBSYSTEMS;if(b.lastSeen&&now-b.lastSeen<=FRESHNESS_SUBSYSTEMS[subsystem]*3600000)return bad(c,"source is not stale");
  source={kind:"freshness",subsystem,lastSeen:b.lastSeen};sourceId=`ops_freshness_${subsystem.replaceAll("-","_")}_${b.lastSeen}`;title="Pipeline freshness needs attention";summary="The source has exceeded its configured freshness window. Check this pipeline before relying on it.";baseScore=.65;
 }else return bad(c,"operational kind: job|freshness");
 const n=upsertNudge(omniConfig.ownerEmail(),{sourceId,sourcePath:source.kind==="job"?`omni/jobs/${source.jobId}`:`omni/health/${source.subsystem}`,kind:source.kind,operationalSource:source,title,summary,reasons:["Verified source status"],senderId:null,baseScore,priority:.7,deadline:null,urgentAt:null,commitment:false},now);
 publishNotice({type:"card",id:n.id,op:"nudge"});return c.json(n,201);
});
omniApi.post("/nudges/:id/action",async c=>{
 if(!humanOrigin(c).human)return c.json({error:"human_origin_required"},403);
 const b=await jsonBody(c);if(!b)return bad(c,"JSON object required");
 const owner=omniConfig.ownerEmail(),id=c.req.param("id");const n=getNudge(owner,id);if(!n)return c.json({error:"not_found"},404);
 if(!["noise","relevant","dismiss","snooze","seen"].includes(String(b.action)))return bad(c,"invalid action");
 const until=b.until;
 if(b.action==="snooze"&&(typeof until!=="number"||!Number.isSafeInteger(until)||until<=Date.now()||until>Date.now()+30*86400000))return bad(c,"until: future timestamp within 30 days");
 return c.json(nudgeAction(owner,id,b.action as "noise"|"relevant"|"dismiss"|"snooze"|"seen",b.action==="snooze"?until as number:null));
});

/** Meeting evidence comes from the read-only calendar producer; Focus comes from the owner's device. */
omniApi.post("/hooks/nudges/context",async c=>{
 const b=await jsonBody(c);if(!b||typeof b.inMeeting!=="boolean")return bad(c,"inMeeting: boolean");
 const owner=omniConfig.ownerEmail(),now=Date.now(),old=nudgeSettings(owner).context;
 const context:InterruptContext={inMeeting:b.inMeeting,focus:old?.focus??"unknown",meetingObservedAt:now,focusObservedAt:old?.focusObservedAt??0,observedAt:now};
 setNudgeSettings(owner,{context},now);return c.json({ok:true});
});
omniApi.post("/nudges/context",async c=>{
 if(!humanOrigin(c).human||requestVia(c)!=="device")return c.json({error:"device_token_required"},403);
 const b=await jsonBody(c);if(!b||!["none","work","unknown"].includes(String(b.focus)))return bad(c,"focus: none|work|unknown");
 const owner=omniConfig.ownerEmail(),now=Date.now(),old=nudgeSettings(owner).context;
 const context:InterruptContext={inMeeting:old?.inMeeting??true,focus:b.focus as InterruptContext["focus"],meetingObservedAt:old?.meetingObservedAt??0,focusObservedAt:now,observedAt:old?.meetingObservedAt??0};
 setNudgeSettings(owner,{context},now);return c.json({ok:true});
});
const nudgeStarts=new Map<string,Promise<Response>>();
omniApi.post("/nudges/:id/start",async c=>{
 if(!humanOrigin(c).human)return c.json({error:"human_origin_required"},403);
 const b=await jsonBody(c);if(!b||!["draft-reply","start-working"].includes(String(b.action)))return bad(c,"action: draft-reply|start-working");
 const owner=omniConfig.ownerEmail(),id=c.req.param("id"),n=getNudge(owner,id);if(!n)return c.json({error:"not_found"},404);
 if(n.resolved)return c.json({error:"source_resolved"},409);
 const key=idemKeyOf(c);if(!key)return bad(c,"Idempotency-Key required");
 if(nudgeStarts.has(id))return c.json({error:"start_in_progress"},409);
 const work=(async()=>{
  const operational=n.candidate.operationalSource;
  if(operational&&b.action==="draft-reply")return bad(c,"operational sources support private investigation only");
  if(!operational){const source=await resolveNote({id:n.candidate.sourceId,fresh:true});if(!source||source.tags?.includes("prism-trashed")||source.trashed)return c.json({error:"source_unavailable"},422);}
  if(operational?.kind==="job"){
   try{const job=await hermes.getJob(operational.jobId);if(job.last_status!=="error"||Date.parse(String(job.last_run_at))!==operational.runAt)return c.json({error:"job_run_changed"},409);}catch(e){return hermesFailure(c,e);}
  }
  let threadId=n.threadId;
  if(!threadId){
   threadId=newId("omni");
   try{await hermes.createSession({id:threadId,title:n.candidate.title.slice(0,100)});}catch(e){return hermesFailure(c,e);}
   ensureThread({id:threadId,title:n.candidate.title,taskNoteId:operational?null:n.candidate.sourceId,source:"nudge"});
   bindNudgeThread(owner,id,threadId);
  }
  const instruction=b.action==="draft-reply"?"Read the source and prepare a reply draft for my review. Propose it with omni_propose; do not send, publish or execute anything.":"Read the source and help me start working on this item. Explain the next useful step. Do not send, publish or execute anything.";
  const prompt=operational?`Investigate this operational source privately: ${JSON.stringify(operational)}. ${n.candidate.summary} Check current status before proposing a fix. Do not send, publish, retry or execute anything without my review.`:withNotes(instruction,[n.candidate.sourceId]);
  const r=startTurn(threadId,prompt,`nudge-${sha256(`${id}:${b.action}:${key}`)}`);
  publishNotice({type:"thread",id:threadId,op:"nudge-started"});
  return c.json({threadId,turnId:"turn" in r?r.turn.id:"replay" in r?r.replay.id:r.active.id});
 })();nudgeStarts.set(id,work);try{return await work;}finally{nudgeStarts.delete(id);}
});

/** These hooks expose IDs/counts only to the already authenticated loopback producer. */
omniApi.get("/hooks/nudges/jobs",async c=>{
 try { const jobs=await hermes.listJobs(true);if(jobs.length>=500)return c.json({error:"jobs_incomplete"},503);
 return c.json({complete:true,jobs:jobs.map(j=>({id:j.id,last_run_at:j.last_run_at,last_status:j.last_status}))}); }catch(e){return hermesFailure(c,e);}
});
omniApi.get("/hooks/nudges/sources",c=>c.json(priorNudgeSources(omniConfig.ownerEmail())));
omniApi.post("/hooks/nudges/resolve",async c=>{
 const b=await jsonBody(c);if(!b||b.complete!==true||!Array.isArray(b.sourceIds)||b.sourceIds.length>5000||b.sourceIds.some(id=>typeof id!=="string"||!NOTE_ID_RE.test(id)))return bad(c,"complete verified resolution IDs required");
 for(const id of new Set(b.sourceIds as string[])){const resolved=resolveNudgeSource(omniConfig.ownerEmail(),id);if(resolved)publishNotice({type:"card",id:resolved,op:"nudge"});}
 return c.json({resolved:new Set(b.sourceIds as string[]).size});
});
omniApi.post("/hooks/nudges/audit",async c=>{
 const b=await jsonBody(c),now=Date.now();
 if(!b||b.complete!==true||typeof b.since!=="number"||!Number.isSafeInteger(b.since)||b.since<now-8*86400000||b.since>now||!Array.isArray(b.replies)||b.replies.length>5000||typeof b.unknownChat!=="number"||!Number.isSafeInteger(b.unknownChat)||b.unknownChat<0||b.unknownChat>50000)return bad(c,"complete weekly reply evidence required");
 const since=b.since;
 if(b.replies.some(r=>!r||typeof r!=="object"||typeof r.sourceId!=="string"||!NOTE_ID_RE.test(r.sourceId)||!Number.isSafeInteger(r.repliedAt)||r.repliedAt<since||r.repliedAt>now||!Number.isSafeInteger(r.inboundAt)||r.inboundAt<since||r.inboundAt>r.repliedAt))return bad(c,"complete dated weekly reply evidence required");
 const report=nudgeWeeklyAudit(omniConfig.ownerEmail(),b.replies as {sourceId:string;repliedAt:number;inboundAt:number}[],since,now,b.unknownChat as number);
 publishNotice({type:"card",id:"nudge-audit",op:"nudge"});return c.json(report);
});
