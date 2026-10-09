/**
 * A STUB Hermes API server — the routes `src/omni/hermes-client.ts` calls, nothing else.
 * DEV + TEST ONLY: it has no model and no tools. Its sessions, transcripts and jobs live in
 * memory; give it a `store` (the dev script does: a JSON file beside the dev database) and
 * they survive a restart, as a real Hermes' sessions do.
 *
 * One implementation, two front doors:
 *  - `scripts/omni-stub-hermes.ts` serves `stub.fetch` over HTTP on 127.0.0.1 for the
 *    laptop dev gateway (docs/omni-module.md "Developing against a stub Hermes");
 *  - `test/omni-gateway.test.ts` + `test/omni-stub.test.ts` hand `stub.fetch` to
 *    `setHermesFetchForTests`, so the suite and the dev stub cannot drift apart.
 *
 * IT COPIES A REAL HERMES. Every shape and rule below was read from Hermes Agent v0.20.5
 * (`gateway/platforms/api_server.py`) and observed on a running one; the same checks run
 * against the stub and against a real Hermes (`scripts/omni-contract.ts`,
 * `test/omni-contract.test.ts`), so the stub can no longer agree with the gateway merely
 * because the gateway's author wrote it. What that means in practice:
 *
 *   GET    /api/sessions?limit=&offset=     → {object:"list", data, limit, offset, has_more}; ARCHIVED
 *                                             sessions are left out; pinned ones are always included
 *   POST   /api/sessions {id?, title?}      → 201 {object:"hermes.session", session}; 409 `session_exists`;
 *                                             a title already used by ANY session, or > 100 chars → 400 `invalid_title`
 *   GET    /api/sessions/{id}               → {session} | 404 `session_not_found`
 *   PATCH  /api/sessions/{id}               → {session}; an unknown key → 400 `unsupported_session_field`
 *   GET    /api/sessions/{id}/messages      → {object:"list", session_id, data, pagination}; tool rows carry
 *                                             the tool's RESULT, assistant rows the `tool_calls`
 *   POST   /api/sessions/{id}/chat/stream   → SSE; every frame carries session_id, run_id, seq, ts:
 *            run.started, message.started, assistant.delta, tool.progress, tool.started,
 *            tool.completed, assistant.completed, run.completed {messages, usage}, done
 *          - a tool that FAILED still sends `tool.completed` (there is no `tool.failed`); a tool a
 *            plugin BLOCKED sends no frame at all. The result is only in the tool row.
 *          - an MCP or plugin tool is stored as a call of the `tool_call` bridge (tool search);
 *            the stream and the tool row name the tool itself.
 *          - a run whose model call failed sends `assistant.completed` with the ERROR TEXT and
 *            `run.completed` whose `messages` hold no answer (there is no `run.failed`).
 *          - a stopped run ends the same way with what it had written (no `run.cancelled`).
 *          - `: keepalive` after 30 s of silence.
 *   POST   /v1/runs/{run_id}/stop           → {run_id, status:"stopping"}; 404 `run_not_found` until the
 *                                             run's agent exists, and once the run ended
 *   GET    /api/jobs[?include_disabled=true] → {jobs}; a paused job is disabled (hidden without the flag)
 *   POST   /api/jobs {name, schedule, prompt?, skills?, deliver?} → 200 {job}; `schedule` comes back as
 *                                             {kind, expr, display}; nothing to run / a bad schedule → 500 {error:"…"}
 *   GET|PATCH|DELETE /api/jobs/{id}, POST /api/jobs/{id}/{pause,resume,run}; a malformed id → 400
 * A missing or wrong bearer → 401 `gateway_auth_failed` on every route.
 *
 * What a turn does is decided by `script` — by default `defaultScript`, which picks a
 * deterministic scenario from a `stub:<name>` marker in the message (see SCENARIOS).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export type StubFrame = [event: string, data: Record<string, unknown>];

/** One thing the stub's "agent" does in a turn. */
export type StubAct =
  /** Assistant text, streamed as `assistant.delta` chunks. Text said before a tool call is
   *  stored on that call's assistant row; text said last is the answer. */
  | { say: string }
  /**
   * A tool call: `tool.started`, then the result (a string, or what `result()` returns —
   * a side effect such as the `omni_propose` hook call), stored as the tool row, then
   * `tool.completed` — also when the result is an error. `blocked`: a plugin vetoed the
   * call (`pre_tool_call`): the row holds the refusal and NO frame is sent for it.
   */
  | { tool: string; args?: Record<string, unknown>; preview?: string; result?: string | (() => Promise<string>); blocked?: boolean }
  /** The model's thinking (`tool.progress`, tool `_thinking`). */
  | { think: string }
  | { wait: number }
  /** A raw frame, for names this Hermes version never sends (see test/omni-gateway.test.ts). */
  | { frame: StubFrame };

/** How a turn ends after its acts. */
export type StubEnd =
  /** The answer is what was said last. Nothing said → Hermes' "no reply" notice + an `(empty)` row. */
  | "complete"
  /** The model call failed: Hermes' error text as `assistant.completed`, no answer row. */
  | "fail"
  /** Hermes itself threw: an `error {message}` frame. */
  | "raise"
  /** Keep the stream open (keepalives) until `POST /v1/runs/{id}/stop` or the caller disconnects. */
  | "hold"
  /** Break the connection without a terminal frame (a crash / a dropped socket). */
  | "drop"
  /** End the response with no terminal frame. */
  | "truncate";

export interface StubTurn {
  acts: StubAct[];
  /** Pause before every frame, ms (0 = all at once — the test suite's setting). */
  delayMs?: number;
  /** How long the run's agent takes to exist. Until then the run cannot be stopped
   *  (`run_not_found`) and a dropped caller does not interrupt it. */
  startMs?: number;
  end?: StubEnd;
  /** `fail` / `raise`: Hermes' error text. */
  failText?: string;
  /** Answer the chat POST with this HTTP error instead of a stream. */
  http?: { status: number; code?: string };
  /** After the stream ended normally: something Hermes does later on its own. */
  after?: () => void;
}

export interface StubScriptContext {
  sessionId: string;
  message: string;
  runId: string;
  stub: HermesStub;
}

export interface StubSession {
  id: string;
  title?: string | null;
  source?: string;
  model?: string | null;
  started_at?: number | null;
  last_active?: number | null;
  message_count?: number;
  preview?: string | null;
  pinned?: boolean;
  archived?: boolean;
  hidden?: boolean;
  [k: string]: unknown;
}
export interface StubMessage {
  id: number;
  session_id?: string;
  role: string;
  content?: unknown;
  tool_call_id?: string | null;
  tool_calls?: unknown;
  tool_name?: string | null;
  timestamp?: number;
  finish_reason?: string | null;
  display_kind?: string | null;
}

export interface HermesStubOptions {
  /** The bearer every request must present (Hermes' `API_SERVER_KEY`). */
  key: string;
  script?: (ctx: StubScriptContext) => StubTurn | Promise<StubTurn>;
  /** Run id minted per turn (`run_<32 hex>`). */
  runId?: () => string;
  jobs?: Array<Record<string, unknown>>;
  /** `: keepalive` comment interval while a stream is open and quiet (Hermes: 30 s). 0 = none. */
  keepaliveMs?: number;
  /** The gateway's loopback hook routes, for the scenarios that play the `omni-bridge`
   *  plugin. Absent → those scenarios' tool call reports an error. */
  bridge?: StubBridge;
  log?: (line: string) => void;
  /** Where sessions, transcripts and jobs are kept between runs. Absent → memory only. */
  store?: StubStore;
}

/** Everything the stub remembers. */
export interface StubState {
  version: 1;
  sessions: StubSession[];
  transcripts: Record<string, StubMessage[]>;
  jobs: Array<Record<string, unknown>>;
}
export interface StubStore {
  /** The saved state, or null when there is none (or it cannot be read). */
  load(): StubState | null;
  /** Called after every change. May batch; must not throw. */
  save(state: StubState): void;
}

/** What the real `omni-bridge` Hermes plugin does: two loopback POSTs with the service token. */
export interface StubBridge {
  propose(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; id?: string }>;
  turn(sessionId: string): Promise<{ ok: boolean; status: number }>;
}

export interface HermesStub {
  /** `HermesFetch`-compatible: hand it to `setHermesFetchForTests`, or serve it over HTTP. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sessions: Map<string, StubSession>;
  transcripts: Map<string, StubMessage[]>;
  jobs: Array<Record<string, unknown>>;
  /** Runs that can be stopped now (their agent exists): id → stop it. */
  runs: Map<string, () => void>;
  bridge?: StubBridge;
  /** Append to a session's transcript (what an unsolicited Hermes turn would leave). */
  appendMessage(sessionId: string, role: string, content: string, extra?: Partial<StubMessage>): StubMessage;
}

/** Hermes' limit on a session title (`SessionDB.MAX_TITLE_LENGTH`). */
const TITLE_MAX = 100;
const J = { "content-type": "application/json" };
const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: J });
/** Hermes' OpenAI-shaped error (`_openai_error`). */
const oaiError = (status: number, message: string, code: string | null): Response => json({ error: { message, type: "invalid_request_error", param: null, code } }, status);
const authError = (): Response => json({ error: { message: "Invalid gateway API key (API_SERVER_KEY)", type: "gateway_auth_error", code: "gateway_auth_failed" } }, 401);
const hex = (n: number): string => randomBytes(n).toString("hex");
const nowSec = (): number => Date.now() / 1000;
/** Hermes' notice for a model answer with no text, and the row it stores for it. */
const NO_REPLY = "⚠️ No reply: the model returned empty content after retries and any fallback providers. Try `continue`, switch model/provider, or inspect the tool output above.";
const EMPTY_ROW = "(empty)";
const RUNTIME = { provider: "stub", model: "stub-hermes", route_source: "global", requested: { provider: "", model: "" } };

/** The session as `_session_response` projects it. */
function sessionView(s: StubSession, rich = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: s.id, source: s.source ?? "api_server", user_id: null, model: s.model ?? null, title: s.title ?? null,
    started_at: s.started_at ?? null, ended_at: null, end_reason: null, message_count: s.message_count ?? 0, tool_call_count: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
    estimated_cost_usd: null, actual_cost_usd: null, api_call_count: 0, parent_session_id: null,
  };
  // Only the list carries these two (`list_sessions_rich`).
  if (rich) Object.assign(out, { last_active: s.last_active ?? s.started_at ?? null, preview: s.preview ?? "" });
  return Object.assign(out, { pinned: !!s.pinned, archived: !!s.archived, hidden: !!s.hidden, has_system_prompt: false, has_model_config: false });
}
/** A stored message as `_message_response` projects it. */
const messageView = (m: StubMessage, sessionId: string): Record<string, unknown> => ({
  id: m.id, session_id: sessionId, role: m.role, content: m.content ?? "", tool_call_id: m.tool_call_id ?? null, tool_calls: m.tool_calls ?? null,
  tool_name: m.tool_name ?? null, timestamp: m.timestamp ?? null, token_count: null, finish_reason: m.finish_reason ?? null, reasoning: null,
  reasoning_content: null, display_kind: m.display_kind ?? null,
});
/** A turn's row as `run.completed.messages` carries it (no ids). */
function turnRow(m: StubMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content ?? "" };
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.tool_name) out.tool_name = m.tool_name;
  out.timestamp = m.timestamp ?? null;
  if (m.role === "assistant") Object.assign(out, { finish_reason: m.finish_reason ?? null, reasoning: null });
  return out;
}

/** Hermes' cron schedule object, from the string a client sends (`cron/jobs.py` `parse_schedule`). */
function parseSchedule(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  if (/^(\S+\s+){4}\S+$/.test(s) && /^[\d*/,\-\s]+$/.test(s)) return { kind: "cron", expr: s, display: s };
  const every = /^every\s+(\d+)\s*([mhd])$/i.exec(s);
  if (every) return { kind: "interval", minutes: Number(every[1]) * ({ m: 1, h: 60, d: 1440 } as Record<string, number>)[every[2]!.toLowerCase()]!, display: `every ${every[1]}${every[2]!.toLowerCase()}` };
  if (/^\d+\s*[mhd]$/i.test(s) || /^\d{4}-\d{2}-\d{2}T/.test(s)) return { kind: "once", run_at: s, display: `once at ${s}` };
  return null;
}
const invalidSchedule = (raw: string): string =>
  `Invalid schedule '${raw}'. Use:\n  - Duration: '30m', '2h', '1d' (one-shot)\n  - Interval: 'every 30m', 'every 2h' (recurring)\n  - Cron: '0 9 * * *' (cron expression)\n  - Timestamp: '2026-02-03T14:00:00' (one-shot at time)`;

export function createHermesStub(opts: HermesStubOptions): HermesStub {
  if (!opts.key || opts.key.length < 16) throw new Error("hermes stub: a key of at least 16 characters is required");
  const want = Buffer.from(opts.key);
  const log = opts.log ?? (() => {});
  const mintRun = opts.runId ?? (() => `run_${hex(16)}`);
  const script = opts.script ?? defaultScript;
  const saved = opts.store?.load() ?? null;
  /** Hand the current state to the store (after every change). */
  const persist = (): void => {
    if (!opts.store) return;
    opts.store.save({ version: 1, sessions: [...stub.sessions.values()], transcripts: Object.fromEntries(stub.transcripts), jobs: stub.jobs });
  };
  let nextMessageId = 1;
  const stub: HermesStub = {
    fetch: handle,
    sessions: new Map((saved?.sessions ?? []).filter((x) => x && typeof x.id === "string").map((x) => [x.id, x])),
    transcripts: new Map(Object.entries(saved?.transcripts ?? {}).filter(([, v]) => Array.isArray(v))),
    // Saved jobs win over the seed list: a job paused before the restart stays paused.
    jobs: saved?.jobs?.length ? saved.jobs : (opts.jobs ?? []),
    runs: new Map(),
    // The plugin's calls are logged by outcome only (never the draft, never the token).
    bridge: opts.bridge && {
      propose: async (body) => {
        const r = await opts.bridge!.propose(body).catch(() => ({ ok: false, status: 0 }));
        log(`omni-bridge → /hooks/propose ${r.status || "unreachable"}`);
        return r;
      },
      turn: async (sessionId) => {
        const r = await opts.bridge!.turn(sessionId).catch(() => ({ ok: false, status: 0 }));
        log(`omni-bridge → /hooks/turn ${r.status || "unreachable"}`);
        return r;
      },
    },
    appendMessage(sessionId, role, content, extra = {}) {
      const list = stub.transcripts.get(sessionId) ?? [];
      // Message ids are one sequence across every session, as in Hermes' state.db.
      const row: StubMessage = { id: nextMessageId++, role, content, timestamp: nowSec(), ...extra };
      list.push(row);
      stub.transcripts.set(sessionId, list);
      const s = stub.sessions.get(sessionId);
      if (s) {
        s.last_active = nowSec();
        s.message_count = list.length;
        // The preview is the conversation's first user message.
        if (role === "user" && !s.preview) s.preview = content.replace(/\s+/g, " ").slice(0, 120);
      }
      persist();
      return row;
    },
  };
  for (const list of stub.transcripts.values()) for (const m of list) if (typeof m.id === "number" && m.id >= nextMessageId) nextMessageId = m.id + 1;

  function authorized(h: Headers): boolean {
    const a = h.get("authorization") ?? "";
    if (!a.startsWith("Bearer ")) return false;
    const got = Buffer.from(a.slice(7).trim());
    return got.length === want.length && timingSafeEqual(got, want);
  }
  /** `set_session_title`'s rules: ≤ 100 characters, unique across every session. */
  function titleProblem(title: string, selfId: string): string | null {
    if (title.length > TITLE_MAX) return `Title too long (${title.length} chars, max ${TITLE_MAX})`;
    for (const s of stub.sessions.values()) if (s.id !== selfId && s.title === title) return `Title '${title}' is already in use by session ${s.id}`;
    return null;
  }

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const p = u.pathname;
    // The key is never logged; only the method and path are.
    log(`${method} ${p}`);
    if (!authorized(new Headers(init.headers))) return authError();
    let body: Record<string, unknown> = {};
    if (init.body !== undefined && init.body !== null) {
      try {
        const v = JSON.parse(String(init.body)) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) return oaiError(400, "Request body must be a JSON object", null);
        body = v as Record<string, unknown>;
      } catch {
        return oaiError(400, "Invalid JSON in request body", null);
      }
    }

    // ── sessions ──
    if (p === "/api/sessions" && method === "POST") {
      const raw = body.id ?? body.session_id;
      const id = raw ? String(raw).trim() : `api_${Math.floor(nowSec())}_${hex(4)}`;
      // Hermes refuses control characters, path-unsafe ids and ids over 256 characters.
      if (!id || /[\r\n\0]/.test(id) || /(^|[\\/])\.\.([\\/]|$)|[\\/]/.test(id)) return oaiError(400, "Invalid session ID", "invalid_session_id");
      if (id.length > 256) return oaiError(400, "Session ID too long", "invalid_session_id");
      if (stub.sessions.has(id)) return oaiError(409, `Session already exists: ${id}`, "session_exists");
      const title = body.title !== undefined && body.title !== null ? String(body.title).trim() : null;
      if (title) {
        const bad = titleProblem(title, id);
        // `POST` words the duplicate differently from `PATCH`; the code is the same.
        if (bad) return oaiError(400, bad.startsWith("Title '") ? `Title already in use by session ${bad.split(" ").pop()}` : bad, "invalid_title");
      }
      const s: StubSession = { id, title: title || null, source: "api_server", model: null, started_at: nowSec(), last_active: nowSec(), message_count: 0, preview: "", pinned: false, archived: false, hidden: false };
      stub.sessions.set(id, s);
      persist();
      return json({ object: "hermes.session", session: sessionView(s) }, 201);
    }
    if (p === "/api/sessions" && method === "GET") {
      const limit = Math.min(200, Math.max(0, Number(u.searchParams.get("limit") ?? 50) || 50));
      const offset = Math.max(0, Number(u.searchParams.get("offset") ?? 0) || 0);
      // Archived and hidden sessions are not listed. Newest activity first.
      const all = [...stub.sessions.values()].filter((s) => !s.archived && !s.hidden).sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
      const page = all.slice(offset, offset + limit);
      // A pin means "always reachable": pinned sessions outside the window are added past the limit.
      const pins = all.filter((s) => s.pinned && !page.includes(s));
      const windowed = page.filter((s) => !s.pinned).length;
      return json({ object: "list", data: [...page, ...pins].map((s) => sessionView(s, true)), limit, offset, has_more: limit > 0 && windowed >= limit });
    }
    let m = /^\/api\/sessions\/([^/]+)$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const s = stub.sessions.get(id);
      if (!s) return oaiError(404, `Session not found: ${id}`, "session_not_found");
      if (method === "PATCH") {
        const allowed = ["title", "end_reason", "pinned", "archived", "hidden", "unread"];
        const unknown = Object.keys(body).filter((k) => !allowed.includes(k)).sort();
        if (unknown.length) return oaiError(400, `Unsupported session fields: ${unknown.join(", ")}`, "unsupported_session_field");
        for (const flag of ["pinned", "archived", "hidden", "unread"]) if (flag in body && typeof body[flag] !== "boolean") return oaiError(400, `'${flag}' must be a boolean`, "invalid_session_field");
        if ("title" in body) {
          const title = body.title === null ? "" : String(body.title).trim();
          const bad = title ? titleProblem(title, id) : null;
          if (bad) return oaiError(400, bad, "invalid_title");
          s.title = title || null;
        }
        for (const k of ["pinned", "archived", "hidden"]) if (k in body) s[k] = body[k];
        persist();
        return json({ object: "hermes.session", session: sessionView(s) });
      }
      if (method === "GET") return json({ object: "hermes.session", session: sessionView(s) });
      if (method === "DELETE") {
        stub.sessions.delete(id);
        stub.transcripts.delete(id);
        persist();
        return json({ object: "hermes.session.deleted", id, deleted: true });
      }
      return new Response("405: Method Not Allowed", { status: 405 });
    }
    m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(p);
    if (m && method === "GET") {
      const id = decodeURIComponent(m[1]!);
      if (!stub.sessions.has(id)) return oaiError(404, `Session not found: ${id}`, "session_not_found");
      const order = u.searchParams.get("order");
      if (order !== null && order !== "oldest" && order !== "latest") return oaiError(400, "order must be one of: oldest, latest", "invalid_pagination");
      const rawLimit = u.searchParams.get("limit");
      const limit = rawLimit === null ? 500 : Math.min(500, Number(rawLimit));
      const offset = Number(u.searchParams.get("offset") ?? 0);
      if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 0 || offset < 0) return oaiError(400, "limit and offset must be non-negative integers", "invalid_pagination");
      const all = stub.transcripts.get(id) ?? [];
      // `order=latest` (also the default without a limit): the newest `limit` rows, oldest of them first.
      const latest = order === "latest" || (order === null && rawLimit === null);
      const data = latest ? all.slice(Math.max(0, all.length - offset - limit), all.length - offset) : all.slice(offset, offset + limit);
      return json({ object: "list", session_id: id, data: data.map((x) => messageView(x, id)), pagination: { limit, offset, order: order ?? (rawLimit === null ? "latest" : "oldest"), returned: data.length } });
    }
    m = /^\/api\/sessions\/([^/]+)\/chat\/stream$/.exec(p);
    if (m && method === "POST") {
      const id = decodeURIComponent(m[1]!);
      if (!stub.sessions.has(id)) return oaiError(404, `Session not found: ${id}`, "session_not_found");
      const message = body.message ?? body.input;
      if (typeof message !== "string" || !message.trim()) return oaiError(400, "Missing 'message' field", "missing_message");
      const runId = mintRun();
      const turn = await script({ sessionId: id, message, runId, stub });
      if (turn.http) return oaiError(turn.http.status, "stub: simulated refusal", turn.http.code ?? "stub_error");
      return stream(id, runId, message, turn, init.signal ?? null);
    }

    // ── runs ──
    m = /^\/v1\/runs\/([^/]+)\/stop$/.exec(p);
    if (m && method === "POST") {
      const runId = decodeURIComponent(m[1]!);
      const stop = stub.runs.get(runId);
      // Not yet stoppable (its agent is still being built), or already over: the same answer.
      if (!stop) return oaiError(404, `Run not found: ${runId}`, "run_not_found");
      stop();
      return json({ run_id: runId, status: "stopping" });
    }

    // ── jobs (errors are `{error: "…"}`) ──
    if (p === "/api/jobs" && method === "GET") {
      const all = ["true", "1"].includes((u.searchParams.get("include_disabled") ?? "").toLowerCase());
      return json({ jobs: stub.jobs.filter((j) => all || j.enabled !== false) });
    }
    if (p === "/api/jobs" && method === "POST") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const raw = typeof body.schedule === "string" ? body.schedule.trim() : "";
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (!name) return json({ error: "Name is required" }, 400);
      if (name.length > 200) return json({ error: "Name must be ≤ 200 characters" }, 400);
      if (!raw) return json({ error: "Schedule is required" }, 400);
      if (prompt.length > 5000) return json({ error: "Prompt must be ≤ 5000 characters" }, 400);
      // Only `skills` (a list) is read; a lone `skill` key is ignored, as in Hermes.
      const skills = Array.isArray(body.skills) ? body.skills.filter((x): x is string => typeof x === "string" && !!x) : [];
      const schedule = parseSchedule(raw);
      // Hermes answers these two with a 500 and the reason as text.
      if (!schedule) return json({ error: invalidSchedule(raw) }, 500);
      if (!prompt.trim() && !skills.length) return json({ error: "Cron job has nothing to run: the prompt is blank and no script or skill(s) are set. Provide a prompt, a script, or at least one skill." }, 500);
      const job: Record<string, unknown> = {
        id: hex(6), name, prompt, skills, skill: skills[0] ?? null, schedule, schedule_display: schedule.display, repeat: { times: null, completed: 0 },
        enabled: true, state: "scheduled", paused_at: null, paused_reason: null, created_at: new Date().toISOString(), next_run_at: new Date(Date.now() + 3600_000).toISOString(),
        last_run_at: null, last_status: null, last_error: null, last_delivery_error: null, failure_streak: 0, deliver: typeof body.deliver === "string" ? body.deliver : "local",
        origin: { platform: "api_server", chat_id: "api" },
      };
      stub.jobs.push(job);
      persist();
      return json({ job });
    }
    m = /^\/api\/jobs\/([^/]+)(?:\/(pause|resume|run))?$/.exec(p);
    if (m) {
      if (!/^[a-f0-9]{12}$/.test(m[1]!)) return json({ error: "Invalid job ID format" }, 400);
      const i = stub.jobs.findIndex((j) => j.id === m![1]);
      if (i < 0) return json({ error: "Job not found" }, 404);
      const job = stub.jobs[i]!;
      if (m[2] && method === "POST") {
        if (m[2] === "pause") Object.assign(job, { enabled: false, state: "paused", paused_at: new Date().toISOString() });
        else if (m[2] === "resume") Object.assign(job, { enabled: true, state: "scheduled", paused_at: null, paused_reason: null });
        else Object.assign(job, { last_run_at: new Date().toISOString(), last_status: "ok" });
        persist();
        return json({ job });
      }
      if (!m[2] && method === "GET") return json({ job });
      if (!m[2] && method === "PATCH") {
        const allowed = ["name", "schedule", "prompt", "deliver", "skills", "skill", "repeat", "enabled"];
        const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
        if (!Object.keys(patch).length) return json({ error: "No valid fields to update" }, 400);
        if (typeof patch.schedule === "string") {
          const schedule = parseSchedule(patch.schedule);
          if (!schedule) return json({ error: invalidSchedule(patch.schedule) }, 500);
          Object.assign(patch, { schedule, schedule_display: schedule.display });
        }
        Object.assign(job, patch);
        persist();
        return json({ job });
      }
      if (!m[2] && method === "DELETE") {
        stub.jobs.splice(i, 1);
        persist();
        return json({ ok: true });
      }
    }
    return new Response("404: Not Found", { status: 404 });
  }

  /** One turn's SSE response, written the way `_handle_session_chat_stream` writes it. */
  function stream(sessionId: string, runId: string, message: string, turn: StubTurn, signal: AbortSignal | null): Response {
    const enc = new TextEncoder();
    const messageId = `msg_${hex(16)}`;
    let stopped = false;
    let wake: (() => void) | null = null;
    const stop = () => {
      stopped = true;
      wake?.();
    };
    /** The caller hung up before the agent existed: Hermes did not notice. */
    let deaf = false;
    /** The caller is gone: its request was aborted, or it stopped reading. */
    let gone = false;
    const dropped = () => !deaf && (gone || !!signal?.aborted);
    const onAbort = () => {
      if (!deaf) wake?.();
    };
    signal?.addEventListener("abort", onAbort);
    /** Sleep, ending early on stop or a dropped caller. */
    const pause = (ms: number, interruptible = true) =>
      new Promise<void>((resolve) => {
        if (interruptible && (stopped || dropped())) return resolve();
        const t = ms === Infinity ? null : setTimeout(done, ms);
        function done() {
          if (t) clearTimeout(t);
          wake = null;
          resolve();
        }
        if (interruptible) wake = done;
      });
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        let seq = 0;
        let open = true;
        const send = (event: string, data: Record<string, unknown> = {}) => {
          if (!open || gone) return;
          const payload = { session_id: sessionId, run_id: runId, seq: ++seq, ts: nowSec(), ...data };
          ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        };
        const keepalive = opts.keepaliveMs ? setInterval(() => open && !gone && ctrl.enqueue(enc.encode(": keepalive\n\n")), opts.keepaliveMs) : null;
        /** This turn's assistant + tool rows, as stored. */
        const rows: StubMessage[] = [];
        /** Text said since the last tool call. */
        let said = "";
        const close = (how: "close" | "abort" | "drop") => {
          if (keepalive) clearInterval(keepalive);
          signal?.removeEventListener("abort", onAbort);
          stub.runs.delete(runId);
          open = false;
          if (gone) return; // nobody is reading any more
          if (how === "close") ctrl.close();
          else ctrl.error(new Error(how === "abort" ? "aborted" : "stub: dropped stream"));
        };
        /** Store what was said as the turn's answer row (an interrupted run keeps its partial text). */
        const storeAnswer = (finish: string | null) => {
          if (!said) return;
          rows.push(stub.appendMessage(sessionId, "assistant", said, finish ? { finish_reason: finish } : {}));
          said = "";
        };
        const ending = (content: string) => {
          send("assistant.completed", { message_id: messageId, content, completed: true, partial: false, interrupted: false, runtime: RUNTIME });
          send("run.completed", { message_id: messageId, completed: true, messages: rows.map(turnRow), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, runtime: RUNTIME }, runtime: RUNTIME });
          send("done");
        };
        try {
          send("run.started", { user_message: { role: "user", content: message }, runtime: { provider: "", model: "", route_source: "global", requested: { provider: "", model: "" } } });
          send("message.started", { message: { id: messageId, role: "assistant" } });
          stub.appendMessage(sessionId, "user", message);
          // The agent is being built: the run exists but cannot be stopped, and a caller that
          // hangs up now is not noticed.
          if (turn.startMs) {
            await pause(turn.startMs, false);
            // …so the run goes on with nobody listening, until it is stopped by id.
            if (gone || signal?.aborted) deaf = true;
          }
          stub.runs.set(runId, stop);
          const delay = turn.delayMs ?? 0;
          for (const act of turn.acts) {
            if (dropped() || stopped) break;
            if ("wait" in act) {
              await pause(act.wait);
            } else if ("say" in act) {
              for (let i = 0; i < act.say.length; i += 14) {
                if (delay > 0) await pause(delay);
                if (dropped() || stopped) break;
                const delta = act.say.slice(i, i + 14);
                said += delta;
                send("assistant.delta", { message_id: messageId, delta });
              }
            } else if ("think" in act) {
              send("tool.progress", { message_id: messageId, tool_name: "_thinking", delta: act.think });
            } else if ("frame" in act) {
              if (delay > 0) await pause(delay);
              send(act.frame[0], act.frame[1]);
            } else {
              if (delay > 0) await pause(delay);
              const callId = `call_${hex(8)}`;
              const args = act.args ?? {};
              // Tool search is on by default: an MCP or plugin tool is hidden behind the
              // `tool_call` bridge, and the assistant row stores the bridge call. The stream
              // and the tool row name the underlying tool.
              const bridged = act.tool.startsWith("mcp__") || act.tool === "omni_propose";
              const fn = bridged ? { name: "tool_call", arguments: JSON.stringify({ name: act.tool, arguments: args }) } : { name: act.tool, arguments: JSON.stringify(args) };
              rows.push(
                stub.appendMessage(sessionId, "assistant", said, {
                  finish_reason: "tool_calls",
                  tool_calls: [{ id: callId, call_id: callId, response_item_id: `fc_${callId.slice(5)}`, type: "function", function: fn }],
                }),
              );
              said = "";
              // A call a plugin vetoes never reaches the progress callback: no frame at all.
              if (!act.blocked) send("tool.started", { message_id: messageId, tool_name: act.tool, preview: act.preview ?? null, args });
              // The tool runs a moment after it is announced, never in the same instant.
              await pause(Math.max(delay, 5), false);
              const result = typeof act.result === "function" ? await act.result().catch(() => JSON.stringify({ error: "stub: the tool raised" })) : (act.result ?? JSON.stringify({ success: true }));
              // The row is stored BEFORE the completion is announced, as in Hermes.
              rows.push(stub.appendMessage(sessionId, "tool", result, { tool_call_id: callId, tool_name: act.tool }));
              if (!act.blocked) send("tool.completed", { message_id: messageId, tool_name: act.tool, preview: null, args: null });
            }
          }
          if (!dropped() && !stopped && turn.end === "hold") await pause(Infinity);
          // A dropped caller: Hermes interrupts the run and keeps what it had written.
          if (dropped()) {
            storeAnswer(null);
            return close("abort");
          }
          if (stopped) {
            // Stopped by id: the stream ends like any other, with the text so far.
            const partial = said;
            storeAnswer(null);
            ending(partial);
            return close("close");
          }
          switch (turn.end ?? "complete") {
            case "drop":
              return close("drop");
            case "truncate":
              return close("close");
            case "raise":
              send("error", { message: turn.failText ?? "stub: Hermes raised" });
              send("done");
              return close("close");
            case "fail":
              // No answer row is stored; `messages` holds only what the turn did before failing.
              ending(turn.failText ?? "API call failed after 3 retries: HTTP 500: stub: simulated failure");
              return close("close");
            default: {
              if (!said) {
                rows.push(stub.appendMessage(sessionId, "assistant", EMPTY_ROW));
                ending(NO_REPLY);
              } else {
                const answer = said;
                send("tool.progress", { message_id: messageId, tool_name: "_thinking", delta: answer.slice(0, 500) });
                storeAnswer("stop");
                ending(answer);
              }
              close("close");
              turn.after?.();
            }
          }
        } catch (e) {
          log(`stream error: ${(e as Error).name}`);
          close("drop");
        }
      },
      cancel() {
        // The reader went away (the gateway cancelled, or the HTTP client closed): the same
        // as a dropped connection — noticed only once the agent exists.
        gone = true;
        if (!deaf) wake?.();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", "x-hermes-session-id": sessionId } });
  }

  return stub;
}

// ── the default script ──────────────────────────────────────────────────────

/** Canned drafts per approval kind — every address and id is a reserved example value. */
export const STUB_PROPOSALS: Record<string, { summary: string; payload: Record<string, unknown> }> = {
  email: {
    summary: "Email Dana (stub)",
    payload: { to: ["dana@example.com"], subject: "Friday call", body: "Hi Dana,\n\nCan we move our call to Friday at 10?\n\nThanks,\nBenjamin" },
  },
  "email-reply": {
    summary: "Reply to Dana (stub)",
    payload: { noteId: "stub-email-note-0001", expectTo: ["dana@example.com"], body: "Friday at 10 works for me.\n\nBenjamin" },
  },
  message: { summary: "Message the dev room (stub)", payload: { roomId: "!stubroom:example.org", body: "Running a few minutes late." } },
  "calendar-invite": {
    summary: "Invite: Buoy sync (stub)",
    payload: { title: "Buoy sync", start: "2026-10-09T17:00:00Z", end: "2026-10-09T17:30:00Z", attendees: ["dana@example.com"], location: "Video call", description: "Stub invite — never sent." },
  },
  tweet: { summary: "Post (stub)", payload: { text: "A stub post that is never published." } },
  "wallet-proposal": {
    summary: "Wallet proposal (stub)",
    payload: { to: "0x0000000000000000000000000000000000000000", amount: "1", token: "USDC", chain: "base", purpose: "Stub proposal — never submitted." },
  },
};

/**
 * The scenarios, chosen by `stub:<name>[:<arg>]` anywhere in the message (the app's
 * composer text reaches Hermes verbatim). No marker → `reply`.
 */
export const SCENARIOS: Record<string, string> = {
  reply: "A normal answer: a few words, one read-only tool call, then the final text.",
  plain: "A one-word answer with no tool call.",
  slow: "Streams a chunk every second for two minutes, then holds — cancel it. `stub:slow:<seconds>` sets the length.",
  slowstart: "The run's agent takes 3 s to exist (`stub:slowstart:<seconds>`): until then a stop is answered `run_not_found`, as on a real Hermes. Then it streams slowly — cancel it at once.",
  approval: "Plays the omni-bridge plugin: proposes a draft through the gateway hook. `stub:approval:<kind>` picks email (default), email-reply, message, calendar-invite, tweet or wallet-proposal.",
  error: "The model call fails: Hermes' error text arrives as the answer and the gateway must turn it into a code. `stub:error:<kind>`: auth_failed, rate_limit, budget_exceeded, timeout (default: a plain failure).",
  raise: "Hermes itself throws: an `error` frame.",
  toolfail: "`stub:toolfail:<noteId>`: a note update whose tool reports an error. Hermes still says `tool.completed`; the gateway must show it failed and build no card.",
  blocked: "A tool call a plugin vetoed (omni-bridge refusing `terminal`): nothing on the stream, the refusal in its row.",
  drop: "The connection breaks mid-answer with no terminal frame (→ `hermes_unavailable`).",
  truncate: "The stream ends cleanly but without a terminal frame (→ `stream_ended`).",
  http: "The chat request itself is refused. `stub:http:<status>` (default 500).",
  card: "`stub:card:<noteId>` reports a successful `prism_update_note` on that note, so the gateway builds a record card (the stub writes nothing).",
  followup: "A normal answer, then 3 s later an unsolicited message announced through the gateway's turn hook.",
  empty: "The model answers with no text at all (Hermes stores `(empty)` and says there was no reply).",
  silent: "Says nothing for 45 s (`stub:silent:<seconds>`), then answers — only keepalive comments in between.",
};

/** Hermes' error text for a failed model call, by the kind asked for. Never shown to the app. */
const FAILURES: Record<string, string> = {
  auth_failed: "HTTP 401: stub: Incorrect API key provided",
  rate_limit: "API call failed after 3 retries: HTTP 429: stub: rate limit exceeded",
  budget_exceeded: "HTTP 402: stub: insufficient credits",
  timeout: "API call failed after 3 retries: Request timed out.",
};

export function defaultScript(ctx: StubScriptContext): StubTurn {
  // The gateway's own "revise this draft" turn asks for a new proposal by tool name.
  const marker = /\bstub:([a-z-]+)(?::([A-Za-z0-9_.-]+))?/i.exec(ctx.message);
  const name = marker ? marker[1]!.toLowerCase() : /\bomni_propose\b/.test(ctx.message) ? "approval" : "reply";
  const arg = marker?.[2];
  const asked = ctx.message.replace(/\s+/g, " ").trim().slice(0, 80);
  const delayMs = 120;
  const slowly = (seconds: number): StubAct[] => Array.from({ length: seconds }, (_, i) => [{ wait: 1000 }, { say: `step ${i + 1} of ${seconds}… ` }] as StubAct[]).flat();

  switch (name) {
    case "slow":
      return { acts: slowly(Math.min(3600, Math.max(1, Number(arg) || 120))), end: "hold" };
    case "slowstart":
      return { startMs: Math.min(60, Math.max(1, Number(arg) || 3)) * 1000, acts: slowly(120), end: "hold" };
    case "approval": {
      const kind = arg && STUB_PROPOSALS[arg] ? arg : "email";
      const draft = STUB_PROPOSALS[kind]!;
      return {
        delayMs,
        acts: [
          { say: "Drafting that now. " },
          {
            // The plugin's tool, by its real name (a plugin tool carries no `mcp__` prefix).
            tool: "omni_propose",
            preview: `propose ${kind}`,
            args: { kind, payload: draft.payload, summary: draft.summary },
            // What the plugin returns to the model: the approval's id, or an error — never a send.
            result: async () => {
              const r = ctx.stub.bridge ? await ctx.stub.bridge.propose({ kind, payload: draft.payload, threadId: ctx.sessionId, summary: draft.summary }).catch(() => null) : null;
              if (!r) return JSON.stringify({ error: "omni_propose: the Omni gateway is not reachable; nothing was proposed and nothing was sent" });
              if (!r.ok) return JSON.stringify({ error: `omni_propose: the Omni gateway refused the proposal (HTTP ${r.status}); nothing was sent` });
              return JSON.stringify({ ok: true, approval_id: r.id ?? null, status: "pending", sent: false });
            },
          },
          { say: `I drafted the ${kind} and put it in front of you to review. Nothing has been sent.` },
        ],
      };
    }
    case "error":
      return { delayMs, acts: [], end: "fail", failText: (arg && FAILURES[arg]) || undefined };
    case "raise":
      return { delayMs, acts: [{ say: "Working on it… " }], end: "raise" };
    case "toolfail":
      return {
        delayMs,
        acts: [
          { tool: "mcp__prism__prism_update_note", preview: "update note", args: { id: arg ?? "stub-note-0001", metadata: { status: "in-progress" } }, result: JSON.stringify({ error: "stub: the note is locked" }) },
          { say: "I could not update that note: the tool reported an error." },
        ],
      };
    case "blocked":
      return {
        delayMs,
        acts: [
          { tool: "terminal", preview: "echo hi", args: { command: "echo hi" }, blocked: true, result: JSON.stringify({ error: "'terminal' is not available on the Omni surface (omni-bridge)." }) },
          { say: "I am not allowed to run commands here." },
        ],
      };
    case "drop":
      return { delayMs, acts: [{ say: "This answer will be cut off mid-" }], end: "drop" };
    case "truncate":
      return { delayMs, acts: [{ say: "This answer just stops." }], end: "truncate" };
    case "http":
      return { acts: [], http: { status: Number(arg) >= 400 && Number(arg) <= 599 ? Number(arg) : 500 } };
    case "card":
      if (!arg) return { delayMs, acts: [{ say: "Name a note: stub:card:<noteId>." }] };
      return {
        delayMs,
        acts: [
          { tool: "mcp__prism__prism_update_note", preview: "update note", args: { id: arg, metadata: { status: "in-progress" } }, result: JSON.stringify({ result: JSON.stringify({ id: arg, updated: true }) }) },
          { say: "I reported an update to that note. (The stub changed nothing in the vault.)" },
        ],
      };
    case "plain":
      return { delayMs, acts: [{ say: "ok" }] };
    case "empty":
      return { delayMs, acts: [] };
    case "silent":
      return { acts: [{ wait: Math.min(3600, Math.max(1, Number(arg) || 45)) * 1000 }, { say: "I was quiet for a while, and now I answer." }] };
    case "followup":
      return {
        delayMs,
        acts: [{ say: "I will come back to you in a few seconds." }],
        after: () => {
          const t = setTimeout(() => {
            ctx.stub.appendMessage(ctx.sessionId, "assistant", "Following up, unprompted: this message was not started by the app.");
            void ctx.stub.bridge?.turn(ctx.sessionId).catch(() => {});
          }, 3000);
          t.unref?.();
        },
      };
    default:
      return {
        delayMs,
        acts: [
          { say: "Let me look. " },
          { tool: "mcp__prism__prism_search_notes", preview: "search notes", args: { query: asked }, result: JSON.stringify({ result: "3 notes" }) },
          { wait: 400 },
          { say: `This is the stub Hermes. You said: “${asked}”. I have no model and no tools; I answer the same way every time.` },
        ],
      };
  }
}

/**
 * The `omni-bridge` plugin's two calls, against a gateway on loopback. `gatewayUrl` must be
 * an http loopback URL: the service token is never sent anywhere else.
 */
export function httpBridge(gatewayUrl: string, serviceToken: string): StubBridge {
  const u = new URL(gatewayUrl);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") throw new Error("hermes stub: the gateway URL must be http://127.0.0.1:<port>");
  const base = u.origin;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` }, body: JSON.stringify(body), redirect: "error" });
  return {
    async propose(body) {
      const r = await post("/api/omni/hooks/propose", body);
      const j = (await r.json().catch(() => ({}))) as { id?: unknown };
      return { ok: r.ok, status: r.status, id: typeof j.id === "string" ? j.id : undefined };
    },
    async turn(sessionId) {
      const r = await post("/api/omni/hooks/turn", { sessionId });
      return { ok: r.ok, status: r.status };
    },
  };
}

/**
 * A `StubStore` in one JSON file (the dev script puts it beside the dev database; it is
 * git-ignored and holds only what was typed at the stub). Writes are batched and atomic
 * (temp file + rename, mode 0600); a file that cannot be read or parsed counts as "none".
 * `flush()` writes what is pending now (call it before the process exits).
 */
export function fileStubStore(path: string, fs: { readFileSync(p: string, enc: "utf8"): string; writeFileSync(p: string, data: string, o: { mode: number }): void; renameSync(a: string, b: string): void }, debounceMs = 150): StubStore & { flush(): void } {
  let pending: StubState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const state = pending;
    pending = null;
    try {
      fs.writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(`${path}.tmp`, path);
    } catch {
      /* a dev convenience: a failed save only means the next start forgets */
    }
  };
  return {
    load() {
      try {
        const v = JSON.parse(fs.readFileSync(path, "utf8")) as StubState;
        return v && v.version === 1 && Array.isArray(v.sessions) && v.transcripts && typeof v.transcripts === "object" ? v : null;
      } catch {
        return null;
      }
    },
    save(state) {
      pending = state;
      if (debounceMs <= 0) return flush();
      if (!timer) {
        timer = setTimeout(flush, debounceMs);
        timer.unref?.();
      }
    },
    flush,
  };
}
