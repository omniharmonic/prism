/**
 * A FAKE model — a tiny deterministic OpenAI-compatible server (`/v1/chat/completions`,
 * `/v1/models`) for running a REAL Hermes on a laptop with no provider credential and no
 * provider call. DEV ONLY. Point a dev Hermes at it (`model.provider: custom`,
 * `model.base_url: http://127.0.0.1:<port>/v1`); docs/omni-module.md "Testing against a real
 * Hermes" has the whole recipe.
 *
 *   OMNI_FAKE_LLM_PORT    port (default 18651)
 *   OMNI_FAKE_LLM_QUIET=1 no request log
 *   OMNI_FAKE_LLM_TOOLS=1 also log the NAMES of the tools each request offers
 *   OMNI_FAKE_LLM_PROBE   comma list of words: log which of them the prompt contains (never the prompt)
 *
 * What a completion does is chosen by a marker in the LAST user message:
 *
 *   (none)                    a short answer, streamed ~12 characters every 40 ms
 *   fake:slow[:<n>]           n chunks (default 60), one per second
 *   fake:silent:<seconds>     says nothing for that long, then answers (stream keepalive test)
 *   fake:tool:<name> <json>   asks for that tool with those arguments (the JSON may span lines and
 *                             may itself contain markers — e.g. a goal handed to a sub-agent,
 *                             which the fake model then obeys in the sub-agent). `<name>` may be the bare
 *                             name of an offered `mcp__server__tool`. A tool Hermes hides behind
 *                             its tool-search bridge is asked for through `tool_call`.
 *   fake:propose[:<kind>]     asks for `omni_propose` with a canned draft (example.com only)
 *   fake:error[:<status>]     the provider refuses the request (default 500; 401, 429, …)
 *   fake:empty                a completion with no text
 *   fake:echo                 (with fake:tool) the answer repeats the start of the tool's result
 *   fake:then-error           (with fake:tool / fake:propose) the provider fails AFTER the tool ran
 *
 * After a tool result it answers once more, saying only whether the tool reported an error.
 * A request that is not streamed (Hermes' auxiliary calls: titles, summaries) gets a short
 * fixed answer. LOOPBACK ONLY; it needs no key and logs no message text.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

const HOST = "127.0.0.1";
const port = Number(process.env.OMNI_FAKE_LLM_PORT ?? 18651);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("[fake-llm] OMNI_FAKE_LLM_PORT must be a port between 1024 and 65535");
  process.exit(1);
}
const quiet = process.env.OMNI_FAKE_LLM_QUIET === "1";
const MODEL = "fake-1";

type Msg = { role?: string; content?: unknown; tool_calls?: unknown; name?: string };
type Tool = { type?: string; function?: { name?: string } };

/** Canned drafts per approval kind — reserved example values only. */
export const FAKE_PROPOSALS: Record<string, { summary: string; payload: Record<string, unknown> }> = {
  email: { summary: "Email Dana (fake model)", payload: { to: ["dana@example.com"], subject: "Friday call", body: "Hi Dana,\n\nCan we move our call to Friday at 10?\n\nThanks,\nBenjamin" } },
  "email-reply": { summary: "Reply to Dana (fake model)", payload: { noteId: "fake-email-note-0001", expectTo: ["dana@example.com"], body: "Friday at 10 works for me.\n\nBenjamin" } },
  message: { summary: "Message the dev room (fake model)", payload: { roomId: "!fakeroom:example.org", body: "Running a few minutes late." } },
  "calendar-invite": { summary: "Invite: Buoy sync (fake model)", payload: { title: "Buoy sync", start: "2026-10-09T17:00:00Z", end: "2026-10-09T17:30:00Z", attendees: ["dana@example.com"] } },
  tweet: { summary: "Post (fake model)", payload: { text: "A fake post that is never published." } },
  "wallet-proposal": { summary: "Wallet proposal (fake model)", payload: { to: "0x0000000000000000000000000000000000000000", amount: "1", token: "USDC", chain: "base", purpose: "Fake proposal — never submitted." } },
};

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("") : "";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const id = (p: string) => `${p}${randomBytes(8).toString("hex")}`;

/**
 * How to ask for the tool `want` (its name, or the last part of an `mcp__server__tool`
 * name). Offered directly → by name. Otherwise, when Hermes' tool search is on (MCP and
 * plugin tools are then hidden behind its `tool_call` bridge), through the bridge — with the
 * name as given, since the fake model cannot see the hidden catalog.
 */
function callFor(tools: Tool[], want: string, args: Record<string, unknown>): { name: string; args: string } | null {
  const names = tools.map((t) => t?.function?.name).filter((n): n is string => typeof n === "string");
  const direct = names.find((n) => n === want) ?? names.find((n) => n.endsWith(`__${want}`));
  if (direct) return { name: direct, args: JSON.stringify(args) };
  if (names.includes("tool_call")) return { name: "tool_call", args: JSON.stringify({ name: want, arguments: args }) };
  return null;
}

/** Index just past the JSON object that opens at `open` (string-aware); -1 if it never closes. */
function jsonEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

interface Plan {
  status?: number;
  text?: string;
  tool?: { name: string; args: string };
  chunkMs?: number;
  chunks?: string[];
  silentMs?: number;
  marker: string;
}

function plan(messages: Msg[], tools: Tool[]): Plan {
  const last = messages[messages.length - 1];
  // A tool result is the newest message: finish the turn (never loop on the marker again).
  const user = [...messages].reverse().find((m) => m?.role === "user");
  const said = textOf(user?.content);
  // The LAST marker wins: Hermes merges a user message into the previous one when the turn
  // before it left no answer (a failed run), so one message can carry two. A marker INSIDE
  // a tool's JSON arguments is that tool's business (a delegated goal, a cron prompt), not
  // this turn's: the JSON is skipped whole.
  const all: Array<{ name: string; arg?: string; json?: string }> = [];
  const re = /\bfake:([a-z-]+)(?::([A-Za-z0-9_.-]+))?/gi;
  for (let mm = re.exec(said); mm; mm = re.exec(said)) {
    const name = mm[1]!.toLowerCase();
    if (name === "then-error" || name === "echo") continue;
    const entry: { name: string; arg?: string; json?: string } = { name, arg: mm[2] };
    if (name === "tool") {
      const open = said.indexOf("{", re.lastIndex);
      if (open >= 0 && /^\s*$/.test(said.slice(re.lastIndex, open))) {
        const end = jsonEnd(said, open);
        if (end > open) {
          entry.json = said.slice(open, end);
          re.lastIndex = end;
        }
      }
    }
    all.push(entry);
  }
  const m = all.length ? all[all.length - 1]! : null;
  if (last?.role === "tool") {
    if (/\bfake:then-error\b/i.test(said)) return { marker: "after-tool-error", status: 500 };
    const out = textOf(last.content);
    const failed = /"error"|"success":\s*false|^Error/i.test(out.slice(0, 2000)) && !/"exit_code":\s*0\b/.test(out.slice(0, 4000));
    // `fake:echo`: repeat what the tool returned (the start of it), so a walk-through can see
    // a command's output arrive in the conversation.
    if (/\bfake:echo\b/i.test(said)) return { marker: "after-tool-echo", text: `${failed ? "The tool reported an error" : "The tool returned"}: ${out.replace(/<untrusted_tool_result[^>]*>[^\n]*\n[^\n]*\n\n/, "").replace(/\s+/g, " ").slice(0, 1500)}` };
    return { marker: "after-tool", text: failed ? "The tool reported an error, so I stopped there. Nothing was sent." : "The tool call went through. Nothing has been sent; it is waiting for your review." };
  }
  const name = m ? m.name : "reply";
  const arg = m?.arg;
  switch (name) {
    case "slow": {
      const n = Math.min(3600, Math.max(1, Number(arg) || 60));
      return { marker: "slow", chunkMs: 1000, chunks: Array.from({ length: n }, (_, i) => `step ${i + 1} of ${n}… `) };
    }
    case "silent":
      return { marker: "silent", silentMs: Math.min(3600, Math.max(1, Number(arg) || 45)) * 1000, text: "I was quiet for a while, and now I answer." };
    case "error":
      return { marker: "error", status: Number(arg) >= 400 && Number(arg) <= 599 ? Number(arg) : 500 };
    case "empty":
      return { marker: "empty", text: "" };
    case "propose": {
      const kind = arg && FAKE_PROPOSALS[arg] ? arg : "email";
      const call = callFor(tools, "omni_propose", { kind, payload: FAKE_PROPOSALS[kind]!.payload, summary: FAKE_PROPOSALS[kind]!.summary });
      if (!call) return { marker: "propose-unavailable", text: "I have no omni_propose tool on this surface, so I cannot propose a draft here." };
      return { marker: call.name === "tool_call" ? "propose (through tool_call)" : "propose", tool: call };
    }
    case "tool": {
      let args: Record<string, unknown> = {};
      if (m?.json) {
        try {
          const v = JSON.parse(m.json) as unknown;
          if (v && typeof v === "object" && !Array.isArray(v)) args = v as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      const call = arg ? callFor(tools, arg, args) : null;
      if (!call) return { marker: "tool-unavailable", text: `I was not offered a tool named ${arg ?? "(none)"}.` };
      return { marker: call.name === "tool_call" ? "tool (through tool_call)" : "tool", tool: call };
    }
    default:
      return { marker: "reply", text: `This is the fake model. You said: “${said.replace(/\s+/g, " ").trim().slice(0, 80)}”.` };
  }
}

const split = (text: string, size = 12): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 32 * 1024 * 1024) return null;
    parts.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

async function completions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (!body || !Array.isArray(body.messages)) return void sendJson(res, 400, { error: { message: "messages is required", type: "invalid_request_error", code: "invalid_request" } });
  const tools = Array.isArray(body.tools) ? (body.tools as Tool[]) : [];
  const stream = body.stream === true;
  const p = stream ? plan(body.messages as Msg[], tools) : ({ marker: "aux", text: "Fake title" } satisfies Plan);
  if (!quiet) console.log(`[fake-llm] POST /v1/chat/completions stream=${stream} tools=${tools.length} → ${p.marker}`);
  if (!quiet && process.env.OMNI_FAKE_LLM_TOOLS === "1" && stream) console.log(`[fake-llm]   tools: ${tools.map((t) => t?.function?.name).join(" ")}`);
  // OMNI_FAKE_LLM_PROBE="word,word": say which of these the prompt contains (system prompt and
  // the newest user message apart) — to see that a surface loads its persona, skills and
  // guidance, without logging the prompt itself.
  const probe = (process.env.OMNI_FAKE_LLM_PROBE ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  if (!quiet && probe.length && stream) {
    const msgs = body.messages as Msg[];
    const sys = msgs.filter((x) => x?.role === "system").map((x) => textOf(x.content)).join("\n");
    const usr = textOf([...msgs].reverse().find((x) => x?.role === "user")?.content);
    const has = (t: string) => probe.filter((w) => t.toLowerCase().includes(w.toLowerCase())).join(",") || "-";
    console.log(`[fake-llm]   prompt: system ${sys.length} chars has [${has(sys)}]; user turn has [${has(usr)}]`);
  }
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (p.status) {
    const type = p.status === 401 ? "authentication_error" : p.status === 429 ? "rate_limit_error" : "server_error";
    return void sendJson(res, p.status, { error: { message: `fake model: simulated ${p.status}`, type, code: type } });
  }
  const cid = id("chatcmpl-");
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    return void sendJson(res, 200, { id: cid, object: "chat.completion", created, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: p.text ?? "" }, finish_reason: "stop" }], usage });
  }
  let open = true;
  res.on("close", () => (open = false));
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.flushHeaders();
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => {
    if (open) res.write(`data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
  };
  if (p.silentMs) await sleep(p.silentMs);
  chunk({ role: "assistant", content: "" });
  if (p.tool) {
    await sleep(60);
    const callId = id("call_");
    chunk({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: p.tool.name, arguments: "" } }] });
    // Arguments arrive in pieces, as a real model streams them.
    for (const piece of split(p.tool.args, 40)) {
      await sleep(15);
      chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
    }
    chunk({}, "tool_calls");
  } else {
    for (const piece of p.chunks ?? split(p.text ?? "")) {
      await sleep(p.chunkMs ?? 40);
      if (!open) return;
      chunk({ content: piece });
    }
    chunk({}, "stop");
  }
  if (open) {
    res.write(`data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model: MODEL, choices: [], usage })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  const done = (e: unknown) => {
    console.error(`[fake-llm] request failed: ${(e as Error).name}`);
    if (!res.headersSent) sendJson(res, 500, { error: { message: "fake model error", type: "server_error", code: "server_error" } });
    else res.destroy();
  };
  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    if (!quiet) console.log("[fake-llm] GET /v1/models");
    return void sendJson(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "fake", context_length: 131072 }] });
  }
  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) return void completions(req, res).catch(done);
  if (!quiet) console.log(`[fake-llm] ${req.method} ${path} → 404`);
  sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error", code: "not_found" } });
});
server.on("error", (e) => {
  console.error(`[fake-llm] cannot listen on ${HOST}:${port}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`);
  process.exit(1);
});
server.listen(port, HOST, () => console.log(`[fake-llm] listening on http://${HOST}:${port}/v1 (loopback only, model ${MODEL})`));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
