/**
 * stream-json → AgentEvent normalizer (Arch v2 WP3.1). Pure + stateful per turn:
 * feed it the CLI's stdout (arbitrary chunking), get normalized events out.
 *
 * Input: `claude -p --output-format stream-json --verbose --include-partial-messages`.
 * Shapes (recorded from CLI 2.1.x — see test/fixtures/agent-stream-*.jsonl):
 *   {type:"system",subtype:"init",session_id,model,tools,mcp_servers,…}
 *   {type:"stream_event",event:{type:"message_start",message:{id}}}
 *   {type:"stream_event",event:{type:"content_block_start",index,content_block:{type:"text"|"tool_use"|"thinking"}}}
 *   {type:"stream_event",event:{type:"content_block_delta",index,delta:{type:"text_delta",text}}}
 *   {type:"assistant",message:{id,content:[ONE block: text|tool_use|thinking]}}   (final block)
 *   {type:"user",message:{content:[{type:"tool_result",tool_use_id,content,is_error?}]}}
 *   {type:"result",subtype:"success"|"error_…",is_error,duration_ms,total_cost_usd,result,…}
 * Everything else (status, rate_limit_event, permission_denied, commands_changed,
 * thinking, signatures) is dropped — the denial also arrives as an error tool_result.
 *
 * SECURITY: tool inputs are REDACTED (secret-looking keys) and TRUNCATED; tool
 * results become a short SUMMARY with token-shaped strings scrubbed — raw tool
 * output never leaves this module. `note_touched` is emitted only for a vault
 * write whose tool_result SUCCEEDED (a denied/failed write touched nothing).
 */

export type AgentTurnStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

export type AgentEvent =
  | { t: "init"; cliSessionId: string; model: string; tools: string[]; mcp: Array<{ name: string; status: string }> }
  | { t: "text_delta"; blockId: string; text: string }
  | { t: "text"; blockId: string; text: string }
  | { t: "tool_use"; id: string; name: string; input: unknown }
  | { t: "tool_result"; toolUseId: string; ok: boolean; summary: string }
  | { t: "note_touched"; noteId: string; op: "create" | "update" | "delete" }
  | { t: "status"; status: AgentTurnStatus; reason?: string }
  | { t: "result"; ok: boolean; costUsd?: number; durationMs: number; numTurns?: number; error?: string };

export const MAX_INPUT_JSON = 2000;
export const MAX_INPUT_STRING = 300;
export const MAX_RESULT_SUMMARY = 300;
export const MAX_TEXT = 100_000;

const SECRET_KEY_RE = /token|secret|password|passwd|authorization|api[-_]?key|cookie|bearer|credential|private[-_]?key/i;
// Token-shaped strings: JWTs, bearer headers, common key prefixes, long hex/base64 blobs.
const SECRET_VALUE_RES: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b(?:Bearer|Capability)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:pvt|pd|sk|pk|rk|ghp|gho|ghs|xox[abprs]|re)_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?=[A-Fa-f0-9]*[A-Fa-f])(?=[A-Fa-f0-9]*\d)[A-Fa-f0-9]{40,}\b/g, // hex keys (not plain digit runs)
];

/** Replace token-shaped substrings with `[redacted]`. */
export function scrubSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE_RES) out = out.replace(re, "[redacted]");
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s;
}

/** Redact + truncate a tool input for persistence/display. Secret-named keys are
 *  replaced, strings scrubbed and capped, depth/size bounded. */
export function redactToolInput(input: unknown): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (v == null || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") return truncate(scrubSecrets(v), MAX_INPUT_STRING);
    if (depth > 4) return "[…]";
    if (Array.isArray(v)) {
      const items = v.slice(0, 20).map((x) => walk(x, depth + 1));
      return v.length > 20 ? [...items, `[… ${v.length - 20} more]`] : items;
    }
    if (typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
        o[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : walk(x, depth + 1);
      }
      return o;
    }
    return String(v);
  };
  const red = walk(input, 0);
  const json = JSON.stringify(red) ?? "null";
  return json.length > MAX_INPUT_JSON ? { _truncated: true, preview: json.slice(0, MAX_INPUT_JSON) } : red;
}

/** The text of a tool_result's `content` (string or content-block array). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/** A short, scrubbed summary of a tool result — never the raw output. */
export function summarizeToolResult(content: unknown): string {
  const text = toolResultText(content).replace(/\s+/g, " ").trim();
  return truncate(scrubSecrets(text), MAX_RESULT_SUMMARY);
}

/** Vault MCP write tools → the note op they perform. */
const WRITE_OPS: Record<string, "create" | "update" | "delete"> = {
  "create-note": "create",
  "update-note": "update",
  "delete-note": "delete",
};

/** `mcp__parachute-vault__create-note` → `create-note` (null: not a vault tool). */
export function vaultToolName(name: string): string | null {
  const m = /^mcp__parachute-vault__(.+)$/.exec(name);
  return m ? m[1]! : null;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Note ids touched by a successful vault write (best effort; ids only). */
export function touchedNotes(tool: string, input: unknown, resultContent: unknown): Array<{ noteId: string; op: "create" | "update" | "delete" }> {
  const op = WRITE_OPS[tool];
  if (!op) return [];
  const inp = asObj(input) ?? {};
  const out: Array<{ noteId: string; op: "create" | "update" | "delete" }> = [];
  if (op === "create") {
    // The result carries the created note(s): {id,…} | [{id,…}] | {notes:[…]}.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(toolResultText(resultContent));
    } catch {
      /* not JSON */
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(asObj(parsed)?.notes) ? (asObj(parsed)!.notes as unknown[]) : [parsed];
    for (const n of list) {
      const id = str(asObj(n)?.id) ?? str(asObj(n)?.path);
      if (id) out.push({ noteId: id, op });
    }
    if (out.length === 0) {
      const path = str(inp.path);
      if (path) out.push({ noteId: path, op });
    }
    return out;
  }
  // update/delete: {id} or a batch {notes:[{id}]} / {ids:[…]}.
  const ids: string[] = [];
  const one = str(inp.id) ?? str(inp.path);
  if (one) ids.push(one);
  if (Array.isArray(inp.ids)) for (const x of inp.ids) if (str(x)) ids.push(x as string);
  if (Array.isArray(inp.notes)) for (const n of inp.notes) {
    const id = str(asObj(n)?.id) ?? str(asObj(n)?.path);
    if (id) ids.push(id);
  }
  return [...new Set(ids)].map((noteId) => ({ noteId, op }));
}

/** A stateful per-turn normalizer. */
export class StreamNormalizer {
  private buf = "";
  private msgId = "m";
  /** text-block counter per message (for delta blockIds). */
  private deltaTextIx = new Map<string, number>();
  /** stream index → blockId, for the current message's text blocks. */
  private blockAt = new Map<number, string>();
  /** text-block counter per message (for final text blockIds). */
  private finalTextIx = new Map<string, number>();
  /** tool_use id → {name, input} (raw, in memory only) for note_touched. */
  private tools = new Map<string, { name: string; input: unknown }>();
  /** The final result event, once seen. */
  result: Extract<AgentEvent, { t: "result" }> | null = null;
  cliSessionId: string | null = null;

  /** Feed a raw stdout chunk; returns the events completed by it. */
  push(chunk: string): AgentEvent[] {
    this.buf += chunk;
    const out: AgentEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      out.push(...this.line(line));
    }
    // Guard a runaway line without newline.
    if (this.buf.length > 10_000_000) this.buf = "";
    return out;
  }

  /** Flush a trailing line without newline (call at process exit). */
  end(): AgentEvent[] {
    const rest = this.buf;
    this.buf = "";
    return rest.trim() ? this.line(rest) : [];
  }

  private blockIdFor(counter: Map<string, number>): string {
    const n = counter.get(this.msgId) ?? 0;
    counter.set(this.msgId, n + 1);
    return `${this.msgId}:${n}`;
  }

  line(raw: string): AgentEvent[] {
    const t = raw.trim();
    if (!t.startsWith("{")) return [];
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      return [];
    }
    switch (ev.type) {
      case "system": {
        if (ev.subtype !== "init") return [];
        this.cliSessionId = str(ev.session_id);
        return [
          {
            t: "init",
            cliSessionId: this.cliSessionId ?? "",
            model: str(ev.model) ?? "",
            tools: Array.isArray(ev.tools) ? ev.tools.filter((x): x is string => typeof x === "string") : [],
            mcp: Array.isArray(ev.mcp_servers)
              ? ev.mcp_servers.map((s) => ({ name: String(asObj(s)?.name ?? ""), status: String(asObj(s)?.status ?? "") }))
              : [],
          },
        ];
      }
      case "stream_event": {
        const se = asObj(ev.event);
        if (!se) return [];
        if (se.type === "message_start") {
          this.msgId = str(asObj(se.message)?.id) ?? this.msgId;
          this.blockAt.clear();
          return [];
        }
        if (se.type === "content_block_start" && asObj(se.content_block)?.type === "text") {
          this.blockAt.set(Number(se.index), this.blockIdFor(this.deltaTextIx));
          return [];
        }
        if (se.type === "content_block_delta") {
          const d = asObj(se.delta);
          if (d?.type !== "text_delta" || typeof d.text !== "string" || !d.text) return [];
          const blockId = this.blockAt.get(Number(se.index)) ?? `${this.msgId}:?`;
          return [{ t: "text_delta", blockId, text: d.text }];
        }
        return [];
      }
      case "assistant": {
        const msg = asObj(ev.message);
        if (!msg) return [];
        this.msgId = str(msg.id) ?? this.msgId;
        const out: AgentEvent[] = [];
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          const block = asObj(b);
          if (!block) continue;
          if (block.type === "text" && typeof block.text === "string") {
            out.push({ t: "text", blockId: this.blockIdFor(this.finalTextIx), text: truncate(block.text, MAX_TEXT) });
          } else if (block.type === "tool_use") {
            const id = str(block.id) ?? "";
            const name = str(block.name) ?? "";
            this.tools.set(id, { name, input: block.input });
            out.push({ t: "tool_use", id, name, input: redactToolInput(block.input) });
          }
        }
        return out;
      }
      case "user": {
        const msg = asObj(ev.message);
        const out: AgentEvent[] = [];
        for (const b of Array.isArray(msg?.content) ? (msg!.content as unknown[]) : []) {
          const block = asObj(b);
          if (block?.type !== "tool_result") continue;
          const toolUseId = str(block.tool_use_id) ?? "";
          const ok = block.is_error !== true;
          out.push({ t: "tool_result", toolUseId, ok, summary: summarizeToolResult(block.content) });
          const call = this.tools.get(toolUseId);
          const tool = call ? vaultToolName(call.name) : null;
          if (ok && tool) {
            for (const n of touchedNotes(tool, call!.input, block.content)) out.push({ t: "note_touched", ...n });
          }
        }
        return out;
      }
      case "result": {
        const ok = ev.is_error !== true && ev.subtype === "success";
        const r: Extract<AgentEvent, { t: "result" }> = {
          t: "result",
          ok,
          durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : 0,
        };
        if (typeof ev.total_cost_usd === "number") r.costUsd = ev.total_cost_usd;
        if (typeof ev.num_turns === "number") r.numTurns = ev.num_turns;
        if (!ok) {
          const errs = Array.isArray(ev.errors) ? ev.errors.map(String).join("; ") : "";
          r.error = truncate(scrubSecrets(errs || String(ev.subtype ?? "error")), 500);
        }
        this.result = r;
        return [r];
      }
      default:
        return [];
    }
  }
}

/** Convenience: normalize a whole recorded stream. */
export function normalizeStream(text: string): AgentEvent[] {
  const n = new StreamNormalizer();
  return [...n.push(text), ...n.end()];
}
