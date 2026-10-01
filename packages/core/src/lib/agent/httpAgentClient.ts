/**
 * HTTP implementation of the AgentClient seam against the Prism Server's
 * `/api/agent` API. Transport-agnostic: the shell passes its request helper
 * (apps/web: `serverFetch` from transport.ts, which handles origin + cookie vs.
 * bearer), so the same client works in the PWA and in the native build.
 *
 * Streaming uses the fetch-based `streamSSE` (EventSource cannot send a bearer
 * header). Resume is by seq: `?after=N` on the first request, `Last-Event-ID`
 * (the last persisted seq; live `text_delta`s carry no id) on reconnects.
 */
import { streamSSE, type StreamSSEOptions } from "../transport/sse";
import {
  AgentApiError,
  isTerminalTurn,
  type AgentClient,
  type AgentStreamMessage,
  type AgentStreamHandlers,
} from "./sessions";

export type AgentFetch = (path: string, init?: RequestInit) => Promise<Response>;
/** SSE opener for a server path (apps/web: `streamServerSSE`). */
export type AgentSSE = (path: string, opts: Omit<StreamSSEOptions, "fetch">) => Promise<void>;

export interface HttpAgentClientOptions {
  /** Request helper: resolves a server path ("/api/agent/…") with the shell's auth. */
  fetch: AgentFetch;
  /** Extra headers per request (e.g. the active vault/workspace). */
  headers?: () => Record<string, string>;
  /** API base (default "/api/agent"). */
  base?: string;
  /** SSE opener (default: `streamSSE` over `fetch`). */
  sse?: AgentSSE;
  /** Cache scope for query keys (e.g. the active vault id). */
  scope?: () => string;
}

const enc = encodeURIComponent;

export function createHttpAgentClient(opts: HttpAgentClientOptions): AgentClient {
  const base = (opts.base ?? "/api/agent").replace(/\/+$/, "");
  const hdrs = () => opts.headers?.() ?? {};
  const sse: AgentSSE = opts.sse ?? ((path, o) => streamSSE(path, { ...o, fetch: (u, init) => opts.fetch(u, init) }));

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const scope = opts.scope?.();
    const headers: Record<string, string> = { ...hdrs() };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const resp = await opts.fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await resp.json().catch((error) => { if (resp.ok) throw error; return null; });
    if (scope !== opts.scope?.()) throw new Error("Workspace changed while waiting for the agent. Reopen the conversation in its original workspace.");
    if (!resp.ok) {
      const j = data as { error?: string; detail?: string; turnId?: string } | null;
      throw new AgentApiError(resp.status, j?.error ?? `http_${resp.status}`, j?.detail, j?.turnId);
    }
    return data as T;
  }

  return {
    updatePermissions: (id, mode, expectedVersion) => call("PATCH", `/sessions/${enc(id)}/permissions`, { mode, expectedVersion }),
    createSession: (p = {}) => call("POST", "/sessions", p),
    listSessions: ({ limit, archived } = {}) => {
      const q = new URLSearchParams();
      if (limit) q.set("limit", String(limit));
      if (archived) q.set("archived", "1");
      const s = q.toString();
      return call("GET", `/sessions${s ? `?${s}` : ""}`);
    },
    getSession: (id) => call("GET", `/sessions/${enc(id)}`),
    sendTurn: (id, prompt, o = {}) => call("POST", `/sessions/${enc(id)}/turns`, { prompt, ...(o.noteId ? { noteId: o.noteId } : {}) }),
    getLimits: () => call("GET", "/limits"),
    cancelTurn: async (turnId) => (await call<{ ok: boolean }>("POST", `/turns/${enc(turnId)}/cancel`)).ok,
    archiveSession: async (id) => {
      await call("DELETE", `/sessions/${enc(id)}`);
    },
    streamSession: (id, afterSeq, handlers) => streamSessionEvents(sse, `${base}/sessions/${enc(id)}/stream`, afterSeq, hdrs(), handlers),
    scope: opts.scope,
  };
}

/**
 * Open a session stream. Ends (and calls `onClose` exactly once) when:
 *  - a terminal `status` event arrives for the newest turn seen on the stream
 *    AND the server then closes (the server keeps the stream open only while a
 *    turn is queued/running), detected as a clean close with nothing new;
 *  - a fatal HTTP error (403/404) — reported through `onError` first;
 *  - the caller unsubscribes.
 * Drops mid-turn reconnect with backoff and resume from the last persisted seq.
 */
export function streamSessionEvents(
  sse: AgentSSE,
  url: string,
  afterSeq: number,
  headers: Record<string, string>,
  handlers: AgentStreamHandlers,
): () => void {
  const ctrl = new AbortController();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    ctrl.abort();
    handlers.onClose?.();
  };
  // A clean server close with no new persisted events on that connection means
  // there is nothing in flight — stop instead of re-polling forever.
  let eventsThisConn = 0;
  let opens = 0;
  let sawTerminal = false;
  let lastConnFailed = false;
  const after = Math.max(0, Math.floor(afterSeq) || 0);
  const sep = url.includes("?") ? "&" : "?";

  void sse(`${url}${sep}after=${after}`, {
    headers,
    signal: ctrl.signal,
    retryMs: 1000,
    maxRetryMs: 15000,
    onOpen: () => {
      opens++;
      if (opens > 1 && !lastConnFailed && (eventsThisConn === 0 || sawTerminal)) {
        // Reconnected after a CLEAN server close that delivered nothing new (or
        // after the turn already ended): nothing is in flight for us.
        close();
        return;
      }
      eventsThisConn = 0;
      lastConnFailed = false;
      handlers.onOpen?.();
    },
    onError: (err, info) => {
      if (closed) return;
      lastConnFailed = true; // a drop, not a clean close — the reconnect is real
      handlers.onError?.(err, info);
      if (!info.willRetry) close();
    },
    onEvent: (m) => {
      if (closed) return "stop";
      if (m.event === "message") return; // not part of the protocol
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(m.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const msg = { ...data, t: m.event } as AgentStreamMessage;
      if (typeof msg.seq === "number") {
        eventsThisConn++;
        // A new turn's event after a terminal one means the session continued.
        sawTerminal = msg.t === "status" && isTerminalTurn(msg.status);
      }
      handlers.onEvent(msg);
    },
  }).finally(close);

  return close;
}
