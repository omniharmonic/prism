/**
 * Omni gateway (`/api/omni/*`, src/routes/omni.ts + src/omni/*). Hermes is FAKED via
 * `setHermesFetchForTests` — nothing here reaches a real Hermes or the network; record
 * lookups, the tree feed, the executor and push are injected too.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.OMNI_ENABLED = "true";
process.env.OMNI_HERMES_URL = "http://127.0.0.1:8642";
process.env.OMNI_HERMES_KEY = "hermes-test-key-0123456789";
process.env.OMNI_SERVICE_TOKEN = "omni-service-token-0123456789";

import { config } from "../src/config";
import { omniApi, setOmniExecutorForTests } from "../src/routes/omni";
import { setHermesFetchForTests } from "../src/omni/hermes-client";
import { setOmniRecordSourcesForTests, type NoteMeta } from "../src/omni/records";
import { setOmniPusherForTests } from "../src/omni/bus";
import { turnSettled } from "../src/omni/turns";
import { eventsAfter, getTurn, getThread, auditRows, resetOmniStoreForTests } from "../src/omni/store";
import { approvalDigest, canonicalJson, type Executor } from "../src/omni/approvals";
import { INPROCESS_ACTOR, INPROCESS_CLIENT_KEY } from "../src/auth/actor";
import { issueDeviceToken } from "../src/auth/device";
import { setMembership } from "../src/db";
import { resetDb, makeSession, sessionCookie, makeCapability } from "./helpers";
import type { TreeChange } from "../src/tree";

const J = { "content-type": "application/json" };
const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
const hook = { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
let keyN = 0;
const key = () => `omni-test-key-${Date.now()}-${++keyN}`;

// ── fake Hermes ─────────────────────────────────────────────────────────────

type Frame = [string, Record<string, unknown>];
interface Fake {
  calls: Array<{ method: string; path: string; auth: string | null; body: unknown }>;
  sessions: Map<string, { id: string; title?: string; last_active?: number }>;
  /** Frames the next chat/stream answers with. `hold` = keep the stream open until released. */
  frames: Frame[];
  hold: boolean;
  release: () => void;
  status: number | null;
  throwNext: boolean;
  jobs: Array<Record<string, unknown>>;
}
let fake: Fake;

function sse(frames: Frame[], hold: boolean, onAbort: (r: () => void) => void, signal?: AbortSignal | null): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let seq = 0;
      for (const [ev, data] of frames) ctrl.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify({ ...data, seq: ++seq, run_id: "run_abc123" })}\n\n`));
      if (hold) {
        await new Promise<void>((resolve) => {
          onAbort(resolve);
          signal?.addEventListener("abort", () => resolve());
        });
        if (signal?.aborted) {
          ctrl.error(new Error("aborted"));
          return;
        }
        ctrl.enqueue(enc.encode(`event: run.completed\ndata: {"run_id":"run_abc123"}\n\n`));
      }
      ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function installHermes(): void {
  fake = { calls: [], sessions: new Map(), frames: [], hold: false, release: () => {}, status: null, throwNext: false, jobs: [{ id: "abcdef012345", name: "Brief", schedule: "0 7 * * *", enabled: true, secret_field: "x" }] };
  setHermesFetchForTests(async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init.headers).get("authorization");
    fake.calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, auth, body });
    assert.equal(init.redirect, "error", "the key must never follow a redirect");
    if (fake.throwNext) {
      fake.throwNext = false;
      throw new TypeError("fetch failed");
    }
    if (fake.status) return new Response(JSON.stringify({ error: { message: "no", code: "x" } }), { status: fake.status });
    const p = u.pathname;
    const json = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: J });
    if (p === "/api/sessions" && init.method === "POST") {
      fake.sessions.set(body.id, { id: body.id, title: body.title, last_active: Date.now() / 1000 });
      return json({ session: fake.sessions.get(body.id) }, 201);
    }
    if (p === "/api/sessions") return json({ data: [...fake.sessions.values()], has_more: false });
    let m = /^\/api\/sessions\/([^/]+)$/.exec(p);
    if (m) {
      const s = fake.sessions.get(m[1]!);
      if (!s) return json({ error: { message: "Session not found", code: "session_not_found" } }, 404);
      if (init.method === "PATCH") Object.assign(s, body);
      return json({ session: s });
    }
    m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(p);
    if (m) return json({ data: [{ id: 1, role: "user", content: "hi", timestamp: 1700000000 }, { id: 2, role: "tool", tool_name: "prism_update_note", content: "RAW TOOL OUTPUT secret" }, { id: 3, role: "assistant", content: "done", timestamp: 1700000001 }] });
    m = /^\/api\/sessions\/([^/]+)\/chat\/stream$/.exec(p);
    if (m) return sse(fake.frames, fake.hold, (r) => (fake.release = r), init.signal);
    if (/^\/v1\/runs\/[^/]+\/stop$/.test(p)) {
      fake.release();
      return json({ status: "stopping" });
    }
    if (p === "/api/jobs") return json({ jobs: fake.jobs });
    m = /^\/api\/jobs\/([a-f0-9]{12})\/(pause|resume|run)$/.exec(p);
    if (m) return json({ job: { ...fake.jobs[0], enabled: m[2] !== "pause" } });
    return json({ error: "nope" }, 404);
  });
}

const notes = new Map<string, NoteMeta>();
let treeListener: ((c: TreeChange) => void) | null = null;
let pushes: Array<[string, string]>;
let execCalls: Array<Parameters<Executor>[0]>;

beforeEach(() => {
  resetDb();
  resetOmniStoreForTests();
  installHermes();
  notes.clear();
  notes.set("n1", { id: "n1", path: "vault/tasks/call-dana", tags: ["task"], title: "Call Dana Friday", updatedAt: "2026-10-08T10:00:00Z" });
  notes.set("n2", { id: "n2", path: "vault/projects/buoy", tags: ["project"], title: null });
  setOmniRecordSourcesForTests({
    resolver: async (ref) => [...notes.values()].find((n) => (ref.id && n.id === ref.id) || (ref.path && n.path === ref.path)) ?? null,
    subscriber: async (l) => {
      treeListener = l;
      return () => {
        treeListener = null;
      };
    },
  });
  pushes = [];
  setOmniPusherForTests(async (_o, kind, id) => void pushes.push([kind, id]));
  execCalls = [];
  setOmniExecutorForTests(null);
  Object.assign(config, { actionsEmailEnabled: false, actionsCalendarEnabled: false, actionsMatrixEnabled: false });
});
after(() => {
  setHermesFetchForTests(null);
  setOmniExecutorForTests(null);
  setOmniPusherForTests(null);
});

const req = (path: string, init: RequestInit = {}, env?: Record<symbol, unknown>) => omniApi.request(path, init, env);
const post = (path: string, body: unknown, headers: Record<string, string> = owner(), env?: Record<symbol, unknown>) =>
  req(path, { method: "POST", headers, body: JSON.stringify(body) }, env);

async function newThread(frames: Frame[], hold = false): Promise<{ id: string; turnId: string }> {
  fake.frames = frames;
  fake.hold = hold;
  const r = await post("/threads", { prompt: "Create a task to call Dana Friday" });
  assert.equal(r.status, 201);
  const j = (await r.json()) as { thread: { id: string }; turnId: string };
  return { id: j.thread.id, turnId: j.turnId };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const events = (threadId: string): any[] => eventsAfter(threadId, 0).map((e) => e.payload);

// ── gates ───────────────────────────────────────────────────────────────────

test("OMNI_ENABLED off → every route (hooks too) is a 404", async () => {
  process.env.OMNI_ENABLED = "false";
  try {
    assert.equal((await req("/version", { headers: owner() })).status, 404);
    assert.equal((await post("/hooks/propose", {}, hook)).status, 404);
  } finally {
    process.env.OMNI_ENABLED = "true";
  }
});

test("only the server owner by session or device token; every other actor kind is refused", async () => {
  assert.equal((await req("/version")).status, 401, "anonymous");
  const ok = await req("/version", { headers: owner() });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { api: 1, minClient: "1.0" });
  const dev = issueDeviceToken(config.ownerEmail, "Omni (iPhone)", "omni-native").token;
  assert.equal((await req("/version", { headers: { authorization: `Bearer ${dev}` } })).status, 200, "owner device token");
  setMembership("primary", "member@example.test", "admin", null);
  assert.equal((await req("/version", { headers: { cookie: sessionCookie(makeSession("member@example.test")) } })).status, 403, "another account, even an admin");
  const otherDev = issueDeviceToken("member@example.test", "x", "omni-native").token;
  assert.equal((await req("/version", { headers: { authorization: `Bearer ${otherDev}` } })).status, 403, "another account's device");
  assert.equal((await req("/version", { headers: { authorization: `Capability ${makeCapability("note", "n1", "edit")}` } })).status, 403, "capability link");
  assert.equal((await req("/version", { headers: { authorization: `Bearer ${config.collabToken}` } })).status, 403, "loopback owner token");
  const mcp = { [INPROCESS_ACTOR]: { kind: "user", email: config.ownerEmail, role: "owner", vaultId: "primary", grants: [] }, [INPROCESS_CLIENT_KEY]: "mcp:pat:t1" };
  assert.equal((await req("/version", {}, mcp)).status, 403, "in-process MCP dispatch");
  assert.equal((await req("/version", { headers: { ...owner(), authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` } })).status, 200, "service token is no app credential (session decides)");
  assert.equal((await req("/version", { headers: { authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` } })).status, 401, "service token alone is anon to app routes");
});

test("mutations need JSON + same origin (live-actions CSRF guard); device tokens skip the origin check", async () => {
  const r1 = await req("/threads", { method: "POST", headers: { cookie: owner().cookie, "content-type": "text/plain" }, body: "{}" });
  assert.equal(r1.status, 415);
  const r2 = await post("/threads", { prompt: "x" }, { ...owner(), "sec-fetch-site": "cross-site" });
  assert.equal(r2.status, 403);
  const r3 = await post("/threads", { prompt: "x" }, { ...owner(), origin: "https://evil.example" });
  assert.equal(r3.status, 403);
  assert.equal(fake.calls.length, 0, "nothing reached Hermes");
});

// ── threads + streaming + cards ─────────────────────────────────────────────

const happy: Frame[] = [
  ["run.started", {}],
  ["message.started", {}],
  ["assistant.delta", { delta: "Creat" }],
  ["assistant.delta", { delta: "ing…" }],
  ["tool.started", { tool_name: "mcp__prism__prism_update_note", args: { id: "n1", if_updated_at: "x", metadata: { status: "pending", due: "2026-10-10" }, api_key: "sk-supersecretvalue1234567890" } }],
  ["tool.completed", { tool_name: "mcp__prism__prism_update_note", preview: "ok" }],
  ["tool.started", { tool_name: "mcp__prism__prism_delete_note", args: { id: "n2" } }],
  ["tool.failed", { tool_name: "mcp__prism__prism_delete_note", preview: "forbidden" }],
  ["assistant.completed", { content: "Done — I set the due date." }],
  ["run.completed", { usage: {} }],
  ["done", {}],
];

test("create a thread: Hermes session + streamed turn → normalized, persisted events + a record card", async () => {
  const { id, turnId } = await newThread(happy);
  assert.match(id, /^omni_[a-f0-9]{24}$/);
  await turnSettled(turnId);
  const create = fake.calls.find((c) => c.path === "/api/sessions" && c.method === "POST")!;
  assert.equal(create.auth, `Bearer ${process.env.OMNI_HERMES_KEY}`);
  const chat = fake.calls.find((c) => c.path.endsWith("/chat/stream"))!;
  assert.deepEqual(chat.body, { message: "Create a task to call Dana Friday" });
  const ev = events(id);
  assert.deepEqual(ev.map((e) => e.t), ["status", "init", "tool_use", "tool_result", "card", "tool_use", "tool_result", "text", "result", "status"]);
  assert.ok(!ev.some((e) => e.t === "text_delta"), "deltas are never persisted");
  const tool = ev[2]! as { input: Record<string, unknown> };
  assert.equal(tool.input.api_key, "[redacted]");
  const card = (ev[4]! as { card: Record<string, unknown> }).card;
  assert.equal(card.noteId, "n1");
  assert.equal(card.op, "updated");
  assert.equal(card.type, "task");
  assert.equal(card.title, "Call Dana Friday");
  assert.deepEqual(card.changedKeys, ["status", "due"]);
  assert.deepEqual(card.writer, { kind: "agent", label: "Omni" });
  assert.deepEqual(card.links, { prism: `${config.appOrigin}/page/n1`, prismApp: "prism://page/n1", omni: "omni://record/n1" });
  assert.equal((ev[6] as { ok: boolean }).ok, false, "failed delete reported");
  assert.equal(ev.filter((e) => e.t === "card").length, 1, "a FAILED write yields no card");
  assert.deepEqual(ev[7], { t: "text", blockId: `${turnId}:b0`, text: "Done — I set the due date." });
  assert.equal((ev[8] as { ok: boolean }).ok, true);
  assert.equal(getTurn(turnId)!.status, "done");
  assert.equal(getTurn(turnId)!.runId, "run_abc123");
  assert.equal(getThread(id)!.state, "done");
  assert.deepEqual(pushes, [["OMNI_THREAD", id]], "nobody watched → one ids-only push");

  // Replay over SSE after reconnect: persisted events with ids, then the stream closes.
  const s = await req(`/threads/${id}/stream?after=2`, { headers: owner() });
  assert.equal(s.status, 200);
  const text = await s.text();
  assert.ok(!text.includes("id: 1\n") && !text.includes("id: 2\n"));
  assert.match(text, /event: tool_use\ndata: \{"seq":3,.*\nid: 3\n/);
  assert.match(text, /event: card\ndata: \{"seq":5/);
  assert.match(text, /event: status\ndata: .*"state":"done"/);

  // Thread detail: Hermes messages (tool rows keep the NAME only), cards, approvals.
  const d = await req(`/threads/${id}`, { headers: owner() });
  const dj = (await d.json()) as { thread: { state: string; running: boolean }; messages: Array<Record<string, unknown>>; cards: unknown[] };
  assert.equal(dj.thread.state, "done");
  assert.equal(dj.thread.running, false);
  assert.equal(dj.cards.length, 1);
  assert.deepEqual(dj.messages[1], { id: 2, role: "tool", toolName: "prism_update_note", at: null });
  assert.ok(!JSON.stringify(dj).includes("RAW TOOL OUTPUT"));
  // List merges Hermes sessions with local metadata.
  const l = (await (await req("/threads?state=done", { headers: owner() })).json()) as { threads: Array<{ id: string }>; hermes: string };
  assert.equal(l.hermes, "ok");
  assert.deepEqual(l.threads.map((t) => t.id), [id]);
});

test("a create by path resolves through the tree; a create without one is matched from the tree feed", async () => {
  notes.set("n3", { id: "n3", path: "vault/tasks/buy-milk", tags: ["task"], title: "Buy milk" });
  const { id, turnId } = await newThread([
    ["run.started", {}],
    ["tool.started", { tool_name: "mcp__prism__prism_create_note", args: { path: "vault/tasks/buy-milk", tags: ["task"], content: "x" } }],
    ["tool.completed", { tool_name: "mcp__prism__prism_create_note" }],
    ["tool.started", { tool_name: "mcp__parachute_vault__create_note", args: { tags: ["idea"], metadata: { title: "Kelp farm" }, content: "y" } }],
    ["tool.completed", { tool_name: "mcp__parachute_vault__create_note" }],
    ["run.completed", {}],
  ]);
  await turnSettled(turnId);
  let cards = events(id).filter((e) => e.t === "card").map((e) => (e as { card: Record<string, unknown> }).card);
  assert.deepEqual(cards.map((c) => [c.noteId, c.op]), [["n3", "created"]]);
  assert.ok(treeListener, "an unresolved create watches the tree");
  // An unrelated row (other tags) is NOT attributed; the matching new row is.
  const row = (o: Partial<{ id: string; path: string; tags: string[]; title: string }>) => ({ id: "x", path: null, tags: [], updatedAt: null, creator: null, visibility: "workspace" as const, ...o });
  treeListener!({ kind: "upsert", row: row({ id: "zz", path: "vault/inbox/kelp", tags: ["email"], title: "Kelp farm" }), prev: undefined });
  treeListener!({ kind: "upsert", row: row({ id: "n9", path: "vault/ideas/kelp-farm", tags: ["idea"], title: "Kelp farm" }), prev: undefined });
  cards = events(id).filter((e) => e.t === "card").map((e) => (e as { card: Record<string, unknown> }).card);
  assert.deepEqual(cards.map((c) => [c.noteId, c.op, (c.writer as { kind: string }).kind]), [["n3", "created", "agent"], ["n9", "created", "external"]]);
});

test("Hermes failures map to codes: refused key, unreachable, not configured", async () => {
  fake.status = 401;
  const r = await post("/threads", { prompt: "x" });
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: "hermes_auth" });
  fake.status = null;
  fake.throwNext = true;
  const r2 = await post("/threads", { prompt: "x" });
  assert.equal(r2.status, 502);
  assert.deepEqual(await r2.json(), { error: "hermes_unavailable" });
  const saved = process.env.OMNI_HERMES_KEY;
  delete process.env.OMNI_HERMES_KEY;
  try {
    const r3 = await post("/threads", { prompt: "x" });
    assert.equal(r3.status, 503);
    assert.deepEqual(await r3.json(), { error: "hermes_not_configured" });
  } finally {
    process.env.OMNI_HERMES_KEY = saved;
  }
  // A stream that fails mid-way ends the turn with a code, never Hermes' message.
  const { id, turnId } = await newThread([["run.started", {}], ["error", { message: "OAuth token revoked for sk-abc", code: "auth_failed" }]]);
  await turnSettled(turnId);
  const res = events(id).find((e) => e.t === "result") as Record<string, unknown>;
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, "auth");
  assert.ok(!JSON.stringify(events(id)).includes("OAuth token revoked"));
  assert.equal(getTurn(turnId)!.status, "error");
  assert.equal(getThread(id)!.state, "needs-you");
});

test("one turn at a time; idempotent replay; cancel stops the Hermes run", async () => {
  const { id, turnId } = await newThread([["run.started", {}], ["assistant.delta", { delta: "thinking" }]], true);
  await new Promise((r) => setTimeout(r, 20));
  const busy = await post(`/threads/${id}/turns`, { text: "and another" }, { ...owner(), "idempotency-key": key() });
  assert.equal(busy.status, 409);
  assert.equal(((await busy.json()) as { turnId: string }).turnId, turnId);
  const c = await post(`/turns/${turnId}/cancel`, {});
  assert.equal(c.status, 202);
  await turnSettled(turnId);
  assert.ok(fake.calls.some((x) => x.path === "/v1/runs/run_abc123/stop"));
  assert.equal(getTurn(turnId)!.status, "cancelled");
  assert.equal((events(id).find((e) => e.t === "result") as { errorCode: string }).errorCode, "cancelled");
  assert.equal(getThread(id)!.state, "waiting");
  // Idempotency: the same key replays the first turn instead of starting a second.
  fake.frames = [["run.started", {}], ["run.completed", {}]];
  fake.hold = false;
  const k = key();
  const t1 = await post(`/threads/${id}/turns`, { text: "next" }, { ...owner(), "idempotency-key": k });
  assert.equal(t1.status, 202);
  const tid = ((await t1.json()) as { turnId: string }).turnId;
  await turnSettled(tid);
  const t2 = await post(`/threads/${id}/turns`, { text: "next" }, { ...owner(), "idempotency-key": k });
  assert.equal(t2.headers.get("Idempotent-Replayed"), "true");
  assert.equal(((await t2.json()) as { turnId: string }).turnId, tid);
  assert.equal(fake.calls.filter((x) => x.path.endsWith("/chat/stream")).length, 2);
});

// ── approvals ───────────────────────────────────────────────────────────────

const draft = { to: ["kevin@example.test"], subject: "Buoy spec", body: "Hi Kevin,\n\nAttached.\n\nBenjamin" };
async function propose(kind = "email", payload: Record<string, unknown> = draft, threadId?: string, extra: Record<string, unknown> = {}): Promise<{ id: string; digest: string }> {
  const r = await post("/hooks/propose", { kind, payload, threadId, summary: "Email Kevin", ...extra }, hook);
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()) as { id: string; digest: string };
}
const decide = (id: string, body: Record<string, unknown>, headers: Record<string, string> = { ...owner(), "idempotency-key": key() }, env?: Record<symbol, unknown>) =>
  post(`/approvals/${id}/decision`, body, headers, env);

test("hooks: loopback + service token only; propose stores the full draft, digest-bound, and pushes", async () => {
  assert.equal((await post("/hooks/propose", { kind: "email", payload: draft }, { ...J, authorization: "Bearer wrong-token-wrong-token" })).status, 403);
  assert.equal((await post("/hooks/propose", { kind: "email", payload: draft }, { ...hook, "x-forwarded-for": "203.0.113.9" })).status, 403, "not over the tunnel");
  assert.equal((await post("/hooks/propose", { kind: "email", payload: draft }, owner())).status, 403, "an owner session is not the service");
  assert.equal((await post("/hooks/propose", { kind: "send-money", payload: {} }, hook)).status, 400);
  const p = await propose();
  assert.equal(p.digest, approvalDigest("email", draft));
  assert.deepEqual(pushes, [["OMNI_APPROVAL", p.id]]);
  const g = (await (await req(`/approvals/${p.id}`, { headers: owner() })).json()) as { approval: Record<string, unknown> };
  assert.deepEqual(g.approval.payload, draft, "full payload, never truncated");
  assert.equal(g.approval.status, "pending");
  assert.deepEqual(g.approval.executor, { name: "prism-live-actions:email", available: true, enabled: false });
  // Key order does not change the digest.
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
});

test("decide: wrong digest, agent origin, missing key and a disabled executor are all refused; nothing sends", async () => {
  setOmniExecutorForTests(async (o) => {
    execCalls.push(o);
    return { status: "sent", detail: { messageId: "<m@x>" } };
  });
  const p = await propose();
  assert.equal((await decide(p.id, { decision: "send", digest: "0".repeat(64) })).status, 409, "wrong digest");
  const down = await decide(p.id, { decision: "send", digest: p.digest }, { ...owner(), "idempotency-key": key(), "x-prism-action-origin": "agent" });
  assert.equal(down.status, 403);
  assert.equal(((await down.json()) as { error: string }).error, "human_origin_required");
  const mcp = { [INPROCESS_ACTOR]: { kind: "user", email: config.ownerEmail, role: "owner", vaultId: "primary", grants: [] }, [INPROCESS_CLIENT_KEY]: "mcp:pat:t1" };
  assert.equal((await decide(p.id, { decision: "send", digest: p.digest }, { ...J, "idempotency-key": key() }, mcp)).status, 403, "MCP never decides");
  assert.equal((await decide(p.id, { decision: "send", digest: p.digest }, owner())).status, 400, "Idempotency-Key required");
  const dis = await decide(p.id, { decision: "send", payloadHash: p.digest });
  assert.equal(dis.status, 503);
  assert.equal(((await dis.json()) as { error: string }).error, "executor_disabled");
  assert.equal(execCalls.length, 0);
  const still = (await (await req(`/approvals/${p.id}`, { headers: owner() })).json()) as { approval: { status: string } };
  assert.equal(still.approval.status, "pending", "a disabled executor leaves it pending");
  const t = await propose("tweet", { text: "hello" });
  const un = await decide(t.id, { decision: "send", digest: t.digest });
  assert.equal(((await un.json()) as { error: string }).error, "executor_unavailable");
  const audit = auditRows().map((r) => [r.action, r.status, r.error]);
  assert.ok(audit.some((a) => a[2] === "digest_mismatch") && audit.some((a) => a[2] === "human_origin_required") && audit.some((a) => a[2] === "executor_disabled"));
  assert.ok(!JSON.stringify(auditRows()).includes("kevin@"), "audit: ids + digests only");
});

test("decide send: executes ONCE through the executor; replay with the same key; another key → already decided", async () => {
  Object.assign(config, { actionsEmailEnabled: true });
  setOmniExecutorForTests(async (o) => {
    execCalls.push(o);
    return { status: "sent", detail: { executor: "prism-live-actions:email", httpStatus: 200 } };
  });
  const { id: threadId, turnId } = await newThread([["run.started", {}], ["run.completed", {}]]);
  await turnSettled(turnId);
  const p = await propose("email", draft, threadId);
  const k = key();
  const r = await decide(p.id, { decision: "send", digest: p.digest }, { ...owner(), "idempotency-key": k });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { approval: { status: string } }).approval.status, "sent");
  assert.equal(execCalls.length, 1);
  assert.deepEqual(execCalls[0]!.payload, draft);
  assert.ok(execCalls[0]!.headers.cookie, "the decider's own credential is what the executor presents");
  const again = await decide(p.id, { decision: "send", digest: p.digest }, { ...owner(), "idempotency-key": k });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("Idempotent-Replayed"), "true");
  const other = await decide(p.id, { decision: "send", digest: p.digest });
  assert.equal(other.status, 409);
  assert.equal(execCalls.length, 1, "never twice");
  assert.ok(events(threadId).some((e) => e.t === "approval" && (e as { approval: { status: string } }).approval.status === "sent"));
});

test("approvals expire; edit makes a new digest and retires the old one; cancel and revise", async () => {
  const p = await propose("email", draft, undefined, { expiresInSec: 60 });
  const db = (await import("../src/db")).db;
  db.prepare("UPDATE omni_approvals SET expires_at = ? WHERE id = ?").run(Date.now() - 1, p.id);
  const ex = await decide(p.id, { decision: "send", digest: p.digest });
  assert.equal(ex.status, 410);
  const p2 = await propose();
  const edited = { ...draft, body: "Hi Kevin,\n\nSpec attached, v2.\n\nBenjamin" };
  const e = await req(`/approvals/${p2.id}`, { method: "PUT", headers: owner(), body: JSON.stringify({ digest: p2.digest, payload: edited }) });
  assert.equal(e.status, 201);
  const ej = (await e.json()) as { approval: { id: string; digest: string; revises: string } };
  assert.notEqual(ej.approval.digest, p2.digest);
  assert.equal(ej.approval.revises, p2.id);
  assert.equal((await decide(p2.id, { decision: "send", digest: p2.digest })).status, 409, "the old draft is gone");
  assert.equal((await decide(ej.approval.id, { decision: "send", digest: p2.digest })).status, 409, "the old digest does not approve the edit");
  const c = await decide(ej.approval.id, { decision: "cancel", digest: ej.approval.digest });
  assert.equal(c.status, 200);
  assert.equal(((await c.json()) as { approval: { status: string } }).approval.status, "cancelled");
  const pend = (await (await req("/approvals?status=pending", { headers: owner() })).json()) as { approvals: unknown[] };
  assert.equal(pend.approvals.length, 0);
});

// ── hooks/turn, jobs, today ─────────────────────────────────────────────────

test("agent-initiated turn: unread + an ids-only push + a notice on /events", async () => {
  fake.sessions.set("api_1700_abcd1234", { id: "api_1700_abcd1234", title: "Heartbeat" });
  const r = await post("/hooks/turn", { sessionId: "api_1700_abcd1234" }, hook);
  assert.equal(r.status, 202);
  assert.equal(getThread("api_1700_abcd1234")!.unread, 1);
  assert.deepEqual(pushes, [["OMNI_THREAD", "api_1700_abcd1234"]]);
  const l = (await (await req("/threads", { headers: owner() })).json()) as { threads: Array<{ id: string; unread: number; title: string }> };
  assert.deepEqual(l.threads.map((t) => [t.id, t.unread, t.title]), [["api_1700_abcd1234", 1, "Heartbeat"]]);
});

test("jobs: list (allowlisted fields) and pause through Hermes; bad ids never reach it", async () => {
  const l = (await (await req("/jobs", { headers: owner() })).json()) as { jobs: Array<Record<string, unknown>> };
  assert.deepEqual(l.jobs, [{ id: "abcdef012345", name: "Brief", schedule: "0 7 * * *", enabled: true }]);
  const p = await post("/jobs/abcdef012345/pause", {});
  assert.equal(p.status, 200);
  assert.equal(((await p.json()) as { job: { enabled: boolean } }).job.enabled, false);
  const before = fake.calls.length;
  assert.equal((await post("/jobs/../../x/pause", {})).status, 404);
  assert.equal((await post("/jobs/abcdef012345/delete", {})).status, 404);
  assert.equal(fake.calls.length, before);
});

test("today degrades per section: approvals + in-flight still answer when the query routes are unreachable", async () => {
  const p = await propose();
  const r = await req("/today?date=2026-10-08", { headers: owner() });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { date: string; agenda: unknown; tasks: unknown; needsYou: { approvals: Array<{ id: string }> }; errors: Record<string, string> };
  assert.equal(j.date, "2026-10-08");
  assert.equal(j.agenda, null);
  assert.ok(j.errors.agenda && j.errors.tasks);
  assert.deepEqual(j.needsYou.approvals.map((a) => a.id), [p.id]);
  assert.equal((await req("/today?date=tomorrow", { headers: owner() })).status, 400);
});
