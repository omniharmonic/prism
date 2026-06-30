/**
 * LIVE check of the Phase-3 agent executor: actually spawn `claude -p` via the
 * server-side executor against a THROWAWAY vault, with a READ-ONLY prompt, and
 * confirm it runs to completion through the per-vault MCP. Needs `claude` on PATH
 * + network. Safe: writes nothing (a throwaway vault, a read-only task, host
 * tools disallowed); the vault is removed at the end.
 *
 * Run:  node --import tsx scripts/verify-agent-exec.ts
 */
import { execFileSync } from "node:child_process";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { startDispatch, getDispatch } = await import("../src/agent-exec.js");

  console.log("=== provision a throwaway vault ===");
  execFileSync("parachute-vault", ["create", "agent-e2e", "--no-mirror", "--json"], { encoding: "utf8" });
  const token = execFileSync("parachute", ["auth", "mint-token", "--scope", "vault:agent-e2e:write", "--expires-in", "86400"], { encoding: "utf8" }).trim();
  const entry = { id: "agent-e2e", label: "Agent E2E", url: "http://localhost:1940", vault: "agent-e2e", token };
  console.log("  vault agent-e2e + token ready");

  console.log("\n=== dispatch a read-only agent task (real claude -p) ===");
  const d = startDispatch(entry, {
    prompt: "Use the parachute-vault list-tags tool to list this vault's tags, then reply with exactly 'TAG_COUNT=<n>' where <n> is the number of tags. Do not create or modify anything.",
  });
  console.log(`  dispatch ${d.id} started; polling…`);

  const deadline = Date.now() + 150_000; // 2.5 min cap
  let final = getDispatch(d.id)!;
  while (final.status === "running" && Date.now() < deadline) {
    await sleep(3000);
    final = getDispatch(d.id)!;
  }

  console.log(`\n  status: ${final.status}`);
  if (final.error) console.log(`  error: ${final.error}`);
  console.log(`  output (first 600 chars):\n${final.output.slice(0, 600)}`);

  const passed = final.status === "done" && /TAG_COUNT=/.test(final.output);
  console.log(`\n=== ${passed ? "PASS — executor ran claude through the vault MCP" : "CHECK output above"} ===`);

  console.log("=== teardown ===");
  try {
    execFileSync("parachute-vault", ["remove", "agent-e2e", "--yes"], { encoding: "utf8" });
    console.log("  removed agent-e2e");
  } catch (e) {
    console.log("  (teardown:", (e as Error).message, ")");
  }
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-agent-exec crashed:", e);
  try {
    execFileSync("parachute-vault", ["remove", "agent-e2e", "--yes"]);
  } catch {
    /* ignore */
  }
  process.exit(1);
});
