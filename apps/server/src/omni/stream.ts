/**
 * Hermes session stream → Omni's neutral event vocabulary (integration-contract.md
 * § 4 "Stream events"; the same shapes as Prism's agent events, agent-events.ts, so
 * one client reducer serves both). Pure + stateful per turn.
 *
 *   init        {runId}                              run.started
 *   text_delta  {blockId, text}   (live only)        assistant.delta
 *   text        {blockId, text}   (replaces deltas)  assistant.completed / assistant.commentary
 *   tool_use    {id, name, input} (redacted)         tool.started
 *   tool_result {toolUseId, ok, summary}             tool.completed / tool.failed
 *   status      {state, reason?}                     run.queued, approval.request (Hermes' own)
 *   result      {ok, durationMs, errorCode?, error?} run.completed|failed|cancelled, error
 * `card` and `approval` are added by the turn runner (records.ts, approvals.ts), not here.
 *
 * SECURITY: tool inputs are redacted + truncated (`redactToolInput`), text and summaries
 * are secret-scrubbed; Hermes' raw tool output never reaches the app (its stream does not
 * carry it anyway — `preview` is a short label). Hermes error messages are not forwarded,
 * only a code.
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

/** Hermes `error` / `run.failed` → a stable code (never Hermes' message text). */
function errorCodeOf(data: Record<string, unknown>): string {
  const code = typeof data.code === "string" ? data.code : typeof data.turn_exit_reason === "string" ? data.turn_exit_reason : "";
  if (/auth|401|403|oauth|credential/i.test(code)) return "auth";
  if (/quota|usage|rate|429/i.test(code)) return "usage_limit";
  if (/budget|cost/i.test(code)) return "budget";
  if (/timeout|deadline/i.test(code)) return "timeout";
  if (/iteration|max_turns|max_iterations/i.test(code)) return "iteration_limit";
  return "agent_failed";
}

export class HermesNormalizer {
  private block = 0;
  private deltas = "";
  private toolN = 0;
  /** Started-but-unfinished tool calls, FIFO per name (Hermes progress events carry no call id). */
  private open = new Map<string, Array<{ id: string; input: Record<string, unknown> }>>();
  private readonly started = Date.now();
  runId: string | null = null;
  ended = false;
  readonly writes: WriteSignal[] = [];

  constructor(private readonly turnId: string) {}

  private blockId(): string {
    return `${this.turnId}:b${this.block}`;
  }
  private result(ok: boolean, errorCode?: string): OmniEvent {
    this.ended = true;
    return { t: "result", ok, durationMs: Date.now() - this.started, ...(errorCode ? { errorCode } : {}) };
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
        if (!text) return [];
        const ev: OmniEvent = { t: "text", blockId: this.blockId(), text: scrubSecrets(cap(text, MAX_TEXT)) };
        this.block++;
        this.deltas = "";
        return [ev];
      }
      case "assistant.completed": {
        const text = typeof d.content === "string" ? d.content : this.deltas;
        this.deltas = "";
        if (!text.trim()) return [];
        const ev: OmniEvent = { t: "text", blockId: this.blockId(), text: scrubSecrets(cap(text, MAX_TEXT)) };
        this.block++;
        return [ev];
      }
      case "tool.started": {
        const name = typeof d.tool_name === "string" ? d.tool_name : "tool";
        const id = `${this.turnId}:t${++this.toolN}`;
        const input = asObj(d.args);
        const q = this.open.get(name) ?? [];
        q.push({ id, input });
        this.open.set(name, q);
        return [{ t: "tool_use", id, name: bareToolName(name), input: redactToolInput(input) }];
      }
      case "tool.completed":
      case "tool.failed": {
        const name = typeof d.tool_name === "string" ? d.tool_name : "tool";
        const q = this.open.get(name);
        const call = q?.shift() ?? { id: `${this.turnId}:t${++this.toolN}`, input: asObj(d.args) };
        const ok = f.event === "tool.completed";
        const summary = cap(scrubSecrets(typeof d.preview === "string" ? d.preview.replace(/\s+/g, " ").trim() : ""), MAX_RESULT_SUMMARY);
        const w = ok ? writeToolOf(name) : null;
        if (w) this.writes.push({ tool: w.tool, op: w.op, input: call.input, via: w.via });
        return [{ t: "tool_result", toolUseId: call.id, ok, summary }];
      }
      case "approval.request":
        // Hermes' own dangerous-command approval (its terminal tool). Omni does not answer it:
        // Omni turns run without a terminal, so this should not occur; surface it, never auto-approve.
        return [{ t: "status", state: "needs-you", reason: "hermes_approval_requested" }];
      case "run.completed":
        return [this.result(true)];
      case "run.cancelled":
        return [this.result(false, "cancelled")];
      case "run.failed":
        return [this.result(false, errorCodeOf(d))];
      case "error":
        return [this.result(false, errorCodeOf(d))];
      default:
        return []; // message.started, tool.progress (thinking), done, unknown
    }
  }
}
