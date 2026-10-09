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
 * It is written FROM the gateway's client, not from a running Hermes: every shape here
 * is what the gateway expects Hermes to send. Where the real Hermes differs, only a
 * test against the real one will tell (the list is in the doc section named above).
 *
 *   GET    /api/sessions?limit=&offset=              → {object:"list", data:[Session], has_more}
 *   POST   /api/sessions {id?, title?}               → 201 {object:"hermes.session", session}
 *   GET    /api/sessions/{id}                        → {session} | 404 code session_not_found
 *   PATCH  /api/sessions/{id} {title?, pinned?, archived?, unread?} → {session}
 *   GET    /api/sessions/{id}/messages?limit=&order=latest → {object:"list", data:[Message]}
 *   POST   /api/sessions/{id}/chat/stream {message}  → SSE (`event:` / `data: {…, seq, run_id}`)
 *   POST   /v1/runs/{run_id}/stop                    → {run_id, status:"stopping"}
 *   GET    /api/jobs[?include_disabled=true]         → {jobs:[Job]}
 *   POST   /api/jobs                                 → {job}
 *   GET|PATCH|DELETE /api/jobs/{id}                  → {job}
 *   POST   /api/jobs/{id}/{pause,resume,run}         → {job}
 * Every route needs `Authorization: Bearer <key>` (constant-time compare).
 *
 * What a turn does is decided by `script` — by default `defaultScript`, which picks a
 * deterministic scenario from a `stub:<name>` marker in the message (see SCENARIOS).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export type StubFrame = [event: string, data: Record<string, unknown>];

/** How a turn's stream ends after its frames. */
export type StubEnd =
  /** End the response normally. */
  | "close"
  /** Keep it open (keepalives) until `POST /v1/runs/{id}/stop` or the caller disconnects. */
  | "hold"
  /** Break the connection without a terminal frame (a crash / a dropped socket). */
  | "drop";

export interface StubStep {
  /** Wait this long before the frame (overrides the turn's `delayMs`). */
  waitMs?: number;
  frame?: StubFrame;
  /** A side effect at this point of the turn (e.g. the `omni_propose` hook call). It may
   *  return frames to send next (e.g. `tool.completed` or `tool.failed`). */
  effect?: () => Promise<StubFrame[] | void>;
}

export interface StubTurn {
  steps: StubStep[];
  /** Pause before every frame, ms (0 = all at once — the test suite's setting). */
  delayMs?: number;
  end?: StubEnd;
  /** Frames sent when a held or still-running turn is stopped. Default: `run.cancelled`. */
  onStop?: StubFrame[];
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
  [k: string]: unknown;
}
export interface StubMessage {
  id: number;
  role: string;
  content?: unknown;
  tool_name?: string | null;
  timestamp?: number;
}

export interface HermesStubOptions {
  /** The bearer every request must present (Hermes' `API_SERVER_KEY`). */
  key: string;
  script?: (ctx: StubScriptContext) => StubTurn | Promise<StubTurn>;
  /** Run id minted per turn (`run_<alnum>`). */
  runId?: () => string;
  /** Replace the recorded transcript (tests pin a fixed one). */
  messages?: (sessionId: string) => StubMessage[];
  jobs?: Array<Record<string, unknown>>;
  /** `: keepalive` comment interval while a stream is open and quiet. 0 = none. */
  keepaliveMs?: number;
  /** The gateway's loopback hook routes, for the scenarios that play the `omni-bridge`
   *  plugin. Absent → those scenarios report a failed tool call. */
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
  /** Runs whose stream is open: id → stop it. */
  runs: Map<string, () => void>;
  bridge?: StubBridge;
  /** Append to a session's transcript (what an unsolicited Hermes turn would leave). */
  appendMessage(sessionId: string, role: string, content: string): void;
}

const J = { "content-type": "application/json" };
const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: J });
/** Hermes' OpenAI-shaped error. */
const oaiError = (status: number, message: string, code: string): Response => json({ error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error", code } }, status);
const hex = (n: number): string => randomBytes(n).toString("hex");
const nowSec = (): number => Date.now() / 1000;

export function createHermesStub(opts: HermesStubOptions): HermesStub {
  if (!opts.key || opts.key.length < 16) throw new Error("hermes stub: a key of at least 16 characters is required");
  const want = Buffer.from(opts.key);
  const log = opts.log ?? (() => {});
  const mintRun = opts.runId ?? (() => `run_${hex(8)}`);
  const script = opts.script ?? defaultScript;
  const saved = opts.store?.load() ?? null;
  /** Hand the current state to the store (after every change). */
  const persist = (): void => {
    if (!opts.store) return;
    opts.store.save({ version: 1, sessions: [...stub.sessions.values()], transcripts: Object.fromEntries(stub.transcripts), jobs: stub.jobs });
  };
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
    appendMessage(sessionId, role, content) {
      const list = stub.transcripts.get(sessionId) ?? [];
      list.push({ id: list.length + 1, role, content, timestamp: nowSec() });
      stub.transcripts.set(sessionId, list);
      const s = stub.sessions.get(sessionId);
      if (s) {
        s.last_active = nowSec();
        s.message_count = list.length;
        if (role === "assistant") s.preview = content.replace(/\s+/g, " ").slice(0, 120);
      }
      persist();
    },
  };

  function authorized(h: Headers): boolean {
    const a = h.get("authorization") ?? "";
    if (!a.startsWith("Bearer ")) return false;
    const got = Buffer.from(a.slice(7));
    return got.length === want.length && timingSafeEqual(got, want);
  }

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const p = u.pathname;
    // The key is never logged; only the method and path are.
    log(`${method} ${p}`);
    if (!authorized(new Headers(init.headers))) return oaiError(401, "Invalid API key", "invalid_api_key");
    let body: Record<string, unknown> = {};
    if (init.body !== undefined && init.body !== null) {
      try {
        const v = JSON.parse(String(init.body)) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) return oaiError(400, "A JSON object body is required", "invalid_json");
        body = v as Record<string, unknown>;
      } catch {
        return oaiError(400, "Malformed JSON", "invalid_json");
      }
    }

    // ── sessions ──
    if (p === "/api/sessions" && method === "POST") {
      const id = typeof body.id === "string" && body.id ? body.id : `api_${Math.floor(nowSec())}_${hex(4)}`;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return oaiError(400, "Invalid session id", "invalid_session_id");
      if (stub.sessions.has(id)) return oaiError(409, "Session already exists", "session_exists");
      const s: StubSession = { id, title: typeof body.title === "string" ? body.title : null, source: "api_server", model: "stub-hermes", started_at: nowSec(), last_active: nowSec(), message_count: 0, preview: null, pinned: false, archived: false };
      stub.sessions.set(id, s);
      persist();
      return json({ object: "hermes.session", session: s }, 201);
    }
    if (p === "/api/sessions" && method === "GET") {
      const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") ?? 50) || 50));
      const offset = Math.max(0, Number(u.searchParams.get("offset") ?? 0) || 0);
      const all = [...stub.sessions.values()].sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
      return json({ object: "list", data: all.slice(offset, offset + limit), has_more: offset + limit < all.length });
    }
    let m = /^\/api\/sessions\/([^/]+)$/.exec(p);
    if (m) {
      const s = stub.sessions.get(decodeURIComponent(m[1]!));
      if (!s) return oaiError(404, "Session not found", "session_not_found");
      if (method === "PATCH") {
        for (const k of ["title", "pinned", "archived", "unread"]) if (body[k] !== undefined) s[k] = body[k];
        persist();
        return json({ object: "hermes.session", session: s });
      }
      if (method === "GET") return json({ object: "hermes.session", session: s });
      return oaiError(405, "Method not allowed", "method_not_allowed");
    }
    m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(p);
    if (m && method === "GET") {
      const id = decodeURIComponent(m[1]!);
      if (!stub.sessions.has(id)) return oaiError(404, "Session not found", "session_not_found");
      const limit = Math.min(500, Math.max(1, Number(u.searchParams.get("limit") ?? 200) || 200));
      const all = opts.messages ? opts.messages(id) : (stub.transcripts.get(id) ?? []);
      // `order=latest`: the newest `limit` rows, oldest of them first.
      return json({ object: "list", data: all.slice(-limit) });
    }
    m = /^\/api\/sessions\/([^/]+)\/chat\/stream$/.exec(p);
    if (m && method === "POST") {
      const id = decodeURIComponent(m[1]!);
      if (!stub.sessions.has(id)) return oaiError(404, "Session not found", "session_not_found");
      if (typeof body.message !== "string" || !body.message) return oaiError(400, "message is required", "invalid_request");
      const runId = mintRun();
      const turn = await script({ sessionId: id, message: body.message, runId, stub });
      if (turn.http) return oaiError(turn.http.status, "stub: simulated refusal", turn.http.code ?? "stub_error");
      if (!opts.messages) stub.appendMessage(id, "user", body.message);
      return stream(id, runId, turn, init.signal ?? null);
    }

    // ── runs ──
    m = /^\/v1\/runs\/([^/]+)\/stop$/.exec(p);
    if (m && method === "POST") {
      const runId = decodeURIComponent(m[1]!);
      const stop = stub.runs.get(runId);
      if (!stop) return oaiError(404, "Run not found", "run_not_found");
      stop();
      return json({ run_id: runId, status: "stopping" });
    }

    // ── jobs (errors are `{error: "…"}`) ──
    if (p === "/api/jobs" && method === "GET") {
      const all = u.searchParams.get("include_disabled") === "true";
      return json({ jobs: stub.jobs.filter((j) => all || j.enabled !== false) });
    }
    if (p === "/api/jobs" && method === "POST") {
      if (typeof body.name !== "string" || typeof body.schedule !== "string") return json({ error: "name and schedule are required" }, 400);
      const job: Record<string, unknown> = { id: hex(6), name: body.name, schedule: body.schedule, enabled: true, state: "scheduled", next_run_at: null, last_run_at: null, last_status: null };
      for (const k of ["prompt", "skill", "deliver"]) if (body[k] !== undefined) job[k] = body[k];
      stub.jobs.push(job);
      persist();
      return json({ job }, 201);
    }
    m = /^\/api\/jobs\/([a-f0-9]{12})(?:\/(pause|resume|run))?$/.exec(p);
    if (m) {
      const i = stub.jobs.findIndex((j) => j.id === m![1]);
      if (i < 0) return json({ error: "Job not found" }, 404);
      const job = stub.jobs[i]!;
      if (m[2] && method === "POST") {
        if (m[2] === "pause") Object.assign(job, { enabled: false, state: "paused" });
        else if (m[2] === "resume") Object.assign(job, { enabled: true, state: "scheduled" });
        else Object.assign(job, { last_run_at: new Date().toISOString(), last_status: "ok" });
        persist();
        return json({ job });
      }
      if (!m[2] && method === "GET") return json({ job });
      if (!m[2] && method === "PATCH") {
        for (const k of ["name", "schedule", "prompt", "skill", "deliver", "enabled"]) if (body[k] !== undefined) job[k] = body[k];
        persist();
        return json({ job });
      }
      if (!m[2] && method === "DELETE") {
        stub.jobs.splice(i, 1);
        persist();
        return json({ job });
      }
    }
    return json({ error: "not found" }, 404);
  }

  /** One turn's SSE response. Frames carry `seq` and `run_id`, as Hermes' do. */
  function stream(sessionId: string, runId: string, turn: StubTurn, signal: AbortSignal | null): Response {
    const enc = new TextEncoder();
    let stopped = false;
    let wake: (() => void) | null = null;
    const stop = () => {
      stopped = true;
      wake?.();
    };
    stub.runs.set(runId, stop);
    const onAbort = () => wake?.();
    signal?.addEventListener("abort", onAbort);
    /** Sleep, ending early on stop or a dropped caller. */
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        if (stopped || signal?.aborted) return resolve();
        const t = ms === Infinity ? null : setTimeout(done, ms);
        function done() {
          if (t) clearTimeout(t);
          wake = null;
          resolve();
        }
        wake = done;
      });
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        let seq = 0;
        let final = "";
        let completed = false;
        const send = (f: StubFrame) => {
          if (f[0] === "assistant.completed" && typeof f[1].content === "string") final = f[1].content;
          if (f[0] === "run.completed") completed = true;
          ctrl.enqueue(enc.encode(`event: ${f[0]}\ndata: ${JSON.stringify({ ...f[1], seq: ++seq, run_id: runId })}\n\n`));
        };
        const keepalive = opts.keepaliveMs ? setInterval(() => ctrl.enqueue(enc.encode(": keepalive\n\n")), opts.keepaliveMs) : null;
        const finish = (how: "close" | "abort" | "drop") => {
          if (keepalive) clearInterval(keepalive);
          signal?.removeEventListener("abort", onAbort);
          stub.runs.delete(runId);
          if (final && !opts.messages) stub.appendMessage(sessionId, "assistant", final);
          if (how === "close") ctrl.close();
          else ctrl.error(new Error(how === "abort" ? "aborted" : "stub: dropped stream"));
        };
        try {
          const queue: StubStep[] = [...turn.steps];
          while (queue.length) {
            const step = queue.shift()!;
            const wait = step.waitMs ?? (step.frame ? (turn.delayMs ?? 0) : 0);
            if (wait > 0) await pause(wait);
            if (signal?.aborted || stopped) break;
            if (step.frame) send(step.frame);
            if (step.effect) {
              // The plugin acts a moment after its tool call is announced, never in the same
              // instant: the caller has read the frame by then.
              await pause(Math.max(turn.delayMs ?? 0, 5));
              if (signal?.aborted || stopped) break;
              const more = await step.effect();
              if (more?.length) queue.unshift(...more.map((frame) => ({ frame })));
            }
          }
          if (!signal?.aborted && !stopped && turn.end === "hold") await pause(Infinity);
          // A dropped caller: Hermes interrupts the run; there is nobody left to tell. The
          // gateway also hangs up as soon as it has read `run.completed` — that run is done.
          if (signal?.aborted) {
            finish("abort");
            if (completed) turn.after?.();
            return;
          }
          if (stopped) {
            for (const f of turn.onStop ?? [["run.cancelled", {}] as StubFrame, ["done", {}] as StubFrame]) send(f);
            return finish("close");
          }
          if (turn.end === "drop") return finish("drop");
          finish("close");
          turn.after?.();
        } catch (e) {
          log(`stream error: ${(e as Error).name}`);
          finish("drop");
        }
      },
      cancel() {
        // The reader went away (the gateway cancelled, or the HTTP client closed).
        stop();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
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
  reply: "A normal answer: a few streamed chunks, one read-only tool call, then the final text.",
  slow: "Streams a chunk every second for two minutes, then holds — cancel it. `stub:slow:<seconds>` sets the length.",
  approval: "Plays the omni-bridge plugin: proposes a draft through the gateway hook. `stub:approval:<kind>` picks email (default), email-reply, message, calendar-invite, tweet or wallet-proposal.",
  error: "The run fails. `stub:error:<code>` sends that Hermes error code (auth_failed, rate_limit, budget_exceeded, timeout, max_iterations).",
  drop: "The connection breaks mid-answer with no terminal frame (→ `hermes_unavailable`).",
  truncate: "The stream ends cleanly but without a terminal frame (→ `stream_ended`).",
  http: "The chat request itself is refused. `stub:http:<status>` (default 500).",
  card: "`stub:card:<noteId>` reports a successful `prism_update_note` on that note, so the gateway builds a record card (the stub writes nothing).",
  "hermes-approval": "Hermes' own terminal approval request (the gateway surfaces it, never answers it).",
  queued: "The run is queued first, then answers.",
  followup: "A normal answer, then 3 s later an unsolicited message announced through the gateway's turn hook.",
  empty: "A run that completes with no text at all.",
};

const chunks = (text: string, size = 14): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};
const f = (event: string, data: Record<string, unknown> = {}): StubStep => ({ frame: [event, data] });

/** A streamed answer: deltas, then `assistant.completed` with the same text. */
function say(text: string): StubStep[] {
  return [...chunks(text).map((c) => f("assistant.delta", { delta: c })), f("assistant.completed", { content: text })];
}

export function defaultScript(ctx: StubScriptContext): StubTurn {
  // The gateway's own "revise this draft" turn asks for a new proposal by tool name.
  const marker = /\bstub:([a-z-]+)(?::([A-Za-z0-9_.-]+))?/i.exec(ctx.message);
  const name = marker ? marker[1]!.toLowerCase() : /\bomni_propose\b/.test(ctx.message) ? "approval" : "reply";
  const arg = marker?.[2];
  const asked = ctx.message.replace(/\s+/g, " ").trim().slice(0, 80);
  const start: StubStep[] = [f("run.started"), f("message.started")];
  const end: StubStep[] = [f("run.completed", { usage: { input_tokens: 0, output_tokens: 0 } }), f("done")];
  const delayMs = 120;

  switch (name) {
    case "slow": {
      const seconds = Math.min(3600, Math.max(1, Number(arg) || 120));
      const steps = [...start];
      for (let i = 1; i <= seconds; i++) steps.push({ waitMs: 1000, frame: ["assistant.delta", { delta: `step ${i} of ${seconds}… ` }] });
      return { steps, end: "hold" };
    }
    case "approval": {
      const kind = arg && STUB_PROPOSALS[arg] ? arg : "email";
      const draft = STUB_PROPOSALS[kind]!;
      const tool = "mcp__omni_bridge__omni_propose";
      return {
        delayMs,
        steps: [
          ...start,
          ...chunks("Drafting that now. ").map((c) => f("assistant.delta", { delta: c })),
          f("assistant.commentary", { text: "Drafting that now." }),
          {
            frame: ["tool.started", { tool_name: tool, preview: `propose ${kind}`, args: { kind, payload: draft.payload } }],
            effect: async () => {
              const r = ctx.stub.bridge ? await ctx.stub.bridge.propose({ kind, payload: draft.payload, threadId: ctx.sessionId, summary: draft.summary }).catch(() => null) : null;
              if (!r?.ok) return [["tool.failed", { tool_name: tool, preview: r ? `the gateway refused the proposal (${r.status})` : "the gateway hook is not reachable" }]];
              return [["tool.completed", { tool_name: tool, preview: `proposed ${r.id ?? "a draft"}` }]];
            },
          },
          ...say(`I drafted the ${kind} and put it in front of you to review. Nothing has been sent.`),
          ...end,
        ],
      };
    }
    case "error":
      return { delayMs, steps: [...start, f("assistant.delta", { delta: "Working on it… " }), f("run.failed", { error: "stub: simulated failure", ...(arg ? { code: arg } : {}) }), f("done")] };
    case "drop":
      return { delayMs, steps: [...start, f("assistant.delta", { delta: "This answer will be cut " }), f("assistant.delta", { delta: "off mid-" })], end: "drop" };
    case "truncate":
      return { delayMs, steps: [...start, f("assistant.delta", { delta: "This answer just stops." })] };
    case "http":
      return { steps: [], http: { status: Number(arg) >= 400 && Number(arg) <= 599 ? Number(arg) : 500 } };
    case "card": {
      const tool = "mcp__prism__prism_update_note";
      if (!arg) return { delayMs, steps: [...start, ...say("Name a note: stub:card:<noteId>."), ...end] };
      return {
        delayMs,
        steps: [
          ...start,
          f("tool.started", { tool_name: tool, preview: "update note", args: { id: arg, metadata: { status: "in-progress" } } }),
          f("tool.completed", { tool_name: tool, preview: "ok" }),
          ...say("I reported an update to that note. (The stub changed nothing in the vault.)"),
          ...end,
        ],
      };
    }
    case "hermes-approval":
      return { delayMs, steps: [...start, f("approval.request", { command: "stub", description: "stub: a terminal command wants approval" }), ...say("I asked for a terminal approval, which Omni never answers."), ...end] };
    case "queued":
      return { delayMs, steps: [f("run.queued"), { waitMs: 1500, frame: ["run.started", {}] }, f("message.started"), ...say("That waited in the queue, then ran."), ...end] };
    case "empty":
      return { delayMs, steps: [...start, ...end] };
    case "followup":
      return {
        delayMs,
        steps: [...start, ...say("I will come back to you in a few seconds."), ...end],
        after: () => {
          const t = setTimeout(() => {
            ctx.stub.appendMessage(ctx.sessionId, "assistant", "Following up, unprompted: this message was not started by the app.");
            void ctx.stub.bridge?.turn(ctx.sessionId).catch(() => {});
          }, 3000);
          t.unref?.();
        },
      };
    default: {
      const tool = "mcp__prism__prism_search_notes";
      return {
        delayMs,
        steps: [
          ...start,
          ...chunks("Let me look. ").map((c) => f("assistant.delta", { delta: c })),
          f("assistant.commentary", { text: "Let me look." }),
          f("tool.started", { tool_name: tool, preview: "search notes", args: { query: asked } }),
          { waitMs: 400, frame: ["tool.completed", { tool_name: tool, preview: "3 notes" }] },
          ...say(`This is the stub Hermes. You said: “${asked}”. I have no model and no tools; I answer the same way every time.`),
          ...end,
        ],
      };
    }
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
