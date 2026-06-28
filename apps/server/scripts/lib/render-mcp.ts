/**
 * Render the project-local `.mcp.json` from `.mcp.json.template`.
 *
 * The repo ships a committed `.mcp.json.template` with `${PARACHUTE_URL}`,
 * `${PARACHUTE_VAULT}`, `${PARACHUTE_TOKEN}` placeholders; the real `.mcp.json`
 * (gitignored) is what Claude Code reads for project-local vault MCP access.
 * Nothing rendered it before — this closes that gap (G3). Used by both the
 * `prism setup` flow and the standalone `scripts/render-mcp.ts` CLI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo-root paths (this file lives at apps/server/scripts/lib/). */
export const MCP_TEMPLATE_PATH = resolve(__dirname, "../../../../.mcp.json.template");
export const MCP_OUTPUT_PATH = resolve(__dirname, "../../../../.mcp.json");

export interface RenderMcpOptions {
  url: string;
  vault: string;
  token: string;
  /** Override the template/output paths (tests). */
  templatePath?: string;
  outPath?: string;
  /** Compute + validate but write nothing. */
  dryRun?: boolean;
}

export interface RenderMcpResult {
  outPath: string;
  content: string;
  wrote: boolean;
}

/**
 * Substitute the three Parachute placeholders into the template, validate that
 * NO `${...}` placeholder survives and the result is valid JSON, and (unless
 * dryRun) write it chmod 600. Throws on a missing input or an unresolved
 * placeholder so a caller never produces a half-rendered, broken `.mcp.json`.
 */
export function renderMcp(opts: RenderMcpOptions): RenderMcpResult {
  for (const [k, v] of [["url", opts.url], ["vault", opts.vault], ["token", opts.token]] as const) {
    if (!v) throw new Error(`renderMcp: missing required ${k}`);
  }
  const templatePath = opts.templatePath ?? MCP_TEMPLATE_PATH;
  const outPath = opts.outPath ?? MCP_OUTPUT_PATH;

  const subs: Record<string, string> = {
    "${PARACHUTE_URL}": opts.url,
    "${PARACHUTE_VAULT}": opts.vault,
    "${PARACHUTE_TOKEN}": opts.token,
  };
  let content = readFileSync(templatePath, "utf8");
  for (const [k, v] of Object.entries(subs)) content = content.split(k).join(v);

  const leftover = content.match(/\$\{[A-Za-z0-9_]+\}/g);
  if (leftover) throw new Error(`unresolved placeholders in .mcp.json: ${[...new Set(leftover)].join(", ")}`);
  JSON.parse(content); // throws if the substitution broke JSON

  if (!opts.dryRun) writeFileSync(outPath, content, { mode: 0o600 });
  return { outPath, content, wrote: !opts.dryRun };
}
