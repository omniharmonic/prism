/**
 * Hermes API client (Omni module). Talks to the Hermes gateway's `api_server`
 * platform (Nous Research Hermes Agent, `gateway/platforms/api_server.py`), which
 * the Prism Server reaches on loopback with Hermes' `API_SERVER_KEY`. Shapes below are
 * v0.20.5's, checked against a running one (`scripts/omni-contract.ts`):
 *
 *   GET    /api/sessions?limit=&offset=          → {object:"list", data:[Session], limit, offset, has_more}
 *          Every source (Telegram, CLI, cron…), newest activity first. ARCHIVED sessions are
 *          left out (Hermes also archives old ones by itself) — absence proves nothing.
 *   POST   /api/sessions {id?, title?}           → 201 {object:"hermes.session", session}
 *          Our own id is accepted (409 `session_exists`). A title must be unique across ALL
 *          sessions and ≤ 100 characters, else 400 `invalid_title`.
 *   GET    /api/sessions/{id}                    → {session}            (404 code session_not_found)
 *   PATCH  /api/sessions/{id} {title?, pinned?, archived?, unread?}     (unknown key → 400)
 *   GET    /api/sessions/{id}/messages?limit=&order=latest → {data:[Message], pagination}
 *          The newest `limit` rows, oldest first. Tool rows carry the tool's RESULT.
 *   POST   /api/sessions/{id}/chat/stream {message} → SSE `event: <name>` / `data: {…, seq, run_id, ts}`
 *          names: run.started, message.started, assistant.delta {delta}, tool.progress,
 *          tool.started {tool_name, preview, args}, tool.completed {tool_name},
 *          assistant.completed {content}, run.completed {messages, usage}, error {message},
 *          done. `: keepalive` every 30 s of silence. See stream.ts for what is NOT sent.
 *   POST   /v1/runs/{run_id}/stop               → {run_id, status:"stopping"}; 404 `run_not_found`
 *          until the run's agent exists (a few seconds after `run.started`) and once it ended.
 *   GET    /api/jobs[?include_disabled=true]     → {jobs:[Job]}   (a paused job is disabled)
 *   GET|PATCH|DELETE /api/jobs/{id}; POST /api/jobs {name, schedule, prompt?, skills?, deliver?};
 *   POST /api/jobs/{id}/{pause,resume,run} → {job}. `schedule` comes back as an object
 *   {kind, expr, display}.
 * Errors are OpenAI-shaped `{error:{message,type,code}}`; a refused key is 401
 * `gateway_auth_failed`. Jobs answer `{error: "…"}`, and a job Hermes will not accept
 * (bad schedule, nothing to run) is a 500 with that text.
 *
 * SECURITY: the key comes from the environment (`omniConfig.hermesKey`) and goes ONLY
 * in the Authorization header to the configured base URL; redirects are refused (a
 * redirect would carry it elsewhere). Hermes error text is never echoed to the app
 * verbatim — callers map the error CLASS to a code. The fetch is injectable
 * (`setHermesFetchForTests`): no test ever reaches a real Hermes.
 */
import { omniConfig } from "./config";

export type HermesFetch = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: HermesFetch | null = null;
export function setHermesFetchForTests(f: HermesFetch | null): void {
  fetchImpl = f;
}
const doFetch = (url: string, init: RequestInit): Promise<Response> => (fetchImpl ?? fetch)(url, init);

/** Base class: `code` is what the route answers; `status` the HTTP status it uses. */
export class HermesError extends Error {
  constructor(
    readonly code: "hermes_not_configured" | "hermes_unavailable" | "hermes_auth" | "not_found" | "conflict" | "hermes_rejected" | "hermes_timeout",
    readonly status: number,
    message: string,
    /** Hermes' own error code when it sent one (e.g. `session_not_found`) — never its message. */
    readonly hermesCode?: string,
  ) {
    super(message);
    this.name = "HermesError";
  }
}

export interface HermesSession {
  id: string;
  title?: string | null;
  source?: string;
  model?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  last_active?: number | null;
  message_count?: number;
  preview?: string | null;
  pinned?: boolean;
  archived?: boolean;
  estimated_cost_usd?: number | null;
}
export interface HermesMessage {
  id?: string | number;
  role: string;
  content?: unknown;
  tool_name?: string | null;
  tool_call_id?: string | null;
  tool_calls?: unknown;
  timestamp?: number | string | null;
  /** `hidden` = model-only scaffolding (a compaction handoff), not conversation. */
  display_kind?: string | null;
}
export interface HermesJob {
  id: string;
  name?: string;
  schedule?: unknown;
  enabled?: boolean;
  [k: string]: unknown;
}
export interface HermesStreamFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Hermes' own limit on a session title (`SessionDB.MAX_TITLE_LENGTH`). */
export const HERMES_TITLE_MAX = 100;
/** Hermes session ids we accept from a client (Hermes' own mint: `api_<ts>_<hex8>`; ours: `omni_<hex>`). */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Hermes cron job ids (`_JOB_ID_RE` in api_server.py). */
export const JOB_ID_RE = /^[a-f0-9]{12}$/;
const RUN_ID_RE = /^run_[A-Za-z0-9]{1,64}$/;

function base(): { url: string; key: string } {
  const key = omniConfig.hermesKey();
  if (!key) throw new HermesError("hermes_not_configured", 503, "Hermes API key is not configured");
  const url = omniConfig.hermesUrl();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HermesError("hermes_not_configured", 503, "OMNI_HERMES_URL is not a URL");
  }
  // Plain http only to a loopback host: the bearer must not cross a network in clear text.
  const loop = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) {
    throw new HermesError("hermes_not_configured", 503, "OMNI_HERMES_URL must be https or a loopback http URL");
  }
  return { url, key };
}

function classify(status: number, body: unknown): HermesError {
  const err = (body as { error?: unknown } | null)?.error;
  const hermesCode = err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string" ? ((err as { code: string }).code) : undefined;
  if (status === 401 || status === 403) return new HermesError("hermes_auth", 502, "Hermes refused the gateway's key", hermesCode);
  if (status === 404) return new HermesError("not_found", 404, "not found in Hermes", hermesCode);
  if (status === 409) return new HermesError("conflict", 409, "Hermes reported a conflict", hermesCode);
  if (status >= 400 && status < 500) return new HermesError("hermes_rejected", 400, `Hermes rejected the request (${status})`, hermesCode);
  // The cron routes answer a job they will not accept with a 500 and the reason as text
  // (`{"error": "Invalid schedule …"}`): that is the request's fault, not an outage.
  if (status === 500 && typeof err === "string" && /^(Invalid schedule|Cron job has nothing to run|Name |Prompt |Schedule |Repeat )/.test(err)) {
    return new HermesError("hermes_rejected", 400, "Hermes rejected the job", "invalid_job");
  }
  return new HermesError("hermes_unavailable", 502, `Hermes answered ${status}`, hermesCode);
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = omniConfig.requestTimeoutMs(), extraHeaders: Record<string, string> = {}): Promise<T> {
  const { url, key } = base();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await doFetch(url + path, {
      method,
      headers: { ...extraHeaders, authorization: `Bearer ${key}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (ac.signal.aborted) throw new HermesError("hermes_timeout", 504, "Hermes did not answer in time");
    throw new HermesError("hermes_unavailable", 502, `Hermes unreachable (${(e as Error).name})`);
  }
  try {
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) throw classify(res.status, parsed);
    return parsed as T;
  } catch (e) {
    if (e instanceof HermesError) throw e;
    if (ac.signal.aborted) throw new HermesError("hermes_timeout", 504, "Hermes did not answer in time");
    throw new HermesError("hermes_unavailable", 502, "Hermes answer could not be read");
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;
function sid(id: string): string {
  if (!SESSION_ID_RE.test(id)) throw new HermesError("not_found", 404, "invalid session id");
  return enc(id);
}
function jid(id: string): string {
  if (!JOB_ID_RE.test(id)) throw new HermesError("not_found", 404, "invalid job id");
  return enc(id);
}

export const hermes = {
  async listSessions(o: { limit?: number; offset?: number } = {}): Promise<{ sessions: HermesSession[]; hasMore: boolean }> {
    const q = new URLSearchParams({ limit: String(Math.min(200, Math.max(1, o.limit ?? 50))), offset: String(Math.max(0, o.offset ?? 0)) });
    const r = await request<{ data?: HermesSession[]; has_more?: boolean }>("GET", `/api/sessions?${q}`);
    return { sessions: Array.isArray(r?.data) ? r.data : [], hasMore: !!r?.has_more };
  },
  /**
   * Create the session under OUR id. The title is a convenience for Hermes' own lists: it
   * must be unique there and short, so one Hermes refuses (`invalid_title` — say, a second
   * "Call Dana") is dropped and the session is created untitled. The gateway keeps the
   * thread's real title itself.
   */
  async createSession(o: { id: string; title?: string }): Promise<HermesSession> {
    const title = o.title?.trim().slice(0, HERMES_TITLE_MAX);
    const create = (withTitle: boolean) => request<{ session?: HermesSession }>("POST", "/api/sessions", { id: o.id, ...(withTitle && title ? { title } : {}) });
    let r: { session?: HermesSession };
    try {
      r = await create(true);
    } catch (e) {
      if (!(e instanceof HermesError && e.hermesCode === "invalid_title")) throw e;
      r = await create(false);
    }
    if (!r?.session?.id) throw new HermesError("hermes_unavailable", 502, "Hermes created no session");
    return r.session;
  },
  async getSession(id: string): Promise<HermesSession> {
    const r = await request<{ session?: HermesSession }>("GET", `/api/sessions/${sid(id)}`);
    if (!r?.session) throw new HermesError("not_found", 404, "no such session");
    return r.session;
  },
  /**
   * Change a session's flags and, when it will take it, its title. A title Hermes refuses
   * (not unique, or too long for it) is skipped — `titleKept: false` — and the flags are
   * still written; the gateway's own row holds the title the app shows.
   */
  async patchSession(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean; unread?: boolean }): Promise<{ session: HermesSession | null; titleKept: boolean }> {
    const { title, ...flags } = patch;
    let session: HermesSession | null = null;
    let titleKept = true;
    if (Object.keys(flags).length) session = (await request<{ session?: HermesSession }>("PATCH", `/api/sessions/${sid(id)}`, flags))?.session ?? null;
    if (title !== undefined) {
      try {
        session = (await request<{ session?: HermesSession }>("PATCH", `/api/sessions/${sid(id)}`, { title: title.slice(0, HERMES_TITLE_MAX) }))?.session ?? session;
      } catch (e) {
        if (!(e instanceof HermesError && e.hermesCode === "invalid_title")) throw e;
        titleKept = false;
      }
    }
    return { session, titleKept };
  },
  async getMessages(id: string, o: { limit?: number; timeoutMs?: number } = {}): Promise<HermesMessage[]> {
    const q = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, o.limit ?? 200))), order: "latest" });
    const r = await request<{ data?: HermesMessage[] }>("GET", `/api/sessions/${sid(id)}/messages?${q}`, undefined, o.timeoutMs);
    return Array.isArray(r?.data) ? r.data : [];
  },
  /**
   * One streamed turn. Yields parsed SSE frames until Hermes ends the stream. `signal`
   * aborts it. Hanging up is NOT a reliable stop: Hermes notices only at its next write,
   * and before the run's agent exists it does not stop the run at all — use `stopRun`.
   * A gap of `idleMs` with no bytes at all (Hermes sends `: keepalive` every 30 s) ends it
   * with `hermes_timeout`.
   */
  async *chatStream(id: string, message: string, signal: AbortSignal, idleMs = omniConfig.streamIdleMs()): AsyncGenerator<HermesStreamFrame> {
    const { url, key } = base();
    const ac = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    // An abort ends the request AND the read: a body that is not bound to the request's
    // signal would otherwise keep being read after the caller gave up.
    const onAbort = () => {
      ac.abort();
      void reader?.cancel().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let idle: NodeJS.Timeout | undefined;
    let idled = false;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        idled = true;
        ac.abort();
        void reader?.cancel().catch(() => {});
      }, idleMs);
    };
    arm();
    try {
      let res: Response;
      try {
        res = await doFetch(`${url}/api/sessions/${sid(id)}/chat/stream`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, accept: "text/event-stream", "content-type": "application/json" },
          body: JSON.stringify({ message }),
          redirect: "error",
          signal: ac.signal,
        });
      } catch (e) {
        if (signal.aborted) return;
        if (idled) throw new HermesError("hermes_timeout", 504, "Hermes did not answer in time");
        throw new HermesError("hermes_unavailable", 502, `Hermes unreachable (${(e as Error).name})`);
      }
      if (!res.ok || !res.body) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(await res.text());
        } catch {
          /* ignore */
        }
        throw classify(res.status, parsed);
      }
      reader = res.body.getReader();
      if (signal.aborted) return void reader.cancel().catch(() => {});
      const dec = new TextDecoder();
      let buf = "";
      let evName = "";
      let data: string[] = [];
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            if (signal.aborted) return;
            if (idled) throw new HermesError("hermes_timeout", 504, "Hermes stream went silent");
            throw new HermesError("hermes_unavailable", 502, "Hermes stream broke");
          }
          if (chunk.done || signal.aborted) break;
          arm();
          buf += dec.decode(chunk.value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            let line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line === "") {
              if (data.length) {
                let parsed: unknown = null;
                try {
                  parsed = JSON.parse(data.join("\n"));
                } catch {
                  /* skip a malformed frame */
                }
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  yield { event: evName || "message", data: parsed as Record<string, unknown> };
                }
              }
              evName = "";
              data = [];
            } else if (line.startsWith(":")) {
              /* comment / keepalive */
            } else if (line.startsWith("event:")) {
              evName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data.push(line.slice(5).replace(/^ /, ""));
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      // The read ended because it went silent, not because Hermes closed the stream.
      if (idled && !signal.aborted) throw new HermesError("hermes_timeout", 504, "Hermes stream went silent");
    } finally {
      clearTimeout(idle);
      signal.removeEventListener("abort", onAbort);
    }
  },
  /**
   * Ask Hermes to stop a run. `true` = accepted. `false` = Hermes does not know the run
   * (`run_not_found`): either it already ended, or its agent is not built yet — in the
   * first seconds after `run.started` nothing can be stopped, so the caller retries.
   */
  async stopRun(runId: string): Promise<boolean> {
    if (!RUN_ID_RE.test(runId)) return false;
    try {
      await request("POST", `/v1/runs/${enc(runId)}/stop`, {});
      return true;
    } catch (e) {
      if (e instanceof HermesError && e.code === "not_found") return false;
      throw e;
    }
  },
  async listJobs(includeDisabled = true): Promise<HermesJob[]> {
    const r = await request<{ jobs?: HermesJob[] }>("GET", `/api/jobs${includeDisabled ? "?include_disabled=true" : ""}`);
    if (!Array.isArray(r?.jobs)) throw new HermesError("hermes_unavailable",503,"Hermes jobs response is incomplete");
    return r.jobs;
  },
  async getJob(id: string): Promise<HermesJob> {
    const r = await request<{ job?: HermesJob }>("GET", `/api/jobs/${jid(id)}`);
    if (!r?.job) throw new HermesError("not_found", 404, "no such job");
    return r.job;
  },
  async createJob(body: Record<string, unknown>, threadId?: string): Promise<HermesJob> {
    if (threadId !== undefined && !/^omni_[a-f0-9]+$/.test(threadId)) throw new HermesError("hermes_rejected", 400, "Invalid job thread");
    const r = await request<{ job?: HermesJob }>("POST", "/api/jobs", body, omniConfig.requestTimeoutMs(), threadId ? { "X-Omni-Thread": threadId } : {});
    if (!r?.job) throw new HermesError("hermes_unavailable", 502, "Hermes created no job");
    return r.job;
  },
  async updateJob(id: string, body: Record<string, unknown>): Promise<HermesJob> {
    const r = await request<{ job?: HermesJob }>("PATCH", `/api/jobs/${jid(id)}`, body);
    if (!r?.job) throw new HermesError("hermes_unavailable", 502, "Hermes updated no job");
    return r.job;
  },
  async deleteJob(id: string): Promise<void> {
    const r = await request<{ ok?: boolean }>("DELETE", `/api/jobs/${jid(id)}`);
    if (r?.ok !== true) throw new HermesError("hermes_unavailable", 502, "Hermes did not confirm deletion");
  },
  async jobAction(id: string, action: "pause" | "resume" | "run"): Promise<HermesJob> {
    const r = await request<{ job?: HermesJob }>("POST", `/api/jobs/${jid(id)}/${action}`, {});
    if (!r?.job) throw new HermesError("not_found", 404, "no such job");
    if (action === "run" && (r.job.executed !== true || r.job.execution_mode !== "background")) {
      throw new HermesError("hermes_unavailable", 502, "Hermes did not confirm job dispatch", "job_dispatch_unconfirmed");
    }
    return r.job;
  },
};
