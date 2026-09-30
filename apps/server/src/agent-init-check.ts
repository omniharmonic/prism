/**
 * Isolation check over the Claude CLI's `system/init` stream-json event (Arch v2
 * WP0.1). Pure, so it is unit-tested and shared by scripts/verify-agent-exec.ts:
 * a hardened dispatch must expose ONLY the target vault's MCP tools — no other
 * MCP server (a personal vault, a shared org brain, a registrar connector, …)
 * and no built-in host tool (file, shell, web, sub-agent, notebook, skill).
 */
import { VAULT_MCP_NAME } from "./agent-exec";

/** The subset of the init event we assert on. */
export interface CliInitEvent {
  type?: string;
  subtype?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status?: string }>;
  permissionMode?: string;
}

/** Built-in tools that must never be present (spot-list for readable failures;
 *  the prefix rule below already rejects ANY non-vault tool). */
export const HOST_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "BashOutput",
  "KillShell",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "TodoWrite",
] as const;

/** Parse stream-json output (one JSON object per line; non-JSON lines such as
 *  stderr noise are ignored) and return the `system/init` event, if any. */
export function findInitEvent(output: string): CliInitEvent | null {
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as CliInitEvent;
      if (ev.type === "system" && ev.subtype === "init") return ev;
    } catch {
      /* not a JSON line */
    }
  }
  return null;
}

/** Returns a list of isolation violations (empty = isolated). */
export function checkInitIsolation(init: CliInitEvent, expect: { cwd?: string } = {}): string[] {
  const problems: string[] = [];
  const prefix = `mcp__${VAULT_MCP_NAME}__`;
  const tools = init.tools ?? [];
  if (tools.length === 0) problems.push("no tools at all — the vault MCP did not load");
  for (const t of tools) if (!t.startsWith(prefix)) problems.push(`non-vault tool present: ${t}`);
  for (const h of HOST_TOOLS) if (tools.includes(h)) problems.push(`host tool present: ${h}`);
  const servers = init.mcp_servers ?? [];
  const names = servers.map((s) => s.name);
  if (names.length !== 1 || names[0] !== VAULT_MCP_NAME) {
    problems.push(`MCP servers must be exactly [${VAULT_MCP_NAME}], got [${names.join(", ")}]`);
  }
  const vault = servers.find((s) => s.name === VAULT_MCP_NAME);
  if (vault && vault.status && vault.status !== "connected") problems.push(`vault MCP status is ${vault.status}`);
  if (init.permissionMode !== "dontAsk") problems.push(`permissionMode is ${init.permissionMode ?? "missing"}, expected dontAsk`);
  if (expect.cwd && init.cwd !== expect.cwd) problems.push(`cwd is ${init.cwd}, expected ${expect.cwd}`);
  return problems;
}
