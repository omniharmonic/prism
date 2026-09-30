/**
 * Fetch-based Server-Sent Events client. `EventSource` cannot send an
 * `Authorization` header (native shells authenticate with a bearer device token),
 * so this streams `text/event-stream` over `fetch` + `ReadableStream`, with
 * reconnect and `Last-Event-ID` resume. Transport-agnostic: pass `fetch` to
 * inject auth/origin (apps/web wraps it as `streamServerSSE`).
 */
export interface SSEMessage {
  /** `event:` field; "message" when absent. */
  event: string;
  /** Joined `data:` lines. */
  data: string;
  /** `id:` field, if the server sent one. */
  id?: string;
}

export interface StreamSSEOptions {
  headers?: Record<string, string>;
  /** Resume point for the first request (sent as `Last-Event-ID`). */
  lastEventId?: string;
  /** Return `"stop"` to end the stream without reconnecting. */
  onEvent: (msg: SSEMessage) => void | "stop" | Promise<void | "stop">;
  signal?: AbortSignal;
  /** Fires each time a connection is established (UI: clear "reconnecting…"). */
  onOpen?: () => void;
  /** Errors (network drop, 5xx) before a reconnect, and the fatal one. */
  onError?: (err: Error, info: { willRetry: boolean }) => void;
  /** Transport to use (defaults to global fetch). Receives the merged init. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Reconnect on drop / retryable error. Default true. */
  reconnect?: boolean;
  /** Base / max backoff in ms (default 1000 / 15000). A server `retry:` overrides the base. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Give up after this many consecutive failed attempts (default: unlimited). */
  maxAttempts?: number;
  method?: string;
  body?: BodyInit;
}

/** HTTP statuses worth retrying; every other 4xx is final (auth, not found, …). */
const RETRYABLE = new Set([408, 425, 429]);

/** Incremental SSE parser: feed decoded text, get complete messages. Exported for tests. */
export class SSEParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;
  /** Last `retry:` value (ms) seen. */
  retry: number | undefined;

  push(chunk: string): SSEMessage[] {
    this.buf += chunk;
    const out: SSEMessage[] = [];
    let idx: number;
    // Lines end with \r\n, \n or \r.
    while ((idx = this.buf.search(/\r\n|\n|\r/)) !== -1) {
      const crlf = this.buf.startsWith("\r\n", idx);
      // A trailing lone "\r" might be half of "\r\n" — wait for more input.
      if (this.buf[idx] === "\r" && !crlf && idx === this.buf.length - 1) break;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + (crlf ? 2 : 1));
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  private line(line: string): SSEMessage | null {
    if (line === "") {
      if (this.data.length === 0 && !this.event) {
        this.id = undefined;
        return null;
      }
      const msg: SSEMessage = { event: this.event || "message", data: this.data.join("\n"), id: this.id };
      this.event = "";
      this.data = [];
      this.id = undefined;
      return msg;
    }
    if (line.startsWith(":")) return null; // comment / keep-alive
    const c = line.indexOf(":");
    const field = c === -1 ? line : line.slice(0, c);
    let value = c === -1 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event": this.event = value; break;
      case "data": this.data.push(value); break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
    }
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Open an SSE stream and deliver events until `signal` aborts, `onEvent` returns
 * "stop", a fatal HTTP error occurs, or (with reconnect off) the stream ends.
 * Resolves when done; never rejects on abort.
 */
export async function streamSSE(url: string, opts: StreamSSEOptions): Promise<void> {
  const doFetch = opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const reconnect = opts.reconnect !== false;
  const maxBackoff = opts.maxRetryMs ?? 15000;
  let baseDelay = opts.retryMs ?? 1000;
  let lastEventId = opts.lastEventId;
  let failures = 0;

  while (!opts.signal?.aborted) {
    const parser = new SSEParser();
    let stop = false;
    let failure: Error | null = null;
    let fatal = false;
    try {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        ...opts.headers,
      };
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;
      const resp = await doFetch(url, { method: opts.method ?? "GET", headers, body: opts.body, signal: opts.signal });
      if (!resp.ok) {
        fatal = resp.status >= 400 && resp.status < 500 && !RETRYABLE.has(resp.status);
        throw new Error(`SSE ${resp.status}`);
      }
      if (!resp.body) throw new Error("SSE response has no body");
      opts.onOpen?.();
      failures = 0;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
            if (msg.id !== undefined) lastEventId = msg.id;
            if ((await opts.onEvent(msg)) === "stop") {
              stop = true;
              break;
            }
          }
          if (parser.retry !== undefined) baseDelay = parser.retry;
          if (stop) break;
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) return;
      failure = e instanceof Error ? e : new Error(String(e));
    }
    if (stop || opts.signal?.aborted) return;
    if (failure) failures++;
    const willRetry = reconnect && !fatal && (opts.maxAttempts === undefined || failures < opts.maxAttempts);
    if (failure) opts.onError?.(failure, { willRetry });
    if (!willRetry) return;
    // Exponential backoff with jitter after failures; a clean server close reconnects at the base delay.
    const delay = failure ? Math.min(maxBackoff, baseDelay * 2 ** Math.max(0, failures - 1)) : baseDelay;
    await sleep(delay * (0.75 + Math.random() * 0.5), opts.signal);
  }
}
