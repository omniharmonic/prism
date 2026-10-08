/**
 * The openai-compatible backend: any server that speaks the OpenAI `/v1` API —
 * LM Studio, Ollama (`/v1`), vLLM, llama.cpp server, OpenRouter, OpenAI, or a
 * frontier provider's compatibility endpoint.
 *
 * Plain + structured completions and embeddings. NO tools and NO agent loop (see
 * MODELS.md "Chat on other models" for the planned MCP tool loop).
 *
 * The API key is read from the env var the provider NAMES (`api_key_env`) at call
 * time and sent only as `Authorization: Bearer`. It never appears in an error: error
 * text is scrubbed of the key's value and of every URL.
 *
 * Request bodies are exactly what Prism sent before the provider layer
 * (`{model, messages, stream:false, max_tokens?, response_format?}` — no temperature),
 * so routing an existing job through here changes nothing on the wire.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ProviderErrorKind = "unreachable" | "timeout" | "http" | "bad_response" | "too_large" | "cancelled";

export class ProviderCallError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    /** HTTP status for kind "http". */
    public readonly status?: number,
    /** A scrubbed snippet of the error body (kind "http"), or the transport error text. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ProviderCallError";
  }
}

export interface OpenAICompatibleTarget {
  baseUrl: string;
  /** Env var NAME holding the key (null: no Authorization header). */
  apiKeyEnv?: string | null;
  /** A key held by the caller (the legacy EMBED_API_KEY path only). Prefer apiKeyEnv. */
  apiKey?: string;
}

export interface CompletionRequest {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Bounded response (never buffer an unbounded body from a model server). */
export const MAX_RESPONSE_BYTES = 2_000_000;
export const MAX_TEXT_CHARS = 200_000;

/** Replace the key's value (if any) and every URL; one line, bounded. */
export function scrubProviderText(s: string, secret?: string | null): string {
  let out = s;
  if (secret && secret.length >= 4) out = out.split(secret).join("<key>");
  return out
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 <key>")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

export interface OpenAICompatibleBackend {
  /** POST JSON to `<base><path>`; throws ProviderCallError on transport/timeout/cancel/HTTP. */
  postJson(path: string, body: unknown, opts: { timeoutMs?: number | null; signal?: AbortSignal; maxBytes?: number }): Promise<string>;
  /** One plain completion → the reply text (a leading <think> block removed). */
  complete(req: CompletionRequest): Promise<string>;
  /** One JSON-schema-constrained completion → the raw reply text (content, else reasoning_content). */
  structuredText(req: CompletionRequest & { schemaName: string; schema: unknown }): Promise<string>;
  /** Embeddings for `texts`, in order. */
  embed(model: string, texts: string[], opts?: { timeoutMs?: number | null; signal?: AbortSignal }): Promise<number[][]>;
}

export function openAICompatible(target: OpenAICompatibleTarget, fetchImpl: FetchLike = (u, i) => fetch(u, i)): OpenAICompatibleBackend {
  const base = target.baseUrl.replace(/\/+$/, "");
  const key = (): string => (target.apiKeyEnv ? (process.env[target.apiKeyEnv] ?? "") : (target.apiKey ?? ""));

  async function postJson(path: string, body: unknown, opts: { timeoutMs?: number | null; signal?: AbortSignal; maxBytes?: number }): Promise<string> {
    const secret = key();
    const timers: AbortSignal[] = [];
    if (opts.timeoutMs) timers.push(AbortSignal.timeout(opts.timeoutMs));
    if (opts.signal) timers.push(opts.signal);
    const signal = timers.length === 0 ? undefined : timers.length === 1 ? timers[0] : AbortSignal.any(timers);
    let resp: Response;
    try {
      resp = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      const err = e as Error;
      if (opts.signal?.aborted) throw new ProviderCallError("cancelled", "cancelled");
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new ProviderCallError("timeout", `timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`);
      }
      const detail = scrubProviderText(err.message ?? String(e), secret);
      throw new ProviderCallError("unreachable", `unreachable: ${detail}`, undefined, err.message ?? String(e));
    }
    const max = opts.maxBytes ?? Infinity;
    if (!resp.ok) {
      const text = await resp.text().catch(() => "<no body>");
      throw new ProviderCallError("http", `HTTP ${resp.status}`, resp.status, scrubProviderText(text, secret));
    }
    const declared = Number(resp.headers.get("content-length") ?? 0);
    if (declared > max) throw new ProviderCallError("too_large", "response too large");
    const raw = await resp.text();
    if (raw.length > max) throw new ProviderCallError("too_large", "response too large");
    return raw;
  }

  const messages = (r: CompletionRequest) => [
    { role: "system", content: r.system },
    { role: "user", content: r.user },
  ];
  const message = (raw: string): { content?: string | null; reasoning_content?: string | null } | null => {
    try {
      const j = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }> };
      return j?.choices?.[0]?.message ?? null;
    } catch {
      return null;
    }
  };

  return {
    postJson,
    async complete(req) {
      const raw = await postJson(
        "/chat/completions",
        { model: req.model, messages: messages(req), stream: false, ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}) },
        { timeoutMs: req.timeoutMs, signal: req.signal, maxBytes: MAX_RESPONSE_BYTES },
      );
      const full = message(raw)?.content;
      if (typeof full !== "string") throw new ProviderCallError("bad_response", "response had no text");
      const text = full.length > MAX_TEXT_CHARS ? full.slice(0, MAX_TEXT_CHARS) : full;
      // Reasoning models may prefix a <think>…</think> block; callers want the answer only.
      return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "").trim();
    },
    async structuredText(req) {
      const raw = await postJson(
        "/chat/completions",
        {
          model: req.model,
          messages: messages(req),
          stream: false,
          response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
        },
        { timeoutMs: req.timeoutMs, signal: req.signal },
      );
      const msg = message(raw);
      if (!msg) throw new ProviderCallError("bad_response", "response missing choices[0].message");
      // Reasoning models route grammar-constrained output to reasoning_content.
      const c = (msg.content ?? "").trim();
      return c !== "" ? c : (msg.reasoning_content ?? "").trim();
    },
    async embed(model, texts, opts = {}) {
      if (texts.length === 0) return [];
      const raw = await postJson("/embeddings", { model, input: texts }, { timeoutMs: opts.timeoutMs ?? null, signal: opts.signal });
      let j: { data?: Array<{ index: number; embedding: number[] }> };
      try {
        j = JSON.parse(raw);
      } catch {
        throw new ProviderCallError("bad_response", "embeddings response was not JSON");
      }
      const out: number[][] = new Array(texts.length);
      for (const row of j.data ?? []) out[row.index] = row.embedding;
      return out;
    },
  };
}
