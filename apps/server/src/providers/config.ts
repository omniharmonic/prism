/**
 * models.json: ONE file that defines the model providers and which provider/model
 * serves each job, with ordered fallbacks. Plain-language guide: MODELS.md (repo root);
 * a commented example: apps/server/config/models.example.json.
 *
 * Where it is read from: `PRISM_MODELS_CONFIG` (a path), else
 * `apps/server/config/models.json` when that file exists.
 *
 * NO FILE = THE OLD BEHAVIOUR, byte for byte. `envModelsConfig()` maps the pre-existing
 * env vars into the same shape (source "env") so status and tests can see it, but
 * every call site keeps its legacy code path while the source is "env":
 *   SKILLS_DEFAULT_PROVIDER / SKILLS_LOCAL_BASE_URL / SKILLS_LOCAL_MODEL → triage
 *   the Settings → AI models routing (SQLite `agent-routing`)            → drafting
 *   EMBED_ENDPOINT / EMBED_MODEL / EMBED_API_KEY                         → embeddings
 *   claude / sonnet                                                       → chat
 *
 * A file that does not validate STOPS THE SERVER at boot (`assertModelsConfig`) — a
 * typo must never silently put a job on another model.
 *
 * Keys: a provider names the ENV VAR that holds its key (`api_key_env`), never the key.
 * Nothing in this module (status, logs, errors) ever contains a key's value.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import {
  CAPABILITIES,
  JOBS,
  JOB_REQUIRES,
  KIND_CAPABILITIES,
  isJob,
  type Capability,
  type FallbackPolicy,
  type Job,
  type JobRoute,
  type ModelsConfig,
  type ProviderKind,
  type ProviderSpec,
  type RouteStep,
} from "./types";

export class ModelsConfigError extends Error {
  constructor(public readonly problems: string[], path: string | null) {
    super(`models config${path ? ` (${path})` : ""} is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ModelsConfigError";
  }
}

/** claude-cli's model vocabulary (the runner's `--model` allowlist). */
export const CLAUDE_CLI_MODELS = ["sonnet", "opus", "haiku"] as const;

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,99}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const PROVIDER_KEYS = new Set(["kind", "model", "base_url", "api_key_env", "local", "memory_guard", "timeout_ms", "capabilities"]);
const JOB_KEYS = new Set(["use", "fallback"]);
const FALLBACKS: readonly FallbackPolicy[] = ["any", "local-only", "none"];
const isComment = (k: string) => k.startsWith("_") || k.startsWith("//");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Loopback host = the model server runs on THIS machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost") return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) return h === "::1";
  return false;
}

/** Validate a parsed models.json. Throws ModelsConfigError listing EVERY problem. */
export function validateModelsConfig(raw: unknown, path: string | null = null): ModelsConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) throw new ModelsConfigError(["the file must be a JSON object with \"providers\" and \"jobs\""], path);
  for (const k of Object.keys(raw)) {
    if (!isComment(k) && k !== "version" && k !== "providers" && k !== "jobs") problems.push(`unknown top-level key "${k}"`);
  }
  if (raw.version !== undefined && raw.version !== 1) problems.push(`"version" must be 1`);

  const providers: Record<string, ProviderSpec> = {};
  if (!isObj(raw.providers)) problems.push(`"providers" must be an object of {name: {kind, …}}`);
  else {
    for (const [id, v] of Object.entries(raw.providers)) {
      if (isComment(id)) continue;
      const where = `providers.${id}`;
      if (!PROVIDER_ID_RE.test(id)) {
        problems.push(`${where}: a provider name is lowercase letters, digits, - or _ (starting with a letter)`);
        continue;
      }
      if (!isObj(v)) {
        problems.push(`${where}: must be an object`);
        continue;
      }
      for (const k of Object.keys(v)) if (!isComment(k) && !PROVIDER_KEYS.has(k)) problems.push(`${where}: unknown key "${k}"`);
      const kind = v.kind;
      if (kind !== "claude-cli" && kind !== "openai-compatible") {
        problems.push(`${where}.kind: must be "claude-cli" or "openai-compatible"`);
        continue;
      }
      const spec = validateProvider(id, kind, v, problems);
      if (spec) providers[id] = spec;
    }
  }

  const jobs: Partial<Record<Job, JobRoute>> = {};
  if (raw.jobs !== undefined && !isObj(raw.jobs)) problems.push(`"jobs" must be an object of {job: [...]}`);
  else if (isObj(raw.jobs)) {
    for (const [name, v] of Object.entries(raw.jobs)) {
      if (isComment(name)) continue;
      if (!isJob(name)) {
        problems.push(`jobs.${name}: unknown job (expected one of ${JOBS.join(", ")})`);
        continue;
      }
      const route = validateJob(name, v, providers, problems, warnings);
      if (route) jobs[name] = route;
    }
  }
  if (problems.length) throw new ModelsConfigError(problems, path);
  return { source: "file", path, providers, jobs, warnings };
}

function validateProvider(id: string, kind: ProviderKind, v: Record<string, unknown>, problems: string[]): ProviderSpec | null {
  const where = `providers.${id}`;
  const n = problems.length;
  let model: string | null = null;
  if (v.model !== undefined) {
    if (typeof v.model !== "string" || !MODEL_RE.test(v.model)) problems.push(`${where}.model: not a model id`);
    else model = v.model;
  }
  if (kind === "claude-cli" && model !== null && !(CLAUDE_CLI_MODELS as readonly string[]).includes(model)) {
    problems.push(`${where}.model: claude-cli takes ${CLAUDE_CLI_MODELS.join(", ")}`);
  }
  let baseUrl: string | null = null;
  let loopback = false;
  if (kind === "openai-compatible") {
    if (typeof v.base_url !== "string") problems.push(`${where}.base_url: required (e.g. "http://127.0.0.1:1234/v1")`);
    else {
      try {
        const u = new URL(v.base_url);
        if (u.protocol !== "http:" && u.protocol !== "https:") problems.push(`${where}.base_url: must be http(s)`);
        else if (u.username || u.password) problems.push(`${where}.base_url: must not carry credentials — put the key in an env var and name it in api_key_env`);
        else if (u.search || u.hash) problems.push(`${where}.base_url: no query string or fragment`);
        else {
          baseUrl = v.base_url.replace(/\/+$/, "");
          loopback = isLoopbackHost(u.hostname);
        }
      } catch {
        problems.push(`${where}.base_url: not a URL`);
      }
    }
  } else if (v.base_url !== undefined) problems.push(`${where}.base_url: claude-cli has no base_url`);
  let apiKeyEnv: string | null = null;
  if (v.api_key_env !== undefined) {
    if (kind === "claude-cli") problems.push(`${where}.api_key_env: claude-cli signs in through the CLI's own login`);
    else if (typeof v.api_key_env !== "string" || !ENV_NAME_RE.test(v.api_key_env)) {
      // Never echo the value: it may BE a key pasted into the wrong field.
      problems.push(`${where}.api_key_env: the NAME of an environment variable (e.g. "OPENROUTER_API_KEY"), never the key itself`);
    } else apiKeyEnv = v.api_key_env;
  }
  const bool = (k: string, d: boolean): boolean => {
    if (v[k] === undefined) return d;
    if (typeof v[k] !== "boolean") problems.push(`${where}.${k}: true or false`);
    return v[k] === true;
  };
  // claude-cli calls a cloud model; an openai-compatible server on this host is local.
  const local = bool("local", kind === "openai-compatible" && loopback);
  const memoryGuard = bool("memory_guard", kind === "openai-compatible" && loopback);
  if (kind === "claude-cli" && memoryGuard) problems.push(`${where}.memory_guard: only for openai-compatible servers on this host`);
  let timeoutMs: number | null = null;
  if (v.timeout_ms !== undefined) {
    if (typeof v.timeout_ms !== "number" || !Number.isInteger(v.timeout_ms) || v.timeout_ms < 1000 || v.timeout_ms > 3_600_000) problems.push(`${where}.timeout_ms: whole milliseconds, 1000–3600000`);
    else timeoutMs = v.timeout_ms;
  }
  let capabilities: readonly Capability[] = KIND_CAPABILITIES[kind];
  if (v.capabilities !== undefined) {
    if (!Array.isArray(v.capabilities) || v.capabilities.some((c) => !(CAPABILITIES as readonly unknown[]).includes(c))) {
      problems.push(`${where}.capabilities: a list of ${CAPABILITIES.join(", ")}`);
    } else {
      const caps = v.capabilities as Capability[];
      if (caps.includes("agent") && kind !== "claude-cli") problems.push(`${where}.capabilities: "agent" (a tool-using chat loop) exists only for claude-cli today — see MODELS.md "Chat on other models"`);
      if (kind === "claude-cli" && caps.some((c) => !KIND_CAPABILITIES["claude-cli"].includes(c))) problems.push(`${where}.capabilities: claude-cli can only do ${KIND_CAPABILITIES["claude-cli"].join(", ")}`);
      capabilities = [...new Set(caps)];
    }
  }
  if (problems.length > n) return null;
  return { id, kind, model, baseUrl, apiKeyEnv, local, memoryGuard, timeoutMs, capabilities };
}

/** "provider" | "provider:model" | {provider, model}. The FIRST ":" splits, so
 *  `ollama:llama3.1:8b` = provider "ollama", model "llama3.1:8b". */
function parseStep(v: unknown): { provider: string; model: string | null } | null {
  if (typeof v === "string") {
    const i = v.indexOf(":");
    return i < 0 ? { provider: v, model: null } : { provider: v.slice(0, i), model: v.slice(i + 1) };
  }
  if (isObj(v) && typeof v.provider === "string" && (v.model === undefined || typeof v.model === "string")) {
    return { provider: v.provider, model: (v.model as string | undefined) ?? null };
  }
  return null;
}

function validateJob(job: Job, v: unknown, providers: Record<string, ProviderSpec>, problems: string[], warnings: string[]): JobRoute | null {
  const where = `jobs.${job}`;
  let list: unknown[];
  let fallback: FallbackPolicy = "any";
  if (Array.isArray(v)) list = v;
  else if (isObj(v)) {
    for (const k of Object.keys(v)) if (!isComment(k) && !JOB_KEYS.has(k)) problems.push(`${where}: unknown key "${k}"`);
    if (!Array.isArray(v.use)) {
      problems.push(`${where}.use: a list like ["local:qwen2.5-7b-instruct", "claude:sonnet"]`);
      return null;
    }
    list = v.use;
    if (v.fallback !== undefined) {
      if (!FALLBACKS.includes(v.fallback as FallbackPolicy)) problems.push(`${where}.fallback: one of ${FALLBACKS.join(", ")}`);
      else fallback = v.fallback as FallbackPolicy;
    }
  } else {
    problems.push(`${where}: a list of "provider:model" entries, or {use: [...], fallback}`);
    return null;
  }
  if (list.length === 0) return { steps: [], fallback };
  if (job === "embeddings" && list.length > 1) {
    problems.push(`${where}: exactly one model — vectors from different models cannot be mixed in one index, so embeddings never fall back`);
  }
  const steps: RouteStep[] = [];
  const need = JOB_REQUIRES[job];
  list.forEach((entry, i) => {
    const p = parseStep(entry);
    const at = `${where}[${i}]`;
    if (!p) return problems.push(`${at}: "provider" or "provider:model"`);
    const spec = providers[p.provider];
    if (!spec) return problems.push(`${at}: no provider named "${p.provider}" in "providers"`);
    const model = p.model ?? spec.model;
    if (!model) return problems.push(`${at}: no model — write "${p.provider}:<model>" or give providers.${p.provider} a "model"`);
    if (!MODEL_RE.test(model)) return problems.push(`${at}: "${model}" is not a model id`);
    if (spec.kind === "claude-cli" && !(CLAUDE_CLI_MODELS as readonly string[]).includes(model)) return problems.push(`${at}: claude-cli takes ${CLAUDE_CLI_MODELS.join(", ")}`);
    if (!spec.capabilities.includes(need)) {
      // chat: kept and refused at RUN time with a clear message (the brief's explicit
      // capability check); everything else can never work, so it is a config error.
      if (job === "chat") warnings.push(`${at}: "${p.provider}" has no agent loop (tool-using chat needs claude-cli today) — chat turns will be refused while it is first`);
      else return problems.push(`${at}: "${p.provider}" (${spec.kind}) cannot do ${need}, which ${job} needs`);
    }
    steps.push({ provider: p.provider, model });
  });
  return { steps, fallback };
}

// ── the pre-provider-layer env vars, as a config ─────────────────────────────

export interface EnvModelSettings {
  skillsDefaultProvider: string;
  skillsLocalBaseUrl: string;
  skillsLocalModel: string;
  embedEndpoint: string;
  embedModel: string;
}

/** The legacy env vars in the provider shape (source "env"). Descriptive only: while
 *  the source is "env" every call site runs its unchanged legacy path. */
export function envModelsConfig(s: EnvModelSettings): ModelsConfig {
  const providers: Record<string, ProviderSpec> = {
    claude: { id: "claude", kind: "claude-cli", model: "sonnet", baseUrl: null, apiKeyEnv: null, local: false, memoryGuard: false, timeoutMs: null, capabilities: KIND_CAPABILITIES["claude-cli"] },
  };
  if (s.skillsLocalBaseUrl) {
    providers.local = { id: "local", kind: "openai-compatible", model: s.skillsLocalModel || null, baseUrl: s.skillsLocalBaseUrl, apiKeyEnv: null, local: true, memoryGuard: true, timeoutMs: null, capabilities: ["completion", "structured"] };
  }
  if (s.embedEndpoint) {
    providers.embed = { id: "embed", kind: "openai-compatible", model: s.embedModel, baseUrl: s.embedEndpoint, apiKeyEnv: "EMBED_API_KEY", local: safeLoopback(s.embedEndpoint), memoryGuard: false, timeoutMs: null, capabilities: ["embeddings"] };
  }
  const localTriage = (s.skillsDefaultProvider === "local" || s.skillsDefaultProvider === "ollama") && !!s.skillsLocalBaseUrl && !!s.skillsLocalModel;
  const one = (step: RouteStep): JobRoute => ({ steps: [step], fallback: "none" });
  return {
    source: "env",
    path: null,
    providers,
    jobs: {
      chat: one({ provider: "claude", model: "sonnet" }),
      // Per skill, from Settings → AI models (SQLite `agent-routing`); claude/sonnet unless set there.
      drafting: one({ provider: "claude", model: "sonnet" }),
      triage: one(localTriage ? { provider: "local", model: s.skillsLocalModel } : { provider: "claude", model: "sonnet" }),
      // No EMBED_ENDPOINT → the offline lexical (hash) embedder, no provider at all.
      embeddings: s.embedEndpoint ? one({ provider: "embed", model: s.embedModel }) : { steps: [], fallback: "none" },
    },
    warnings: [],
  };
}
const safeLoopback = (u: string): boolean => {
  try {
    return isLoopbackHost(new URL(u).hostname);
  } catch {
    return false;
  }
};

// ── loading ──────────────────────────────────────────────────────────────────

/** apps/server/config/models.json (resolved from this module, not the cwd). */
export const DEFAULT_MODELS_CONFIG_PATH = fileURLToPath(new URL("../../config/models.json", import.meta.url));

/** Read + validate a file. Throws ModelsConfigError (also for unreadable / bad JSON). */
export function loadModelsConfigFile(path: string): ModelsConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ModelsConfigError([`cannot read the file (${(e as NodeJS.ErrnoException).code ?? "error"})`], path);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ModelsConfigError([`not valid JSON: ${(e as Error).message.slice(0, 160)}`], path);
  }
  return validateModelsConfig(raw, path);
}

/** Which file applies: PRISM_MODELS_CONFIG (must exist), else the default path if present. */
export function modelsConfigPath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  const set = env.PRISM_MODELS_CONFIG?.trim();
  if (set) return set;
  return exists(DEFAULT_MODELS_CONFIG_PATH) ? DEFAULT_MODELS_CONFIG_PATH : null;
}

let cached: ModelsConfig | null = null;
let envSettings: (() => EnvModelSettings) | null = null;

/** config.ts registers how to read the legacy env settings (avoids an import cycle). */
export function setEnvModelSettings(f: () => EnvModelSettings): void {
  envSettings = f;
}

/** The active config (cached). A broken file throws — boot calls `assertModelsConfig`. */
export function getModelsConfig(): ModelsConfig {
  if (cached) return cached;
  const path = modelsConfigPath();
  cached = path
    ? loadModelsConfigFile(path)
    : envModelsConfig(envSettings ? envSettings() : { skillsDefaultProvider: "claude", skillsLocalBaseUrl: "", skillsLocalModel: "", embedEndpoint: "", embedModel: "" });
  for (const w of cached.warnings) console.warn(`[providers] ${w}`);
  return cached;
}

/** Boot check: an invalid models.json stops the server with every problem listed. */
export function assertModelsConfig(): void {
  cached = null;
  getModelsConfig();
}

/** True when a models.json drives routing (else every call site runs its legacy path). */
export const modelsFileActive = (): boolean => getModelsConfig().source === "file";

/** Tests: install a config (a raw object is validated like a file), or null to re-read. */
export function setModelsConfigForTests(c: ModelsConfig | Record<string, unknown> | null): void {
  if (c === null) cached = null;
  else cached = "source" in c && (c.source === "file" || c.source === "env") ? (c as ModelsConfig) : validateModelsConfig(c, "<test>");
}

// ── resolution ───────────────────────────────────────────────────────────────

export interface ResolvedStep extends RouteStep {
  spec: ProviderSpec;
}

/**
 * A job's chain as it will be tried: the configured steps, with an optional caller
 * override FIRST (Settings → AI models, a skill note's provider/model), then the
 * fallback policy and the job's capability applied. Duplicates are dropped.
 * `skipped` explains every step left out (it is logged, never silent).
 */
export function resolveChain(cfg: ModelsConfig, job: Job, override?: RouteStep | null): { steps: ResolvedStep[]; skipped: string[] } {
  const route = cfg.jobs[job] ?? { steps: [], fallback: "any" as FallbackPolicy };
  const need = JOB_REQUIRES[job];
  const wanted = override ? [override, ...route.steps] : route.steps;
  const steps: ResolvedStep[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const s of wanted) {
    const key = `${s.provider}\u0000${s.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const spec = cfg.providers[s.provider];
    if (!spec) {
      skipped.push(`${s.provider}:${s.model} (no such provider)`);
      continue;
    }
    if (!spec.capabilities.includes(need) && job !== "chat") {
      skipped.push(`${s.provider}:${s.model} (cannot do ${need})`);
      continue;
    }
    if (steps.length > 0) {
      if (route.fallback === "none") {
        skipped.push(`${s.provider}:${s.model} (fallback: none)`);
        continue;
      }
      if (route.fallback === "local-only" && !spec.local) {
        skipped.push(`${s.provider}:${s.model} (fallback: local-only, provider is not local)`);
        continue;
      }
    }
    steps.push({ ...s, spec });
  }
  return { steps, skipped };
}

/** The provider the legacy "local" route names: one called `local`, else the first
 *  local openai-compatible provider. */
export function localProviderId(cfg: ModelsConfig): string | null {
  if (cfg.providers.local?.kind === "openai-compatible") return "local";
  return Object.values(cfg.providers).find((p) => p.kind === "openai-compatible" && p.local)?.id ?? null;
}
/** The provider the legacy "claude" route names: one called `claude`, else the first claude-cli. */
export function claudeProviderId(cfg: ModelsConfig): string | null {
  if (cfg.providers.claude?.kind === "claude-cli") return "claude";
  return Object.values(cfg.providers).find((p) => p.kind === "claude-cli")?.id ?? null;
}

/** Thrown when a job is routed to a provider that cannot do it (e.g. chat → no agent loop). */
export class ProviderCapabilityError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ProviderCapabilityError";
  }
}

/**
 * Chat sessions are tool-using, multi-turn runs (stream-json, --resume, the vault/Prism
 * MCP) — only claude-cli has that loop today. Returns the claude `--model` to use
 * (undefined = the runner's default, i.e. the old behaviour), or throws a clear
 * ProviderCapabilityError naming what to change.
 */
export function chatModel(cfg: ModelsConfig = getModelsConfig()): string | undefined {
  if (cfg.source === "env") return undefined;
  const first = cfg.jobs.chat?.steps[0];
  if (!first) return undefined; // no chat entry: the runner default (claude / sonnet)
  const spec = cfg.providers[first.provider];
  if (!spec || spec.kind !== "claude-cli" || !spec.capabilities.includes("agent")) {
    throw new ProviderCapabilityError(
      `Agent chat is routed to "${first.provider}:${first.model}", which cannot run tool-using conversations (needs: tools). ` +
        `Only claude-cli has an agent loop today. Put a claude-cli provider first in jobs.chat in the models config (see MODELS.md).`,
    );
  }
  return first.model;
}

/** A config safe to show: key env var NAMES and whether they are set — never values. */
export function redactedModelsConfig(cfg: ModelsConfig, env: NodeJS.ProcessEnv = process.env): {
  source: ModelsConfig["source"];
  path: string | null;
  providers: Array<Omit<ProviderSpec, "apiKeyEnv"> & { apiKeyEnv: string | null; apiKeySet: boolean }>;
  jobs: Record<string, { use: string[]; fallback: FallbackPolicy }>;
  warnings: string[];
} {
  return {
    source: cfg.source,
    path: cfg.path,
    providers: Object.values(cfg.providers).map((p) => ({ ...p, apiKeySet: !!(p.apiKeyEnv && env[p.apiKeyEnv]) })),
    jobs: Object.fromEntries(Object.entries(cfg.jobs).map(([j, r]) => [j, { use: r!.steps.map((s) => `${s.provider}:${s.model}`), fallback: r!.fallback }])),
    warnings: cfg.warnings,
  };
}
