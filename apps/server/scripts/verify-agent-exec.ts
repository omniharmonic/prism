/**
 * LIVE isolation check of the hardened agent executor (Arch v2 WP0.1): spawn the
 * real `claude -p` through `startDispatch` against a SANDBOX vault with a
 * READ-ONLY prompt, then assert — from the CLI's own `system/init` event — that
 * the run sees ONLY the target vault's MCP tools: no other MCP server (other
 * vaults, shared org brains, third-party connectors) and no built-in host tool
 * (Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/Task/…), in dontAsk mode,
 * from the fixed empty cwd.
 *
 * It NEVER defaults to a live target and provisions nothing: you supply an
 * explicit env file describing an already-running sandbox vault + a token for
 * it (see the sandbox recipe in docs/roadmap/architecture-v2/WORKPLAN.md §0).
 *
 * Run:
 *   node --import tsx scripts/verify-agent-exec.ts --env /path/to/agent-verify.env
 *
 * The env file must set:
 *   AGENT_VERIFY_VAULT_URL=http://127.0.0.1:<sandbox-port>   (no trailing /vault/…)
 *   AGENT_VERIFY_VAULT=<sandbox vault name>
 *   AGENT_VERIFY_TOKEN=<read-scoped token for that vault>     (never printed)
 * Optional:
 *   AGENT_CWD=<dir>                     fixed cwd override (default ~/.prism/agent-cwd)
 *   AGENT_VERIFY_ALLOW_LIVE_PORT=1      only if you REALLY mean a :1940/:8787 target
 */
import { realpathSync } from "node:fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIVE_PORTS = new Set(["1940", "8787"]);

function fail(msg: string): never {
  console.error(`verify-agent-exec: ${msg}`);
  process.exit(2);
}

function loadTarget() {
  const i = process.argv.indexOf("--env");
  const envFile = i >= 0 ? process.argv[i + 1] : undefined;
  if (!envFile) fail("an explicit --env <file> pointing at a SANDBOX vault is required (no default target)");
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    fail(`cannot read env file ${envFile}: ${(e as Error).message}`);
  }
  const url = process.env.AGENT_VERIFY_VAULT_URL?.trim().replace(/\/+$/, "");
  const vault = process.env.AGENT_VERIFY_VAULT?.trim();
  const token = process.env.AGENT_VERIFY_TOKEN?.trim();
  if (!url || !vault || !token) fail("env file must set AGENT_VERIFY_VAULT_URL, AGENT_VERIFY_VAULT and AGENT_VERIFY_TOKEN");
  let port: string;
  try {
    const u = new URL(url);
    port = u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    fail(`AGENT_VERIFY_VAULT_URL is not a URL: ${url}`);
  }
  if (LIVE_PORTS.has(port) && process.env.AGENT_VERIFY_ALLOW_LIVE_PORT !== "1") {
    fail(`refusing port ${port} (a live Prism/Parachute port) — point at the sandbox, or set AGENT_VERIFY_ALLOW_LIVE_PORT=1 deliberately`);
  }
  return { id: "agent-verify", label: "Agent verify (sandbox)", url, vault, token };
}

async function main() {
  const entry = loadTarget();
  const { startDispatch, getDispatch, defaultAgentCwd, ensureAgentCwd } = await import("../src/agent-exec.js");
  const { findInitEvent, checkInitIsolation } = await import("../src/agent-init-check.js");

  const cwd = realpathSync(ensureAgentCwd(defaultAgentCwd()));
  console.log(`=== target: ${entry.url}/vault/${entry.vault} (token from env file, not shown); cwd ${cwd} ===`);

  const d = startDispatch(
    entry,
    {
      prompt:
        "Use the parachute-vault list-tags tool to list this vault's tags, then reply with exactly 'TAG_COUNT=<n>' where <n> is the number of tags. Do not create or modify anything.",
    },
    { outputFormat: "stream-json" },
  );
  console.log(`  dispatch ${d.id} ${d.status}${d.queuedReason ? ` (${d.queuedReason})` : ""}; polling…`);

  const deadline = Date.now() + 180_000;
  let final = getDispatch(d.id)!;
  while ((final.status === "running" || final.status === "queued") && Date.now() < deadline) {
    await sleep(2000);
    final = getDispatch(d.id)!;
  }
  console.log(`\n  status: ${final.status}${final.error ? ` — ${final.error}` : ""}`);

  const problems: string[] = [];
  const init = findInitEvent(final.output);
  if (!init) {
    problems.push("no system/init event in the CLI output");
    console.log(`  output (first 600 chars):\n${final.output.slice(0, 600)}`);
  } else {
    console.log(`  init tools: ${JSON.stringify(init.tools)}`);
    console.log(`  init MCP servers: ${JSON.stringify(init.mcp_servers)}`);
    console.log(`  init permissionMode: ${init.permissionMode}; cwd: ${init.cwd}`);
    problems.push(...checkInitIsolation(init, { cwd }));
  }

  // The final result line: success + the expected answer, and no denied tool calls.
  const result = final.output
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as { type?: string; subtype?: string; result?: string; permission_denials?: unknown[] };
      } catch {
        return null;
      }
    })
    .find((e) => e?.type === "result");
  if (final.status !== "done") problems.push(`dispatch ended ${final.status}`);
  if (!result) problems.push("no result event");
  else {
    if (result.subtype !== "success") problems.push(`result subtype ${result.subtype}`);
    if (!/TAG_COUNT=\d+/.test(result.result ?? "")) problems.push("result text lacks TAG_COUNT=<n> (the vault tool was not usable)");
    if ((result.permission_denials ?? []).length > 0) problems.push(`permission denials: ${JSON.stringify(result.permission_denials)}`);
  }

  if (problems.length) {
    console.log("\n=== FAIL ===");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log("\n=== PASS — only the target vault's MCP tools; no host tools; no other MCP servers ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("verify-agent-exec crashed:", e);
  process.exit(1);
});
