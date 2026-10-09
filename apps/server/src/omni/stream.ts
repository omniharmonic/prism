/**
 * Hermes session stream → Omni's neutral event vocabulary (integration-contract.md
 * § 4 "Stream events"; the same shapes as Prism's agent events, agent-events.ts, so
 * one client reducer serves both). Pure + stateful per turn.
 *
 * WHAT HERMES v0.20.5 REALLY SENDS on `POST /api/sessions/{id}/chat/stream`
 * (`gateway/platforms/api_server.py` `_handle_session_chat_stream`; verified against a
 * running one with `scripts/omni-contract.ts`):
 *
 *   run.started, message.started, assistant.delta {delta}, tool.progress {_thinking},
 *   tool.started {tool_name, preview, args}, tool.completed {tool_name, preview:null, args:null},
 *   assistant.completed {content}, run.completed {messages, usage}, error {message}, done
 *
 * and what that means here:
 *  - There is NO `tool.failed` and no call id: a tool that failed looks like any other
 *    `tool.completed`, and a call a plugin blocked sends no frame at all. The
 *    truth is the tool ROW Hermes writes — in `run.completed.messages`, and in the session
 *    transcript. `reconcile()` pairs those rows with the calls seen on the stream, corrects
 *    a `tool_result` that was announced ok, closes calls that never completed, and only then
 *    lets a write become a record card (`writes`).
 *  - There is NO `run.failed`: a run whose model call failed ends as `assistant.completed`
 *    carrying Hermes' ERROR TEXT + `run.completed` whose `messages` do not end with an
 *    assistant answer. So the final text is HELD until `run.completed` says which it is; a
 *    failed run's text is used only to pick an error code and is never forwarded.
 *  - All assistant text arrives as `assistant.delta` under one message id, interleaved with
 *    tools; `assistant.completed` carries only the LAST reply. Text streamed before a tool
 *    call is closed as its own block when the tool starts.
 *  - A stopped run ends as `run.completed` too (there is no `run.cancelled`); the turn
 *    runner knows it cancelled.
 * Names other Hermes surfaces or versions use (`tool.failed`, `run.failed`, `run.cancelled`,
 * `run.queued`, `assistant.commentary`, `approval.request`, `error {code}`) are still read.
 *
 *   init        {runId}                              run.started
 *   text_delta  {blockId, text}   (live only)        assistant.delta
 *   text        {blockId, text}   (replaces deltas)  text before a tool; the final answer
 *   tool_use    {id, name, input} (redacted)         tool.started
 *   tool_result {toolUseId, ok, summary}             tool.completed, then the tool row (a second
 *                                                    event for the same id corrects the first)
 *   status      {state, reason?}                     run.queued, approval.request (Hermes' own)
 *   result      {ok, durationMs, errorCode?}         run.completed, error
 * `card` and `approval` are added by the turn runner (records.ts, approvals.ts), not here.
 *
 * SECURITY: tool inputs are redacted + truncated (`redactToolInput`), text and summaries
 * are secret-scrubbed; Hermes' raw tool output never reaches the app — it is read here only
 * to decide ok / failed and to find a created note's id. Hermes error messages are not
 * forwarded, only a code.
 */
import { redactToolInput, scrubSecrets, MAX_RESULT_SUMMARY, MAX_TEXT } from "../agent-events";
import type { HermesStreamFrame } from "./hermes-client";

export type OmniEvent =
  | { t: "init"; runId: string | null }
  | { t: "text_delta"; blockId: string; text: string }
  | { t: "text"; blockId: string; text: string }
  | { t: "tool_use"; id: string; name: string; input: unknown }
  | { t: "tool_result"; toolUseId: string; ok: boolean; summary: string }
  | { t: "card"; card: Record<string, unknown> }
  | { t: "approval"; approval: Record<string, unknown> }
  | { t: "status"; state: string; reason?: string }
  | { t: "result"; ok: boolean; durationMs: number; errorCode?: string; error?: string };

/** A successful write by the agent, for the card builder. */
export interface WriteSignal {
  tool: string;
  op: CardOp;
  input: Record<string, unknown>;
  /** The tool family: Prism MCP (writer stamp `agent`) or the raw vault MCP (`external`). */
  via: "prism" | "vault";
  /** A create's new note id, when the tool's own result named one. */
  createdId?: string;
}
export type CardOp = "created" | "updated" | "deleted" | "commented" | "suggested";

/** Prism MCP + vault MCP write tools → the card op. */
const WRITE_TOOLS: Record<string, { op: CardOp; via: "prism" | "vault" }> = {
  prism_create_note: { op: "created", via: "prism" },
  prism_update_note: { op: "updated", via: "prism" },
  prism_delete_note: { op: "deleted", via: "prism" },
  prism_restore_version: { op: "updated", via: "prism" },
  prism_sheet_update: { op: "updated", via: "prism" },
  prism_add_comment: { op: "commented", via: "prism" },
  prism_resolve_comment: { op: "commented", via: "prism" },
  prism_suggest_edit: { op: "suggested", via: "prism" },
  // Parachute vault MCP (`create-note`; Hermes sanitises `-` to `_` in MCP names).
  create_note: { op: "created", via: "vault" },
  update_note: { op: "updated", via: "vault" },
  delete_note: { op: "deleted", via: "vault" },
  "create-note": { op: "created", via: "vault" },
  "update-note": { op: "updated", via: "vault" },
  "delete-note": { op: "deleted", via: "vault" },
};

/** `mcp__prism__prism_update_note` → `prism_update_note`; a bare name stays. */
export function bareToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const i = name.lastIndexOf("__");
  return i > 4 ? name.slice(i + 2) : name;
}
export const writeToolOf = (name: string): { tool: string; op: CardOp; via: "prism" | "vault" } | null => {
  const tool = bareToolName(name);
  const w = WRITE_TOOLS[tool];
  return w ? { tool, ...w } : null;
};

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A Hermes error CODE (legacy `error {code}` / `run.failed`) or its error TEXT → a stable
 *  code. The text is only ever matched here; it is never forwarded. */
export function errorCodeOf(data: Record<string, unknown>, text = ""): string {
  const code = typeof data.code === "string" ? data.code : typeof data.turn_exit_reason === "string" ? data.turn_exit_reason : "";
  const msg = typeof data.message === "string" ? data.message : "";
  const s = `${code}\n${msg}\n${text}`.slice(0, 4000);
  if (/\b(401|403)\b|\bauth\b|auth_|authenticat|authoriz|unauthori[sz]ed|oauth|credential|api[ _-]?key|forbidden/i.test(s)) return "auth";
  if (/\b429\b|quota|usage[ _-]?limit|rate[ _-]?limit|too many requests/i.test(s)) return "usage_limit";
  if (/\b402\b|budget|billing|insufficient (credit|fund|balance)|out of credit/i.test(s)) return "budget";
  if (/timeout|timed out|deadline/i.test(s)) return "timeout";
  if (/iteration|max[ _-]?turns|max_iterations/i.test(s)) return "iteration_limit";
  return "agent_failed";
}

// ── the tool rows Hermes writes (the only place a tool's outcome is recorded) ──

/** One tool result as Hermes stored it. */
export interface ToolRow {
  /** Hermes' tool call id (`call_…`); a row is consumed once. */
  callId: string | null;
  name: string;
  /** The call's arguments, when the row's assistant message is in the same list. */
  args?: unknown;
  content: string;
}

const contentText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("") : "";
const parseJson = (s: unknown): unknown => {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/**
 * The tool rows of a Hermes message list — `run.completed.messages`, or the session
 * transcript (`GET /api/sessions/{id}/messages`) — in order. Each `role: "tool"` row carries
 * `tool_call_id`, `tool_name` and the result as `content`; the assistant message before it
 * carries the call (`tool_calls[].id`, `.function.name`, `.function.arguments`).
 */
export function toolRowsOf(messages: unknown): ToolRow[] {
  if (!Array.isArray(messages)) return [];
  const calls = new Map<string, { name: string; args: unknown }>();
  const out: ToolRow[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (m.role === "assistant") {
      const tcs = parseJson(m.tool_calls);
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const t = asObj(tc);
          const fn = asObj(t.function);
          const id = typeof t.id === "string" ? t.id : typeof t.call_id === "string" ? t.call_id : "";
          if (!id || typeof fn.name !== "string") continue;
          let name = fn.name;
          let args = parseJson(fn.arguments);
          // With Hermes' tool search on, an MCP or plugin tool is called through the
          // `tool_call` bridge: {name, arguments}. The stream and the tool row name the
          // underlying tool; so does this.
          const inner = asObj(args);
          if (name === "tool_call" && typeof inner.name === "string") {
            name = inner.name;
            args = parseJson(inner.arguments);
          }
          calls.set(id, { name, args });
        }
      }
    } else if (m.role === "tool") {
      const callId = typeof m.tool_call_id === "string" && m.tool_call_id ? m.tool_call_id : null;
      const call = callId ? calls.get(callId) : undefined;
      const name = typeof m.tool_name === "string" && m.tool_name ? m.tool_name : (call?.name ?? "");
      if (!name) continue;
      out.push({ callId, name, ...(call ? { args: call.args } : {}), content: contentText(m.content) });
    }
  }
  return out;
}

/**
 * Did this tool call fail? Hermes' own rule (`agent/display.py` `_detect_tool_failure`,
 * the one its CLI and its `/v1/runs` stream use), applied to the stored result: a terminal
 * result by its exit code; a JSON result with an `error` (or `success: false` + a message);
 * otherwise `"error"` / `"failed"` in the first 500 characters, or a result that starts
 * with `Error`. Also true for a call a plugin blocked (its row is `{"error": …}`).
 */
export function toolFailed(name: string, content: string): boolean {
  const data = parseJson(content);
  const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  // A terminal result is judged by its exit code; one without any (the call never ran: a
  // plugin's veto is `{"error": …}`) by its error.
  if (bareToolName(name) === "terminal" && obj && obj.exit_code != null) return obj.exit_code !== 0;
  if (obj) {
    const err = obj.error || obj.message;
    if (err && (obj.success === false || "error" in obj)) return true;
  }
  const head = content.slice(0, 500).toLowerCase();
  return head.includes('"error"') || head.includes('"failed"') || content.startsWith("Error");
}

const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The id a successful create named in its result. Hermes wraps an MCP tool's text as
 *  `{"result": "<text>"}`; the vault and Prism MCPs answer a create with the note as JSON. */
export function createdIdOf(content: string): string | undefined {
  const pick = (v: unknown, depth: number): string | undefined => {
    if (depth > 3) return undefined;
    const o = typeof v === "string" ? parseJson(v) : v;
    if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
    const r = o as Record<string, unknown>;
    if (typeof r.id === "string" && NOTE_ID.test(r.id)) return r.id;
    for (const k of ["note", "result", "structuredContent", "data"]) {
      const hit = pick(r[k], depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  return pick(content, 0);
}

const canon = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
};

/** Hermes' placeholder for a model answer with no text (`_EMPTY_TEXT_PLACEHOLDER`). */
const EMPTY_PLACEHOLDER = "(empty)";

interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** A `tool.completed` / `tool.failed` was read. */
  done: boolean;
  /** The `ok` last announced to the app (null = no `tool_result` yet). */
  announced: boolean | null;
  /** The tool row was read: `announced` is the truth. */
  verified: boolean;
}

export class HermesNormalizer {
  private block = 0;
  private deltas = "";
  private toolN = 0;
  /** Every tool call of the turn, in the order Hermes started them. */
  private calls: Call[] = [];
  private consumed = new Set<string>();
  /** `assistant.completed`'s text, held until `run.completed` says answer or error. */
  private held: string | null = null;
  private readonly started = Date.now();
  runId: string | null = null;
  ended = false;
  /** Verified successful writes, for the card builder. */
  readonly writes: WriteSignal[] = [];

  constructor(private readonly turnId: string) {}

  private blockId(): string {
    return `${this.turnId}:b${this.block}`;
  }
  private result(ok: boolean, errorCode?: string): OmniEvent {
    this.ended = true;
    return { t: "result", ok, durationMs: Date.now() - this.started, ...(errorCode ? { errorCode } : {}) };
  }
  /** Close the text streamed so far as a finished block (`text` overrides the deltas). */
  private closeBlock(text?: string): OmniEvent[] {
    const body = (text ?? this.deltas).trim() ? (text ?? this.deltas) : "";
    this.deltas = "";
    if (!body.trim()) return [];
    const ev: OmniEvent = { t: "text", blockId: this.blockId(), text: scrubSecrets(cap(body, MAX_TEXT)) };
    this.block++;
    return [ev];
  }

  /** A write tool finished and its row has not been read yet: the caller may read the
   *  transcript now (`reconcile`) so the card appears while the turn still runs. */
  get needsVerification(): boolean {
    return this.calls.some((c) => c.done && !c.verified && c.announced !== false && !!writeToolOf(c.name));
  }

  private settle(c: Call, failed: boolean, content: string | null): OmniEvent[] {
    c.verified = true;
    c.done = true;
    const out: OmniEvent[] = [];
    if (c.announced !== !failed) {
      c.announced = !failed;
      out.push({ t: "tool_result", toolUseId: c.id, ok: !failed, summary: "" });
    }
    const w = failed ? null : writeToolOf(c.name);
    if (w) {
      const createdId = w.op === "created" && content !== null ? createdIdOf(content) : undefined;
      this.writes.push({ tool: w.tool, op: w.op, input: c.input, via: w.via, ...(createdId ? { createdId } : {}) });
    }
    return out;
  }

  /**
   * Pair Hermes' tool rows with the calls seen on the stream (same tool name, in order;
   * the same arguments first) and settle each: a result announced ok that failed is
   * corrected, a successful write becomes a `writes` entry. `final` (the run is over and
   * `rows` is its whole transcript): a call with no row never ran → failed.
   */
  reconcile(rows: ToolRow[], final: boolean): OmniEvent[] {
    const out: OmniEvent[] = [];
    rows.forEach((row, i) => {
      const key = row.callId ?? `#${i}:${row.name}`;
      if (this.consumed.has(key)) return;
      const open = this.calls.filter((c) => !c.verified && c.name === row.name);
      if (!open.length) return;
      const want = row.args !== undefined ? canon(row.args) : null;
      const call = (want !== null ? open.find((c) => canon(c.input) === want) : undefined) ?? open[0]!;
      this.consumed.add(key);
      out.push(...this.settle(call, toolFailed(row.name, row.content), row.content));
    });
    if (final) for (const c of this.calls) if (!c.verified) out.push(...this.settle(c, true, null));
    return out;
  }

  /** No tool rows will ever be read (a Hermes that sends none): what the stream said stands. */
  private trustStream(): OmniEvent[] {
    const out: OmniEvent[] = [];
    for (const c of this.calls) if (c.done && !c.verified) out.push(...this.settle(c, c.announced === false, null));
    return out;
  }

  push(f: HermesStreamFrame): OmniEvent[] {
    if (this.ended) return [];
    const d = f.data;
    if (typeof d.run_id === "string" && !this.runId) this.runId = d.run_id;
    switch (f.event) {
      case "run.started":
        return [{ t: "init", runId: this.runId }];
      case "run.queued":
        return [{ t: "status", state: "working", reason: "queued" }];
      case "assistant.delta": {
        const text = typeof d.delta === "string" ? d.delta : "";
        if (!text) return [];
        this.deltas = cap(this.deltas + text, MAX_TEXT);
        return [{ t: "text_delta", blockId: this.blockId(), text: scrubSecrets(text) }];
      }
      case "assistant.commentary": {
        const text = typeof d.text === "string" ? d.text.trim() : "";
        return text ? this.closeBlock(text) : [];
      }
      case "assistant.completed":
        this.held = typeof d.content === "string" ? d.content : "";
        return [];
      case "tool.started": {
        const name = typeof d.tool_name === "string" ? d.tool_name : "tool";
        const id = `${this.turnId}:t${++this.toolN}`;
        const input = asObj(d.args);
        this.calls.push({ id, name, input, done: false, announced: null, verified: false });
        // What the model said before the tool is its own finished block.
        return [...this.closeBlock(), { t: "tool_use", id, name: bareToolName(name), input: redactToolInput(input) }];
      }
      case "tool.completed":
      case "tool.failed": {
        const name = typeof d.tool_name === "string" ? d.tool_name : "tool";
        let call = this.calls.find((c) => !c.done && c.name === name);
        if (!call) {
          call = { id: `${this.turnId}:t${++this.toolN}`, name, input: asObj(d.args), done: false, announced: null, verified: false };
          this.calls.push(call);
        }
        call.done = true;
        const ok = f.event === "tool.completed";
        call.announced = ok;
        // A `tool.failed` is final; a `tool.completed` is provisional until its row is read.
        if (!ok) call.verified = true;
        const summary = cap(scrubSecrets(typeof d.preview === "string" ? d.preview.replace(/\s+/g, " ").trim() : ""), MAX_RESULT_SUMMARY);
        return [{ t: "tool_result", toolUseId: call.id, ok, summary }];
      }
      case "approval.request":
        // Hermes' own dangerous-command approval (its terminal tool). Omni does not answer it:
        // Omni turns run without a terminal, so this should not occur; surface it, never auto-approve.
        return [{ t: "status", state: "needs-you", reason: "hermes_approval_requested" }];
      case "run.completed": {
        const final = this.held;
        this.held = null;
        if (!Array.isArray(d.messages)) {
          // No transcript on the frame: nothing to judge by — the stream stands as it is.
          return [...this.trustStream(), ...this.closeBlock(final?.trim() ? final : undefined), this.result(true)];
        }
        const out = this.reconcile(toolRowsOf(d.messages), true);
        const last = asObj(d.messages[d.messages.length - 1]);
        const pending = parseJson(last.tool_calls);
        const answer = last.role === "assistant" && !(Array.isArray(pending) && pending.length) ? contentText(last.content).trim() : "";
        if (!answer || answer === EMPTY_PLACEHOLDER) {
          // The run produced no answer: `final` is Hermes' error text. What the model itself
          // streamed before that stays; the error text is only classified.
          return [...out, ...this.closeBlock(), this.result(false, answer === EMPTY_PLACEHOLDER ? "agent_failed" : errorCodeOf({}, final ?? ""))];
        }
        return [...out, ...this.closeBlock(final?.trim() ? final : answer), this.result(true)];
      }
      case "run.cancelled":
        return [...this.closeBlock(), this.result(false, "cancelled")];
      case "run.failed":
      case "error":
        this.held = null;
        return [...this.closeBlock(), this.result(false, errorCodeOf(d))];
      default:
        return []; // message.started, tool.progress (thinking), done, unknown
    }
  }
}
