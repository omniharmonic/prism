/**
 * The `system/init` isolation check used by scripts/verify-agent-exec.ts (Arch
 * v2 WP0.1). The "good" fixture mirrors the shape of a real hardened init event
 * (CLI 2.1.x, strict MCP config, --tools "", dontAsk); the bad fixtures are what
 * the pre-hardening runner produced (host tools + ambient user-scope MCP servers).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findInitEvent, checkInitIsolation, type CliInitEvent } from "../src/agent-init-check";

const GOOD: CliInitEvent = {
  type: "system",
  subtype: "init",
  cwd: "/home/u/.prism/agent-cwd",
  tools: ["mcp__parachute-vault__query-notes", "mcp__parachute-vault__list-tags", "mcp__parachute-vault__vault-info"],
  mcp_servers: [{ name: "parachute-vault", status: "connected" }],
  permissionMode: "dontAsk",
};

test("a hardened init passes", () => {
  assert.deepEqual(checkInitIsolation(GOOD, { cwd: "/home/u/.prism/agent-cwd" }), []);
});

test("host tools are rejected", () => {
  const p = checkInitIsolation({ ...GOOD, tools: [...GOOD.tools!, "Read", "WebFetch", "Bash"] });
  assert.ok(p.some((x) => /host tool present: Read/.test(x)));
  assert.ok(p.some((x) => /host tool present: WebFetch/.test(x)));
  assert.ok(p.some((x) => /non-vault tool present: Bash/.test(x)));
});

test("any other MCP server (or its tools) is rejected", () => {
  const p = checkInitIsolation({
    ...GOOD,
    tools: [...GOOD.tools!, "mcp__other-vault__query-notes", "mcp__registrar__list-domains"],
    mcp_servers: [...GOOD.mcp_servers!, { name: "other-vault", status: "connected" }, { name: "registrar", status: "needs-auth" }],
  });
  assert.ok(p.some((x) => /non-vault tool present: mcp__other-vault__query-notes/.test(x)));
  assert.ok(p.some((x) => /non-vault tool present: mcp__registrar__list-domains/.test(x)));
  assert.ok(p.some((x) => /MCP servers must be exactly \[parachute-vault\]/.test(x)));
});

test("wrong permission mode, a failed vault MCP, an empty tool list, or a wrong cwd are rejected", () => {
  assert.ok(checkInitIsolation({ ...GOOD, permissionMode: "bypassPermissions" }).some((x) => /permissionMode/.test(x)));
  assert.ok(
    checkInitIsolation({ ...GOOD, tools: [], mcp_servers: [{ name: "parachute-vault", status: "failed" }] }).some((x) =>
      /no tools at all/.test(x),
    ),
  );
  assert.ok(checkInitIsolation({ ...GOOD, mcp_servers: [{ name: "parachute-vault", status: "failed" }] }).some((x) => /status is failed/.test(x)));
  assert.ok(checkInitIsolation({ ...GOOD, cwd: "/repo" }, { cwd: "/home/u/.prism/agent-cwd" }).some((x) => /cwd is \/repo/.test(x)));
});

test("findInitEvent picks the init line out of stream-json, ignoring noise", () => {
  const out = [
    "some stderr noise",
    JSON.stringify({ type: "system", subtype: "hook_started" }),
    JSON.stringify(GOOD),
    JSON.stringify({ type: "assistant", message: {} }),
    "{not json",
  ].join("\n");
  assert.deepEqual(findInitEvent(out)?.tools, GOOD.tools);
  assert.equal(findInitEvent("plain text only"), null);
});
