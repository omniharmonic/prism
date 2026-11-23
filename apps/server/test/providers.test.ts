/**
 * The provider layer (src/providers/): models.json validation, the legacy env
 * mapping, job → chain resolution, ordered fallbacks that are logged and reported,
 * the chat capability check, key redaction, and its effect on the three call sites
 * that use it (the drafting dispatch, the triage scheduler, the embedder).
 *
 * Everything external is faked: model servers via injected fetch, the claude runner
 * via configureAgentRunner (never a real process). No network.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chatModel,
  envModelsConfig,
  getModelsConfig,
  loadModelsConfigFile,
  ModelsConfigError,
  modelsConfigPath,
  ProviderCapabilityError,
  redactedModelsConfig,
  resolveChain,
  setModelsConfigForTests,
  validateModelsConfig,
} from "../src/providers/config";
import { ChainCancelledError, ChainExhaustedError, providerStatus, runChain, _resetProviderStatus } from "../src/providers/router";
import { openAICompatible, ProviderCallError, scrubProviderText } from "../src/providers/openai-compatible";
import { agentApi } from "../src/routes/agent";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { configureAgentRunner, ensureAgentCwd, getDispatch, runnerStatus, _resetDispatches, type SpawnedProc } from "../src/agent-exec";
import { draftingPlan, setLocalAiFetchForTests, setLocalAiMemoryProbeForTests, setLocalAiSettingsForTests, writeRouting, defaultRouting } from "../src/local-ai";
import { createSession, ProfileUnavailableError } from "../src/agent-sessions";
import { resolveVaultEntry } from "../src/db";
import { _resetSkillsState, runSkillsOnce, triageSteps, type LocalModel, type LocalStatus, type SkillsDeps } from "../src/worker/skills";
import { embedderFromModelsConfig, HashEmbedder, OpenAICompatEmbedder } from "../src/rag/embedder";
import type { Note } from "../src/parachute";

const KEY_ENV = "PRISM_TEST_PROVIDER_KEY";
const KEY = "sk-test-SECRET-value-0123456789";
const EXAMPLE = fileURLToPath(new URL("../config/models.example.json", import.meta.url));

let root: string;
let spawned: string[][];
let claudeReply: { out: string; code: number } = { out: "claude answer", code: 0 };

beforeEach(() => {
  resetDb();
  _resetDispatches();
  _resetSkillsState();
  _resetProviderStatus();
  setModelsConfigForTests(null);
  process.env[KEY_ENV] = KEY;
  spawned = [];
  claudeReply = { out: "claude answer", code: 0 };
  root = mkdtempSync(join(tmpdir(), "prism-providers-"));
  configureAgentRunner({
    spawner: (_cmd, args) => {
      spawned.push(args);
      const outs: Array<(c: string) => void> = [];
      let exit: ((c: number | null) => void) | null = null;
      const p: SpawnedProc = {
        stdout: { on: (_e, cb) => outs.push(cb as (c: string) => void) },
        stderr: { on: () => {} },
        on: (ev, cb) => {
          if (ev === "exit") exit = cb as (c: number | null) => void;
        },
        kill: () => exit?.(null),
      };
      setImmediate(() => {
        outs.forEach((cb) => cb(claudeReply.out));
        exit?.(claudeReply.code);
      });
      return p;
    },
    cwd: () => ensureAgentCwd(join(root, "cwd")),
    claudePath: () => "/opt/fake/claude",
    memoryProbe: () => ({ swapUsedPct: 0, freePct: 90 }),
    maxConcurrent: 4,
    maxBudgetUsd: null,
  });
  setLocalAiSettingsForTests({ localBaseUrl: "http://lm.test/v1", swapMaxPct: 80, freeMinPct: 15, loadFreeMinPct: 35 });
  setLocalAiMemoryProbeForTests(() => ({ swapUsedPct: 5, freePct: 70 }));
});
afterEach(() => {
  setModelsConfigForTests(null);
  setLocalAiFetchForTests(null);
  setLocalAiMemoryProbeForTests(null);
  setLocalAiSettingsForTests(null);
  _resetDispatches();
  _resetSkillsState();
  delete process.env[KEY_ENV];
  rmSync(root, { recursive: true, force: true });
});

const problemsOf = (raw: unknown): string[] => {
  try {
    validateModelsConfig(raw);
    return [];
  } catch (e) {
    assert.ok(e instanceof ModelsConfigError);
    return e.problems;
  }
};

const REMOTE = { kind: "openai-compatible", base_url: "http://remote.test/v1", api_key_env: KEY_ENV };

// ── config validation ────────────────────────────────────────────────────────

test("the shipped example validates", () => {
  const cfg = loadModelsConfigFile(EXAMPLE);
  assert.equal(cfg.source, "file");
  assert.deepEqual(cfg.jobs.drafting?.steps, [
    { provider: "local", model: "qwen2.5-14b-instruct" },
    { provider: "claude", model: "sonnet" },
  ]);
  // Loopback → local + memory guard by default; the Tailscale box opts in to local only.
  assert.equal(cfg.providers.local!.local, true);
  assert.equal(cfg.providers.local!.memoryGuard, true);
  assert.equal(cfg.providers.workstation!.local, true);
  assert.equal(cfg.providers.workstation!.memoryGuard, false);
  assert.equal(cfg.providers.openrouter!.local, false);
  assert.equal(cfg.jobs.triage?.fallback, "local-only");
});

test("validation lists every problem and never echoes a pasted key", () => {
  const problems = problemsOf({
    surprise: 1,
    providers: {
      a: { kind: "openai-compatible", base_url: "http://user:pw@host.test/v1" },
      b: { kind: "openai-compatible", base_url: "http://h.test/v1", api_key_env: KEY },
      c: { kind: "claude-cli", model: "gpt-9" },
      d: { kind: "wizard" },
      e: { kind: "openai-compatible", base_url: "http://h.test/v1", capabilities: ["agent"] },
      Bad: { kind: "claude-cli" },
    },
    jobs: {
      chat: ["claude"],
      embeddings: ["x:one", "y:two"],
      drafting: ["missing:model"],
      triage: ["claude-less"],
      teleport: ["a:m"],
    },
  });
  const text = problems.join("\n");
  for (const want of [/unknown top-level key "surprise"/, /must not carry credentials/, /NAME of an environment variable/, /claude-cli takes sonnet, opus, haiku/, /kind: must be/, /"agent".*exists only for claude-cli/, /a provider name is lowercase/, /exactly one model/, /no provider named "missing"/, /unknown job/]) {
    assert.match(text, want);
  }
  assert.ok(!text.includes(KEY), "a key pasted into api_key_env is never repeated back");
});

test("a job entry may name a model with colons; capability mismatches are errors except for chat", () => {
  const cfg = validateModelsConfig({
    providers: { ollama: { kind: "openai-compatible", base_url: "http://127.0.0.1:11434/v1" }, claude: { kind: "claude-cli" } },
    jobs: { drafting: ["ollama:llama3.1:8b"], chat: ["ollama:llama3.1:8b"] },
  });
  assert.deepEqual(cfg.jobs.drafting?.steps, [{ provider: "ollama", model: "llama3.1:8b" }]);
  assert.match(cfg.warnings.join(), /no agent loop/);
  assert.match(problemsOf({ providers: { claude: { kind: "claude-cli", model: "sonnet" } }, jobs: { embeddings: ["claude"] } }).join(), /cannot do embeddings/);
  assert.match(problemsOf({ providers: { o: { kind: "openai-compatible", base_url: "http://x.test/v1" } }, jobs: { drafting: ["o"] } }).join(), /no model/);
});

test("which file applies: PRISM_MODELS_CONFIG, else the default path only when it exists", () => {
  assert.equal(modelsConfigPath({ PRISM_MODELS_CONFIG: "/x/models.json" }, () => false), "/x/models.json");
  assert.equal(modelsConfigPath({}, () => false), null);
  assert.match(modelsConfigPath({}, () => true) ?? "", /apps\/server\/config\/models\.json$/);
  // A broken file is an error (boot stops), never a silent fallback to the env routing.
  const bad = join(root, "models.json");
  writeFileSync(bad, "{ not json");
  assert.throws(() => loadModelsConfigFile(bad), ModelsConfigError);
});

// ── backward compatibility ───────────────────────────────────────────────────

test("no models.json: the legacy env vars map into the same shape, single routes, no fallback", () => {
  const local = envModelsConfig({ skillsDefaultProvider: "local", skillsLocalBaseUrl: "http://127.0.0.1:1234/v1", skillsLocalModel: "gemma", embedEndpoint: "", embedModel: "nomic-embed-text" });
  assert.equal(local.source, "env");
  assert.deepEqual(local.jobs.triage, { steps: [{ provider: "local", model: "gemma" }], fallback: "none" });
  assert.deepEqual(local.jobs.embeddings?.steps, [], "no EMBED_ENDPOINT → the offline hash embedder");
  assert.deepEqual(local.jobs.chat?.steps, [{ provider: "claude", model: "sonnet" }]);
  const claude = envModelsConfig({ skillsDefaultProvider: "claude", skillsLocalBaseUrl: "", skillsLocalModel: "", embedEndpoint: "http://e.test/v1", embedModel: "m" });
  assert.equal(claude.jobs.triage?.steps[0]?.provider, "claude");
  assert.equal(claude.providers.embed?.apiKeyEnv, "EMBED_API_KEY");
  // The test env has no models.json: the active config is the env mapping.
  assert.equal(getModelsConfig().source, "env");
  assert.equal(chatModel(), undefined, "sessions keep the runner's default --model");
  assert.equal(triageSteps({}, getModelsConfig()), null, "skills keep effectiveRouting");
  assert.equal(draftingPlan("edit").claudeModel, "sonnet");
  assert.equal(embedderFromModelsConfig(), null, "the embedder keeps EMBED_*");
});

test("no models.json: a dispatch routed local in Settings runs exactly the old local path", async () => {
  writeRouting({ ...defaultRouting(), edit: { provider: "local", model: "qwen-7b" } });
  setLocalAiFetchForTests(async (url) => {
    if (url === "http://lm.test/api/v0/models") return Response.json({ data: [{ id: "qwen-7b", state: "loaded" }] });
    return new Response("down", { status: 500 });
  });
  const r = await post("/dispatch", { prompt: "fix", skill: "edit", profile: "vault-ro" });
  assert.equal(r.provider, "local");
  const d = await settled(r.id);
  assert.equal(d.status, "error");
  assert.equal(d.error, "local model returned HTTP 500", "the legacy message, not a chain summary");
  assert.equal(d.provider, undefined, "no provider metadata on the legacy path");
});

// ── resolution + fallback ────────────────────────────────────────────────────

const chainCfg = () =>
  validateModelsConfig({
    providers: {
      local: { kind: "openai-compatible", base_url: "http://127.0.0.1:1234/v1" },
      cloud: REMOTE,
      claude: { kind: "claude-cli" },
    },
    jobs: {
      drafting: { use: ["local:small", "cloud:big", "claude:sonnet"] },
      triage: { use: ["local:small", "cloud:big"], fallback: "local-only" },
      extraction: { use: ["cloud:big", "local:small"], fallback: "none" },
    },
  });

test("resolveChain: override first, duplicates dropped, fallback policies applied and explained", () => {
  const cfg = chainCfg();
  assert.deepEqual(resolveChain(cfg, "drafting", { provider: "cloud", model: "big" }).steps.map((s) => `${s.provider}:${s.model}`), ["cloud:big", "local:small", "claude:sonnet"]);
  const tri = resolveChain(cfg, "triage");
  assert.deepEqual(tri.steps.map((s) => s.provider), ["local"]);
  assert.match(tri.skipped.join(), /local-only/);
  const ext = resolveChain(cfg, "extraction");
  assert.deepEqual(ext.steps.map((s) => s.provider), ["cloud"]);
  assert.match(ext.skipped.join(), /fallback: none/);
});

test("runChain tries steps in order, logs every hand-over, and records who served", async () => {
  const logs: string[] = [];
  const steps = resolveChain(chainCfg(), "drafting").steps;
  const tried: string[] = [];
  const r = await runChain("drafting", steps, async (s) => {
    tried.push(s.provider);
    if (s.provider !== "claude") throw new Error(`boom from ${s.provider} with ${KEY} at http://secret.test/x`);
    return "ok";
  }, { log: (m) => logs.push(m) });
  assert.deepEqual(tried, ["local", "cloud", "claude"]);
  assert.equal(r.value, "ok");
  assert.deepEqual([r.servedBy.provider, r.servedBy.fallbacks.map((f) => f.provider)], ["claude", ["local", "cloud"]]);
  assert.match(logs.join("\n"), /local:small failed .* → trying cloud:big/);
  assert.match(logs.join("\n"), /served by claude:sonnet after/);
  const status = JSON.stringify(providerStatus());
  assert.match(status, /"fellBackFrom":\["local:small","cloud:big"\]/);
  assert.ok(!status.includes("secret.test"), "URLs are scrubbed from recorded reasons");
});

test("runChain: cancellation stops at once; an exhausted chain throws with every reason", async () => {
  const steps = resolveChain(chainCfg(), "drafting").steps;
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(
    runChain("drafting", steps, async () => {
      calls++;
      ac.abort();
      throw new Error("aborted");
    }, { signal: ac.signal, log: () => {} }),
    ChainCancelledError,
  );
  assert.equal(calls, 1);
  await assert.rejects(runChain("drafting", steps, async (s) => { throw new Error(`no ${s.provider}`); }, { log: () => {} }), (e: unknown) => e instanceof ChainExhaustedError && /no local.*no cloud.*no claude/.test(e.message));
  await assert.rejects(runChain("drafting", [], async () => "x", { log: () => {} }), /no provider is configured/);
});

// ── the openai-compatible backend ────────────────────────────────────────────

test("openai-compatible: key from the named env var as a Bearer header only; errors never carry it", async () => {
  const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const be = openAICompatible({ baseUrl: "http://remote.test/v1/", apiKeyEnv: KEY_ENV }, async (url, init) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    if (url.endsWith("/embeddings")) return Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    if ((JSON.parse(String(init?.body)) as { model: string }).model === "bad") return new Response(`invalid key ${KEY}`, { status: 401 });
    return Response.json({ choices: [{ message: { content: "<think>x</think> hello " } }] });
  });
  assert.equal(await be.complete({ model: "m", system: "s", user: "u", timeoutMs: 5000 }), "hello");
  assert.equal(seen[0]!.url, "http://remote.test/v1/chat/completions");
  assert.equal(seen[0]!.auth, `Bearer ${KEY}`);
  // The same body Prism always sent: no temperature, no tools.
  assert.deepEqual(Object.keys(seen[0]!.body), ["model", "messages", "stream"]);
  assert.deepEqual(await be.embed("e", ["a", "b"]), [[1, 0], [0, 1]], "rows follow the response index");
  const err = await be.complete({ model: "bad", system: "s", user: "u", timeoutMs: 5000 }).catch((e) => e);
  assert.ok(err instanceof ProviderCallError && err.kind === "http" && err.status === 401);
  assert.ok(!JSON.stringify({ m: err.message, d: err.detail }).includes(KEY), "the echoed key is scrubbed");
  assert.equal(scrubProviderText(`Authorization: Bearer abc.def at https://x.test/p ${KEY}`, KEY), "Authorization: Bearer <key> at <url> <key>");
  // No key env → no Authorization header at all.
  const plain = openAICompatible({ baseUrl: "http://local.test/v1" }, async (_u, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return Response.json({ choices: [{ message: { content: "", reasoning_content: "{\"a\":1}" } }] });
  });
  assert.equal(await plain.structuredText({ model: "m", system: "s", user: "u", timeoutMs: 1000, schemaName: "x", schema: {} }), "{\"a\":1}");
});

test("status redacts keys: the env var NAME and whether it is set, never the value", () => {
  setModelsConfigForTests({ providers: { cloud: REMOTE }, jobs: { drafting: ["cloud:big"] } });
  const red = redactedModelsConfig(getModelsConfig());
  assert.equal(red.providers[0]!.apiKeyEnv, KEY_ENV);
  assert.equal(red.providers[0]!.apiKeySet, true);
  assert.ok(!JSON.stringify(runnerStatus()).includes(KEY));
  assert.deepEqual((runnerStatus().providers.config as { jobs: unknown }).jobs, { drafting: { use: ["cloud:big"], fallback: "any" } });
});

// ── chat: the capability check ───────────────────────────────────────────────

test("chat routed to a provider with no agent loop is refused with a clear message", () => {
  setModelsConfigForTests({ providers: { local: { kind: "openai-compatible", base_url: "http://127.0.0.1:1234/v1" }, claude: { kind: "claude-cli" } }, jobs: { chat: ["local:qwen", "claude:sonnet"] } });
  assert.throws(() => chatModel(), (e: unknown) => e instanceof ProviderCapabilityError && /needs: tools/.test(e.message) && /jobs\.chat/.test(e.message));
  assert.throws(() => createSession({ vaultId: resolveVaultEntry().id, ownerEmail: config.ownerEmail }), ProfileUnavailableError);
  setModelsConfigForTests({ providers: { claude: { kind: "claude-cli" } }, jobs: { chat: ["claude:opus"] } });
  assert.equal(chatModel(), "opus", "a models.json can pick the chat model");
  setModelsConfigForTests({ providers: { claude: { kind: "claude-cli" } }, jobs: {} });
  assert.equal(chatModel(), undefined, "no chat job → the runner default");
});

// ── drafting through the dispatch route ──────────────────────────────────────

const owner = () => ({ "content-type": "application/json", cookie: sessionCookie(makeSession(config.ownerEmail)) });
async function post(path: string, body: unknown): Promise<{ id: string; provider?: string; model?: string }> {
  const r = await agentApi.request(path, { method: "POST", headers: owner(), body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json() as Promise<{ id: string; provider?: string; model?: string }>;
}
async function settled(id: string) {
  for (let i = 0; i < 200; i++) {
    const d = getDispatch(id)!;
    if (d.status !== "queued" && d.status !== "running") return d;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("dispatch never settled");
}

test("drafting with a models.json: a failing provider falls back to the next, and the dispatch says who answered", async () => {
  setModelsConfigForTests({ providers: { cloud: REMOTE, claude: { kind: "claude-cli" } }, jobs: { drafting: ["cloud:big", "claude:haiku"] } });
  const calls: string[] = [];
  setLocalAiFetchForTests(async (url) => {
    calls.push(url);
    return new Response(`overloaded (key ${KEY})`, { status: 503 });
  });
  const r = await post("/dispatch", { prompt: "Summarize: hello", skill: "generate", profile: "text" });
  assert.deepEqual([r.provider, r.model], ["cloud", "big"], "the response names the PREFERRED step");
  const d = await settled(r.id);
  assert.equal(d.status, "done", d.error ?? "");
  assert.equal(d.output, "claude answer");
  assert.deepEqual([d.provider, d.model], ["claude", "haiku"]);
  assert.equal(d.fallbacks?.[0]?.provider, "cloud");
  assert.equal(calls[0], "http://remote.test/v1/chat/completions");
  // The claude step kept the dispatch's narrowing: text-only (no tools) and the chosen model.
  const args = spawned[0]!;
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.ok(!args.includes("--allowedTools"));
  assert.ok(!JSON.stringify(d).includes(KEY) && !JSON.stringify(runnerStatus()).includes(KEY));
  assert.ok(runnerStatus().providers.lastFallback, "the fallback is visible in GET /api/agent/runner");
});

test("drafting with a models.json: a saved Settings route goes first; a single claude step keeps the plain runner", async () => {
  setModelsConfigForTests({ providers: { local: { kind: "openai-compatible", base_url: "http://lm.test/v1", local: true }, claude: { kind: "claude-cli" } }, jobs: { drafting: { use: ["claude:sonnet"], fallback: "local-only" } } });
  assert.equal(draftingPlan("edit").claudeModel, "sonnet", "unsaved → the file's single claude step → startDispatch as before");
  writeRouting({ ...defaultRouting(), edit: { provider: "local", model: "qwen-7b" } });
  const plan = draftingPlan("edit");
  assert.deepEqual(plan.steps.map((s) => `${s.provider}:${s.model}`), ["local:qwen-7b"], "local-only drops the cloud fallback");
  assert.match(plan.skipped.join(), /local-only/);
  setLocalAiFetchForTests(async (url) => {
    assert.equal(url, "http://lm.test/v1/chat/completions", "not loopback → no memory-guard probe");
    return Response.json({ choices: [{ message: { content: "local answer" } }] });
  });
  const r = await post("/dispatch", { prompt: "fix", skill: "edit", profile: "vault-ro" });
  const d = await settled(r.id);
  assert.deepEqual([d.status, d.output, d.provider], ["done", "local answer", "local"]);
  assert.equal(spawned.length, 0);
});

test("drafting: a Settings choice of a LOCAL model never falls back to a cloud provider, even with fallback: any", () => {
  setModelsConfigForTests({ providers: { local: { kind: "openai-compatible", base_url: "http://lm.test/v1", local: true }, claude: { kind: "claude-cli" } }, jobs: { drafting: { use: ["local:qwen-14b", "claude:sonnet"], fallback: "any" } } });
  writeRouting({ ...defaultRouting(), edit: { provider: "local", model: "qwen-7b" } });
  const plan = draftingPlan("edit");
  assert.ok(plan.steps.every((s) => s.spec.local), "every step stays on local hardware");
  assert.deepEqual(plan.steps.map((s) => `${s.provider}:${s.model}`), ["local:qwen-7b", "local:qwen-14b"]);
  assert.match(plan.skipped.join(), /never falls back off this hardware/);
  assert.equal(plan.claudeModel, null);
  writeRouting(defaultRouting());
});

// ── triage through the scheduler ─────────────────────────────────────────────

test("triage with a models.json: an unreachable preferred provider hands the skill to the next, logged", async () => {
  setModelsConfigForTests({
    providers: { first: { kind: "openai-compatible", base_url: "http://first.test/v1" }, second: REMOTE },
    jobs: { triage: ["first:m1", "second:m2"] },
  });
  const notes = new Map<string, Note>();
  const add = (n: Partial<Note> & { id: string }) => notes.set(n.id, { content: "", path: null, metadata: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags: [], ...n } as Note);
  add({ id: "skill", path: "vault/agent/skills/tri", tags: ["agent-skill"], content: "Classify.", metadata: { skillName: "tri", enabled: true, intervalSecs: 3600, runner: "server", executionMode: "structured", structured: { sourceTags: ["inbox"], schema: { type: "object" }, resultField: "label", allowedValues: ["a", "b"] } } });
  add({ id: "n1", tags: ["inbox"], content: "hello" });
  const used: string[] = [];
  const fake = (name: string, reachable: boolean): LocalModel => ({
    async status(): Promise<LocalStatus> {
      return reachable ? { reachable: true, loaded: null } : { reachable: false, loaded: null, error: "connection refused" };
    },
    async structured(_s, _u, _n, _schema, model) {
      used.push(`${name}:${model}`);
      return { label: "a" };
    },
  });
  const logs: string[] = [];
  const deps: SkillsDeps = {
    vault: {
      listNotes: async (o) => [...notes.values()].filter((n) => !o.tags?.[0] || n.tags!.includes(o.tags[0])).map((n) => structuredClone(n)),
      getNote: async (id) => structuredClone(notes.get(id)!),
      createNote: async (p) => ({ id: "d", content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? [], createdAt: "", updatedAt: "" }) as Note,
      updateNote: async (id, p) => {
        const n = notes.get(id)!;
        n.metadata = { ...(n.metadata ?? {}), ...p.metadata };
        return structuredClone(n);
      },
      addTags: async (id, tags) => {
        notes.get(id)!.tags = [...new Set([...(notes.get(id)!.tags ?? []), ...tags])];
      },
    },
    local: fake("legacy", true),
    localFor: (step) => fake(step.provider, step.provider !== "first"),
    claude: () => {
      throw new Error("claude must not run");
    },
    memoryProbe: () => ({ swapUsedPct: 0, freePct: 90 }),
    now: () => new Date("2026-03-10T09:30:00Z"),
    localParts: (d) => ({ hour: d.getUTCHours(), day: d.toISOString().slice(0, 10) }),
    settings: { enabled: true, defaultProvider: "local", localBaseUrl: "http://lm.test/v1", localModel: "legacy-model", swapMaxPct: 80, swapMinFreeMb: 512, freeMinPct: 15, loadFreeMinPct: 35, localRunTimeoutMs: 60_000 },
    log: (m) => logs.push(m),
    isTrustedCreator: () => true,
  };
  const res = await runSkillsOnce(deps);
  assert.deepEqual(res.finished, [{ skill: "tri", status: "completed" }]);
  assert.deepEqual(used, ["second:m2"]);
  assert.match(logs.join("\n"), /triage: served by second:m2 after first:m1 \(first unreachable: connection refused\)/);
  assert.ok(notes.get("n1")!.tags!.includes("a"));

  // Nobody reachable → deferred (stays due) with every reason; nothing ran.
  _resetSkillsState();
  notes.get("skill")!.metadata!.lastRun = null;
  used.length = 0;
  const none = await runSkillsOnce({ ...deps, localFor: (step) => fake(step.provider, false) });
  assert.equal(none.refused.length, 1);
  assert.match(none.refused[0]!.reason, /first:m1: .*; second:m2: /);
  assert.deepEqual(used, []);
});

// ── embeddings ───────────────────────────────────────────────────────────────

test("embeddings with a models.json: the one configured model, or the offline embedder", () => {
  setModelsConfigForTests({ providers: { ollama: { kind: "openai-compatible", base_url: "http://127.0.0.1:11434/v1" } }, jobs: { embeddings: ["ollama:nomic-embed-text"] } });
  const e = embedderFromModelsConfig();
  assert.ok(e instanceof OpenAICompatEmbedder);
  assert.equal(e.id, "openai:nomic-embed-text", "same id as EMBED_MODEL gave → no re-index on switching to the file");
  setModelsConfigForTests({ providers: {}, jobs: {} });
  assert.ok(embedderFromModelsConfig() instanceof HashEmbedder);
});

test("the example file stays parseable JSON with only comment keys added", () => {
  const raw = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw).filter((k) => !k.startsWith("_")), ["version", "providers", "jobs"]);
});
