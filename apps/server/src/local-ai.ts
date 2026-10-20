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
import { openAICompatible, ProviderCallError, type OpenAICompatibleTarget } from "./providers/openai-compatible";
import { claudeProviderId, getModelsConfig, localProviderId, resolveChain, type ResolvedStep } from "./providers/config";
import type { ModelsConfig, ProviderSpec, RouteStep } from "./providers/types";
import { ChainCancelledError, runChain } from "./providers/router";
import { claudeText } from "./providers/claude-cli";
import type { ExternalResult } from "./agent-exec";
import type { ClaudeModel } from "./agent-exec";
import type { VaultEntry } from "./config";

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

/**
 * The server the Settings → AI models "local" choice means: with a models.json, its
 * local provider (one named `local`, else the first local openai-compatible one);
 * otherwise SKILLS_LOCAL_BASE_URL (undefined).
 */
export function uiLocalTarget(): OpenAICompatibleTarget | undefined {
  const cfg = getModelsConfig();
  if (cfg.source !== "file") return undefined;
  const id = localProviderId(cfg);
  const spec = id ? cfg.providers[id] : undefined;
  return spec?.baseUrl ? { baseUrl: spec.baseUrl, apiKeyEnv: spec.apiKeyEnv } : undefined;
}

/** `local_ai_list_models` / `ollama_list_models`: LM Studio's native
 *  `/api/v0/models` (type + loaded state), else the OpenAI-compatible `/v1/models`. */
export async function listLocalModels(): Promise<LocalModelList> {
  const base = (uiLocalTarget()?.baseUrl ?? localSettings().localBaseUrl).replace(/\/+$/, "");
  const out: LocalModelList = { baseUrl: base, configured: base !== "", reachable: false, models: [], error: null };
  if (!base) return out;
  const root = base.replace(/\/v1$/, "");
  const keyEnv = uiLocalTarget()?.apiKeyEnv;
  const key = keyEnv ? (process.env[keyEnv] ?? "") : "";
  const get = (u: string) => fetchImpl(u, { signal: AbortSignal.timeout(5000), ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) });
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

/** L5 caps (the raw HTTP body 2 MB, the returned text 200k chars) live in the
 *  openai-compatible backend (MAX_RESPONSE_BYTES / MAX_TEXT_CHARS). */

export class LocalRefusedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LocalRefusedError";
  }
}

/** One plain completion against LM Studio's `/chat/completions` (no tools, no stream).
 *  Goes through the provider layer's openai-compatible backend (same request body as
 *  before); `target` points it at a models.json provider instead of SKILLS_LOCAL_BASE_URL. */
export async function localChat(
  model: string,
  system: string,
  user: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; maxTokens?: number; target?: OpenAICompatibleTarget } = {},
): Promise<string> {
  const base = (opts.target?.baseUrl ?? localSettings().localBaseUrl).replace(/\/+$/, "");
  if (!base) throw new LocalRefusedError("no local model server is configured (SKILLS_LOCAL_BASE_URL)");
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  try {
    return await openAICompatible({ baseUrl: base, apiKeyEnv: opts.target?.apiKeyEnv ?? null }, fetchImpl).complete({ model, system, user, timeoutMs, signal: opts.signal, maxTokens: opts.maxTokens });
  } catch (e) {
    if (!(e instanceof ProviderCallError)) throw e;
    // The messages callers and tests have always seen.
    switch (e.kind) {
      case "cancelled":
        throw new Error("cancelled");
      case "timeout":
        throw new Error(`local model timed out after ${Math.round(timeoutMs / 1000)}s`);
      case "unreachable":
        throw new Error(`local model unreachable: ${scrub(e.detail ?? e.message)}`);
      case "http":
        throw new Error(`local model returned HTTP ${e.status}`);
      case "too_large":
        throw new Error("local model response too large");
      default:
        throw new Error("local model response had no text");
    }
  }
}

/** The interactive system prompt (the desktop's local path had none; the server
 *  prompt templates already carry every instruction). */
const SYSTEM = "You are a writing assistant inside Prism, a notes app. Follow the user's instructions exactly and return only the requested text.";

/**
 * Run one interactive prompt on the local model, behind the skills' admission
 * guard + the shared one-local-run slot. Throws LocalRefusedError when refused.
 */
export async function runLocalInteractive(model: string, prompt: string, signal?: AbortSignal, opts: { maxTokens?: number; timeoutMs?: number; target?: OpenAICompatibleTarget } = {}): Promise<string> {
  const s = localSettings();
  const local: LocalModel = lmStudioClient(opts.target?.baseUrl ?? s.localBaseUrl, fetchImpl, opts.target?.apiKeyEnv ?? null);
  const verdict = await admitLocal({ local, memoryProbe: probe, settings: s }, model);
  if (!verdict.ok) throw new LocalRefusedError(`local model refused: ${verdict.reason}`);
  // Acquire AFTER the async admission (M1); release only our own slot.
  const slot = tryAcquireLocalModel();
  if (!slot) throw new LocalRefusedError("local model refused: another local-model run is in progress");
  try {
    return await localChat(model, SYSTEM, prompt, { signal, ...opts });
  } finally {
    releaseLocalModel(slot);
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
    const reply = await runLocalInteractive(route.model, "Reply with exactly the word: ready", undefined, { maxTokens: 16, timeoutMs: 120_000, target: uiLocalTarget() });
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

// ── the provider layer: the `drafting` job (models.json) ─────────────────────

/** Settings → AI models entries the owner has actually SAVED (no defaults filled in). */
export function storedRouting(): Partial<AgentRouting> {
  const out: Partial<AgentRouting> = {};
  try {
    const raw = JSON.parse(getAgentRoutingSetting() ?? "{}") as Record<string, unknown>;
    for (const s of INTERACTIVE_SKILLS) {
      try {
        if (raw[s] !== undefined) out[s] = validateRoute(s, raw[s]);
      } catch {
        /* invalid entry: as if unset */
      }
    }
  } catch {
    /* nothing stored */
  }
  return out;
}

export interface DraftStep extends ResolvedStep {
  /** The pre-provider-layer local route (SKILLS_LOCAL_BASE_URL + the shared guard). */
  legacyLocal?: boolean;
}
export interface DraftingPlan {
  source: "env" | "file";
  steps: DraftStep[];
  /** Steps left out (fallback policy, capability, no such provider) — logged by the runner. */
  skipped: string[];
  /** Set when the whole plan is ONE claude-cli step: the unchanged `startDispatch` path. */
  claudeModel: ClaudeModel | null;
}

const legacyLocalSpec = (): ProviderSpec => ({
  id: "local",
  kind: "openai-compatible",
  model: null,
  baseUrl: localSettings().localBaseUrl || null,
  apiKeyEnv: null,
  local: true,
  memoryGuard: true,
  timeoutMs: null,
  capabilities: ["completion", "structured"],
});
const legacyClaudeSpec = (): ProviderSpec => ({ id: "claude", kind: "claude-cli", model: "sonnet", baseUrl: null, apiKeyEnv: null, local: false, memoryGuard: false, timeoutMs: null, capabilities: ["agent", "completion", "structured"] });

function legacyPlan(skill: InteractiveSkill, source: "env" | "file"): DraftingPlan {
  const route = routeFor(skill);
  if (route.provider === "local") return { source, steps: [{ provider: "local", model: route.model, spec: legacyLocalSpec(), legacyLocal: true }], skipped: [], claudeModel: null };
  return { source, steps: [{ provider: "claude", model: route.model, spec: legacyClaudeSpec() }], skipped: [], claudeModel: isClaudeModel(route.model) ? route.model : "sonnet" };
}

/**
 * Which model(s) serve an interactive one-shot (edit / transform / generate / chat →
 * the `drafting` job), in order.
 *  - No models.json: Settings → AI models, exactly as before (one route, no fallback).
 *  - models.json: a route the owner SAVED in Settings → AI models goes first, then
 *    `jobs.drafting` under its fallback policy. A models.json with no `drafting` job
 *    and nothing saved keeps the old default (claude / sonnet).
 */
export function draftingPlan(skill: InteractiveSkill, cfg: ModelsConfig = getModelsConfig()): DraftingPlan {
  if (cfg.source !== "file") return legacyPlan(skill, "env");
  const saved = storedRouting()[skill];
  if (!saved && cfg.jobs.drafting === undefined) return legacyPlan(skill, "file");
  const skipped: string[] = [];
  let override: RouteStep | null = null;
  if (saved) {
    const id = saved.provider === "local" ? localProviderId(cfg) : claudeProviderId(cfg);
    if (id) override = { provider: id, model: saved.model };
    else skipped.push(`Settings → AI models chose ${saved.provider}:${saved.model}, but the models config has no ${saved.provider === "local" ? "local openai-compatible" : "claude-cli"} provider`);
  }
  const chain = resolveChain(cfg, "drafting", override);
  // A "local" choice in Settings may be a privacy choice: never let it fall back to a
  // provider off Benjamin's hardware, whatever the file's `fallback` says.
  const localOnly = saved?.provider === "local";
  const steps: DraftStep[] = localOnly ? chain.steps.filter((st) => st.spec.local) : chain.steps;
  if (localOnly) for (const st of chain.steps) if (!st.spec.local) skipped.push(`${st.provider}:${st.model} (Settings chose a local model; never falls back off this hardware)`);
  const only = steps.length === 1 && steps[0]!.spec.kind === "claude-cli" && isClaudeModel(steps[0]!.model) ? (steps[0]!.model as ClaudeModel) : null;
  return { source: "file", steps, skipped: [...skipped, ...chain.skipped], claudeModel: only };
}

export interface DraftingContext {
  entry: VaultEntry;
  prompt: string;
  signal: AbortSignal;
  skill: string | null;
  noteId: string | null;
  /** The dispatch's narrowing (claude steps keep it: text-only, or the read-only vault tools). */
  textOnly: boolean;
  allowedTools?: readonly string[];
}

/** One step of a drafting chain. */
function runDraftStep(step: DraftStep, ctx: DraftingContext): Promise<string> {
  if (step.spec.kind === "claude-cli") {
    return claudeText({ entry: ctx.entry, prompt: ctx.prompt, model: step.model, textOnly: ctx.textOnly, allowedTools: ctx.allowedTools, skill: ctx.skill, noteId: ctx.noteId, signal: ctx.signal });
  }
  const timeoutMs = step.spec.timeoutMs ?? undefined;
  if (step.legacyLocal) return runLocalInteractive(step.model, ctx.prompt, ctx.signal);
  const target = { baseUrl: step.spec.baseUrl ?? "", apiKeyEnv: step.spec.apiKeyEnv };
  // A model server on THIS host: the shared memory guard + one-local-run slot.
  if (step.spec.memoryGuard) return runLocalInteractive(step.model, ctx.prompt, ctx.signal, { target, timeoutMs });
  return localChat(step.model, SYSTEM, ctx.prompt, { signal: ctx.signal, target, timeoutMs });
}

/**
 * Run a drafting plan inside an external dispatch. The pre-provider-layer local route
 * runs exactly as before (its own error text); a models.json plan walks the chain with
 * logged fallbacks and reports who served it (dispatch `provider` / `model` / `fallbacks`).
 */
export async function runDraftingPlan(plan: DraftingPlan, ctx: DraftingContext): Promise<string | ExternalResult> {
  if (plan.source === "env" && plan.steps.length === 1 && plan.steps[0]!.legacyLocal) return runDraftStep(plan.steps[0]!, ctx);
  if (plan.skipped.length) console.log(`[providers] drafting (${ctx.skill ?? "?"}): left out ${plan.skipped.join("; ")}`);
  try {
    const { value, servedBy } = await runChain("drafting", plan.steps, (step) => runDraftStep(step, ctx), { signal: ctx.signal });
    return { text: value, provider: servedBy.provider, model: servedBy.model, fallbacks: servedBy.fallbacks };
  } catch (e) {
    if (e instanceof ChainCancelledError) throw new Error("cancelled");
    throw e;
  }
}
