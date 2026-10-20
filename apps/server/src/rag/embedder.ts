/**
 * Pluggable text embedder for semantic search.
 *
 * Two implementations behind one interface:
 *  - `OpenAICompatEmbedder` — POSTs to a `/v1/embeddings` endpoint (Ollama's
 *    OpenAI-compat layer, LM Studio, llama.cpp server, or a hosted API). This is
 *    the real, semantic path; the model is configured once and shared with the
 *    Rust indexer so vectors are comparable across processes.
 *  - `HashEmbedder` — a deterministic, dependency-free, offline fallback (a
 *    hashing-trick bag-of-words, L2-normalized). Not semantic, but real lexical
 *    signal — enough to run and TEST the whole retrieval pipeline with no model
 *    or network. Used automatically when no EMBED_ENDPOINT is set.
 *
 * All embedders return L2-normalized vectors, so cosine similarity == dot product.
 */
import { config } from "../config";
import { openAICompatible, ProviderCallError, type OpenAICompatibleBackend } from "../providers/openai-compatible";
import { getModelsConfig } from "../providers/config";

export interface Embedder {
  /** Stable id (`provider:model`) — stored alongside vectors so a model change
   *  is detectable and triggers a re-index rather than mixing vector spaces. */
  readonly id: string;
  readonly dim: number;
  /** Embed a batch; result[i] corresponds to texts[i]. Vectors are normalized. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** L2-normalize in place and return the same array (zero-vectors pass through). */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

/** Dot product of two equal-length normalized vectors == cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** FNV-1a 32-bit hash — small, fast, deterministic. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const TOKEN_RE = /[a-z0-9]+/g;

/**
 * Deterministic offline embedder: lowercase word tokens are hashed into a
 * fixed-dim vector (signed hashing trick), then L2-normalized. Captures lexical
 * overlap (shared words → higher cosine) without any model. Bigrams are mixed in
 * for a little word-order signal.
 */
export class HashEmbedder implements Embedder {
  readonly id: string;
  constructor(readonly dim = config.embedFallbackDim) {
    this.id = `hash:${this.dim}`;
  }
  private one(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const tokens = (text.toLowerCase().match(TOKEN_RE) ?? []).slice(0, 4000);
    let prev: string | null = null;
    for (const tok of tokens) {
      const h = fnv1a(tok);
      v[h % this.dim]! += (h & 1 ? 1 : -1) * 1.0;
      if (prev) {
        const hb = fnv1a(prev + " " + tok);
        v[hb % this.dim]! += (hb & 1 ? 1 : -1) * 0.5;
      }
      prev = tok;
    }
    return normalize(v);
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }
}

/** Calls an OpenAI-compatible `/v1/embeddings` endpoint (the provider layer's
 *  openai-compatible backend; the key is a literal for EMBED_API_KEY, or read from
 *  the env var a models.json provider names). */
export class OpenAICompatEmbedder implements Embedder {
  readonly id: string;
  // Real dimension is learned from the first response; seeded optimistically.
  dim = 0;
  private readonly backend: OpenAICompatibleBackend;
  constructor(
    endpoint: string,
    private readonly model: string,
    apiKey = "",
    apiKeyEnv: string | null = null,
  ) {
    this.id = `openai:${model}`;
    this.backend = openAICompatible({ baseUrl: endpoint, apiKey, apiKeyEnv });
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    let rows: number[][];
    try {
      rows = await this.backend.embed(this.model, texts);
    } catch (e) {
      if (e instanceof ProviderCallError && e.kind === "http") throw new Error(`embeddings ${e.status}: ${e.detail ?? ""}`);
      throw e;
    }
    const out: Float32Array[] = new Array(texts.length);
    rows.forEach((row, i) => {
      if (!row) return;
      const v = Float32Array.from(row);
      this.dim = v.length;
      out[i] = normalize(v);
    });
    return out;
  }
}

let _embedder: Embedder | null = null;

/**
 * The embedder for an `embeddings` job of a models.json (null: not a file config).
 * One model only (validation refuses a fallback: vectors can't be mixed); no entry =
 * the offline hash embedder, exactly like no EMBED_ENDPOINT.
 */
export function embedderFromModelsConfig(): Embedder | null {
  const cfg = getModelsConfig();
  if (cfg.source !== "file") return null;
  const step = cfg.jobs.embeddings?.steps[0];
  const spec = step ? cfg.providers[step.provider] : undefined;
  if (!step || !spec?.baseUrl) return new HashEmbedder();
  console.log(`[providers] embeddings → ${step.provider}:${step.model}`);
  return new OpenAICompatEmbedder(spec.baseUrl, step.model, "", spec.apiKeyEnv);
}

/** The process-wide embedder: the models.json `embeddings` job when that file is in
 *  use, else EMBED_ENDPOINT (real endpoint) or the offline fallback — as before. */
export function getEmbedder(): Embedder {
  if (_embedder) return _embedder;
  _embedder =
    embedderFromModelsConfig() ??
    (config.embedEndpoint ? new OpenAICompatEmbedder(config.embedEndpoint, config.embedModel, config.embedApiKey) : new HashEmbedder());
  return _embedder;
}

/** Test seam: override the embedder (e.g. inject a deterministic one). */
export function setEmbedder(e: Embedder): void {
  _embedder = e;
}
