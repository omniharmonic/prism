/**
 * The Hermes contract — every assumption `src/omni/hermes-client.ts` and `src/omni/stream.ts`
 * make about Hermes' API server, as checks that run against ANY Hermes: the stub
 * (`test/omni-contract.test.ts`), a dev Hermes on a fake model, or the production one
 * (`scripts/omni-contract.ts`). One list, so the stub and the real thing are held to the
 * same facts. Numbers are the assumptions in docs/omni-module.md ("The contract with Hermes").
 *
 * Three depths:
 *   safe  no model call. Auth, routes, shapes, session rules. Creates one throwaway session
 *         (`omni_contract_<hex>`) and deletes it.
 *   turn  + one plain message to the model (stream vocabulary, transcript, hang-up).
 *   full  + scripted turns: tool calls, failures, stop, drop, a busy session, jobs. Needs a
 *         Hermes whose model obeys markers — the stub or the fake model (`driver`).
 *
 * It prints nothing itself and holds no credential: the caller supplies `call`, which adds
 * the bearer. Failure text is the check's own words — never a response body.
 */
import { toolFailed, toolRowsOf } from "../../src/omni/stream";

export type ContractCall = (method: string, path: string, body?: unknown, o?: { auth?: boolean; signal?: AbortSignal }) => Promise<Response>;

/** How to ask this Hermes' model for a scripted behaviour (a marker in the message). */
export interface ContractDriver {
  name: "stub" | "fake";
  /** A message answered with text only (no tool call). */
  plain: string;
  /** Streams `n` chunks one second apart, then (stub) holds. */
  slow(n: number): string;
  /** As `slow`, on a run whose agent takes a moment to exist (a real Hermes always does). */
  slowStart(n: number): string;
  /** One tool call that succeeds. */
  toolOk: string;
  /** One tool call whose result is an error. */
  toolFail: string;
  /** The model call fails (the provider refuses the key). */
  providerError: string;
  /** The model answers with no text. */
  empty: string;
  /** Says nothing for `seconds`, then answers. */
  silent(seconds: number): string;
}
export const STUB_DRIVER: ContractDriver = {
  name: "stub",
  plain: "stub:plain Reply with the single word ok.",
  slow: (n) => `stub:slow:${n}`,
  slowStart: (n) => `stub:slowstart:1 then ${n}`,
  toolOk: "stub:reply look something up",
  toolFail: "stub:toolfail:contract-note-0001",
  providerError: "stub:error:auth_failed",
  empty: "stub:empty",
  silent: (s) => `stub:silent:${s}`,
};
export const FAKE_DRIVER: ContractDriver = {
  name: "fake",
  plain: "Reply with the single word ok.",
  slow: (n) => `fake:slow:${n}`,
  slowStart: (n) => `fake:slow:${n}`,
  toolOk: "fake:tool:skills_list {}",
  toolFail: 'fake:tool:read_file {"path":"/nonexistent/omni-contract-probe.txt"}',
  providerError: "fake:error:401",
  empty: "fake:empty",
  silent: (s) => `fake:silent:${s}`,
};

export interface ContractOptions {
  call: ContractCall;
  depth: "safe" | "turn" | "full";
  driver?: ContractDriver;
  /** Wait for a `: keepalive` during a silent model call (30 s on a real Hermes). */
  keepalive?: { silentSeconds: number; withinMs: number };
  /** Also create, pause, resume and delete a cron job (`full` only). */
  jobs?: boolean;
  /** Called after each check. */
  report?: (r: ContractResult) => void;
  /** Milliseconds one streamed turn may take. */
  turnTimeoutMs?: number;
  /** How long to wait for Hermes to act on a stop or a hang-up before reading the transcript
   *  (default 4000; the in-process test uses less). */
  settleMs?: number;
}
export interface ContractResult {
  /** The assumption's number in the doc, e.g. `3`, `4b`. */
  id: string;
  name: string;
  ok: boolean;
  /** PASS: what was seen. FAIL: what was expected and not found. */
  note: string;
}

class Unmet extends Error {}
function expect(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Unmet(what);
}
const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
async function jsonOf(r: Response): Promise<Obj> {
  try {
    return obj(JSON.parse(await r.text()));
  } catch {
    return {};
  }
}
const errCode = (j: Obj): unknown => obj(j.error).code;

/** Frame names v0.20.5 sends on the session stream. Another name is reported, not ignored. */
export const KNOWN_EVENTS = ["run.started", "message.started", "assistant.delta", "tool.progress", "tool.started", "tool.completed", "assistant.completed", "run.completed", "error", "done"];

export interface StreamRead {
  frames: Array<{ event: string; data: Obj; at: number }>;
  /** `: comment` lines, with when they arrived. */
  comments: Array<{ text: string; at: number }>;
  status: number;
  /** The stream ended by itself (not by our hanging up). */
  closed: boolean;
}
/**
 * Read one `chat/stream` response. `until` may stop the read early (the hang-up cases):
 * return true to hang up right after that frame.
 */
export async function readStream(res: Response, o: { until?: (event: string, data: Obj) => boolean; onFrame?: (event: string, data: Obj) => void; abort?: AbortController; timeoutMs?: number } = {}): Promise<StreamRead> {
  const out: StreamRead = { frames: [], comments: [], status: res.status, closed: false };
  if (!res.ok || !res.body) return out;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  const deadline = Date.now() + (o.timeoutMs ?? 120_000);
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const chunk = await Promise.race([reader.read(), sleep(left).then(() => null)]);
      if (chunk === null) break;
      if (chunk.done) {
        out.closed = true;
        break;
      }
      buf += dec.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(data.join("\n"));
            } catch {
              /* a malformed frame is simply not a frame */
            }
            const name = event || "message";
            event = "";
            data = [];
            if (parsed && typeof parsed === "object") {
              out.frames.push({ event: name, data: obj(parsed), at: Date.now() });
              o.onFrame?.(name, obj(parsed));
              if (o.until?.(name, obj(parsed))) {
                o.abort?.abort();
                await reader.cancel().catch(() => {});
                return out;
              }
            }
          }
          event = "";
        } else if (line.startsWith(":")) out.comments.push({ text: line.slice(1).trim(), at: Date.now() });
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  } catch {
    /* the connection broke: what was read stands */
  }
  await reader.cancel().catch(() => {});
  return out;
}

const names = (s: StreamRead): string[] => s.frames.map((f) => f.event);
const last = (s: StreamRead, event: string): Obj | null => [...s.frames].reverse().find((f) => f.event === event)?.data ?? null;
const text = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof obj(p).text === "string" ? (obj(p).text as string) : "")).join("") : "");

export async function runContract(o: ContractOptions): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  const { call } = o;
  const driver = o.driver;
  const turnMs = o.turnTimeoutMs ?? 120_000;
  const settleMs = o.settleMs ?? 4_000;
  /** One short message a real model answers in a word, with no tool. */
  const PLAIN = driver?.plain ?? "Reply with the single word ok.";
  const made: string[] = [];
  const madeJobs: string[] = [];

  async function check(id: string, name: string, fn: () => Promise<string>): Promise<boolean> {
    let r: ContractResult;
    try {
      r = { id, name, ok: true, note: await fn() };
    } catch (e) {
      // Our own words, or an error NAME — never a response body or a header.
      r = { id, name, ok: false, note: e instanceof Unmet ? e.message : `${(e as Error).name}: could not complete the check` };
    }
    results.push(r);
    o.report?.(r);
    return r.ok;
  }
  const session = async (title?: string): Promise<string> => {
    const id = `omni_contract_${hex(12)}`;
    const r = await call("POST", "/api/sessions", { id, ...(title ? { title } : {}) });
    expect(r.status === 201, `creating a session answered ${r.status}, not 201`);
    made.push(id);
    return id;
  };
  const chat = (sid: string, message: string, signal?: AbortSignal) => call("POST", `/api/sessions/${sid}/chat/stream`, { message }, { signal });
  const transcript = async (sid: string, q = "limit=200&order=latest"): Promise<Obj[]> => {
    const r = await call("GET", `/api/sessions/${sid}/messages?${q}`);
    expect(r.status === 200, `the transcript answered ${r.status}`);
    const j = await jsonOf(r);
    expect(Array.isArray(j.data), "the transcript has no `data` list");
    return (j.data as unknown[]).map(obj);
  };
  /** Start a turn and keep reading it in the background. */
  const open = (sid: string, message: string, timeoutMs = 90_000) => {
    let gotRun: (id: string) => void = () => {};
    let gotText: () => void = () => {};
    const run = new Promise<string>((r) => (gotRun = r));
    const said = new Promise<void>((r) => (gotText = r));
    const ac = new AbortController();
    let deltas = 0;
    const done = chat(sid, message, ac.signal).then((res) =>
      readStream(res, {
        abort: ac,
        timeoutMs,
        onFrame: (e, d) => {
          if (typeof d.run_id === "string") gotRun(d.run_id);
          if (e === "assistant.delta" && ++deltas >= 2) gotText();
        },
      }),
    );
    const within = <T>(pr: Promise<T>, ms: number, what: string): Promise<T> =>
      Promise.race([pr, sleep(ms).then(() => { throw new Unmet(what); })]);
    return { runId: () => within(run, 30_000, "no frame with a run id arrived in 30 s"), streaming: () => within(said, 60_000, "the slow run never streamed text"), done, hangUp: () => ac.abort() };
  };
  /** Ask to stop until Hermes accepts (it cannot until the run's agent exists). */
  const stopUntilAccepted = async (runId: string, forMs = 30_000): Promise<{ refused: number; accepted: boolean }> => {
    const end = Date.now() + forMs;
    let refused = 0;
    for (;;) {
      const r = await call("POST", `/v1/runs/${runId}/stop`, {});
      if (r.status === 200) return { refused, accepted: true };
      expect(r.status === 404, `stop answered ${r.status} (expected 200 or 404 run_not_found)`);
      refused++;
      if (Date.now() > end) return { refused, accepted: false };
      await sleep(300);
    }
  };

  try {
    // ── 1. routes, the key ──────────────────────────────────────────────────
    await check("1a", "a request without the key is refused", async () => {
      const r = await call("GET", "/api/sessions?limit=1", undefined, { auth: false });
      expect(r.status === 401, `no key answered ${r.status}, not 401`);
      expect(errCode(await jsonOf(r)) === "gateway_auth_failed", "the 401 does not carry code gateway_auth_failed");
      return "401 gateway_auth_failed";
    });
    const listed = await check("1b", "GET /api/sessions lists sessions", async () => {
      const r = await call("GET", "/api/sessions?limit=5&offset=0");
      expect(r.status === 200, `the list answered ${r.status} (is the api_server platform enabled, and is this its key?)`);
      const j = await jsonOf(r);
      expect(Array.isArray(j.data) && typeof j.has_more === "boolean", "the list is not {data: [], has_more}");
      return `{data, has_more} — ${(j.data as unknown[]).length} session(s) on this page`;
    });
    if (!listed) return results; // nothing else can be judged
    await check("1c", "GET /api/jobs lists cron jobs", async () => {
      const r = await call("GET", "/api/jobs?include_disabled=true");
      expect(r.status === 200, `the job list answered ${r.status}`);
      const j = await jsonOf(r);
      expect(Array.isArray(j.jobs), "the job list is not {jobs: []}");
      const first = obj((j.jobs as unknown[])[0]);
      if ((j.jobs as unknown[]).length) expect(typeof first.id === "string" && /^[a-f0-9]{12}$/.test(first.id as string) && "enabled" in first && "schedule" in first, "a job lacks id (12 hex) / enabled / schedule");
      return `{jobs} — ${(j.jobs as unknown[]).length} job(s)`;
    });
    await check("1d", "POST /v1/runs/{id}/stop exists; an unknown run is 404 run_not_found", async () => {
      const r = await call("POST", `/v1/runs/run_${hex(32)}/stop`, {});
      expect(r.status === 404, `stopping an unknown run answered ${r.status}, not 404`);
      expect(errCode(await jsonOf(r)) === "run_not_found", "the 404 does not carry code run_not_found");
      return "404 run_not_found";
    });

    // ── 2. sessions under our own id ────────────────────────────────────────
    let sid = "";
    const title = `Omni contract check ${hex(6)}`;
    const haveSession = await check("2a", "POST /api/sessions accepts our own id", async () => {
      const id = `omni_contract_${hex(12)}`;
      const r = await call("POST", "/api/sessions", { id, title });
      expect(r.status === 201, `create answered ${r.status}, not 201`);
      made.push(id);
      const s = obj((await jsonOf(r)).session);
      expect(s.id === id, "Hermes minted its own id instead of keeping ours");
      sid = id;
      return `201, id kept, source ${String(s.source)}`;
    });
    if (!haveSession) return results;
    await check("2b", "the same id again is 409 session_exists", async () => {
      const r = await call("POST", "/api/sessions", { id: sid });
      expect(r.status === 409 && errCode(await jsonOf(r)) === "session_exists", `a taken id answered ${r.status}`);
      return "409 session_exists";
    });
    await check("2c", "a title another session has, or one over 100 characters, is 400 invalid_title", async () => {
      const dup = await call("POST", "/api/sessions", { id: `omni_contract_${hex(12)}`, title });
      if (dup.status === 201) made.push(String(obj((await jsonOf(dup)).session).id));
      expect(dup.status === 400, `a duplicate title answered ${dup.status}, not 400`);
      expect(errCode(await jsonOf(dup)) === "invalid_title", "the 400 does not carry code invalid_title");
      const long = await call("PATCH", `/api/sessions/${sid}`, { title: "x".repeat(101) });
      expect(long.status === 400 && errCode(await jsonOf(long)) === "invalid_title", `a 101-character title answered ${long.status}`);
      return "both refused with invalid_title (the gateway keeps its own title)";
    });
    await check("2d", "GET / PATCH a session; an unknown id is 404 session_not_found; an unknown field is refused", async () => {
      const g = await call("GET", `/api/sessions/${sid}`);
      expect(g.status === 200 && obj((await jsonOf(g)).session).id === sid, `GET answered ${g.status}`);
      const p = await call("PATCH", `/api/sessions/${sid}`, { pinned: true });
      expect(p.status === 200 && obj((await jsonOf(p)).session).pinned === true, `PATCH {pinned} answered ${p.status}`);
      const u = await call("PATCH", `/api/sessions/${sid}`, { state: "done" });
      expect(u.status === 400, `an unknown field answered ${u.status}, not 400`);
      const m = await call("GET", `/api/sessions/omni_contract_missing_${hex(8)}`);
      expect(m.status === 404 && errCode(await jsonOf(m)) === "session_not_found", `an unknown id answered ${m.status}`);
      await call("PATCH", `/api/sessions/${sid}`, { pinned: false });
      return "ok; 404 session_not_found; 400 for an unknown field";
    });
    await check("2e", "an ARCHIVED session leaves the list but still answers by id", async () => {
      const a = await call("PATCH", `/api/sessions/${sid}`, { archived: true });
      expect(a.status === 200, `PATCH {archived} answered ${a.status}`);
      const l = await jsonOf(await call("GET", "/api/sessions?limit=200"));
      const inList = (l.data as unknown[]).some((s) => obj(s).id === sid);
      const g = await call("GET", `/api/sessions/${sid}`);
      await call("PATCH", `/api/sessions/${sid}`, { archived: false });
      expect(!inList, "an archived session is still listed (the gateway's `gone` rule assumes it is not)");
      expect(g.status === 200, `an archived session answered ${g.status} by id`);
      return "not listed, 200 by id — so absence from the list never proves a session is gone";
    });
    await check("7a", "an empty transcript: GET …/messages?order=latest → {data: []}", async () => {
      const rows = await transcript(sid);
      expect(rows.length === 0, `a new session already has ${rows.length} message(s)`);
      const bad = await call("GET", `/api/sessions/${sid}/messages?order=sideways`);
      expect(bad.status === 400, `an unknown order answered ${bad.status}, not 400`);
      return "{data: []}";
    });
    if (o.depth === "safe") return results;

    // ── 3. the stream, on one plain turn ────────────────────────────────────
    let plain: StreamRead | null = null;
    const streamed = await check("3a", "a turn streams run.started … assistant.completed, run.completed, done", async () => {
      const s = await readStream(await chat(sid, PLAIN), { timeoutMs: turnMs });
      expect(s.status === 200, `chat/stream answered ${s.status}`);
      plain = s;
      const n = names(s);
      expect(n[0] === "run.started", `the first frame is ${n[0] ?? "(none)"}, not run.started`);
      for (const want of ["assistant.completed", "run.completed", "done"]) expect(n.includes(want), `no ${want} frame`);
      expect(n[n.length - 1] === "done" && s.closed, "the stream does not end with `done` and a close");
      expect(n.indexOf("assistant.completed") < n.indexOf("run.completed"), "assistant.completed does not come before run.completed");
      const unknown = [...new Set(n.filter((x) => !KNOWN_EVENTS.includes(x)))];
      expect(!unknown.length, `frame name(s) the gateway does not know: ${unknown.join(", ")}`);
      return `${n.length} frames: ${[...new Set(n)].join(", ")}`;
    });
    if (!streamed || !plain) return results;
    const p: StreamRead = plain;
    await check("3b", "every frame carries the same run_id (run_…) and a rising seq", async () => {
      const ids = new Set(p.frames.map((f) => f.data.run_id));
      expect(ids.size === 1 && typeof p.frames[0]!.data.run_id === "string", "frames do not share one run_id");
      expect(/^run_[A-Za-z0-9]{1,64}$/.test(p.frames[0]!.data.run_id as string), "the run id is not run_<alphanumerics> (the gateway would not send a stop for it)");
      const seqs = p.frames.map((f) => f.data.seq as number);
      expect(seqs.every((x, i) => typeof x === "number" && (i === 0 || x > seqs[i - 1]!)), "seq does not rise");
      return "one run id, seq rises";
    });
    await check("3c", "assistant.delta {delta} adds up to assistant.completed {content}; run.completed {messages} ends with that answer", async () => {
      const deltas = p.frames.filter((f) => f.event === "assistant.delta");
      expect(deltas.length > 0 && deltas.every((f) => typeof f.data.delta === "string"), "no assistant.delta frames with a `delta` string");
      const content = last(p, "assistant.completed")!.content;
      expect(typeof content === "string" && content.trim().length > 0, "assistant.completed has no `content` text");
      expect(deltas.map((f) => f.data.delta).join("").trim() === (content as string).trim(), "the deltas do not add up to the final content");
      const msgs = last(p, "run.completed")!.messages;
      expect(Array.isArray(msgs) && msgs.length > 0, "run.completed has no `messages` list");
      const end = obj((msgs as unknown[])[(msgs as unknown[]).length - 1]);
      expect(end.role === "assistant" && text(end.content).trim() === (content as string).trim(), "run.completed.messages does not end with the assistant's answer");
      return "deltas = content = the last message";
    });
    await check("7b", "the transcript: newest N in chronological order, with role, content, timestamp", async () => {
      const rows = await transcript(sid);
      expect(rows.length >= 2, `the transcript has ${rows.length} row(s) after one turn`);
      const tail = await transcript(sid, "limit=2&order=latest");
      expect(tail.length === 2, `limit=2 returned ${tail.length}`);
      expect(tail[0]!.role === "user" && tail[1]!.role === "assistant", `the newest two are ${String(tail[0]!.role)}, ${String(tail[1]!.role)} — not user, assistant`);
      expect(typeof tail[1]!.content === "string" && typeof tail[1]!.timestamp === "number", "a row lacks string content / a numeric timestamp");
      expect((tail[0]!.timestamp as number) <= (tail[1]!.timestamp as number), "rows are not oldest-first");
      return "user then assistant, timestamps in seconds";
    });
    await check("5", "hanging up right after run.completed loses nothing", async () => {
      const ac = new AbortController();
      const s = await readStream(await chat(sid, PLAIN, ac.signal), { until: (e) => e === "run.completed", abort: ac, timeoutMs: turnMs });
      expect(names(s).includes("run.completed"), "the turn did not reach run.completed");
      const want = text(last(s, "assistant.completed")!.content).trim();
      await sleep(Math.min(300, settleMs));
      const rows = await transcript(sid, "limit=1&order=latest");
      expect(rows[0]?.role === "assistant" && text(rows[0].content).trim() === want, "the answer is not in the transcript after the hang-up");
      return "the answer was already saved";
    });
    if (o.depth !== "full" || !driver) return results;

    // ── 6. tools ────────────────────────────────────────────────────────────
    await check("6a", "a tool call: tool.started {tool_name, args}, tool.completed {tool_name}; no call id on the stream; the result is in the tool row", async () => {
      const s = await readStream(await chat(await session(), driver.toolOk), { timeoutMs: turnMs });
      const st = last(s, "tool.started");
      const done = last(s, "tool.completed");
      expect(st && done, "no tool.started / tool.completed pair");
      expect(typeof st.tool_name === "string" && st.args && typeof st.args === "object", "tool.started lacks tool_name / args (the tool input)");
      expect(done.tool_name === st.tool_name, "tool.completed names another tool");
      expect(!("tool_call_id" in st) && !("call_id" in st), "the stream now carries a call id — pairing could use it");
      const rows = toolRowsOf(last(s, "run.completed")?.messages);
      expect(rows.length === 1 && rows[0]!.name === st.tool_name && !!rows[0]!.callId, "run.completed.messages has no tool row with tool_call_id + tool_name");
      expect(!toolFailed(rows[0]!.name, rows[0]!.content), "a successful tool's row reads as failed");
      return `${String(st.tool_name)}: started → completed; row has the call id and the result`;
    });
    await check("6b", "a tool that FAILED still sends tool.completed (there is no tool.failed); only its row says so", async () => {
      const s = await readStream(await chat(await session(), driver.toolFail), { timeoutMs: turnMs });
      expect(!names(s).includes("tool.failed"), "this Hermes sends tool.failed");
      const done = last(s, "tool.completed");
      expect(done, "no tool.completed for the failed tool");
      expect(done.preview == null && !("is_error" in done) && !("error" in done), "tool.completed now carries the outcome — the gateway could read it there");
      const rows = toolRowsOf(last(s, "run.completed")?.messages);
      expect(rows.length === 1 && toolFailed(rows[0]!.name, rows[0]!.content), "the tool row does not read as failed");
      return "tool.completed with no flag; the row holds the error";
    });

    // ── 8. a failed run ─────────────────────────────────────────────────────
    await check("8a", "a failed model call: no run.failed and no error frame — the error text arrives as the answer, and `messages` holds no answer", async () => {
      const id = await session();
      const s = await readStream(await chat(id, driver.providerError), { timeoutMs: turnMs });
      const n = names(s);
      expect(!n.includes("run.failed"), "this Hermes sends run.failed");
      expect(n.includes("run.completed"), "the failed run did not end with run.completed");
      const content = last(s, "assistant.completed")?.content;
      expect(typeof content === "string" && content.length > 0, "the failed run's assistant.completed has no text");
      const msgs = last(s, "run.completed")!.messages;
      expect(Array.isArray(msgs), "run.completed has no `messages` list");
      const end = obj((msgs as unknown[])[(msgs as unknown[]).length - 1]);
      expect(!(end.role === "assistant" && text(end.content).trim()), "run.completed.messages ends with an assistant answer for a failed run");
      const rows = await transcript(id);
      expect(rows.length === 1 && rows[0]!.role === "user", "the transcript of a failed turn is not just the user's message");
      return "run.completed with no answer row; the error text is only in assistant.completed";
    });
    await check("8b", "a model answer with no text: the row is `(empty)`", async () => {
      const s = await readStream(await chat(await session(), driver.empty), { timeoutMs: turnMs });
      const msgs = last(s, "run.completed")?.messages;
      expect(Array.isArray(msgs) && msgs.length > 0, "run.completed has no messages");
      const end = obj((msgs as unknown[])[(msgs as unknown[]).length - 1]);
      expect(end.role === "assistant" && text(end.content).trim() === "(empty)", "the last message is not Hermes' `(empty)` placeholder");
      return "assistant row `(empty)`; assistant.completed is Hermes' notice";
    });

    // ── 4. stop and hang-up ─────────────────────────────────────────────────
    await check("4a", "POST /v1/runs/{id}/stop stops a run started by chat/stream; the stream ends with run.completed (no run.cancelled) and the text so far is kept", async () => {
      const id = await session();
      const t = open(id, driver.slow(40));
      const runId = await t.runId();
      await t.streaming();
      const stop = await stopUntilAccepted(runId);
      expect(stop.accepted, "the stop was never accepted (run_not_found for 30 s)");
      const s = await t.done;
      const n = names(s);
      expect(s.closed && n.includes("run.completed"), "the stopped run's stream did not end with run.completed");
      expect(!n.includes("run.cancelled"), "this Hermes sends run.cancelled");
      const kept = (await transcript(id)).filter((r) => r.role === "assistant").map((r) => text(r.content)).join("");
      expect(kept.length > 0 && !kept.includes("step 40 of 40"), "the text so far was not kept (or the run finished)");
      const again = await call("POST", `/v1/runs/${runId}/stop`, {});
      expect(again.status === 404, `stopping the finished run answered ${again.status}, not 404`);
      return `stopped after ${n.filter((x) => x === "assistant.delta").length} delta(s); run.completed; a second stop is 404`;
    });
    await check("4b", "a stop sent the moment the run starts is refused (run_not_found) until its agent exists — it must be retried", async () => {
      const id = await session();
      const ac = new AbortController();
      const s = await readStream(await chat(id, driver.slowStart(40), ac.signal), { until: (e) => e === "run.started", abort: ac, timeoutMs: 30_000 });
      const runId = String(s.frames[0]?.data.run_id ?? "");
      expect(/^run_/.test(runId), "no run id on run.started");
      const stop = await stopUntilAccepted(runId);
      expect(stop.accepted, "the stop was never accepted — a run cancelled early would go on to call the model and its tools");
      await sleep(settleMs);
      const rows = await transcript(id);
      const said = rows.filter((r) => r.role === "assistant").map((r) => text(r.content)).join("");
      expect(!said.includes("step 40 of 40"), "the run finished anyway");
      return `refused ${stop.refused}×, then accepted; the run did not finish`;
    });
    await check("4c", "hanging up mid-answer interrupts the run (at Hermes' next write) and keeps the text so far", async () => {
      const id = await session();
      const t = open(id, driver.slow(40));
      await t.streaming();
      t.hangUp();
      await t.done;
      await sleep(settleMs);
      const said = (await transcript(id)).filter((r) => r.role === "assistant").map((r) => text(r.content)).join("");
      expect(said.length > 0, "nothing of the interrupted answer was kept");
      expect(!said.includes("step 12 of 40"), "the run kept going after the hang-up");
      return "interrupted; the partial answer is in the transcript";
    });

    // ── 10. a second message on a busy session ──────────────────────────────
    await check("10", "a second message while a run is active is neither queued nor refused: Hermes runs both at once", async () => {
      const id = await session();
      const first = open(id, driver.slow(8));
      await first.streaming();
      const second = await chat(id, PLAIN);
      expect(second.status === 200, `the second message answered ${second.status}`);
      const s2 = await readStream(second, { timeoutMs: turnMs });
      expect(!names(s2).includes("run.queued"), "this Hermes queues the second run");
      expect(names(s2).includes("run.completed"), "the second run did not complete");
      await stopUntilAccepted(await first.runId(), 5_000).catch(() => {});
      await first.done;
      return "both ran — the gateway's own one-turn-per-thread rule is what prevents this";
    });

    // ── 9. keepalives ───────────────────────────────────────────────────────
    if (o.keepalive) {
      const k = o.keepalive;
      await check("9", "while the model is silent Hermes sends `: keepalive` comments", async () => {
        const s = await readStream(await chat(await session(), driver.silent(k.silentSeconds)), { timeoutMs: k.silentSeconds * 1000 + 60_000 });
        expect(names(s).includes("run.completed"), "the silent turn did not complete");
        const begin = s.frames[0]!.at;
        const first = s.comments.find((c) => c.text === "keepalive");
        expect(first, "no `: keepalive` comment during the silence");
        expect(first.at - begin <= k.withinMs, `the first keepalive came after ${Math.round((first.at - begin) / 1000)} s`);
        return `first keepalive after ${Math.round((first.at - begin) / 100) / 10} s (the gateway gives up after OMNI_HERMES_STREAM_IDLE_MS of nothing at all)`;
      });
    }

    // ── 11. jobs ────────────────────────────────────────────────────────────
    if (o.jobs) {
      await check("11", "jobs: create → {job} with a schedule OBJECT; `skill` alone is ignored; a bad schedule is a 500; pause disables and hides it", async () => {
        const c = await call("POST", "/api/jobs", { name: `omni contract ${hex(6)}`, schedule: "0 7 * * *", prompt: "Say hello.", deliver: "local" });
        expect(c.status === 200, `create answered ${c.status}, not 200`);
        const job = obj((await jsonOf(c)).job);
        const id = String(job.id);
        expect(/^[a-f0-9]{12}$/.test(id), "the job id is not 12 hex characters");
        madeJobs.push(id);
        expect(typeof obj(job.schedule).display === "string", "schedule is not an object with `display`");
        expect(job.enabled === true && job.state === "scheduled", "a new job is not enabled / scheduled");
        const lone = await call("POST", "/api/jobs", { name: `omni contract ${hex(6)}`, schedule: "0 7 * * *", skill: "some-skill" });
        if (lone.status === 200) madeJobs.push(String(obj((await jsonOf(lone)).job).id));
        expect(lone.status === 500, `a job with only \`skill\` answered ${lone.status} (expected 500: Hermes reads \`skills\`)`);
        const bad = await call("POST", "/api/jobs", { name: "x", schedule: "not a schedule", prompt: "x" });
        expect(bad.status === 500 && /^Invalid schedule/.test(String((await jsonOf(bad)).error)), `a bad schedule answered ${bad.status}`);
        const paused = obj((await jsonOf(await call("POST", `/api/jobs/${id}/pause`, {}))).job);
        expect(paused.enabled === false && paused.state === "paused", "pause did not set enabled: false, state: paused");
        const shown = (await jsonOf(await call("GET", "/api/jobs"))).jobs as unknown[];
        const all = (await jsonOf(await call("GET", "/api/jobs?include_disabled=true"))).jobs as unknown[];
        expect(!shown.some((j) => obj(j).id === id) && all.some((j) => obj(j).id === id), "a paused job is not hidden without include_disabled=true");
        const resumed = obj((await jsonOf(await call("POST", `/api/jobs/${id}/resume`, {}))).job);
        expect(resumed.enabled === true && resumed.state === "scheduled", "resume did not re-enable it");
        expect((await call("GET", "/api/jobs/nothex")).status === 400, "a malformed job id is not a 400");
        expect((await call("GET", `/api/jobs/${hex(12)}`)).status === 404, "an unknown job id is not a 404");
        return "create/pause/resume as the gateway expects";
      });
    }
    return results;
  } finally {
    // Leave nothing behind: every session and job this run made is deleted.
    for (const id of madeJobs) await call("DELETE", `/api/jobs/${id}`).catch(() => {});
    for (const id of made) await call("DELETE", `/api/sessions/${id}`).catch(() => {});
  }
}
