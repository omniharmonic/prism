/**
 * Walk the Omni gateway end to end against the laptop DEV gateway + the stub Hermes
 * (docs/omni-module.md "Developing against a stub Hermes"). Run it through
 * `scripts/omni-dev.sh walkthrough` while `scripts/omni-dev.sh` is up.
 *
 * It signs in the way a device does: an owner SESSION row is minted in the dev database
 * (the existing dev tooling, as `scripts/mk-owner-session.ts` — there is no bypass in
 * the server), that session approves the real PKCE flow for `client_id=omni-native` /
 * `redirect_uri=omni://auth/callback`, and everything after uses the `pd_…` device
 * token, as the app will. At the end the device token is revoked and the session row
 * deleted.
 *
 * `OMNI_WALK_DRIVER=fake` (set by `omni-dev.sh` when it runs against a REAL dev Hermes on the
 * fake model — `OMNI_DEV_HERMES_HOME`) swaps the stub's markers for the fake model's, skips
 * the two failures only a stub can stage (a dropped / truncated stream), and adds what only
 * a real Hermes shows: the omni-bridge plugin's own tool call, its tool policy, a failed tool.
 * `OMNI_WALK_HERMES_CLI=<command>` (the dev Hermes' CLI) also runs a turn on the thread from
 * another surface, for the plugin's post-turn notice.
 *
 * Prints one PASS/FAIL line per step. It never prints a token, a key or a cookie.
 * It talks to a loopback URL only and refuses anything else.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "../src/config";
import { createSession, db } from "../src/db";

const BASE = (process.env.OMNI_DEV_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8797}`).replace(/\/+$/, "");
{
  const u = new URL(BASE);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") {
    console.error("walk-through: OMNI_DEV_URL must be http://127.0.0.1:<port> — this script is for the laptop dev gateway only");
    process.exit(2);
  }
}

/** Which Hermes is behind the gateway: the stub, or a real one on the fake model. */
const REAL = process.env.OMNI_WALK_DRIVER === "fake";
const M = REAL
  ? { slow: "fake:slow take your time", approval: "fake:propose draft an email to Dana", authError: "fake:error:401", says: "fake model" }
  : { slow: "stub:slow take your time", approval: "stub:approval draft an email to Dana", authError: "stub:error:auth_failed", says: "stub Hermes" };
/** A real Hermes builds an agent per turn: give its turns time. */
const TURN_MS = REAL ? 240_000 : 60_000;

// ── reporting ───────────────────────────────────────────────────────────────

let failed = 0;
let n = 0;
class StepFailed extends Error {}
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new StepFailed(what);
}
async function step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  n++;
  const label = `${String(n).padStart(2, "0")} ${name}`;
  try {
    const note = await fn();
    console.log(`PASS  ${label}${note ? ` — ${note}` : ""}`);
    return true;
  } catch (e) {
    failed++;
    // Our own check text, or an error NAME — never a response body or a header.
    console.log(`FAIL  ${label} — ${e instanceof StepFailed ? e.message : `${(e as Error).name}: ${String((e as Error).message).slice(0, 160)}`}`);
    return false;
  }
}

// ── http ────────────────────────────────────────────────────────────────────

let token = "";
const J = { "content-type": "application/json" };
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });
let keyN = 0;
const idem = (): string => `walk-${Date.now()}-${++keyN}-${randomBytes(4).toString("hex")}`;

interface Answer {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const r = await fetch(BASE + path, { method, headers: { ...auth(), ...(body !== undefined ? J : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: r.status, headers: r.headers, body: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {} };
}

interface Ev {
  t: string;
  seq?: number;
  id?: string;
  [k: string]: unknown;
}
/**
 * Read a thread's SSE stream until the server closes it (the turn ended) — or until
 * `stopWhen` says so, in which case the connection is dropped by us.
 */
async function readStream(threadId: string, after: number, o: { stopWhen?: (ev: Ev, all: Ev[]) => boolean; onEvent?: (ev: Ev, all: Ev[]) => void; timeoutMs?: number } = {}): Promise<{ events: Ev[]; closedByServer: boolean }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? TURN_MS);
  const events: Ev[] = [];
  try {
    const r = await fetch(`${BASE}/api/omni/threads/${threadId}/stream?after=${after}`, { headers: { ...auth(), accept: "text/event-stream" }, signal: ac.signal });
    check(r.status === 200 && r.body, `stream answered ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ev: { event?: string; data: string[]; id?: string } = { data: [] };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return { events, closedByServer: true };
      buf += dec.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (ev.data.length) {
            const data = JSON.parse(ev.data.join("\n")) as Record<string, unknown>;
            const one: Ev = { ...data, t: ev.event ?? String(data.t), id: ev.id };
            events.push(one);
            o.onEvent?.(one, events);
            if (o.stopWhen?.(one, events)) {
              await reader.cancel().catch(() => {});
              return { events, closedByServer: false };
            }
          }
          ev = { data: [] };
        } else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
        else if (line.startsWith("data:")) ev.data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
const kinds = (evs: Ev[]): string => {
  const out: string[] = [];
  for (const e of evs) {
    const last = out[out.length - 1];
    if (e.t === "text_delta" && last?.startsWith("text_delta")) out[out.length - 1] = `text_delta×${Number(last.split("×")[1] ?? 1) + 1}`;
    else out.push(e.t);
  }
  return out.join(" ");
};
const lastSeq = (evs: Ev[]): number => evs.reduce((m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m), 0);
const find = (evs: Ev[], t: string): Ev | undefined => evs.find((e) => e.t === t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The digest the app recomputes: SHA-256 of canonical JSON (keys sorted at every depth). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}
const digestOf = (kind: unknown, payload: unknown): string => createHash("sha256").update(canonical({ kind, payload }), "utf8").digest("hex");

// ── the walk ────────────────────────────────────────────────────────────────

let sessionId = "";
let threadId = "";
let firstTurn = "";
let approval: Record<string, unknown> | null = null;

async function main(): Promise<void> {
  console.log(`Omni walk-through against ${BASE} (dev gateway + ${REAL ? "a REAL dev Hermes on the fake model" : "stub Hermes"})`);

  const signedIn = await step("sign in: owner session → PKCE (omni-native, omni://auth/callback) → device token", async () => {
    // The dev owner's browser session, minted the way scripts/mk-owner-session.ts does.
    sessionId = randomUUID();
    createSession(sessionId, config.ownerEmail, 10 * 60_000);
    const cookie = `prism_session=${sessionId}`;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(8).toString("hex");
    const q = new URLSearchParams({ client_id: "omni-native", redirect_uri: "omni://auth/callback", code_challenge: challenge, code_challenge_method: "S256", state, label: "Omni walk-through (laptop)" });
    const a = await fetch(`${BASE}/auth/device/authorize?${q}`, { headers: { cookie }, redirect: "manual" });
    check(a.status === 200, `authorize answered ${a.status} (is OMNI_ENABLED=true on this server, and does it include the omni-native client?)`);
    const html = await a.text();
    const req = /name="req" value="([^"]+)"/.exec(html)?.[1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    const reqCookie = /prism_device_req=([^;]+)/.exec(a.headers.get("set-cookie") ?? "")?.[1];
    check(req && csrf && reqCookie, "the consent page carried no form");
    const ap = await fetch(`${BASE}/auth/device/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${cookie}; prism_device_req=${reqCookie}` }, body: new URLSearchParams({ req, csrf, decision: "approve" }).toString(), redirect: "manual" });
    check(ap.status === 302, `approve answered ${ap.status}`);
    const loc = new URL(ap.headers.get("location") ?? "x:");
    check(`${loc.protocol}//${loc.host}${loc.pathname}` === "omni://auth/callback", "the code was not sent to omni://auth/callback");
    check(loc.searchParams.get("state") === state, "state was not echoed");
    const t = await fetch(`${BASE}/auth/device/token`, { method: "POST", headers: J, body: JSON.stringify({ grant_type: "authorization_code", client_id: "omni-native", redirect_uri: "omni://auth/callback", code: loc.searchParams.get("code"), code_verifier: verifier }) });
    check(t.status === 200, `token answered ${t.status}`);
    const tj = (await t.json()) as { access_token?: string; token_type?: string };
    check(typeof tj.access_token === "string" && tj.access_token.startsWith("pd_"), "no device token came back");
    token = tj.access_token;
    const me = await call("GET", "/auth/me");
    check(me.status === 200 && String(me.body.email).toLowerCase() === config.ownerEmail.toLowerCase(), "the device token is not the owner");
    return "signed in as the dev owner with a pd_ device token (not shown)";
  });
  if (!signedIn) return;

  await step("anonymous is refused", async () => {
    const r = await fetch(`${BASE}/api/omni/version`);
    check(r.status === 401, `expected 401, got ${r.status}`);
    const h = await fetch(`${BASE}/api/omni/hooks/propose`, { method: "POST", headers: { ...J, ...auth() }, body: "{}" });
    check(h.status === 403, `a device token on a hook route: expected 403, got ${h.status}`);
    return "401 without a credential; 403 for a device token on /hooks/*";
  });

  await step("version", async () => {
    const r = await call("GET", "/api/omni/version");
    check(r.status === 200 && r.body.api === 1 && typeof r.body.minClient === "string", `got ${r.status}`);
    return `api ${r.body.api}, minClient ${r.body.minClient}`;
  });

  const created = await step("create thread (starts the first turn)", async () => {
    const r = await call("POST", "/api/omni/threads", { prompt: "Hello from the walk-through", title: "Walk-through", source: "text" });
    check(r.status === 201, `got ${r.status} ${String(r.body.error ?? "")}`);
    const th = r.body.thread as Record<string, unknown>;
    threadId = String(th.id);
    firstTurn = String(r.body.turnId);
    check(/^omni_[a-f0-9]{24}$/.test(threadId) && firstTurn, "no thread id / turn id");
    return `thread omni_… created, state ${th.state}`;
  });
  if (!created) return;

  let seq = 0;
  await step("read the first turn's SSE stream to completion", async () => {
    const { events, closedByServer } = await readStream(threadId, 0);
    seq = lastSeq(events);
    check(closedByServer, "the stream did not close after the turn");
    check(find(events, "init"), "no init");
    check(events.some((e) => e.t === "text_delta"), "no live text_delta");
    const text = events.filter((e) => e.t === "text").pop();
    check(text && String(text.text).includes(M.says), `the final text is not the ${M.says}'s — is the gateway pointed at the right Hermes?`);
    const res = find(events, "result");
    check(res && res.ok === true, `result was ${JSON.stringify(res?.errorCode ?? res?.ok)}`);
    const st = events.filter((e) => e.t === "status").pop();
    check(st?.state === "done", `final state ${String(st?.state)}`);
    return kinds(events);
  });

  let turn2 = "";
  const k2 = idem();
  await step("send a turn", async () => {
    const r = await call("POST", `/api/omni/threads/${threadId}/turns`, { text: "And a second message" }, { "idempotency-key": k2 });
    check(r.status === 202 && r.body.status === "running", `got ${r.status} ${String(r.body.error ?? "")}`);
    turn2 = String(r.body.turnId);
    return "202 running";
  });

  await step("read that turn's stream to completion (from the last seq)", async () => {
    const { events, closedByServer } = await readStream(threadId, seq);
    check(closedByServer, "the stream did not close");
    check(events.every((e) => e.seq === undefined || e.seq > seq), "events at or before `after` were replayed");
    const res = find(events, "result");
    check(res?.ok === true, "the turn did not succeed");
    seq = lastSeq(events);
    return kinds(events);
  });

  await step("same Idempotency-Key again → the same turn, replayed", async () => {
    const r = await call("POST", `/api/omni/threads/${threadId}/turns`, { text: "And a second message" }, { "idempotency-key": k2 });
    check(r.status === 200 && r.body.turnId === turn2 && r.headers.get("idempotent-replayed") === "true", `got ${r.status}, replayed=${r.headers.get("idempotent-replayed")}`);
    return "200 + Idempotent-Replayed: true, no new turn";
  });

  await step("reconnect: ?after=<seq> replays only what was missed, then closes", async () => {
    const all = await readStream(threadId, 0);
    const tail = await readStream(threadId, seq - 2);
    check(all.closedByServer && tail.closedByServer, "a replay did not close");
    check(tail.events.length === 2 && tail.events.every((e) => (e.seq ?? 0) > seq - 2), `expected the last 2 events, got ${tail.events.length}`);
    check(!all.events.some((e) => e.t === "text_delta"), "deltas were replayed (they are live-only)");
    check(all.events.length === seq && all.events.every((e, i) => e.seq === i + 1), `a replay from 0 returned ${all.events.length} of ${seq} stored events`);
    return `after=0 → all ${all.events.length} stored events of both turns; after=${seq - 2} → ${tail.events.length}`;
  });

  await step("cancel a slow turn", async () => {
    const r = await call("POST", `/api/omni/threads/${threadId}/turns`, { text: M.slow }, { "idempotency-key": idem() });
    check(r.status === 202, `turn got ${r.status}`);
    const slow = String(r.body.turnId);
    let cancelled: Answer | null = null;
    let busy: Answer | null = null;
    const { events, closedByServer } = await readStream(threadId, seq, {
      onEvent: (ev, allEvents) => {
        if (ev.t === "text_delta" && allEvents.filter((e) => e.t === "text_delta").length === 2 && !cancelled) {
          void (async () => {
            busy = await call("POST", `/api/omni/threads/${threadId}/turns`, { text: "too soon" }, { "idempotency-key": idem() });
            cancelled = await call("POST", `/api/omni/turns/${slow}/cancel`, {});
          })();
        }
      },
      timeoutMs: REAL ? TURN_MS : 30_000,
    });
    check(closedByServer, "the stream did not close after the cancel");
    check((busy as Answer | null)?.status === 409 && (busy as Answer | null)?.body.turnId === slow, "a second turn while one runs was not a 409 naming the running turn");
    check((cancelled as Answer | null)?.status === 202 && (cancelled as Answer | null)?.body.status === "cancelling", `cancel answered ${(cancelled as Answer | null)?.status}`);
    const res = find(events, "result");
    check(res?.ok === false && res.errorCode === "cancelled", `result errorCode ${String(res?.errorCode)}`);
    check(events.filter((e) => e.t === "status").pop()?.state === "waiting", "the thread is not `waiting` after a cancel");
    seq = lastSeq(events);
    const again = await call("POST", `/api/omni/turns/${slow}/cancel`, {});
    check(again.status === 200 && again.body.status === "cancelled", "cancelling an ended turn was not a 200");
    return `409 while running; cancel 202; ${kinds(events)}`;
  });

  await step(REAL ? "a turn that proposes an approval (the REAL omni-bridge plugin, asked by the fake model)" : "a turn that proposes an approval (stub plays the omni-bridge plugin)", async () => {
    const r = await call("POST", `/api/omni/threads/${threadId}/turns`, { text: M.approval }, { "idempotency-key": idem() });
    check(r.status === 202, `turn got ${r.status}`);
    const { events, closedByServer } = await readStream(threadId, seq);
    check(closedByServer, "the stream did not close");
    const use = find(events, "tool_use");
    check(use?.name === "omni_propose", `tool_use name ${String(use?.name)}`);
    const ap = find(events, "approval");
    check(ap, "no approval event on the thread stream (did the stub reach the gateway's /hooks/propose?)");
    approval = ap.approval as Record<string, unknown>;
    check(approval.status === "pending" && approval.kind === "email" && approval.threadId === threadId, "the approval is not a pending email on this thread");
    check(find(events, "result")?.ok === true, "the turn failed");
    check(events.filter((e) => e.t === "status").pop()?.state === "needs-you", "the thread is not `needs-you`");
    seq = lastSeq(events);
    return kinds(events);
  });
  if (!approval) return;
  const ap = approval as Record<string, unknown>;
  const apId = String(ap.id);

  await step("list approvals", async () => {
    const r = await call("GET", "/api/omni/approvals?status=pending");
    const list = (r.body.approvals ?? []) as Array<Record<string, unknown>>;
    const mine = list.find((a) => a.id === apId);
    check(r.status === 200 && mine, "the proposed approval is not in the pending list");
    check(mine.digest === digestOf(mine.kind, mine.payload), "the digest is not SHA-256 of the canonical {kind, payload}");
    const ex = mine.executor as Record<string, unknown>;
    check(ex.name === "proton-send" && ex.available === true && ex.enabled === false, `executor ${JSON.stringify(ex)}`);
    return `${list.length} pending; digest recomputed locally matches; executor proton-send enabled=false`;
  });

  const sendKey = idem();
  await step("decide: send → the executor is off, nothing is sent", async () => {
    const stale = await call("POST", `/api/omni/approvals/${apId}/decision`, { decision: "send", digest: "0".repeat(64) }, { "idempotency-key": idem() });
    check(stale.status === 409 && stale.body.error === "digest_mismatch", `a wrong digest: expected 409 digest_mismatch, got ${stale.status}`);
    const noKey = await call("POST", `/api/omni/approvals/${apId}/decision`, { decision: "send", digest: ap.digest });
    check(noKey.status === 400, `no Idempotency-Key: expected 400, got ${noKey.status}`);
    const r = await call("POST", `/api/omni/approvals/${apId}/decision`, { decision: "send", digest: ap.digest }, { "idempotency-key": sendKey });
    check(r.status === 503 && r.body.error === "executor_disabled", `expected 503 executor_disabled, got ${r.status} ${String(r.body.error)}`);
    const after = await call("GET", `/api/omni/approvals/${apId}`);
    const a = after.body.approval as Record<string, unknown>;
    check(a.status === "pending" && a.result === null && a.decidedAt === null, `the approval is ${String(a.status)}, not pending`);
    return `503 executor_disabled (${String(r.body.executor)}); the approval is still pending, result null`;
  });

  await step("replay that decision with the same Idempotency-Key", async () => {
    const r = await call("POST", `/api/omni/approvals/${apId}/decision`, { decision: "send", digest: ap.digest }, { "idempotency-key": sendKey });
    check(r.status === 503 && r.body.error === "executor_disabled", `expected the same 503 executor_disabled, got ${r.status} ${String(r.body.error)}`);
    const a = (await call("GET", `/api/omni/approvals/${apId}`)).body.approval as Record<string, unknown>;
    check(a.status === "pending", "the replay changed the approval");
    return `the same 503 executor_disabled, still pending, Idempotent-Replayed=${r.headers.get("idempotent-replayed") ?? "absent"} (a refused send is not a decision, so there is no stored outcome to replay)`;
  });

  await step("a decision that IS stored replays: cancel, then the same key again", async () => {
    const k = idem();
    const r = await call("POST", `/api/omni/approvals/${apId}/decision`, { decision: "cancel", digest: ap.digest }, { "idempotency-key": k });
    check(r.status === 200 && (r.body.approval as Record<string, unknown>).status === "cancelled", `cancel got ${r.status}`);
    const again = await call("POST", `/api/omni/approvals/${apId}/decision`, { decision: "cancel", digest: ap.digest }, { "idempotency-key": k });
    check(again.status === 200 && again.headers.get("idempotent-replayed") === "true" && (again.body.approval as Record<string, unknown>).status === "cancelled", `replay got ${again.status}, replayed=${again.headers.get("idempotent-replayed")}`);
    const other = await call("POST", `/api/omni/approvals/${apId}/decision`, { decision: "send", digest: ap.digest }, { "idempotency-key": idem() });
    check(other.status === 409 && other.body.error === "already_decided", `another key: expected 409 already_decided, got ${other.status}`);
    return "cancel 200; same key → 200 + Idempotent-Replayed: true; another key → 409 already_decided";
  });

  await step(REAL ? "failure path: the model call fails (Hermes sends its error text as the answer)" : "failure paths: a failed run, a dropped Hermes stream", async () => {
    const out: string[] = [];
    const cases: Array<readonly [string, string]> = REAL ? [[M.authError, "auth"]] : [[M.authError, "auth"], ["stub:drop", "hermes_unavailable"], ["stub:truncate", "stream_ended"]];
    for (const [text, code] of cases) {
      const r = await call("POST", `/api/omni/threads/${threadId}/turns`, { text }, { "idempotency-key": idem() });
      check(r.status === 202, `${text}: turn got ${r.status}`);
      const { events, closedByServer } = await readStream(threadId, seq);
      check(closedByServer, `${text}: the stream did not close`);
      const res = find(events, "result");
      check(res?.ok === false && res.errorCode === code, `${text}: errorCode ${String(res?.errorCode)}, expected ${code}`);
      check(!/simulated|Incorrect API key|HTTP 401/.test(JSON.stringify(events)), "Hermes' own error text reached the app");
      seq = lastSeq(events);
      out.push(`${text} → ${code}`);
    }
    return out.join("; ");
  });

  if (REAL) {
    await step("the Omni tool policy: a shell command is refused by omni-bridge, and nothing runs", async () => {
      const r = await call("POST", `/api/omni/threads/${threadId}/turns`, { text: 'fake:tool:terminal {"command":"echo omni-walkthrough"}' }, { "idempotency-key": idem() });
      check(r.status === 202, `turn got ${r.status}`);
      const { events, closedByServer } = await readStream(threadId, seq);
      check(closedByServer, "the stream did not close");
      // Hermes sends no frame for a call a plugin vetoed: the app sees no tool at all.
      check(!events.some((e) => e.t === "tool_use"), "a terminal tool call was shown as started");
      const text = events.filter((e) => e.t === "text").pop();
      check(text && /reported an error/.test(String(text.text)), "the model was not told the tool was refused");
      check(find(events, "result")?.ok === true, "the turn failed");
      seq = lastSeq(events);
      return "no tool ran; the model got the refusal and said so";
    });

    await step("a tool that fails: Hermes says `tool.completed`; the gateway corrects it from the tool's row", async () => {
      const r = await call("POST", `/api/omni/threads/${threadId}/turns`, { text: 'fake:tool:skill_view {"name":"omni-walkthrough-no-such-skill"}' }, { "idempotency-key": idem() });
      check(r.status === 202, `turn got ${r.status}`);
      const { events, closedByServer } = await readStream(threadId, seq);
      check(closedByServer, "the stream did not close");
      const results = events.filter((e) => e.t === "tool_result");
      check(results.length === 2 && results[0]!.ok === true && results[1]!.ok === false && results[0]!.toolUseId === results[1]!.toolUseId, `tool_result events: ${results.map((e) => String(e.ok)).join(", ")} (expected true, then false for the same call)`);
      check(!/not found|available_skills|"success"/i.test(JSON.stringify(events)), "the tool's raw result reached the app");
      seq = lastSeq(events);
      return "tool_result ok → corrected to failed; the raw result stayed in Hermes";
    });
  }

  const cli = process.env.OMNI_WALK_HERMES_CLI;
  if (!REAL || cli) {
    await step(REAL ? "an agent-initiated message: a turn on this thread from the Hermes CLI → omni-bridge's post-turn notice" : "an agent-initiated message (stub plays omni-bridge's post-turn hook)", async () => {
      if (REAL) {
        // Another surface (the CLI) continues the Omni thread. The plugin, loaded in THAT
        // process too, tells the gateway when the turn ends.
        const { spawnSync } = await import("node:child_process");
        const run = spawnSync(cli!, ["chat", "-Q", "-q", "A note from the command line.", "--resume", threadId], { encoding: "utf8", timeout: TURN_MS, stdio: ["ignore", "pipe", "pipe"] });
        check(run.status === 0, `the Hermes CLI exited ${String(run.status)}`);
      } else {
        const r = await call("POST", `/api/omni/threads/${threadId}/turns`, { text: "stub:followup" }, { "idempotency-key": idem() });
        check(r.status === 202, `turn got ${r.status}`);
        const { events } = await readStream(threadId, seq);
        check(find(events, "result")?.ok === true, "the turn failed");
        seq = lastSeq(events);
      }
      // Nothing is attached to the thread now; the notice arrives within a few seconds.
      let unread = 0;
      for (let i = 0; i < 16 && !unread; i++) {
        await sleep(500);
        const list = await call("GET", "/api/omni/threads");
        unread = Number(((list.body.threads ?? []) as Array<Record<string, unknown>>).find((t) => t.id === threadId)?.unread ?? 0);
      }
      check(unread === 1, "the thread did not become unread after the hook");
      const tail = await readStream(threadId, seq);
      const st = tail.events.find((e) => e.t === "status" && e.reason === "agent_message");
      check(st, "no status event with reason agent_message");
      seq = lastSeq(tail.events);
      return "unread 1; status reason agent_message on the thread stream";
    });
  }

  await step("thread detail", async () => {
    const r = await call("GET", `/api/omni/threads/${threadId}`);
    check(r.status === 200, `got ${r.status}`);
    const msgs = (r.body.messages ?? []) as Array<Record<string, unknown>>;
    check(msgs.some((m) => m.role === "user" && m.text === "Hello from the walk-through"), "the first message is not in the transcript");
    check(msgs.some((m) => m.role === "assistant"), "no assistant message");
    const aps = (r.body.approvals ?? []) as Array<Record<string, unknown>>;
    check(aps.some((a) => a.id === apId && a.status === "cancelled"), "the thread does not list its approval");
    const list = await call("GET", "/api/omni/threads");
    check(list.status === 200 && list.body.hermes === "ok" && ((list.body.threads ?? []) as Array<Record<string, unknown>>).some((t) => t.id === threadId), "the thread is not in the list");
    return `${msgs.length} messages, ${aps.length} approval, state ${String((r.body.thread as Record<string, unknown>).state)}; listed with hermes:"ok"`;
  });

  await step("jobs", async () => {
    let r = await call("GET", "/api/omni/jobs");
    let jobs = (r.body.jobs ?? []) as Array<Record<string, unknown>>;
    check(r.status === 200, `got ${r.status}`);
    let made = "";
    if (REAL && !jobs.length) {
      // A fresh dev Hermes has no jobs: make one (it stays in the DEV Hermes, paused).
      const c = await call("POST", "/api/omni/jobs", { name: "Omni walk-through (dev)", schedule: "0 7 * * *", prompt: "Say hello." });
      check(c.status === 201, `create got ${c.status} ${String(c.body.error ?? "")}`);
      made = "; created one";
      r = await call("GET", "/api/omni/jobs");
      jobs = (r.body.jobs ?? []) as Array<Record<string, unknown>>;
    }
    check(jobs.length >= (REAL ? 1 : 2), `${jobs.length} jobs`);
    const id = String(jobs[0]!.id);
    check(typeof (jobs[0]!.schedule as Record<string, unknown> | undefined)?.display === "string", "schedule is not Hermes' {kind, expr, display} object");
    const p = await call("POST", `/api/omni/jobs/${id}/pause`, {});
    check(p.status === 200 && (p.body.job as Record<string, unknown>).enabled === false, `pause got ${p.status}`);
    const listed = ((await call("GET", "/api/omni/jobs")).body.jobs ?? []) as Array<Record<string, unknown>>;
    check(listed.some((j) => j.id === id), "a paused job dropped out of the list");
    const u = await call("POST", `/api/omni/jobs/${id}/resume`, {});
    check(u.status === 200 && (u.body.job as Record<string, unknown>).enabled === true, `resume got ${u.status}`);
    if (made) await call("POST", `/api/omni/jobs/${id}/pause`, {});
    return `${jobs.length} jobs${made}; pause → enabled false (still listed); resume → enabled true`;
  });

  await step("today", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const r = await call("GET", `/api/omni/today?date=${date}`);
    check(r.status === 200 && r.body.date === date, `got ${r.status}`);
    const needs = r.body.needsYou as Record<string, unknown> | undefined;
    check(needs && Array.isArray(needs.approvals) && Array.isArray(r.body.inFlight), "needsYou.approvals / inFlight are missing");
    const errs = Object.keys((r.body.errors ?? {}) as Record<string, unknown>);
    const size = (v: unknown) => (Array.isArray(v) ? String(v.length) : "null");
    return `agenda ${size(r.body.agenda)}, tasks ${size(r.body.tasks)}, pending approvals ${size(needs.approvals)}, in flight ${size(r.body.inFlight)}; sections that failed: ${errs.length ? errs.join(", ") : "none"}`;
  });
}

async function cleanup(): Promise<void> {
  await step("sign out: revoke the device token, delete the session", async () => {
    if (token) {
      const r = await fetch(`${BASE}/auth/device/revoke`, { method: "POST", headers: auth() });
      check(r.status === 200, `revoke answered ${r.status}`);
      const me = await fetch(`${BASE}/api/omni/version`, { headers: auth() });
      check(me.status === 401, `the revoked token still answered ${me.status}`);
    }
    if (sessionId) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    return "the token is dead (401); the session row is gone";
  });
}

main()
  .catch((e) => {
    failed++;
    console.log(`FAIL  walk-through aborted — ${(e as Error).name}`);
  })
  .then(cleanup)
  .then(() => {
    console.log(failed ? `\n${failed} of ${n} steps FAILED` : `\nall ${n} steps passed`);
    process.exit(failed ? 1 : 0);
  });
