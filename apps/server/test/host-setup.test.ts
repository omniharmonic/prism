/**
 * `prism setup` (packaging/host/cli/setup.ts) and `prism token` (packaging/host/cli/token.ts):
 * the step runner as a state machine (order, stop, resume, dry run), the shared step ids
 * (checklist ⇄ run ⇄ skill), the token commands against a FAKE `parachute` binary (a shell
 * script in a scratch folder — no real Parachute, no network), the real steps against a scratch
 * install with an injected vault / server, and `POST /auth/local/setup`. No wall clock.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runSteps, cmdSetup, findExecutable, stockParachuteCommands, type StepImpl, type StepEvent, type SetupDeps } from "../../../packaging/host/cli/setup";
import { cmdToken, tokenFacts, parachuteCallEnv } from "../../../packaging/host/cli/token";
import { EXIT } from "../../../packaging/host/cli/exit-codes";
import { layoutFor, privateDirs, type Layout } from "../../../packaging/host/cli/paths";
import { emptyState, writeState } from "../../../packaging/host/cli/state";
import { freshEnv } from "../../../packaging/host/cli/hostenv";
import { parseArgs } from "../../../packaging/host/cli/args";
import { main, progressWriter } from "../../../packaging/host/cli/main";
import type { Ctx } from "../../../packaging/host/cli/commands";
import type { Fetch } from "../../../packaging/host/cli/health";
import type { MachineProbes } from "../../../packaging/host/cli/doctor";
import { parseEnv } from "../scripts/lib/env-file";
import { CHECKLIST_STEP_IDS, RUN_STEPS, RUN_STEP_IDS, skillForStep, type RunStepDef } from "../src/setup-steps";
import { setupSteps, type SetupFacts } from "../src/setup-status";
import type { SeedOptions, SeedResult } from "../scripts/lib/seed-tag-schemas";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { setHostKeyForTests } from "../src/auth/local-signin";
import { resetLocalSigninLimitsForTests } from "../src/routes/local-signin";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

const REPO = resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "prism-setup-test-"));
  roots.push(d);
  return d;
};
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// ── the runner as a state machine ────────────────────────────────────────────

const DEFS: RunStepDef[] = [
  { id: "a", title: "A", blocking: true, checklist: false, skill: "s" },
  { id: "b", title: "B", blocking: true, checklist: false, skill: "s" },
  { id: "c", title: "C", blocking: false, checklist: false, skill: "s" },
  { id: "d", title: "D", blocking: false, checklist: false, skill: "s" },
];
type World = { calls: string[]; outcome: Record<string, Awaited<ReturnType<StepImpl<World>>>> };
const impls = (w: World): Record<string, StepImpl<World>> =>
  Object.fromEntries(DEFS.map((d) => [d.id, async () => (w.calls.push(d.id), w.outcome[d.id] ?? { state: "done" })]));

test("runner: every step in order, one event each; all done → exit 0, complete, nothing to resume", async () => {
  const w: World = { calls: [], outcome: {} };
  const seen: StepEvent[] = [];
  const r = await runSteps(DEFS, impls(w), w, { dryRun: false, emit: (e) => seen.push(e) });
  assert.deepEqual(w.calls, ["a", "b", "c", "d"]);
  assert.deepEqual(seen.map((e) => [e.event, e.id, e.state]), DEFS.map((d) => ["step", d.id, "done"]));
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.complete, true);
  assert.equal(r.resumeFrom, null);
  assert.equal(r.next, null);
});

test("runner: a blocking needs-person stops the run (exit 12) and says where to resume", async () => {
  const w: World = { calls: [], outcome: { b: { state: "needs-person", next: "ask for the email" } } };
  const r = await runSteps(DEFS, impls(w), w, { dryRun: false });
  assert.deepEqual(w.calls, ["a", "b"]);
  assert.equal(r.code, EXIT.NEEDS_PERSON);
  assert.equal(r.stoppedAt, "b");
  assert.equal(r.resumeFrom, "b");
  assert.equal(r.next, "ask for the email");
  assert.equal(r.complete, false);
});

test("runner: person steps that are not blocking are all reported, the run still ends 0", async () => {
  const w: World = { calls: [], outcome: { c: { state: "needs-person", next: "install the app" }, d: { state: "needs-person", next: "open on the phone" } } };
  const r = await runSteps(DEFS, impls(w), w, { dryRun: false });
  assert.deepEqual(w.calls, ["a", "b", "c", "d"]);
  assert.equal(r.code, EXIT.OK);
  assert.deepEqual(r.pending, ["c", "d"]);
  assert.equal(r.resumeFrom, "c");
  assert.equal(r.next, "install the app");
  assert.equal(r.complete, true, "only blocking steps decide 'complete'");
});

test("runner: a failed step (returned or thrown) stops with its exit code; the message becomes `next`", async () => {
  const w: World = { calls: [], outcome: { a: { state: "failed", code: EXIT.PRECONDITION, next: "not a Mac" } } };
  const r = await runSteps(DEFS, impls(w), w, { dryRun: false });
  assert.deepEqual([r.code, r.stoppedAt, r.next], [EXIT.PRECONDITION, "a", "not a Mac"]);
  const thrown = await runSteps(DEFS, { ...impls(w), a: async () => { throw new Error("boom"); } }, w, { dryRun: false });
  assert.deepEqual([thrown.code, thrown.steps[0]!.state, thrown.steps[0]!.next], [EXIT.ERROR, "failed", "boom"]);
});

test("runner: --from resumes at that step (earlier steps neither run nor reported); an unknown step is a usage error", async () => {
  const w: World = { calls: [], outcome: {} };
  const r = await runSteps(DEFS, impls(w), w, { dryRun: false, from: "c" });
  assert.deepEqual(w.calls, ["c", "d"]);
  assert.deepEqual(r.steps.map((s) => s.id), ["c", "d"]);
  await assert.rejects(runSteps(DEFS, impls(w), w, { dryRun: false, from: "nope" }), (e: { code?: number }) => e.code === EXIT.USAGE);
});

test("runner: a dry run reports every step even past a blocking stop", async () => {
  const w: World = { calls: [], outcome: { a: { state: "needs-person", next: "x" }, b: { state: "skipped", detail: "dry run" } } };
  const r = await runSteps(DEFS, impls(w), w, { dryRun: true });
  assert.deepEqual(w.calls, ["a", "b", "c", "d"]);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.dryRun, true);
});

test("runner: idempotency — a world that is set up reports done with nothing changed, twice", async () => {
  const state = { installed: false };
  const changing: Record<string, StepImpl<World>> = {
    ...impls({ calls: [], outcome: {} }),
    a: async () => (state.installed ? { state: "done", changed: [] } : ((state.installed = true), { state: "done", changed: ["installed"] })),
  };
  const first = await runSteps(DEFS, changing, { calls: [], outcome: {} }, { dryRun: false });
  assert.deepEqual(first.steps[0]!.changed, ["installed"]);
  for (let i = 0; i < 2; i++) {
    const again = await runSteps(DEFS, changing, { calls: [], outcome: {} }, { dryRun: false });
    assert.ok(again.steps.every((s) => s.state === "done" && s.changed!.length === 0));
  }
});

// ── one list of step ids ─────────────────────────────────────────────────────

const allFacts: SetupFacts = { vaultReachable: true, secretsAvailable: true, emailConfigured: false, appOrigin: "http://localhost:8787", agentTokens: 0, agentTokenUsed: false, devices: 0, integrations: { matrix: false, github: true } };

test("step ids: the checklist emits exactly CHECKLIST_STEP_IDS (+ integration:<kind>), and the run reuses them where it has the step", () => {
  const emitted = setupSteps(allFacts).map((s) => s.id);
  const plain = emitted.filter((id) => !id.startsWith("integration:"));
  assert.deepEqual([...plain].sort(), [...CHECKLIST_STEP_IDS].sort(), "the checklist and the shared list agree");
  assert.equal(new Set(RUN_STEP_IDS).size, RUN_STEP_IDS.length, "run ids are unique");
  for (const s of RUN_STEPS) {
    assert.equal((CHECKLIST_STEP_IDS as readonly string[]).includes(s.id), s.checklist, `${s.id}: marked checklist iff it is a checklist id`);
    assert.ok(skillForStep(s.id), s.id);
  }
  for (const id of emitted) assert.ok(skillForStep(id), `${id} has a skill`);
  // The checklist UI names each step it shows.
  const ui = readFileSync(join(REPO, "packages/core/src/components/renderers/network/SetupChecklist.tsx"), "utf8");
  for (const id of CHECKLIST_STEP_IDS) assert.ok(ui.includes(`${/^[a-z]+$/.test(id) ? id : `"${id}"`}:`), `SetupChecklist names ${id}`);
});

test("step ids: the prism-setup skill lists every run step and every checklist step, and each step's skill exists", () => {
  const skill = readFileSync(join(REPO, ".claude/skills/prism-setup/SKILL.md"), "utf8");
  for (const id of [...RUN_STEP_IDS, ...CHECKLIST_STEP_IDS]) assert.ok(skill.includes(`\`${id}\``), `SKILL.md mentions \`${id}\``);
  for (const s of new Set(RUN_STEPS.map((x) => x.skill))) assert.ok(existsSync(join(REPO, ".claude/skills", s, "SKILL.md")), s);
  const vault = readFileSync(join(REPO, ".claude/skills/prism-setup-vault/SKILL.md"), "utf8");
  assert.ok(!/capture the JWT/i.test(vault), "the vault skill no longer asks the agent to capture a token");
});

// ── a fake Parachute + a scratch install ─────────────────────────────────────

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const NOW = new Date("2026-10-20T00:00:00Z");
const jwt = (jti: string, scope: string, expDays = 365, iss = "http://127.0.0.1:1939") =>
  `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64({ jti, scope, iss, exp: Math.floor(NOW.getTime() / 1000) + expDays * 86400 })}.c2lnbmF0dXJlc2ln`;

/**
 * A fake `parachute`: logs each call's argv into $PARACHUTE_HOME/calls, and on `auth mint-token`
 * prints the next prepared token ($PARACHUTE_HOME/tok<N>). `bootstrap --embedded --json` prints
 * {"created":…} (true the first time).
 */
const FAKE = `#!/bin/sh
rec="$PARACHUTE_HOME"
printf '%s\\n' "$*" >> "$rec/calls"
case "$1 $2" in
  "auth mint-token")
    n=$(cat "$rec/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$rec/n"
    cat "$rec/tok$n" ;;
  "auth revoke-token") echo "revoked $3" ;;
  "bootstrap --embedded")
    if [ -e "$rec/booted" ]; then echo '{"created":false}'; else : > "$rec/booted"; echo '{"created":true}'; fi ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
`;

interface World2 {
  root: string;
  layout: Layout;
  home: string;
  pHome: string;
  bin: string;
  /** Tokens the vault accepts. */
  accepted: Set<string>;
  vaultUp: boolean;
  server: { live: boolean; version: string; checklist: Array<{ id: string; done: boolean; group: string; detail?: string }> | null };
  fetches: string[];
  links: string[];
  opened: string[];
}

function writeBundle(dir: string, version: string, embedded = false) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "share"), { recursive: true });
  writeFileSync(join(dir, "bin", "prism"), "#!/bin/sh\n");
  const info = { name: "prism-host", version, platform: "darwin", arch: "arm64", commit: "x", builtAt: "2026-10-20", node: { version: "22.0.0", sha256: "x" }, parachute: { bundled: embedded, version: null }, paths: { node: "runtime/node/bin/node", cli: "libexec/prism.mjs", server: "app/apps/server/src/index.ts", tsxLoader: "x", web: "app/apps/web/dist", webNative: "x", launchd: "share/launchd" } };
  writeFileSync(join(dir, "build-info.json"), JSON.stringify(info));
  if (!existsSync(join(dir, "share", "launchd"))) symlinkSync(join(REPO, "packaging/host/launchd"), join(dir, "share", "launchd"));
}

/** An installed prefix (no launchd, Parachute external unless `embedded`), .env with no token yet. */
function world(o: { installed?: boolean; embedded?: boolean; tokens?: string[]; parachuteOnEnv?: boolean } = {}): World2 {
  const root = scratch();
  const home = join(root, "home");
  mkdirSync(home);
  const layout = layoutFor(join(root, "Host"));
  const pHome = join(root, "parachute-home");
  mkdirSync(pHome);
  const bin = join(root, "bin", "parachute");
  mkdirSync(join(root, "bin"));
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  (o.tokens ?? []).forEach((t, i) => writeFileSync(join(pHome, `tok${i + 1}`), t + "\n"));
  if (o.installed !== false) {
    for (const d of privateDirs(layout)) mkdirSync(d, { recursive: true, mode: 0o700 });
    const s = emptyState(NOW.toISOString(), false, o.embedded ? "embedded" : "external");
    s.current = "0.9.0";
    s.installed = ["0.9.0"];
    writeState(layout, s);
    writeBundle(join(layout.appRoot, "0.9.0"), "0.9.0", o.embedded);
    symlinkSync("0.9.0", layout.current);
    if (o.embedded) {
      mkdirSync(join(layout.appRoot, "0.9.0", "parachute", "bin"), { recursive: true });
      writeFileSync(join(layout.appRoot, "0.9.0", "parachute", "bin", "parachute"), FAKE);
      chmodSync(join(layout.appRoot, "0.9.0", "parachute", "bin", "parachute"), 0o755);
    }
    let env = freshEnv(layout, { ownerEmail: "owner@example.com", port: 9611, parachuteUrl: "http://127.0.0.1:19401", parachuteHome: pHome });
    if (o.parachuteOnEnv) env += `PARACHUTE_BIN=${bin}\n`;
    writeFileSync(layout.envFile, env, { mode: 0o600 });
    writeFileSync(join(layout.data, "host-signin.key"), "setup-test-host-key-0123456789abcdefghijkl\n", { mode: 0o600 });
  }
  return { root, layout, home, pHome, bin, accepted: new Set(), vaultUp: true, server: { live: false, version: "0.9.0", checklist: null }, fetches: [], links: [], opened: [] };
}

function fakeFetch(w: World2): Fetch {
  return async (url, init) => {
    w.fetches.push(url);
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.startsWith("http://127.0.0.1:19401")) {
      if (!w.vaultUp) throw new Error("ECONNREFUSED");
      if (url.endsWith("/health")) return json(200, { ok: true });
      if (url.includes("/vault/default/api/tags")) {
        const tok = (init?.headers?.authorization ?? "").replace(/^Bearer /, "");
        return json(w.accepted.has(tok) ? 200 : 401, w.accepted.has(tok) ? [] : { error: "unauthorized" });
      }
      return json(404, {});
    }
    if (url.startsWith("http://127.0.0.1:9611")) {
      if (!w.server.live) throw new Error("ECONNREFUSED");
      if (url.endsWith("/health?live=1") || url.endsWith("/health")) return json(200, { ok: true });
      if (url.endsWith("/api/version")) return json(200, { version: w.server.version });
      if (url.endsWith("/auth/local/setup")) return w.server.checklist ? json(200, { ready: true, steps: w.server.checklist }) : json(404, { error: "not_found" });
      if (url.endsWith("/auth/local/link")) {
        const link = `http://localhost:9611/auth/local/signin?token=${"t".repeat(43)}`;
        w.links.push(link);
        return json(201, { url: link, expiresAt: "2026-10-20T00:10:00.000Z", expiresInSeconds: 600, email: "owner@example.com", appOrigin: "http://localhost:9611", appOriginIsLocal: true });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const okProbes: MachineProbes = { hardwareArch: () => "arm64", platform: () => "darwin", macosVersion: () => "15.1", portFree: async () => true, freeBytes: () => 50 * 1024 ** 3, isRoot: () => false };

function ctxFor(w: World2, env: NodeJS.ProcessEnv = {}): Ctx {
  return {
    bundleRoot: join(w.layout.appRoot, "0.9.0"),
    home: w.home,
    uid: 501,
    env: { PATH: "/usr/bin:/bin", HOME: w.home, PARACHUTE_HOME: w.pHome, PRISM_APPLICATIONS_DIRS: join(w.root, "Applications"), PRISM_TAILSCALE_BIN: join(w.root, "no-tailscale"), ...env },
    // `launchctl print` finds nothing loaded (no Parachute unit of its own on this "Mac").
    runner: async (cmd, args) => (cmd === "launchctl" && args[0] === "print" ? { code: 113, stdout: "", stderr: "Could not find service" } : { code: 0, stdout: "", stderr: "" }),
    fetch: fakeFetch(w),
    probes: okProbes,
    openSqlite: () => { throw new Error("unused"); },
    copyTree: () => {},
    now: () => NOW,
    log: () => {},
    healthTimeoutMs: 1000,
    openUrl: async (u) => void w.opened.push(u),
  };
}

const calls = (w: World2) => (existsSync(join(w.pHome, "calls")) ? readFileSync(join(w.pHome, "calls"), "utf8").trim().split("\n").filter(Boolean) : []);
const env = (w: World2) => parseEnv(readFileSync(w.layout.envFile, "utf8"));
const tokenArgs = (w: World2, sub: string, extra: string[] = []) => parseArgs(["token", sub, "--prefix", w.layout.prefix, ...extra], { bool: ["force", "dry-run", "json"], value: ["prefix", "expires-in"] });

// ── prism token ──────────────────────────────────────────────────────────────

test("token: the install's .env decides the Parachute binary and home; the caller's secrets never reach the CLI env", () => {
  const { parentEnv, config: cfg } = parachuteCallEnv({ PATH: "/bin", PARACHUTE_TOKEN: "x", PARACHUTE_BIN: "/caller/parachute" }, "PARACHUTE_BIN=/install/parachute\nPARACHUTE_HOME=/install/home\nPARACHUTE_TOKEN=secret\n");
  assert.equal(cfg.bin, "/install/parachute");
  assert.equal(cfg.home, "/install/home");
  assert.notEqual(parentEnv.PARACHUTE_TOKEN, "secret", "the .env's token is not copied into the call env");
});

test("token status: no token → exit 4 and `next`; facts are jti/exp/scope only", async () => {
  const w = world();
  const r = await cmdToken(ctxFor(w), tokenArgs(w, "status"));
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.match(String(r.next), /prism token mint/);
  const t = jwt("jti-a", "vault:default:write", 200);
  assert.deepEqual(tokenFacts(t, NOW), { jti: "jti-a", exp: new Date(NOW.getTime() + 200 * 86400_000).toISOString(), scope: "vault:default:write", expiresInDays: 200 });
});

test("token mint: minted by the fake CLI, checked against the vault, written into .env 0600 — never printed; SECRETS_KEY and every other line untouched", async () => {
  const t1 = jwt("jti-1", "vault:default:write");
  const w = world({ tokens: [t1], parachuteOnEnv: true });
  w.accepted.add(t1);
  const before = readFileSync(w.layout.envFile, "utf8");
  const r = await cmdToken(ctxFor(w), tokenArgs(w, "mint"));
  assert.equal(r.code, EXIT.OK, JSON.stringify(r));
  assert.equal(r.action, "minted");
  assert.deepEqual(calls(w), ["auth mint-token --scope vault:default:write --expires-in 31536000"]);
  assert.equal(env(w).PARACHUTE_TOKEN, t1);
  assert.equal(statSync(w.layout.envFile).mode & 0o777, 0o600);
  const after = readFileSync(w.layout.envFile, "utf8");
  assert.deepEqual(after.split("\n").filter((l) => !l.startsWith("PARACHUTE_TOKEN=")), before.split("\n").filter((l) => !l.startsWith("PARACHUTE_TOKEN=")));
  assert.ok(!JSON.stringify(r).includes(t1) && !JSON.stringify(r).includes(t1.split(".")[1]!), "the token is not in the result");
  assert.deepEqual((r.token as { jti: string }).jti, "jti-1");
  // again: a working token is left alone, the CLI is not called
  const again = await cmdToken(ctxFor(w), tokenArgs(w, "mint"));
  assert.equal(again.action, "unchanged");
  assert.equal(calls(w).length, 1);
});

test("token mint: the vault refuses the new token (the issuer/port-file bug) → exit 5, .env unchanged, the new jti revoked, the hint names hub.port", async () => {
  const bad = jwt("jti-bad", "vault:default:write", 365, "http://127.0.0.1:41939");
  const w = world({ tokens: [bad], parachuteOnEnv: true });
  const before = readFileSync(w.layout.envFile, "utf8");
  await assert.rejects(cmdToken(ctxFor(w), tokenArgs(w, "mint")), (e: { code?: number; message?: string }) => e.code === EXIT.VERIFY_FAILED && /hub\/run\/hub\.port/.test(e.message ?? "") && !(e.message ?? "").includes(bad));
  assert.equal(readFileSync(w.layout.envFile, "utf8"), before);
  assert.deepEqual(calls(w).slice(1), ["auth revoke-token jti-bad"]);
});

test("token rotate: mint → verify → swap → revoke the old jti (and say Parachute's ~60 s revocation cache); an unreachable vault changes nothing", async () => {
  const t1 = jwt("jti-old", "vault:default:write");
  const t2 = jwt("jti-new", "vault:default:write");
  const t3 = jwt("jti-never", "vault:default:write");
  const w = world({ tokens: [t2, t3], parachuteOnEnv: true });
  writeFileSync(w.layout.envFile, readFileSync(w.layout.envFile, "utf8").replace(/^PARACHUTE_TOKEN=.*$/m, `PARACHUTE_TOKEN=${t1}`), { mode: 0o600 });
  const secretsKey = env(w).SECRETS_KEY;
  w.accepted.add(t1).add(t2);
  const dry = await cmdToken(ctxFor(w), tokenArgs(w, "rotate", ["--dry-run"]));
  assert.equal(dry.code, EXIT.OK);
  assert.deepEqual(calls(w), [], "a dry run spawns nothing");
  const r = await cmdToken(ctxFor(w), tokenArgs(w, "rotate"));
  assert.equal(r.code, EXIT.OK, JSON.stringify(r));
  assert.equal(env(w).PARACHUTE_TOKEN, t2);
  assert.equal(env(w).SECRETS_KEY, secretsKey);
  assert.deepEqual(r.revoked, { jti: "jti-old", ok: true });
  assert.match(String(r.note), /60 seconds/);
  assert.deepEqual(calls(w), ["auth mint-token --scope vault:default:write --expires-in 31536000", "auth revoke-token jti-old"]);
  const out = JSON.stringify(r);
  for (const t of [t1, t2]) assert.ok(!out.includes(t));
  // the vault is down: rotate refuses to swap in an unchecked token, and revokes it again
  w.vaultUp = false;
  await assert.rejects(cmdToken(ctxFor(w), tokenArgs(w, "rotate")), (e: { code?: number }) => e.code === EXIT.PRECONDITION);
  assert.equal(env(w).PARACHUTE_TOKEN, t2);
  assert.equal(calls(w).at(-1), "auth revoke-token jti-never");
});

test("token: through main --json, stdout carries jti/exp/scope and never the token", async () => {
  const t1 = jwt("jti-main", "vault:default:write");
  const w = world({ tokens: [t1], parachuteOnEnv: true });
  w.accepted.add(t1);
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => (out.push(String(s)), true);
  try {
    assert.equal(await main(["token", "mint", "--prefix", w.layout.prefix, "--json"], ctxFor(w)), EXIT.OK);
    assert.equal(await main(["token", "status", "--prefix", w.layout.prefix, "--json"], ctxFor(w)), EXIT.OK);
  } finally {
    (process.stdout as { write: unknown }).write = orig;
  }
  const text = out.join("");
  assert.ok(!text.includes(t1) && !text.includes(t1.split(".")[1]!));
  const status = JSON.parse(out.at(-1)!);
  assert.deepEqual([status.set, status.token.jti, status.token.scope, status.vault], [true, "jti-main", "vault:default:write", "accepted"]);
});

// ── prism setup, the real steps ──────────────────────────────────────────────

function seedFake(): SetupDeps & { writes: number; admin: string[] } {
  const state = { seeded: false };
  const f = {
    writes: 0,
    admin: [] as string[],
    loadSchemas: () => ({ task: { description: "A task", fields: {} }, person: { description: "A person", fields: {} } }),
    async seed(o: SeedOptions): Promise<SeedResult> {
      const pending = state.seeded ? [] : ["task", "person"];
      if (!o.dryRun) {
        f.writes++;
        if (o.adminToken) f.admin.push(o.adminToken);
        state.seeded = true;
      }
      return { created: pending, updated: [], unchanged: state.seeded ? ["task", "person"] : [], skipped: [], details: {}, dryRun: !!o.dryRun };
    },
  };
  return f;
}

const setupArgs = (w: World2, extra: string[] = []) =>
  parseArgs(["setup", "--prefix", w.layout.prefix, ...extra], { bool: ["dry-run", "json", "no-signin", "no-launchd"], value: ["prefix", "from", "owner-email", "port"] });
const states = (r: { [k: string]: unknown }) => Object.fromEntries((r.steps as StepEvent[]).map((s) => [s.id, s.state]));

test("setup: nothing installed and no owner email → the install step asks for it (exit 12), nothing written", async () => {
  const w = world({ installed: false });
  const events: Record<string, unknown>[] = [];
  const ctx = { ...ctxFor(w), progress: (e: Record<string, unknown>) => events.push(e) };
  const r = await cmdSetup(ctx, setupArgs(w), seedFake());
  assert.equal(r.code, EXIT.NEEDS_PERSON);
  assert.deepEqual(states(r), { machine: "done", install: "needs-person" });
  assert.equal(r.resumeFrom, "install");
  assert.match(String(r.next), /--owner-email <email> --from install/);
  assert.deepEqual(events.map((e) => e.id), ["machine", "install"]);
  assert.equal(existsSync(w.layout.prefix), false);
});

test("setup: Parachute missing → needs-person with the exact install commands (agent, with consent; no `parachute init`)", async () => {
  const w = world();
  w.vaultUp = false;
  const r = await cmdSetup(ctxFor(w), setupArgs(w), seedFake());
  assert.equal(r.code, EXIT.NEEDS_PERSON);
  assert.equal(r.stoppedAt, "vault");
  const v = (r.steps as StepEvent[]).find((s) => s.id === "vault")!;
  assert.deepEqual(v.commands, stockParachuteCommands());
  assert.deepEqual(v.commands!.map((c) => c.who), ["agent-with-consent", "agent-with-consent"]);
  assert.ok(!v.commands!.some((c) => /\binit\b/.test(c.run)), "never `parachute init` (it installs Parachute's own launchd unit)");
  assert.match(v.commands![1]!.run, /@openparachute\/hub@0\.7\.19 @openparachute\/vault@0\.7\.9/);
  assert.deepEqual(calls(w), [], "nothing was installed or run");
});

test("setup: from an install with Parachute running → explicit binary path, token minted into .env, schemas seeded with a short-lived admin token; stops at the server; a re-run changes nothing", async () => {
  const t1 = jwt("jti-srv", "vault:default:write");
  const admin = jwt("jti-admin", "vault:default:admin", 0);
  const w = world({ tokens: [t1, admin] });
  w.accepted.add(t1);
  const deps = seedFake();
  const ctx = ctxFor(w, { PARACHUTE_BIN: w.bin });
  const before = env(w);
  const r = await cmdSetup(ctx, setupArgs(w), deps);
  assert.deepEqual(states(r), { machine: "done", install: "done", vault: "done", secrets: "done", "vault-token": "done", schemas: "done", server: "needs-person" });
  assert.equal(r.code, EXIT.NEEDS_PERSON, "an install without launchd: the person starts the server");
  assert.equal(r.resumeFrom, "server");
  const after = env(w);
  assert.equal(after.PARACHUTE_BIN, w.bin, "the binary found is recorded as an explicit path");
  assert.equal(after.PARACHUTE_TOKEN, t1);
  for (const k of ["SECRETS_KEY", "SESSION_SECRET", "GOVERNANCE_SIGNING_SECRET", "COLLAB_TOKEN"]) assert.equal(after[k], before[k], k);
  assert.deepEqual(calls(w), ["auth mint-token --scope vault:default:write --expires-in 31536000", "auth mint-token --scope vault:default:admin --ephemeral"]);
  assert.deepEqual(deps.admin, [admin], "the admin token went to the seed only");
  assert.ok(!JSON.stringify(r).includes(t1) && !JSON.stringify(r).includes(admin));
  assert.deepEqual((r.steps as StepEvent[]).find((s) => s.id === "vault-token")!.changed, ["PARACHUTE_TOKEN"]);

  const envText = readFileSync(w.layout.envFile, "utf8");
  const again = await cmdSetup(ctx, setupArgs(w), deps);
  assert.deepEqual(states(again), states(r));
  assert.ok((again.steps as StepEvent[]).every((s) => s.changed!.length === 0), "nothing changed on the second run");
  assert.equal(readFileSync(w.layout.envFile, "utf8"), envText);
  assert.equal(calls(w).length, 2, "no new mint");
  assert.equal(deps.writes, 1, "no second seed write");
});

test("setup: a stale secret set is completed — missing keys added, existing SECRETS_KEY never replaced", async () => {
  const t1 = jwt("jti-s", "vault:default:write");
  const w = world({ tokens: [t1], parachuteOnEnv: true });
  w.accepted.add(t1);
  const text = readFileSync(w.layout.envFile, "utf8");
  const key = parseEnv(text).SECRETS_KEY;
  writeFileSync(w.layout.envFile, text.replace(/^COLLAB_TOKEN=.*\n/m, ""), { mode: 0o600 });
  const r = await cmdSetup(ctxFor(w), setupArgs(w, ["--from", "secrets"]), seedFake());
  const s = (r.steps as StepEvent[])[0]!;
  assert.deepEqual([s.id, s.state, s.changed], ["secrets", "done", ["COLLAB_TOKEN"]]);
  assert.equal(env(w).SECRETS_KEY, key);
});

test("setup --from owner on a running server: the checklist decides; a sign-in link is opened (never reported); person steps listed together, exit 0", async () => {
  const t1 = jwt("jti-o", "vault:default:write");
  const w = world({ tokens: [t1], parachuteOnEnv: true });
  w.server.live = true;
  w.server.checklist = [
    { id: "owner", group: "core", done: false },
    { id: "device", group: "devices", done: false, detail: "No app has signed in to this server yet." },
    { id: "reachable", group: "devices", done: false, detail: "This server answers on this computer only." },
    { id: "integration:github", group: "optional", done: true },
  ];
  const r = await cmdSetup(ctxFor(w), setupArgs(w, ["--from", "owner"]), seedFake());
  assert.equal(r.code, EXIT.OK, JSON.stringify(r));
  assert.deepEqual(states(r), { owner: "needs-person", "mac-client": "needs-person", device: "needs-person", reachable: "needs-person", integrations: "done" });
  assert.deepEqual(r.pending, ["owner", "mac-client", "device", "reachable"]);
  assert.equal(w.opened.length, 1, "the link went to the browser");
  assert.ok(!JSON.stringify(r).includes(w.links[0]!), "and not into the result");
  const step = (id: string) => (r.steps as StepEvent[]).find((s) => s.id === id)!;
  assert.match(step("mac-client").next!, /releases\/latest.*http:\/\/localhost:9611/);
  assert.match(step("reachable").next!, /Tailscale/);
  assert.match(step("integrations").detail!, /integration:github/);

  // the person did it: password set, app installed, phone signed in
  w.server.checklist = w.server.checklist.map((s) => ({ ...s, done: s.id !== "reachable" }));
  mkdirSync(join(w.root, "Applications", "Prism Client.app"), { recursive: true });
  const after = await cmdSetup(ctxFor(w), setupArgs(w, ["--from", "owner"]), seedFake());
  assert.deepEqual(states(after), { owner: "done", "mac-client": "done", device: "done", reachable: "needs-person", integrations: "done" });
  assert.equal(w.opened.length, 1, "no second link once the owner is done");
});

test("setup --dry-run on an install: reports every step, writes nothing, spawns nothing, opens nothing", async () => {
  const w = world({ parachuteOnEnv: true });
  const before = readFileSync(w.layout.envFile, "utf8");
  const r = await cmdSetup(ctxFor(w), setupArgs(w, ["--dry-run"]), seedFake());
  assert.equal(r.code, EXIT.OK);
  assert.deepEqual((r.steps as StepEvent[]).map((s) => s.id), RUN_STEP_IDS);
  assert.equal(states(r)["vault-token"], "skipped");
  assert.equal(readFileSync(w.layout.envFile, "utf8"), before);
  assert.deepEqual(calls(w), []);
  assert.deepEqual(w.opened, []);
});

test("setup: embedded Parachute → the bundled payload's bootstrap, idempotent (created once)", async () => {
  const w = world({ embedded: true });
  const deps = seedFake();
  const r1 = await cmdSetup(ctxFor(w), setupArgs(w, ["--from", "vault"]), deps);
  const v1 = (r1.steps as StepEvent[])[0]!;
  assert.deepEqual([v1.id, v1.state, v1.changed], ["vault", "done", ["parachute-bootstrap"]]);
  const r2 = await cmdSetup(ctxFor(w), setupArgs(w, ["--from", "vault"]), deps);
  assert.deepEqual((r2.steps as StepEvent[])[0]!.changed, []);
  assert.deepEqual(calls(w).filter((c) => c.startsWith("bootstrap")), ["bootstrap --embedded --json", "bootstrap --embedded --json"]);
});

test("setup: findExecutable — explicit absolute path, then PATH, then ~/.bun/bin; nothing → null", () => {
  const w = world({ installed: false });
  const env0 = { PATH: "/nonexistent" };
  assert.equal(findExecutable("parachute", [w.bin], env0, w.home), w.bin);
  assert.equal(findExecutable("parachute", [], { PATH: join(w.root, "bin") }, w.home), w.bin);
  assert.equal(findExecutable("parachute", [], env0, w.home), null);
  mkdirSync(join(w.home, ".bun", "bin"), { recursive: true });
  writeFileSync(join(w.home, ".bun", "bin", "parachute"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(findExecutable("parachute", [], env0, w.home), join(w.home, ".bun", "bin", "parachute"));
});

test("setup progress: --json writes one JSON line per step on stdout; otherwise a line on stderr", () => {
  const out: Array<[string, string]> = [];
  const ev = { event: "step", id: "vault", state: "needs-person", title: "T", next: "do it" };
  progressWriter(true, (s, t) => out.push([s, t]))(ev);
  progressWriter(false, (s, t) => out.push([s, t]))(ev);
  assert.deepEqual(JSON.parse(out[0]![1]), ev);
  assert.equal(out[0]![0], "stdout");
  assert.equal(out[1]![0], "stderr");
  assert.match(out[1]![1], /vault .*\n {4}do it/);
});

// ── POST /auth/local/setup (the server half) ─────────────────────────────────

describeRoute();
function describeRoute() {
  const KEY = "setup-route-host-key-0123456789abcdefghijk";
  const loop = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
  const BASE = `http://127.0.0.1:${config.port}`;
  let fv: FakeVault;
  let app: ReturnType<typeof createApp>;
  const call = (opts: { auth?: string; body?: string; headers?: Record<string, string>; env?: object } = {}) =>
    app.request(`${BASE}/auth/local/setup`, { method: "POST", headers: { "content-type": "application/json", authorization: opts.auth ?? `Bearer ${KEY}`, ...opts.headers }, body: opts.body ?? "{}" }, opts.env ?? loop);

  before(() => setHostKeyForTests(KEY));
  after(() => setHostKeyForTests(null));
  beforeEach(() => {
    resetDb();
    fv = installFakeVault();
    app = createApp();
    resetLocalSigninLimitsForTests();
  });
  afterEach(() => fv.restore());

  test("POST /auth/local/setup: the checklist for the host CLI — same ids as GET /acl/setup, no secret", async () => {
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const body = (await r.json()) as { ready: boolean; steps: Array<{ id: string }> };
    for (const id of CHECKLIST_STEP_IDS) assert.ok(body.steps.some((s) => s.id === id), id);
    assert.ok(!JSON.stringify(body).includes(KEY));
  });

  test("POST /auth/local/setup: the host-key gate — wrong key 401, a browser 403, off loopback 404, fields refused", async () => {
    assert.equal((await call({ auth: "Bearer wrong-key-0123456789abcdefghijklmnop" })).status, 401);
    assert.equal((await call({ headers: { origin: "http://localhost:8787" } })).status, 403);
    assert.equal((await call({ env: { incoming: { socket: { remoteAddress: "100.64.0.9" } } } })).status, 404);
    assert.equal((await call({ body: '{"x":1}' })).status, 400);
  });
}
