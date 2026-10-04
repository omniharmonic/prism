/**
 * Parity A (thin client ⇄ legacy desktop): the server-owner routes for running
 * skills + cancel, the LM Studio model list, interactive per-skill routing and
 * its effect on the read-only one-shot dispatch the client's inline AI uses.
 *
 * Everything external is faked: LM Studio via setLocalAiFetchForTests (never
 * :1234), the claude runner via configureAgentRunner (never a real process),
 * memory via an injected probe.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentApi, _setRoutingTestLimitForTests } from "../src/routes/agent";
import { config } from "../src/config";
import { setMembership } from "../src/db";
import { issueDeviceToken } from "../src/auth/device";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";
import { configureAgentRunner, ensureAgentCwd, _resetDispatches, getDispatch, type SpawnedProc } from "../src/agent-exec";
import { _resetSkillsState, runSkillsOnce, tryAcquireLocalModel, releaseLocalModel, type SkillsDeps } from "../src/worker/skills";
import { defaultRouting, mergeRouting, readRouting, setLocalAiFetchForTests, setLocalAiMemoryProbeForTests, setLocalAiSettingsForTests } from "../src/local-ai";
import type { Note } from "../src/parachute";

const J = { "content-type": "application/json" };
const VAULT = "primary";
const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });

let lmCalls: Array<{ url: string; body: unknown }>;
let lmLoaded: boolean;
let lmUp: boolean;
let lmReply: string;
let spawned: string[][];
let root: string;

beforeEach(() => {
  resetDb();
  _resetSkillsState();
  _resetDispatches();
  lmCalls = [];
  lmLoaded = true;
  lmUp = true;
  lmReply = "local answer";
  _setRoutingTestLimitForTests(1000);
  spawned = [];
  root = mkdtempSync(join(tmpdir(), "prism-parity-"));
  configureAgentRunner({
    spawner: (_cmd, args) => {
      spawned.push(args);
      const p: SpawnedProc = { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, kill: () => {} };
      return p;
    },
    cwd: () => ensureAgentCwd(join(root, "cwd")),
    claudePath: () => "/opt/fake/claude",
    memoryProbe: () => ({ swapUsedPct: 0, freePct: 90 }),
    maxConcurrent: 10,
  });
  setLocalAiSettingsForTests({ localBaseUrl: "http://lm.test/v1", swapMaxPct: 80, freeMinPct: 15, loadFreeMinPct: 35 });
  setLocalAiMemoryProbeForTests(() => ({ swapUsedPct: 5, freePct: 70 }));
  setLocalAiFetchForTests(async (url, init) => {
    lmCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (!lmUp) throw new TypeError("fetch failed");
    if (url === "http://lm.test/api/v0/models") {
      return Response.json({ data: [{ id: "qwen-7b", type: "llm", state: lmLoaded ? "loaded" : "not-loaded", quantization: "Q4_K_M" }, { id: "nomic-embed", type: "embeddings", state: "not-loaded" }] });
    }
    if (url === "http://lm.test/v1/chat/completions") return Response.json({ choices: [{ message: { content: `<think>hmm</think>${lmReply}` } }] });
    return new Response("nope", { status: 404 });
  });
});
afterEach(() => {
  setLocalAiFetchForTests(null);
  setLocalAiMemoryProbeForTests(null);
  setLocalAiSettingsForTests(null);
  _resetDispatches();
  _resetSkillsState();
  rmSync(root, { recursive: true, force: true });
});

const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/skills/running"],
  ["POST", "/skills/some-skill/cancel", {}],
  ["GET", "/models"],
  ["GET", "/routing"],
  ["PUT", "/routing", { routing: { edit: { provider: "claude", model: "opus" } } }],
  ["POST", "/routing/test", { skill: "edit" }],
];
const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  agentApi.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

test("403 matrix: anon, capability link, guest, member, admin, a vault-role owner and an admin device never reach the parity routes", async () => {
  setMembership(VAULT, "member@example.test", "member", null);
  setMembership(VAULT, "admin@example.test", "admin", null);
  setMembership(VAULT, "coowner@example.test", "owner", null);
  const dev = issueDeviceToken("admin@example.test", "phone", "prism-ios").token;
  const callers: Record<string, Record<string, string>> = {
    anon: J,
    link: { ...J, authorization: `Capability ${makeCapability("note", "n1", "edit")}` },
    guest: { ...J, cookie: sessionCookie(makeSession("guest@example.test")) },
    member: { ...J, cookie: sessionCookie(makeSession("member@example.test")) },
    admin: { ...J, cookie: sessionCookie(makeSession("admin@example.test")) },
    "vault-role owner": { ...J, cookie: sessionCookie(makeSession("coowner@example.test")) },
    "admin device": { ...J, authorization: `Bearer ${dev}` },
  };
  for (const [who, h] of Object.entries(callers)) {
    for (const [m, p, b] of ROUTES) assert.equal((await call(m, p, h, b)).status, 403, `${who} ${m} ${p}`);
  }
  assert.equal(lmCalls.length, 0, "nothing reached LM Studio");
  assert.deepEqual(readRouting(), defaultRouting(), "nothing was written");
  // The server owner's device token works (native client).
  const own = issueDeviceToken(config.ownerEmail, "laptop", "prism-client").token;
  assert.equal((await call("GET", "/routing", { authorization: `Bearer ${own}` })).status, 200);
});

test("CSRF on the mutations: form bodies 415, sibling-site / foreign Origin 403; GETs unaffected", async () => {
  for (const [m, p, b] of ROUTES.filter(([m]) => m !== "GET")) {
    assert.equal((await call(m, p, { ...owner(), "content-type": "text/plain" }, b)).status, 415, `${m} ${p}`);
    assert.equal((await call(m, p, { ...owner(), "sec-fetch-site": "same-site" }, b)).status, 403, `${m} ${p}`);
    assert.equal((await call(m, p, { ...owner(), origin: "https://evil.example.test" }, b)).status, 403, `${m} ${p}`);
  }
  assert.deepEqual(readRouting(), defaultRouting());
});

test("GET /models: LM Studio's models with type + loaded state, claude availability; unreachable is reported, not thrown", async () => {
  const r = (await (await call("GET", "/models", owner())).json()) as {
    local: { configured: boolean; reachable: boolean; models: Array<{ id: string; type: string; state: string }> };
    claude: { models: string[] };
  };
  assert.equal(r.local.configured, true);
  assert.equal(r.local.reachable, true);
  assert.deepEqual(r.local.models.map((m) => [m.id, m.type, m.state]), [["qwen-7b", "llm", "loaded"], ["nomic-embed", "embeddings", "not-loaded"]]);
  assert.deepEqual(r.claude.models, ["sonnet", "opus", "haiku"]);
  lmUp = false;
  const down = (await (await call("GET", "/models", owner())).json()) as { local: { reachable: boolean; error: string } };
  assert.equal(down.local.reachable, false);
  assert.ok(!down.local.error.includes("lm.test"), "no URL echoed in the error");
});

test("routing: defaults to claude/sonnet; PUT merges + validates (provider, claude allowlist, local model id, unknown skill)", async () => {
  const g = (await (await call("GET", "/routing", owner())).json()) as { skills: string[]; routing: Record<string, { provider: string; model: string }> };
  assert.deepEqual(g.skills, ["edit", "chat", "transform", "generate"]);
  assert.deepEqual(g.routing.edit, { provider: "claude", model: "sonnet" });
  const ok = await call("PUT", "/routing", owner(), { routing: { edit: { provider: "local", model: "qwen-7b" }, transform: { provider: "claude", model: "haiku" } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(readRouting().edit, { provider: "local", model: "qwen-7b" });
  assert.deepEqual(readRouting().transform, { provider: "claude", model: "haiku" });
  assert.deepEqual(readRouting().chat, { provider: "claude", model: "sonnet" }, "untouched skills keep their route");
  for (const bad of [
    { edit: { provider: "openai", model: "x" } },
    { edit: { provider: "claude", model: "gpt-4" } },
    { edit: { provider: "local", model: "" } },
    { edit: { provider: "local", model: "--evil flag" } },
    { summarize: { provider: "claude", model: "sonnet" } },
    "edit",
  ]) {
    assert.equal((await call("PUT", "/routing", owner(), { routing: bad })).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(readRouting().edit, { provider: "local", model: "qwen-7b" }, "a bad PUT changes nothing");
  assert.throws(() => mergeRouting(defaultRouting(), null));
});

test("dispatch routed LOCAL: the read-only inline edit runs once on LM Studio (no claude spawn), pollable + think-block stripped", async () => {
  await call("PUT", "/routing", owner(), { routing: { edit: { provider: "local", model: "qwen-7b" } } });
  const r = await call("POST", "/dispatch", owner(), { prompt: "Rewrite: hello", skill: "edit", profile: "vault-ro" });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { id: string; provider: string; model: string };
  assert.equal(j.provider, "local");
  assert.equal(j.model, "qwen-7b");
  for (let i = 0; i < 50 && getDispatch(j.id)?.status === "running"; i++) await new Promise((res) => setTimeout(res, 5));
  const d = (await (await call("GET", `/dispatches/${j.id}`, owner())).json()) as { status: string; output: string; skill: string };
  assert.equal(d.status, "done");
  assert.equal(d.output, "local answer");
  assert.equal(d.skill, "edit");
  assert.equal(spawned.length, 0, "claude never spawned");
  const chat = lmCalls.find((c) => c.url.endsWith("/chat/completions"))!;
  const body = chat.body as { model: string; messages: Array<{ role: string; content: string }>; stream: boolean };
  assert.equal(body.model, "qwen-7b");
  assert.equal(body.stream, false);
  assert.equal(body.messages.at(-1)!.content, "Rewrite: hello");
});

test("dispatch routed LOCAL is refused (dispatch error, never a silent claude fallback) under memory pressure / busy slot / not-loaded + low memory", async () => {
  await call("PUT", "/routing", owner(), { routing: { transform: { provider: "local", model: "qwen-7b" } } });
  const run = async () => {
    const j = (await (await call("POST", "/dispatch", owner(), { prompt: "x", skill: "transform", profile: "vault-ro" })).json()) as { id: string };
    for (let i = 0; i < 50 && getDispatch(j.id)?.status === "running"; i++) await new Promise((res) => setTimeout(res, 5));
    return getDispatch(j.id)!;
  };
  setLocalAiMemoryProbeForTests(() => ({ swapUsedPct: 5, freePct: 8 }));
  let d = await run();
  assert.equal(d.status, "error");
  assert.match(d.error!, /local model refused: memory pressure/);
  setLocalAiMemoryProbeForTests(() => ({ swapUsedPct: 5, freePct: 25 }));
  lmLoaded = false;
  d = await run();
  assert.match(d.error!, /not loaded .* refusing to JIT-load/);
  // Interactive local AI shares the skills' JIT-load rule (macOS sample: a swap storm in progress).
  setLocalAiMemoryProbeForTests(() => ({ swapUsedPct: 85, freePct: 60, swapFreeMb: 920, swapTotalMb: 6144, swapDiskFreeMb: 160_000, memTotalMb: 16_384, pressureLevel: 1, swapoutPerS: 6000, pagingWindowS: 2, reclaimableMb: 6000 }));
  setLocalAiSettingsForTests({ localBaseUrl: "http://lm.test/v1", swapMaxPct: null, freeMinPct: 15, loadFreeMinPct: 35 });
  d = await run();
  assert.match(d.error!, /local model refused: .*not loaded and the system is swapping out 6000 pages\/s .* refusing to JIT-load/);
  lmLoaded = true;
  d = await run();
  assert.equal(d.status, "done", "a resident model is unaffected by the swap rule");
  const ranLocal = lmCalls.filter((c) => c.url.endsWith("/chat/completions")).length;
  setLocalAiSettingsForTests({ localBaseUrl: "http://lm.test/v1", swapMaxPct: 80, freeMinPct: 15, loadFreeMinPct: 35 });
  setLocalAiMemoryProbeForTests(() => ({ swapUsedPct: 5, freePct: 25 }));
  const held = tryAcquireLocalModel();
  assert.ok(held, "a skill run holds the local slot");
  d = await run();
  assert.match(d.error!, /another local-model run is in progress/);
  releaseLocalModel(held);
  assert.equal(spawned.length, 0, "never fell back to claude");
  assert.equal(lmCalls.filter((c) => c.url.endsWith("/chat/completions")).length, ranLocal);
  assert.equal(ranLocal, 1, "only the resident-model run reached the model");
});

test("dispatch routed CLAUDE: the chosen --model is passed; full-tools dispatches and non-interactive skills ignore routing", async () => {
  await call("PUT", "/routing", owner(), { routing: { generate: { provider: "claude", model: "opus" }, edit: { provider: "local", model: "qwen-7b" } } });
  await call("POST", "/dispatch", owner(), { prompt: "x", skill: "generate", profile: "vault-ro" });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]![spawned[0]!.indexOf("--model") + 1], "opus");
  // A non-vault-ro dispatch with an interactive skill name is NOT routed (stays sonnet/claude).
  await call("POST", "/dispatch", owner(), { prompt: "y", skill: "edit" });
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1]![spawned[1]!.indexOf("--model") + 1], "sonnet");
  // A free-text skill name never selects a route.
  await call("POST", "/dispatch", owner(), { prompt: "z", skill: "opus", profile: "vault-ro" });
  assert.equal(spawned[2]![spawned[2]!.indexOf("--model") + 1], "sonnet");
  assert.equal(lmCalls.filter((c) => c.url.endsWith("/chat/completions")).length, 0);
});

test("cancel a local inline-AI dispatch: the LM Studio request is aborted and the dispatch ends cancelled", async () => {
  await call("PUT", "/routing", owner(), { routing: { edit: { provider: "local", model: "qwen-7b" } } });
  setLocalAiFetchForTests(async (url, init) => {
    lmCalls.push({ url, body: null });
    if (url.endsWith("/api/v0/models")) return Response.json({ data: [{ id: "qwen-7b", state: "loaded" }] });
    return new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  });
  const j = (await (await call("POST", "/dispatch", owner(), { prompt: "x", skill: "edit", profile: "vault-ro" })).json()) as { id: string };
  await new Promise((res) => setTimeout(res, 10));
  const c = (await (await call("POST", `/dispatches/${j.id}/cancel`, owner())).json()) as { ok: boolean };
  assert.equal(c.ok, true);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(getDispatch(j.id)!.status, "cancelled");
  const again = tryAcquireLocalModel();
  assert.ok(again, "the local slot was released");
  releaseLocalModel(again);
});

test("routing test: local = one tiny completion behind the guard; a refusal is reported as ok:false", async () => {
  await call("PUT", "/routing", owner(), { routing: { chat: { provider: "local", model: "qwen-7b" } } });
  lmReply = "ready";
  const r = (await (await call("POST", "/routing/test", owner(), { skill: "chat" })).json()) as { ok: boolean; reply: string; provider: string };
  assert.deepEqual([r.ok, r.provider, r.reply], [true, "local", "ready"]);
  setLocalAiMemoryProbeForTests(() => ({ swapUsedPct: 5, freePct: 5 }));
  const bad = (await (await call("POST", "/routing/test", owner(), { route: { provider: "local", model: "qwen-7b" } })).json()) as { ok: boolean; error: string };
  assert.equal(bad.ok, false);
  assert.match(bad.error, /memory pressure/);
  assert.equal((await call("POST", "/routing/test", owner(), { route: { provider: "claude", model: "gpt" } })).status, 400);
  assert.equal((await call("POST", "/routing/test", owner(), {})).status, 400);
  const cl = (await (await call("POST", "/routing/test", owner(), { route: { provider: "claude", model: "haiku" } })).json()) as { provider: string };
  assert.equal(cl.provider, "claude");
  assert.equal(spawned.length, 0, "the claude test never spends a turn");
});

test("running skills + cancel route: lists the in-flight server run; cancel → 200, unknown → 404, bad name → 400", async () => {
  const notes = new Map<string, Note>();
  const add = (n: Partial<Note> & { id: string }) => notes.set(n.id, { content: "", path: null, metadata: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags: [], ...n } as Note);
  add({ id: "sk", path: "vault/agent/skills/nightly", tags: ["agent-skill"], content: "Do it.", metadata: { skillName: "nightly", enabled: true, runner: "server" } });
  let cancelled = false;
  const deps: SkillsDeps = {
    vault: {
      listNotes: async ({ tags }) => [...notes.values()].filter((n) => !tags?.[0] || (n.tags ?? []).includes(tags[0])),
      getNote: async (id) => notes.get(id)!,
      createNote: async (p) => {
        const n = { id: `d${notes.size}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, createdAt: "", updatedAt: "", tags: p.tags ?? [] } as Note;
        notes.set(n.id, n);
        return n;
      },
      updateNote: async (id, p) => {
        const n = notes.get(id)!;
        n.metadata = { ...(n.metadata ?? {}), ...(p.metadata ?? {}) };
        return n;
      },
      addTags: async () => {},
    },
    local: { status: async () => ({ reachable: true, loaded: true }), structured: async () => ({}) },
    claude: (_req, onFinish) => ({
      id: "beef0000-2222",
      cancel: () => {
        cancelled = true;
        onFinish("beef0000-2222", { status: "cancelled", output: null, error: "cancelled by the owner", startedAt: 0, completedAt: 1000, durationSecs: 1 });
        return true;
      },
    }),
    memoryProbe: () => null,
    now: () => new Date("2026-03-10T09:30:00Z"),
    localParts: (d) => ({ hour: d.getUTCHours(), day: d.toISOString().slice(0, 10) }),
    settings: { enabled: true, defaultProvider: "claude", localBaseUrl: "", localModel: "", swapMaxPct: null, swapMinFreeMb: 512, freeMinPct: 15, loadFreeMinPct: 35, localRunTimeoutMs: 60_000 },
    log: () => {},
  };
  await runSkillsOnce(deps);
  const list = (await (await call("GET", "/skills/running", owner())).json()) as { running: Array<{ skill: string; kind: string }> };
  assert.deepEqual(list.running.map((r) => [r.skill, r.kind]), [["nightly", "claude"]]);
  assert.equal((await call("POST", "/skills/nightly/cancel", owner(), {})).status, 200);
  assert.equal(cancelled, true);
  assert.equal((await call("POST", "/skills/nightly/cancel", owner(), {})).status, 404, "nothing running any more");
  assert.equal((await call("POST", "/skills/-rf/cancel", owner(), {})).status, 400);
  await new Promise((res) => setTimeout(res, 5));
  const dn = [...notes.values()].find((n) => (n.tags ?? []).includes("agent-dispatch"));
  assert.equal(dn?.metadata?.status, "cancelled");
});

test("L4: a newly routed local model must be listed by the server's LM Studio (unknown → 400, unreachable → 409); /routing/test is rate-limited", async () => {
  assert.equal((await call("PUT", "/routing", owner(), { routing: { edit: { provider: "local", model: "not-installed" } } })).status, 400);
  lmUp = false;
  assert.equal((await call("PUT", "/routing", owner(), { routing: { edit: { provider: "local", model: "qwen-7b" } } })).status, 409);
  lmUp = true;
  assert.equal((await call("PUT", "/routing", owner(), { routing: { edit: { provider: "local", model: "qwen-7b" } } })).status, 200);
  // Re-saving an unchanged local route does not need LM Studio.
  lmUp = false;
  assert.equal((await call("PUT", "/routing", owner(), { routing: { edit: { provider: "local", model: "qwen-7b" }, chat: { provider: "claude", model: "haiku" } } })).status, 200);
  lmUp = true;
  _setRoutingTestLimitForTests(2);
  const t = { route: { provider: "claude", model: "sonnet" } };
  assert.equal((await call("POST", "/routing/test", owner(), t)).status, 200);
  assert.equal((await call("POST", "/routing/test", owner(), t)).status, 200);
  const r = await call("POST", "/routing/test", owner(), t);
  assert.equal(r.status, 429);
  assert.ok(r.headers.get("retry-after"));
});

test("L5: an oversized dispatch prompt is refused before anything runs; an oversized local reply is refused, a long text is capped", async () => {
  assert.equal((await call("POST", "/dispatch", owner(), { prompt: "x".repeat(120_001), skill: "edit", profile: "vault-ro" })).status, 400);
  assert.equal(spawned.length + lmCalls.length, 0);
  await call("PUT", "/routing", owner(), { routing: { edit: { provider: "local", model: "qwen-7b" } } });
  lmCalls = [];
  lmReply = "y".repeat(2_100_000);
  const j = (await (await call("POST", "/dispatch", owner(), { prompt: "p", skill: "edit", profile: "vault-ro" })).json()) as { id: string };
  for (let i = 0; i < 100 && getDispatch(j.id)?.status === "running"; i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(getDispatch(j.id)!.status, "error");
  assert.match(getDispatch(j.id)!.error!, /too large/);
  lmReply = "z".repeat(300_000);
  const k = (await (await call("POST", "/dispatch", owner(), { prompt: "p", skill: "edit", profile: "vault-ro" })).json()) as { id: string };
  for (let i = 0; i < 100 && getDispatch(k.id)?.status === "running"; i++) await new Promise((res) => setTimeout(res, 5));
  const len = getDispatch(k.id)!.output.length;
  assert.ok(len <= 200_000 && len > 199_000, `capped at 200k (got ${len})`);
});
