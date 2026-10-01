/**
 * Interactive AI model routing on the server (parity A) — the port of the
 * desktop's `ModelRouter` per-skill routing (`set_skill_model` /
 * `get_skill_models`), `local_ai_list_models` and `test_local_ai`, so a thin
 * client (PWA / Prism Client) can route its inline AI to the local model the
 * SERVER talks to (LM Studio at SKILLS_LOCAL_BASE_URL — the same server the
 * background skills use). The laptop's own Ollama/LM Studio are not reachable
 * from the server and are out of scope.
 *
 *   skills:   edit | chat | transform | generate (the desktop's KNOWN_SKILLS)
 *   routing:  { provider: "claude", model: sonnet|opus|haiku }
 *           | { provider: "local",  model: <an LM Studio model id> }
 *   default:  claude / sonnet for every skill (the desktop's default).
 *   storage:  SQLite `settings` key `agent-routing` (server-wide; the server owner
 *             is the only one who can run these paths anyway).
 *
 * WHO HONOURS IT: the one-shot read-only dispatch the client's inline edit /
 * transform / generate use (`POST /api/agent/dispatch {profile:"vault-ro",
 * skill}`). Routed local → the prompt runs once against LM Studio's
 * OpenAI-compatible `/chat/completions` (no tools: the prompt already carries the
 * note), behind the SAME admission guard as local skills (reachable, memory,
 * no JIT-load under pressure, one local run at a time — shared with the skill
 * scheduler). A refusal FAILS the dispatch; it never silently falls back to
 * Claude (a local choice may be a privacy choice). Routed claude → the
 * unchanged claude runner with the chosen `--model`.
 * Durable agent chat SESSIONS stay on claude regardless of `chat` routing: they
 * are multi-turn tool-using conversations (`--resume`, the vault MCP) that a
 * single completion call cannot reproduce. `chat` routing applies only where a
 * one-shot chat-style dispatch asks for it.
 */
import { config } from "./config";
import { getAgentRoutingSetting, setAgentRoutingSetting } from "./db";
import { CLAUDE_MODELS, defaultMemoryProbe, isClaudeModel, type MemoryProbe } from "./agent-exec";
import { admitLocal, lmStudioClient, releaseLocalModel, settingsFromConfig, tryAcquireLocalModel, type LocalModel, type SkillsSettings } from "./worker/skills";
import { existsSync } from "node:fs";
import { resolveClaude } from "./agent-exec";

export const INTERACTIVE_SKILLS = ["edit", "chat", "transform", "generate"] as const;
export type InteractiveSkill = (typeof INTERACTIVE_SKILLS)[number];
export const isInteractiveSkill = (s: unknown): s is InteractiveSkill => typeof s === "string" && (INTERACTIVE_SKILLS as readonly string[]).includes(s);

export interface SkillRoute {
  provider: "claude" | "local";
  model: string;
}
export type AgentRouting = Record<InteractiveSkill, SkillRoute>;

const DEFAULT_ROUTE: SkillRoute = { provider: "claude", model: "sonnet" };
const LOCAL_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export function defaultRouting(): AgentRouting {
  return Object.fromEntries(INTERACTIVE_SKILLS.map((s) => [s, { ...DEFAULT_ROUTE }])) as AgentRouting;
}

/** Validate one route; throws an Error with a user-facing message. */
export function validateRoute(skill: string, v: unknown): SkillRoute {
  if (!v || typeof v !== "object") throw new Error(`${skill}: a {provider, model} object is required`);
  const { provider, model } = v as Record<string, unknown>;
  if (provider === "claude") {
    const m = model === undefined || model === "" ? "sonnet" : model;
    if (!isClaudeModel(m)) throw new Error(`${skill}: claude model must be one of ${CLAUDE_MODELS.join(", ")}`);
    return { provider, model: m };
  }
  if (provider === "local") {
    if (typeof model !== "string" || !LOCAL_MODEL_RE.test(model)) throw new Error(`${skill}: pick a local model (an LM Studio model id)`);
    return { provider, model };
  }
  throw new Error(`${skill}: provider must be "claude" or "local"`);
}

/** Merge a (partial) routing patch onto the current one, validating every entry. */
export function mergeRouting(current: AgentRouting, patch: unknown): AgentRouting {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("a routing object is required");
  const next = { ...current };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!isInteractiveSkill(k)) throw new Error(`unknown skill '${k}' (expected ${INTERACTIVE_SKILLS.join(", ")})`);
    next[k] = validateRoute(k, v);
  }
  return next;
}

/** The stored routing (unknown/invalid entries fall back to the default). */
export function readRouting(): AgentRouting {
  const out = defaultRouting();
  try {
    const raw = JSON.parse(getAgentRoutingSetting() ?? "{}") as Record<string, unknown>;
    for (const s of INTERACTIVE_SKILLS) {
      try {
        if (raw[s] !== undefined) out[s] = validateRoute(s, raw[s]);
      } catch {
        /* keep the default */
      }
    }
  } catch {
    /* default */
  }
  return out;
}

export function writeRouting(r: AgentRouting): void {
  setAgentRoutingSetting(JSON.stringify(r));
}

export const routeFor = (skill: InteractiveSkill): SkillRoute => readRouting()[skill];

// ── LM Studio: model list + chat ─────────────────────────────────────────────

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LocalModelInfo {
  id: string;
  /** "llm" | "vlm" | "embeddings" | null (unknown on a plain OpenAI-compatible server). */
  type: string | null;
  /** "loaded" | "not-loaded" | null (unknown). */
  state: string | null;
  quantization: string | null;
}

export interface LocalModelList {
  baseUrl: string;
  configured: boolean;
  reachable: boolean;
  models: LocalModelInfo[];
  error: string | null;
}

let fetchImpl: FetchLike = (u, i) => fetch(u, i);
/** Tests: inject a fake LM Studio (never the real :1234). `null` restores fetch. */
export function setLocalAiFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((u, i) => fetch(u, i));
}
let probe: MemoryProbe = defaultMemoryProbe;
/** Tests: inject a memory probe. `null` restores the real one. */
export function setLocalAiMemoryProbeForTests(p: MemoryProbe | null): void {
  probe = p ?? defaultMemoryProbe;
}
let settingsOverride: Partial<SkillsSettings> | null = null;
/** Tests: override the local settings (base URL, thresholds). */
export function setLocalAiSettingsForTests(s: Partial<SkillsSettings> | null): void {
  settingsOverride = s;
}
const localSettings = (): SkillsSettings => ({ ...settingsFromConfig(), ...(settingsOverride ?? {}) });

const scrub = (s: string) => s.replace(/https?:\/\/\S+/g, "<url>").replace(/[\r\n]+/g, " ").slice(0, 200);

/** `local_ai_list_models` / `ollama_list_models`: LM Studio's native
 *  `/api/v0/models` (type + loaded state), else the OpenAI-compatible `/v1/models`. */
export async function listLocalModels(): Promise<LocalModelList> {
  const base = localSettings().localBaseUrl.replace(/\/+$/, "");
  const out: LocalModelList = { baseUrl: base, configured: base !== "", reachable: false, models: [], error: null };
  if (!base) return out;
  const root = base.replace(/\/v1$/, "");
  const get = (u: string) => fetchImpl(u, { signal: AbortSignal.timeout(5000) });
  try {
    const r = await get(`${root}/api/v0/models`);
    if (r.ok) {
      const j = (await r.json()) as { data?: Array<Record<string, unknown>> };
      out.reachable = true;
      out.models = (j.data ?? [])
        .filter((m) => typeof m.id === "string")
        .map((m) => ({
          id: m.id as string,
          type: typeof m.type === "string" ? m.type : null,
          state: typeof m.state === "string" ? m.state : null,
          quantization: typeof m.quantization === "string" ? m.quantization : null,
        }));
      return out;
    }
    const r2 = await get(`${base}/models`);
    if (!r2.ok) {
      out.error = `HTTP ${r2.status}`;
      return out;
    }
    const j2 = (await r2.json()) as { data?: Array<Record<string, unknown>> };
    out.reachable = true;
    out.models = (j2.data ?? []).filter((m) => typeof m.id === "string").map((m) => ({ id: m.id as string, type: null, state: null, quantization: null }));
    return out;
  } catch (e) {
    out.error = scrub((e as Error).message);
    return out;
  }
}

/** Is the claude CLI present on this host (the agent runner's binary)? */
export function claudeAvailable(): boolean {
  try {
    const p = resolveClaude();
    return p.startsWith("/") ? existsSync(p) : false;
  } catch {
    return false;
  }
}

export class LocalRefusedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LocalRefusedError";
  }
}

/** One plain completion against LM Studio's `/chat/completions` (no tools, no stream). */
export async function localChat(model: string, system: string, user: string, opts: { timeoutMs?: number; signal?: AbortSignal; maxTokens?: number } = {}): Promise<string> {
  const base = localSettings().localBaseUrl.replace(/\/+$/, "");
  if (!base) throw new LocalRefusedError("no local model server is configured (SKILLS_LOCAL_BASE_URL)");
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const signal = opts.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal]) : AbortSignal.timeout(timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") throw new Error(`local model timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`local model unreachable: ${scrub(err.message)}`);
  }
  if (!resp.ok) throw new Error(`local model returned HTTP ${resp.status}`);
  const j = (await resp.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string | null } }> } | null;
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("local model response had no text");
  // Reasoning models may prefix a <think>…</think> block; the inline edit wants the answer only.
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "").trim();
}

/** The interactive system prompt (the desktop's local path had none; the server
 *  prompt templates already carry every instruction). */
const SYSTEM = "You are a writing assistant inside Prism, a notes app. Follow the user's instructions exactly and return only the requested text.";

/**
 * Run one interactive prompt on the local model, behind the skills' admission
 * guard + the shared one-local-run slot. Throws LocalRefusedError when refused.
 */
export async function runLocalInteractive(model: string, prompt: string, signal?: AbortSignal, opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
  const s = localSettings();
  const local: LocalModel = lmStudioClient(s.localBaseUrl, fetchImpl);
  const verdict = await admitLocal({ local, memoryProbe: probe, settings: s }, model);
  if (!verdict.ok) throw new LocalRefusedError(`local model refused: ${verdict.reason}`);
  if (!tryAcquireLocalModel()) throw new LocalRefusedError("local model refused: another local-model run is in progress");
  try {
    return await localChat(model, SYSTEM, prompt, { signal, ...opts });
  } finally {
    releaseLocalModel();
  }
}

/** Settings → "AI models" → Test: a tiny round trip on the chosen route. */
export async function testRoute(route: SkillRoute): Promise<{ ok: boolean; provider: string; model: string; ms: number; reply?: string; error?: string }> {
  const t0 = Date.now();
  if (route.provider === "claude") {
    // Never spends a claude turn: report whether the runner's CLI is present.
    const ok = claudeAvailable();
    return { ok, provider: "claude", model: route.model, ms: Date.now() - t0, ...(ok ? {} : { error: "the claude CLI was not found on the server" }) };
  }
  try {
    const reply = await runLocalInteractive(route.model, "Reply with exactly the word: ready", undefined, { maxTokens: 16, timeoutMs: 120_000 });
    return { ok: true, provider: "local", model: route.model, ms: Date.now() - t0, reply: reply.slice(0, 80) };
  } catch (e) {
    return { ok: false, provider: "local", model: route.model, ms: Date.now() - t0, error: scrub((e as Error).message) };
  }
}

/** For GET /api/agent/models: whatever the UI needs to render the panel. */
export async function modelsOverview(): Promise<{ local: LocalModelList; claude: { available: boolean; models: readonly string[] }; skillsDefaultProvider: string; skillsLocalModel: string }> {
  return {
    local: await listLocalModels(),
    claude: { available: claudeAvailable(), models: CLAUDE_MODELS },
    skillsDefaultProvider: config.skillsDefaultProvider,
    skillsLocalModel: config.skillsLocalModel,
  };
}
