/**
 * Pure conversation state for an agent session (WP3.2). No React, no I/O — the
 * chat UI feeds it the session detail (`seedConversation`) and every stream
 * message (`applyAgentMessage`); `apps/web/scripts/verify-agent-reducer.ts`
 * exercises it.
 *
 * Rules:
 *  - Persisted events (with `seq`) are applied at most once: seq <= lastSeq is a
 *    replay duplicate and ignored. Live `text_delta`s carry no seq.
 *  - `text_delta` appends to the streaming block with that `blockId`; the
 *    persisted `text` for the same blockId REPLACES it (the server's coalesced
 *    text is authoritative — it is also secret-scrubbed as a whole). A delta for a
 *    block that is already final is ignored.
 *  - On reconnect the in-flight turn is rebuilt from a replay starting at its
 *    first seq (`seedConversation` returns that resume point), so nothing is
 *    double-counted and nothing already persisted is lost.
 */
import { isTerminalTurn, type AgentSessionDetail, type AgentStreamMessage, type AgentTurn, type AgentTurnStatus } from "./sessions";

export interface TextBlockView {
  blockId: string;
  text: string;
  /** true while only deltas have arrived; false once the persisted `text` replaced it. */
  streaming: boolean;
}

export interface ToolView {
  id: string;
  name: string;
  /** undefined while the call is in flight. */
  ok?: boolean;
  summary?: string;
}

export interface TurnView {
  id: string;
  prompt: string;
  noteId: string | null;
  status: AgentTurnStatus;
  /** Status reason (e.g. "waiting for your other agent turn to finish"). */
  reason?: string;
  blocks: TextBlockView[];
  tools: ToolView[];
  touched: Array<{ noteId: string; op: string }>;
  costUsd?: number;
  durationMs?: number;
  error?: string;
  startedAt: number | null;
}

export interface ConversationState {
  turns: TurnView[];
  /** Highest persisted seq applied. */
  lastSeq: number;
}

export const emptyConversation: ConversationState = { turns: [], lastSeq: 0 };

/** Strip the MCP server prefix: "mcp__parachute-vault__query-notes" → "query-notes". */
export function shortToolName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] || name;
}

function turnFromDetail(t: AgentTurn): TurnView {
  return {
    id: t.id,
    prompt: t.prompt,
    noteId: t.note_id,
    status: t.status,
    blocks: t.finalText ? [{ blockId: `final:${t.id}`, text: t.finalText, streaming: false }] : [],
    tools: t.tools.map((name, i) => ({ id: `${t.id}:${i}`, name: shortToolName(name) })),
    touched: t.touched.map((x) => ({ noteId: x.noteId, op: x.op })),
    costUsd: t.cost_usd ?? undefined,
    durationMs: t.started_at && t.ended_at ? Math.max(0, t.ended_at - t.started_at) : undefined,
    error: t.error ?? undefined,
    startedAt: t.started_at,
  };
}

/** The turn that is still in flight (queued/running), if any. */
export function activeTurn(state: ConversationState): TurnView | undefined {
  const last = state.turns[state.turns.length - 1];
  return last && !isTerminalTurn(last.status) ? last : undefined;
}

/**
 * Build state from `GET /sessions/:id` and compute where to resume the stream.
 * Finished turns come from the detail summary; an in-flight turn is reset to its
 * prompt and rebuilt by replaying its events (resume = its firstSeq - 1).
 * Returns `streamAfter: null` when nothing is in flight (no stream needed).
 */
export function seedConversation(detail: AgentSessionDetail): { state: ConversationState; streamAfter: number | null } {
  const turns = detail.turns.map(turnFromDetail);
  const maxTurnSeq = detail.turns.reduce((m, t) => Math.max(m, t.lastSeq ?? 0), 0);
  let lastSeq = Math.max(detail.lastSeq ?? 0, maxTurnSeq);
  let streamAfter: number | null = null;
  const lastTurn = detail.turns[detail.turns.length - 1];
  if (lastTurn && !isTerminalTurn(lastTurn.status)) {
    const view = turns[turns.length - 1]!;
    view.blocks = [];
    view.tools = [];
    view.touched = [];
    if (lastTurn.firstSeq != null) {
      lastSeq = lastTurn.firstSeq - 1;
    } else if (detail.lastSeq === undefined && lastTurn.lastSeq === undefined) {
      // A server without resume points: replay the whole session and rebuild
      // every turn from its own events.
      lastSeq = 0;
      for (const t of turns) {
        t.blocks = [];
        t.tools = [];
        t.touched = [];
      }
    }
    // else: the turn has no events yet — resume after everything persisted.
    streamAfter = lastSeq;
  }
  return { state: { turns, lastSeq }, streamAfter };
}

/** Optimistically add a just-sent turn (before its first event arrives). */
export function addPendingTurn(state: ConversationState, turn: { id: string; prompt: string; noteId?: string | null; status?: AgentTurnStatus }): ConversationState {
  if (state.turns.some((t) => t.id === turn.id)) return state;
  const view: TurnView = {
    id: turn.id,
    prompt: turn.prompt,
    noteId: turn.noteId ?? null,
    status: turn.status ?? "queued",
    blocks: [],
    tools: [],
    touched: [],
    startedAt: Date.now(),
  };
  return { ...state, turns: [...state.turns, view] };
}

function updateTurn(state: ConversationState, turnId: string, f: (t: TurnView) => TurnView): ConversationState {
  let idx = state.turns.findIndex((t) => t.id === turnId);
  let turns = state.turns;
  if (idx === -1) {
    // A turn we have not seen (started from another device): add a placeholder;
    // the UI refetches the detail to fill in its prompt.
    turns = [...turns, { id: turnId, prompt: "", noteId: null, status: "running", blocks: [], tools: [], touched: [], startedAt: null }];
    idx = turns.length - 1;
  } else {
    turns = turns.slice();
  }
  turns[idx] = f(turns[idx]!);
  return { ...state, turns };
}

/** Apply one stream message. Returns the same object when nothing changed. */
export function applyAgentMessage(state: ConversationState, msg: AgentStreamMessage): ConversationState {
  if (typeof msg.seq === "number") {
    if (msg.seq <= state.lastSeq) return state; // replay duplicate
  }
  const seqd = (s: ConversationState): ConversationState => (typeof msg.seq === "number" ? { ...s, lastSeq: msg.seq } : s);

  switch (msg.t) {
    case "text_delta": {
      const turn = state.turns.find((t) => t.id === msg.turnId);
      const block = turn?.blocks.find((b) => b.blockId === msg.blockId);
      if (block && !block.streaming) return state; // already final
      return updateTurn(state, msg.turnId, (t) => {
        const i = t.blocks.findIndex((b) => b.blockId === msg.blockId);
        const blocks = t.blocks.slice();
        if (i === -1) blocks.push({ blockId: msg.blockId, text: msg.text, streaming: true });
        else blocks[i] = { ...blocks[i]!, text: blocks[i]!.text + msg.text };
        return { ...t, blocks, status: t.status === "queued" ? "running" : t.status };
      });
    }
    case "text":
      return seqd(
        updateTurn(state, msg.turnId, (t) => {
          const i = t.blocks.findIndex((b) => b.blockId === msg.blockId);
          const blocks = t.blocks.slice();
          const b = { blockId: msg.blockId, text: msg.text, streaming: false };
          if (i === -1) blocks.push(b);
          else blocks[i] = b;
          return { ...t, blocks };
        }),
      );
    case "tool_use":
      return seqd(
        updateTurn(state, msg.turnId, (t) =>
          t.tools.some((x) => x.id === msg.id) ? t : { ...t, tools: [...t.tools, { id: msg.id, name: shortToolName(msg.name) }] },
        ),
      );
    case "tool_result":
      return seqd(
        updateTurn(state, msg.turnId, (t) => ({
          ...t,
          tools: t.tools.map((x) => (x.id === msg.toolUseId ? { ...x, ok: msg.ok, summary: msg.summary } : x)),
        })),
      );
    case "note_touched":
      return seqd(
        updateTurn(state, msg.turnId, (t) =>
          t.touched.some((x) => x.noteId === msg.noteId && x.op === msg.op)
            ? t
            : { ...t, touched: [...t.touched, { noteId: msg.noteId, op: msg.op }] },
        ),
      );
    case "status":
      return seqd(updateTurn(state, msg.turnId, (t) => ({ ...t, status: msg.status, reason: msg.reason })));
    case "result":
      return seqd(
        updateTurn(state, msg.turnId, (t) => ({
          ...t,
          costUsd: msg.costUsd ?? t.costUsd,
          durationMs: msg.durationMs,
          error: msg.ok ? t.error : (msg.error ?? t.error),
        })),
      );
    case "init":
    default:
      return seqd(state);
  }
}

/** Human copy for a turn that did not finish normally (null when it did / is running). */
export function turnProblem(t: TurnView): { tone: "error" | "muted"; text: string } | null {
  switch (t.status) {
    case "error": {
      const e = (t.error ?? t.reason ?? "").toLowerCase();
      if (e.includes("budget")) return { tone: "error", text: "Stopped: this turn hit its spending cap." };
      return { tone: "error", text: t.error || t.reason ? `The agent hit an error: ${t.error ?? t.reason}` : "The agent hit an error." };
    }
    case "cancelled":
      return { tone: "muted", text: "Cancelled." };
    case "interrupted":
      return { tone: "muted", text: "Interrupted — the server restarted mid-turn. Send again to continue." };
    default:
      return null;
  }
}
