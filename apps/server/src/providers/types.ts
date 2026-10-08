/**
 * The provider layer's vocabulary (models.json, MODELS.md). Shared job names with
 * the agent repo and Hermes so the three systems read alike.
 *
 *   JOB          what the server does with it today
 *   chat         durable agent chat sessions (tool-using, multi-turn) — REQUIRES an agent loop
 *   drafting     one-shot inline AI + page Summarize/Draft/Transform (plain completion)
 *   triage       structured background skills (message-classify, clickup-task-triage)
 *   embeddings   the semantic-search index (one model only — vectors can't be mixed)
 *   summarization, extraction, proactive, voice-stt, voice-tts
 *                declared for the agent repo / Hermes; the server routes nothing to them yet
 *
 * A provider is a KIND + where to reach it. Kinds today:
 *   claude-cli          the hardened `claude -p` runner (agent-exec.ts) — the only kind
 *                       with an agent loop (stream-json, --resume, MCP tools)
 *   openai-compatible   any `/v1` chat-completions/embeddings server: LM Studio, Ollama,
 *                       vLLM, llama.cpp, OpenRouter, OpenAI, a frontier API's compat endpoint
 * A native-SDK backend (Anthropic/Gemini/… SDK) is a new kind: add it to `ProviderKind` +
 * `KIND_CAPABILITIES`, write a backend module beside `openai-compatible.ts`, and teach the
 * call sites' step runners about it. The router and the config format do not change.
 */

export const JOBS = ["chat", "drafting", "triage", "summarization", "extraction", "embeddings", "proactive", "voice-stt", "voice-tts"] as const;
export type Job = (typeof JOBS)[number];
export const isJob = (v: unknown): v is Job => typeof v === "string" && (JOBS as readonly string[]).includes(v);

/** What a call needs from a provider. */
export const CAPABILITIES = ["agent", "completion", "structured", "embeddings", "stt", "tts"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The capability each job needs. `agent` = a tool-using, multi-turn loop. */
export const JOB_REQUIRES: Record<Job, Capability> = {
  chat: "agent",
  drafting: "completion",
  triage: "structured",
  summarization: "completion",
  extraction: "structured",
  embeddings: "embeddings",
  proactive: "completion",
  "voice-stt": "stt",
  "voice-tts": "tts",
};

export type ProviderKind = "claude-cli" | "openai-compatible";

/** What each kind can do when its entry does not narrow it (`capabilities`). */
export const KIND_CAPABILITIES: Record<ProviderKind, readonly Capability[]> = {
  // structured: by prompting for JSON (the skills' rubric fallback prompt), not a grammar.
  "claude-cli": ["agent", "completion", "structured"],
  // stt/tts exist on some OpenAI-compatible servers but must be declared explicitly.
  "openai-compatible": ["completion", "structured", "embeddings"],
};

/** One provider as the server uses it (validated, defaults filled). */
export interface ProviderSpec {
  id: string;
  kind: ProviderKind;
  /** Default model for jobs that name the provider without a model. */
  model: string | null;
  /** openai-compatible: the `/v1` base URL (no credentials in it). */
  baseUrl: string | null;
  /** NAME of the environment variable holding the API key — never the key itself. */
  apiKeyEnv: string | null;
  /** Runs on hardware Benjamin controls (privacy: `fallback: "local-only"` keeps a job here). */
  local: boolean;
  /** Before a call, apply the host memory admission guard (the model server runs on THIS host). */
  memoryGuard: boolean;
  timeoutMs: number | null;
  capabilities: readonly Capability[];
}

/** One step of a job's chain: a provider and the model to ask it for. */
export interface RouteStep {
  provider: string;
  model: string;
}

/** `any`: try every listed step; `local-only`: skip steps whose provider is not local;
 *  `none`: only the first step (a failure is the answer). */
export type FallbackPolicy = "any" | "local-only" | "none";

export interface JobRoute {
  steps: RouteStep[];
  fallback: FallbackPolicy;
}

export interface ModelsConfig {
  /** "file" = models.json; "env" = derived from the pre-provider-layer env vars. */
  source: "file" | "env";
  path: string | null;
  providers: Record<string, ProviderSpec>;
  jobs: Partial<Record<Job, JobRoute>>;
  /** Non-fatal findings (e.g. chat routed to a provider with no agent loop). */
  warnings: string[];
}
