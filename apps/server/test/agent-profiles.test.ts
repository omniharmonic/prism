/**
 * Agent profiles + billing mode (Arch v2 WP3.4) — pure checks, no runner, no
 * network, no real `claude`.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRISM_READ_TOOLS,
  PRISM_WRITE_TOOLS,
  SKILL_TOOLS,
  READ_WRITE_TOOLS,
  profileAllowedTools,
  isSessionProfile,
  availableSessionProfiles,
  prismMcpConfig,
  type AgentProfile,
} from "../src/agent-profiles";
import { buildClaudeArgs } from "../src/agent-exec";
import { checkReadOnlyEnforced, findInitEvent, toolsDeniedByProfile } from "../src/agent-init-check";
import { PRISM_TOOLS } from "../src/mcp/router";
import { billingFromAuthStatus, configureBilling, getBillingMode, probeBilling } from "../src/agent-billing";
import { resetDb } from "./helpers";
import { INTERNAL_PAT_MAX_MS, isInternalPat, issueInternalPat, listLivePats, revokeInternalPats, sanitizePatLabel, verifyPat } from "../src/auth/pat";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

beforeEach(() => {
  resetDb();
  delete process.env.AGENT_PRISM_PROFILES;
  configureBilling();
});

test("skill profile = vault-rw minus delete-note; never the whole server", () => {
  assert.ok(!SKILL_TOOLS.includes("delete-note"));
  assert.deepEqual(SKILL_TOOLS, READ_WRITE_TOOLS.filter((t) => t !== "delete-note"));
  const l = profileAllowedTools("skill");
  assert.ok(l.includes("mcp__parachute-vault__create-note") && l.includes("mcp__parachute-vault__update-note"));
  assert.ok(!l.includes("mcp__parachute-vault__delete-note") && !l.includes("mcp__parachute-vault"));
});

test("prism profiles: tool names are real catalog tools with the right scope; no delete/share/governance actions", () => {
  const byName = new Map(PRISM_TOOLS.map((t) => [t.name, t]));
  for (const n of PRISM_READ_TOOLS) assert.equal(byName.get(n)?.scope, "read", `${n} must exist with scope read`);
  for (const n of PRISM_WRITE_TOOLS) assert.equal(byName.get(n)?.scope, "write", `${n} must exist with scope write`);
  for (const banned of ["prism_delete_note", "prism_share", "prism_propose_change", "prism_vote", "prism_withdraw_proposal"]) {
    assert.ok(!PRISM_WRITE_TOOLS.includes(banned as never), banned);
    assert.ok(!(PRISM_READ_TOOLS as readonly string[]).includes(banned), banned);
  }
  assert.deepEqual(
    profileAllowedTools("prism-ro"),
    PRISM_READ_TOOLS.map((t) => `mcp__prism__${t}`),
  );
  const rw = profileAllowedTools("prism-rw");
  assert.ok(rw.includes("mcp__prism__prism_create_note") && rw.includes("mcp__prism__prism_query_notes"));
  assert.ok(profileAllowedTools("prism-ro").every((t) => PRISM_TOOLS.find((p) => `mcp__prism__${p.name}` === t)!.scope === "read"));
});

test("graph-maintenance tools: every prism_people_* tool is assigned deliberately — reads to prism-ro + prism-rw, decisions to prism-rw only", () => {
  const people = PRISM_TOOLS.map((t) => t.name).filter((n) => n.startsWith("prism_people_"));
  const ro = profileAllowedTools("prism-ro"), rw = profileAllowedTools("prism-rw"), suggest = profileAllowedTools("prism-suggest");
  const reads = ["prism_people_review_queue", "prism_people_review_context", "prism_people_duplicates", "prism_people_link_status"];
  const decisions = ["prism_people_review_decide", "prism_people_recommend_merge", "prism_people_file_review"];
  assert.deepEqual([...people].sort(), [...reads, ...decisions].sort(), "a new prism_people_* tool needs an explicit profile decision here");
  for (const n of reads) assert.ok(ro.includes(`mcp__prism__${n}`) && rw.includes(`mcp__prism__${n}`), n);
  for (const n of decisions) {
    assert.ok(rw.includes(`mcp__prism__${n}`), `${n} in prism-rw`);
    assert.ok(!ro.includes(`mcp__prism__${n}`), `${n} never in prism-ro`);
    assert.ok(!suggest.includes(`mcp__prism__${n}`), `${n} never in prism-suggest`);
  }
  for (const p of ["vault-ro", "vault-rw", "skill"] as AgentProfile[]) assert.ok(!profileAllowedTools(p).some((t) => t.includes("prism_people_")), p);
});

test("buildClaudeArgs: a prism run may name ONLY prism tools; a vault run only vault tools", () => {
  const ok = buildClaudeArgs("hi", "/tmp/m.json", { server: "prism", allowedTools: profileAllowedTools("prism-ro") });
  assert.equal(ok[ok.indexOf("--allowedTools") + 1], profileAllowedTools("prism-ro").join(","));
  assert.throws(() => buildClaudeArgs("hi", "/tmp/m.json", { server: "prism", allowedTools: ["mcp__parachute-vault__create-note"] }), /prism MCP server/);
  assert.throws(() => buildClaudeArgs("hi", "/tmp/m.json", { server: "prism", allowedTools: ["Bash"] }), /prism MCP server/);
  assert.throws(() => buildClaudeArgs("hi", "/tmp/m.json", { allowedTools: ["mcp__prism__prism_query_notes"] }), /vault MCP server/);
  assert.throws(() => buildClaudeArgs("hi", "/tmp/m.json", { server: "prism", allowedTools: ["mcp__prismx__prism_query_notes"] }), /prism MCP server/);
  // Default for a prism run (no explicit list) is the prism server rule, not the vault one.
  const dflt = buildClaudeArgs("hi", "/tmp/m.json", { server: "prism" });
  assert.equal(dflt[dflt.indexOf("--allowedTools") + 1], "mcp__prism");
  // The hardened template is unchanged.
  assert.ok(dflt.includes("--strict-mcp-config") && dflt.includes("--tools") && dflt.includes("dontAsk"));
});

test("prism MCP config: loopback /mcp, the per-turn bearer only, no vault token", () => {
  const c = prismMcpConfig("pp_x", 8787) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
  assert.deepEqual(Object.keys(c.mcpServers), ["prism"]);
  assert.equal(c.mcpServers.prism!.url, "http://127.0.0.1:8787/mcp");
  assert.deepEqual(c.mcpServers.prism!.headers, { Authorization: "Bearer pp_x" });
});

test("prism profiles are OFF unless AGENT_PRISM_PROFILES is true", () => {
  assert.deepEqual(availableSessionProfiles(), ["vault-ro", "vault-rw"]);
  assert.equal(isSessionProfile("prism-ro"), false);
  assert.equal(isSessionProfile("skill"), false, "skill is server-internal, never a user pick");
  process.env.AGENT_PRISM_PROFILES = "true";
  assert.deepEqual(availableSessionProfiles(), ["vault-ro", "vault-rw", "prism-ro", "prism-rw", "prism-suggest"]);
  assert.equal(isSessionProfile("prism-rw"), true);
  assert.equal(isSessionProfile("root"), false);
});

test("read-only profile cannot call create-note/update-note: recorded system/init exposes them, the allowlist denies them", () => {
  const init = findInitEvent(fixture("agent-stream-ro-denied.jsonl"))!;
  assert.ok(init.tools!.includes("mcp__parachute-vault__create-note"), "the CLI lists write tools (denial is the permission layer's job)");
  const denied = toolsDeniedByProfile(init, "vault-ro");
  assert.ok(denied.includes("mcp__parachute-vault__create-note") && denied.includes("mcp__parachute-vault__update-note"));
  assert.deepEqual(checkReadOnlyEnforced(init, "vault-ro"), []);
  // vault-rw would allow them — and the checker says so.
  assert.ok(checkReadOnlyEnforced(init, "vault-rw").some((p) => /create-note/.test(p)));
  for (const p of ["vault-ro", "prism-ro"] as AgentProfile[]) assert.deepEqual(checkReadOnlyEnforced({ tools: [] }, p), []);
  assert.ok(checkReadOnlyEnforced({ tools: [] }, "prism-rw").some((p) => /prism_create_note/.test(p)));
});

test("billing: authMethod → mode (claude.ai = subscription, api key = api, anything else unknown)", () => {
  assert.equal(billingFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c" })), "subscription");
  assert.equal(billingFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "oauth_token" })), "subscription");
  assert.equal(billingFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key" })), "api");
  assert.equal(billingFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "bedrock" })), "api");
  assert.equal(billingFromAuthStatus(JSON.stringify({ loggedIn: false, authMethod: "claude.ai" })), "unknown");
  assert.equal(billingFromAuthStatus(JSON.stringify({ loggedIn: true })), "unknown");
  assert.equal(billingFromAuthStatus("not json"), "unknown");
  assert.equal(billingFromAuthStatus(null), "unknown");
});

test("billing: probe is injectable, cached, never throws, and unknown until it answers", async () => {
  assert.equal(getBillingMode(), "unknown");
  let runs = 0;
  configureBilling(async () => {
    runs++;
    return JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });
  });
  assert.equal(getBillingMode(), "unknown", "reading never probes");
  assert.equal(runs, 0);
  assert.equal(await probeBilling(), "subscription");
  assert.equal(getBillingMode(), "subscription");
  assert.equal(getBillingMode(), "subscription");
  assert.equal(runs, 1, "cached");
  configureBilling(async () => {
    throw new Error("spawn ENOENT");
  });
  assert.equal(await probeBilling(), "unknown");
});

test("per-turn PAT: <=3h, scoped, verifies, revoked on demand, hidden from lists, label prefix reserved", () => {
  const now = Date.now();
  const { token, row } = issueInternalPat({ email: "o@x.org", vaultId: "primary", scope: "read", turnId: "t-1", ttlMs: 99 * 3600_000, now });
  assert.ok(token.startsWith("pp_"));
  assert.ok(row.expires_at - now <= INTERNAL_PAT_MAX_MS, "ttl is clamped to 3h");
  assert.equal(row.scope, "read");
  assert.ok(isInternalPat(row));
  assert.ok(verifyPat(token, now + 1000));
  assert.equal(verifyPat(token, now + INTERNAL_PAT_MAX_MS + 1), null, "expires on its own");
  // a user label can never impersonate the internal prefix
  assert.ok(!isInternalPat({ label: sanitizePatLabel("agent-turn:evil") }));
  // boot sweep revokes live internal PATs only
  const other = issueInternalPat({ email: "o@x.org", vaultId: "primary", scope: "write", turnId: "t-2" });
  assert.equal(revokeInternalPats(), 2);
  assert.equal(verifyPat(token, now + 2000), null);
  assert.equal(verifyPat(other.token), null);
  assert.equal(listLivePats("o@x.org").length, 0);
});
