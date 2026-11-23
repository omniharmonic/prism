/**
 * The claude-cli backend: the hardened `claude -p` runner (agent-exec.ts) as ONE
 * provider among others. Every isolation guarantee stays where it is — the argv
 * template, `--strict-mcp-config` + per-run 0600 MCP config, `--tools ""`, the
 * explicit allowlist under `dontAsk`, the empty checked cwd, the env allowlist, the
 * shared run queue + memory admission, the 30-minute clock. This module only calls
 * `enqueueRun` + `buildClaudeArgs`; it never builds an argv of its own.
 *
 * WHAT IS CLAUDE-SPECIFIC, and stays behind this backend (see MODELS.md):
 *  - the agent loop itself: stream-json parsing (agent-events.ts StreamNormalizer),
 *    `--session-id`/`--resume` + the CLI's `~/.claude/projects/<slug>/<uuid>.jsonl`
 *    session files (agent-sessions.ts), MCP tool names `mcp__<server>__<tool>`;
 *  - cost: `result.total_cost_usd` (cumulative across --resume) and the per-turn
 *    `--max-budget-usd` cap;
 *  - billing: `claude auth status` → subscription | api (agent-billing.ts);
 *  - failure classes read from the CLI's own text (agent-failure.ts);
 *  - the model vocabulary sonnet | opus | haiku.
 * The neutral event schema (`init`, `text_delta`, `text`, `tool_use`, `tool_result`,
 * `note_touched`, `status`, `result`) is the contract another agent backend would emit.
 */
import { buildClaudeArgs, buildPrompt, enqueueRun, isClaudeModel, NO_MCP_CONFIG, type Spawner } from "../agent-exec";
import { classifyRunFailure, describeRunFailure } from "../agent-failure";
import type { VaultEntry } from "../config";
import { ChainCancelledError } from "./router";

const MAX_OUTPUT = 2_000_000;

export interface ClaudeTextRequest {
  entry: VaultEntry;
  prompt: string;
  model: string;
  /** Text-only (no MCP server, no tools, the prompt as given) — page actions. */
  textOnly?: boolean;
  /** Else: the vault tools allowed (default: the whole vault MCP server). */
  allowedTools?: readonly string[];
  /** For the vault preamble of a non-text run (as `startDispatch` builds it). */
  skill?: string | null;
  noteId?: string | null;
  signal?: AbortSignal;
  spawner?: Spawner;
}

/**
 * One plain completion through the claude runner, awaited (a chain step). Uses the
 * shared run queue, so it waits for a slot / memory like any dispatch. Rejects with
 * the runner's failure sentence; an abort cancels the run and rejects
 * ChainCancelledError. Not registered as a dispatch of its own: the CALLER's
 * dispatch is the one the user sees.
 */
export function claudeText(req: ClaudeTextRequest): Promise<string> {
  if (!isClaudeModel(req.model)) return Promise.reject(new Error(`claude-cli takes sonnet, opus or haiku (got "${req.model}")`));
  const model = req.model;
  const prompt = req.textOnly ? req.prompt : buildPrompt(req.prompt, req.skill ?? null, req.noteId ?? null);
  return new Promise<string>((resolve, reject) => {
    if (req.signal?.aborted) return reject(new ChainCancelledError());
    let out = "";
    let onAbort: (() => void) | null = null;
    const handle = enqueueRun({
      entry: req.entry,
      spawner: req.spawner,
      ...(req.textOnly ? { mcpConfig: () => NO_MCP_CONFIG } : {}),
      args: (mcpPath) => buildClaudeArgs(prompt, mcpPath, { allowedTools: req.textOnly ? undefined : req.allowedTools, model, textOnly: req.textOnly }),
      onData: (chunk, stream) => {
        if (stream === "stdout" && out.length < MAX_OUTPUT) out += chunk;
      },
      onEnd: (info) => {
        if (onAbort) req.signal?.removeEventListener("abort", onAbort);
        if (info.cancelled) return reject(new ChainCancelledError());
        if (info.code === 0 && !info.error) return resolve(out.trim());
        const code = classifyRunFailure({ exitCode: info.code, runnerError: info.error, texts: [out.slice(-4000)] });
        reject(new Error(describeRunFailure(code, { exitCode: info.code, runnerError: info.error })));
      },
    });
    onAbort = () => void handle.cancel();
    req.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
