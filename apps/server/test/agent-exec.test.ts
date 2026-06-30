/**
 * Agent executor orchestration (Phase 3) — argv template, per-vault MCP config,
 * and the dispatch lifecycle (running → done/error/cancelled, output capture),
 * tested with an INJECTED fake spawner so no real `claude` runs. The live CLI is
 * exercised by scripts/verify-agent-exec.ts.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeArgs,
  vaultMcpConfig,
  buildPrompt,
  startDispatch,
  getDispatch,
  listDispatches,
  cancelDispatch,
  _resetDispatches,
  type SpawnedProc,
} from "../src/agent-exec";
import type { VaultEntry } from "../src/config";

const ENTRY: VaultEntry = { id: "primary", label: "Default", url: "http://localhost:1940", vault: "default", token: "tok_abc" };

/** A controllable fake child process. */
function fakeChild() {
  let exitCb: ((code: number | null) => void) | null = null;
  let errCb: ((e: Error) => void) | null = null;
  const outCbs: Array<(c: string) => void> = [];
  const proc: SpawnedProc = {
    stdout: { on: (_e, cb) => outCbs.push(cb as (c: string) => void) },
    stderr: { on: () => {} },
    on: (ev, cb) => {
      if (ev === "exit") exitCb = cb as (code: number | null) => void;
      if (ev === "error") errCb = cb as (e: Error) => void;
    },
    kill: () => exitCb?.(null),
  };
  return {
    proc,
    out: (s: string) => outCbs.forEach((cb) => cb(s)),
    exit: (code: number | null) => exitCb?.(code),
    err: (e: Error) => errCb?.(e),
  };
}

beforeEach(() => _resetDispatches());

test("buildClaudeArgs is a fixed template with the prompt last and host tools disallowed", () => {
  const args = buildClaudeArgs("do a thing", "/tmp/mcp.json");
  assert.equal(args[0], "-p");
  assert.ok(args.includes("--dangerously-skip-permissions"));
  const di = args.indexOf("--disallowedTools");
  assert.equal(args[di + 1], "Write,Edit,Bash,Glob,Grep");
  // tail: --mcp-config <path> -- <prompt>  (prompt is the final arg, after `--`)
  assert.deepEqual(args.slice(-4), ["--mcp-config", "/tmp/mcp.json", "--", "do a thing"]);
});

test("vaultMcpConfig points at the vault's scoped MCP with its own token", () => {
  const cfg = vaultMcpConfig(ENTRY) as { mcpServers: { "parachute-vault": { url: string; headers: { Authorization: string } } } };
  assert.equal(cfg.mcpServers["parachute-vault"].url, "http://localhost:1940/vault/default/mcp");
  assert.equal(cfg.mcpServers["parachute-vault"].headers.Authorization, "Bearer tok_abc");
});

test("buildPrompt prepends the vault-only rules + skill/note context", () => {
  const p = buildPrompt("summarize", "summarize", "note-1");
  assert.match(p, /parachute-vault MCP tools/);
  assert.match(p, /Skill: summarize/);
  assert.match(p, /Active note: note-1/);
  assert.match(p, /summarize$/);
});

test("dispatch: running → done on exit 0, capturing stdout", () => {
  const fc = fakeChild();
  const d = startDispatch(ENTRY, { prompt: "hi" }, () => fc.proc);
  assert.equal(d.status, "running");
  fc.out("created 2 notes");
  fc.exit(0);
  const after = getDispatch(d.id)!;
  assert.equal(after.status, "done");
  assert.match(after.output, /created 2 notes/);
  assert.ok(after.endedAt && after.endedAt >= after.startedAt);
});

test("dispatch: non-zero exit → error", () => {
  const fc = fakeChild();
  const d = startDispatch(ENTRY, { prompt: "boom" }, () => fc.proc);
  fc.exit(1);
  const after = getDispatch(d.id)!;
  assert.equal(after.status, "error");
  assert.match(after.error ?? "", /exited 1/);
});

test("dispatch: spawn error → error (never stuck running)", () => {
  const d = startDispatch(ENTRY, { prompt: "x" }, () => {
    throw new Error("ENOENT claude");
  });
  assert.equal(d.status, "error");
  assert.match(d.error ?? "", /failed to spawn|ENOENT/);
});

test("dispatch: cancel terminates a running dispatch", () => {
  const fc = fakeChild();
  const d = startDispatch(ENTRY, { prompt: "long" }, () => fc.proc);
  assert.equal(cancelDispatch(d.id), true);
  assert.equal(getDispatch(d.id)!.status, "cancelled");
  // a second cancel is a no-op
  assert.equal(cancelDispatch(d.id), false);
});

test("listDispatches is scoped per vault, newest first", () => {
  startDispatch(ENTRY, { prompt: "a" }, () => fakeChild().proc);
  startDispatch({ ...ENTRY, id: "vault-b" }, { prompt: "b" }, () => fakeChild().proc);
  assert.equal(listDispatches("primary").length, 1);
  assert.equal(listDispatches("vault-b").length, 1);
  assert.equal(listDispatches("primary")[0]!.vaultId, "primary");
});
