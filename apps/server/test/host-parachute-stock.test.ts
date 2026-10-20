/**
 * Stock Parachute run by Prism (packaging/host/cli/parachute-stock.ts — the launch plan's §3.4
 * fallback) and `prism setup`'s run-wide lock. No real Parachute, no launchd: FAKE `parachute` /
 * `parachute-vault` shell scripts in a scratch folder, an injected `launchctl` that only records
 * what it is asked, an injected fetch for the hub (:1939) and vault (:1940) — never the real
 * ports. No wall-clock assertion: readiness answers at once, the lock's clock is injected.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { adminExists, chooseParachuteHome, detectParachuteUnits, knownParachutePaths, parachuteUnitLabels, runStockHub, stockHubCommand, tightenParachuteModes, vaultExists, type ForeignUnit } from "../../../packaging/host/cli/parachute-stock";
import { acquireRunLock, readRunLock, runLockState } from "../../../packaging/host/cli/fsutil";
import { Launchd, type Runner } from "../../../packaging/host/cli/launchd";
import { loadIdentity, loadTemplate, renderAgent } from "../../../packaging/host/cli/plist";
import { layoutFor, privateDirs, type Layout } from "../../../packaging/host/cli/paths";
import { emptyState, readState, writeState } from "../../../packaging/host/cli/state";
import { freshEnv } from "../../../packaging/host/cli/hostenv";
import { parseArgs } from "../../../packaging/host/cli/args";
import { agentsFor, cmdInstall, cmdRun, type Ctx } from "../../../packaging/host/cli/commands";
import { cmdSetup, setPasswordCommand, SETUP_STEP_IMPLS, type SetupDeps, type StepEvent } from "../../../packaging/host/cli/setup";
import { waitForParachute } from "../../../packaging/host/cli/supervisor";
import { EXIT } from "../../../packaging/host/cli/exit-codes";
import type { Fetch } from "../../../packaging/host/cli/health";
import type { MachineProbes } from "../../../packaging/host/cli/doctor";
import { parseEnv } from "../scripts/lib/env-file";

const REPO = resolve(import.meta.dirname, "../../..");
const LAUNCHD_DIR = join(REPO, "packaging/host/launchd");
const NOW = new Date("2026-10-20T00:00:00Z");
const roots: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "prism-stock-test-"));
  roots.push(d);
  return d;
};
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const mode = (p: string) => statSync(p).mode & 0o777;
const identity = loadIdentity(LAUNCHD_DIR);
const OUR_HUB = `${identity.labelPrefix}.hub`;

// ── a fake launchctl that remembers what is loaded ───────────────────────────

function fakeLaunchctl(loaded: Set<string> = new Set()): { runner: Runner; loaded: Set<string>; calls: string[] } {
  const calls: string[] = [];
  const runner: Runner = async (cmd, args) => {
    if (cmd !== "launchctl") return { code: 0, stdout: "", stderr: "" };
    calls.push(args.join(" "));
    const [verb, a, b] = args;
    const labelOf = (target: string) => target.split("/").pop()!;
    if (verb === "print") return loaded.has(labelOf(a!)) ? { code: 0, stdout: "state = running\n\tpid = 4242\n", stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
    if (verb === "bootstrap") loaded.add(basename(b!, ".plist"));
    if (verb === "bootout") loaded.delete(labelOf(a!));
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, loaded, calls };
}

// ── plists + the hub command ─────────────────────────────────────────────────

test("stock mode runs ONE Prism agent for Parachute — the hub (its supervisor runs the vault); embedded runs both", () => {
  assert.deepEqual(agentsFor({ parachute: "stock" }), ["hub", "server"]);
  assert.deepEqual(agentsFor({ parachute: "embedded" }), ["hub", "vault", "server"]);
  assert.deepEqual(agentsFor({ parachute: "external" }), ["server"]);
});

test("stock hub plist: `prism run hub`, paths only, no secret, valid plist", () => {
  const layout = layoutFor("/Users/a/Library/Application Support/Prism/Host");
  const a = renderAgent({ name: "hub", template: loadTemplate(LAUNCHD_DIR, "hub"), identity, layout, home: "/Users/a", launchAgents: "/Users/a/Library/LaunchAgents" });
  assert.equal(a.label, OUR_HUB);
  assert.equal(a.path, `/Users/a/Library/LaunchAgents/${OUR_HUB}.plist`);
  assert.match(a.xml, /<string>\/Users\/a\/Library\/Application Support\/Prism\/Host\/bin\/prism<\/string>\s*<string>run<\/string>\s*<string>hub<\/string>/);
  assert.match(a.xml, /<key>Umask<\/key>\s*<integer>63<\/integer>/, "Umask 077: what the hub creates while Prism runs it is private");
  assert.match(a.xml, /hub\.launchd\.log/);
  assert.ok(!/TOKEN|SECRET|PASSWORD/.test(a.xml.replace(/<!--[\s\S]*?-->/g, "")));
  assert.notEqual(a.label, parachuteUnitLabels({}).hub, "never Parachute's own label");
  if (existsSync("/usr/bin/plutil")) {
    const f = join(scratch(), "hub.plist");
    writeFileSync(f, a.xml);
    assert.equal(spawnSync("/usr/bin/plutil", ["-lint", f]).status, 0);
  }
});

test("stock hub command: the stock `parachute serve` in the foreground, loopback, port 1939, the chosen home; the parent's secrets never pass", () => {
  const c = stockHubCommand({ bin: "/Users/a/.bun/bin/parachute", home: "/Users/a/.parachute", userHome: "/Users/a", parentEnv: { HOME: "/Users/a", USER: "a", LANG: "en_US.UTF-8", LC_ALL: "C", PARACHUTE_TOKEN: "x", SESSION_SECRET: "y", PORT: "8787", PARACHUTE_HUB_ORIGIN: "http://127.0.0.1:41939" } });
  assert.equal(c.cmd, "/Users/a/.bun/bin/parachute");
  assert.deepEqual(c.args, ["serve"]);
  assert.equal(c.cwd, "/Users/a/.parachute");
  assert.equal(c.env.PARACHUTE_BIND_HOST, "127.0.0.1");
  assert.equal(c.env.PORT, "1939");
  assert.equal(c.env.PARACHUTE_HOME, "/Users/a/.parachute");
  assert.equal(c.env.BUN_INSTALL, "/Users/a/.bun");
  assert.ok(c.env.PATH!.startsWith("/Users/a/.bun/bin:"));
  assert.equal(c.env.LC_ALL, "C");
  for (const k of ["PARACHUTE_TOKEN", "SESSION_SECRET", "PARACHUTE_HUB_ORIGIN"]) assert.equal(c.env[k], undefined, k);
});

// ── which home ───────────────────────────────────────────────────────────────

test("home choice: configured wins; existing ~/.parachute data is used where it is; else a Prism-owned home in the install", () => {
  const root = scratch();
  const layout = layoutFor(join(root, "Host"));
  const home = join(root, "home");
  mkdirSync(home);
  assert.deepEqual(chooseParachuteHome({ userHome: home, layout }), { home: layout.parachuteHome, reason: "prism-owned" });
  mkdirSync(join(home, ".parachute"));
  assert.equal(chooseParachuteHome({ userHome: home, layout }).reason, "prism-owned", "an empty ~/.parachute holds no data");
  writeFileSync(join(home, ".parachute", "hub.db"), "");
  assert.deepEqual(chooseParachuteHome({ userHome: home, layout }), { home: join(home, ".parachute"), reason: "existing" });
  assert.deepEqual(chooseParachuteHome({ configured: "/x", userHome: home, layout }), { home: "/x", reason: "configured" });
});

// ── Parachute's own units ────────────────────────────────────────────────────

test("existing-unit detection: Parachute's own hub plist (even unloaded) or a loaded job is found; nothing → none (read-only launchctl print)", async () => {
  const root = scratch();
  const la = join(root, "LaunchAgents");
  mkdirSync(la);
  const lc = fakeLaunchctl();
  const ld = new Launchd(lc.runner, 501, true);
  assert.deepEqual(await detectParachuteUnits(ld, la, {}), []);
  writeFileSync(join(la, "computer.parachute.hub.plist"), "<plist/>");
  assert.deepEqual(await detectParachuteUnits(ld, la, {}), [{ label: "computer.parachute.hub", plist: join(la, "computer.parachute.hub.plist"), loaded: false, pid: null }]);
  lc.loaded.add("computer.parachute.vault");
  const both = await detectParachuteUnits(ld, la, {});
  assert.deepEqual(both.map((u) => [u.label, u.loaded, u.pid]), [["computer.parachute.hub", false, null], ["computer.parachute.vault", true, 4242]]);
  assert.ok(lc.calls.every((c) => c.startsWith("print ")), "only `launchctl print`");
  assert.deepEqual(await detectParachuteUnits(ld, la, { PRISM_PARACHUTE_UNIT_PREFIX: "test.other" }), [], "the labels can be moved (smoke)");
});

// ── file modes ───────────────────────────────────────────────────────────────

test("modes: the files and folders stock Parachute creates lose group/other access; nothing else is touched; symlinks are not followed; dry run changes nothing", () => {
  const home = join(scratch(), "p");
  const mk = (rel: string, m: number) => {
    mkdirSync(join(home, rel), { recursive: true });
    chmodSync(join(home, rel), m);
  };
  const file = (rel: string, m: number) => {
    writeFileSync(join(home, rel), "x");
    chmodSync(join(home, rel), m);
  };
  for (const d of ["", "hub", "hub/logs", "vault", "vault/data", "vault/data/default", "vault/data/default/mirror", "vault/logs", "well-known"]) mk(d, 0o755);
  for (const f of ["hub.db", "hub.db-wal", "hub.db-shm", "vault/config.yaml", "vault/data/default/vault.db", "vault/data/default/vault.db-wal", "hub/logs/hub.log", "vault/logs/vault.log"]) file(f, 0o644);
  file("operator.token", 0o600);
  // not on the list: left exactly as they are
  file("services.json", 0o644);
  file("well-known/parachute.json", 0o644);
  file("vault/data/default/vault.yaml", 0o644);
  file("vault/data/default/mirror/note.md", 0o644);
  const outside = join(scratch(), "outside.db");
  writeFileSync(outside, "x");
  chmodSync(outside, 0o644);
  rmSync(join(home, "hub.db-shm"));
  symlinkSync(outside, join(home, "hub.db-shm"));

  const dry = tightenParachuteModes(home, { dryRun: true });
  assert.ok(dry.length > 0);
  assert.equal(mode(join(home, "hub.db")), 0o644, "a dry run changes nothing");

  const changes = tightenParachuteModes(home);
  assert.deepEqual(changes.map((c) => c.path).sort(), dry.map((c) => c.path).sort());
  for (const d of ["", "hub", "hub/logs", "vault", "vault/data", "vault/data/default", "vault/logs", "well-known"]) assert.equal(mode(join(home, d)), 0o700, d || "home");
  for (const f of ["hub.db", "hub.db-wal", "vault/config.yaml", "vault/data/default/vault.db", "vault/data/default/vault.db-wal", "hub/logs/hub.log", "vault/logs/vault.log", "operator.token"]) assert.equal(mode(join(home, f)), 0o600, f);
  for (const f of ["services.json", "well-known/parachute.json", "vault/data/default/vault.yaml", "vault/data/default/mirror/note.md"]) assert.equal(mode(join(home, f)), 0o644, `${f} is not on the list`);
  assert.equal(mode(join(home, "vault/data/default/mirror")), 0o755, "a folder not on the list");
  assert.ok(lstatSync(join(home, "hub.db-shm")).isSymbolicLink());
  assert.equal(mode(outside), 0o644, "a symlink's target is never changed");
  assert.ok(!changes.some((c) => c.path === join(home, "operator.token")), "already 0600: not reported");
  assert.deepEqual(tightenParachuteModes(home), [], "a second run changes nothing");
  // the list itself is exactly what the docs say
  const { dirs, files } = knownParachutePaths(home);
  assert.ok(dirs.includes(join(home, "vault/data/default")) && !dirs.includes(join(home, "vault/data/default/mirror")));
  assert.ok(files.includes(join(home, "hub/logs/hub.log")) && !files.includes(join(home, "services.json")));
});

// ── a scratch install with fake Parachute CLIs ───────────────────────────────

/** `parachute-vault create <name> --no-mirror --json` makes the vault folder; every call is logged. */
const FAKE_VAULT = `#!/bin/sh
printf 'vault %s\\n' "$*" >> "$HOME/calls"
if [ "$1" = create ]; then mkdir -p "$PARACHUTE_HOME/vault/data/$2"; : > "$PARACHUTE_HOME/vault/data/$2/vault.yaml"; echo '{"name":"'"$2"'"}'; exit 0; fi
exit 2
`;
const FAKE_HUB = `#!/bin/sh
printf 'hub %s\\n' "$*" >> "$HOME/calls"
exit 2
`;

interface W {
  root: string;
  home: string;
  layout: Layout;
  bin: string;
  vaultBin: string;
  calls: string;
  lc: ReturnType<typeof fakeLaunchctl>;
  /** Something answers on :1939 / :1940 without Prism (someone else's Parachute). */
  foreignUp: boolean;
}

function world(o: { launchd?: boolean; existingData?: boolean; theirUnit?: "plist" | "loaded" } = {}): W {
  const root = scratch();
  const home = join(root, "home");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const layout = layoutFor(join(root, "Host"));
  const calls = join(home, "calls"); // the fake CLIs log to $HOME/calls (HOME is on the CLI env allowlist)
  const bin = join(home, ".bun", "bin", "parachute");
  const vaultBin = join(home, ".bun", "bin", "parachute-vault");
  mkdirSync(join(home, ".bun", "bin"), { recursive: true });
  writeFileSync(bin, FAKE_HUB, { mode: 0o755 });
  writeFileSync(vaultBin, FAKE_VAULT, { mode: 0o755 });
  if (o.existingData) {
    mkdirSync(join(home, ".parachute"), { mode: 0o755 });
    writeFileSync(join(home, ".parachute", "hub.db"), "x", { mode: 0o644 });
  }
  for (const d of privateDirs(layout)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const s = emptyState(NOW.toISOString(), o.launchd ?? true, "external");
  s.current = "0.9.0";
  s.installed = ["0.9.0"];
  writeState(layout, s);
  const b = join(layout.appRoot, "0.9.0");
  mkdirSync(join(b, "bin"), { recursive: true });
  mkdirSync(join(b, "share"), { recursive: true });
  writeFileSync(join(b, "bin", "prism"), "#!/bin/sh\n");
  writeFileSync(join(b, "build-info.json"), JSON.stringify({ name: "prism-host", version: "0.9.0", platform: "darwin", arch: "arm64", commit: "x", builtAt: "x", node: { version: "22.0.0", sha256: "x" }, parachute: { bundled: false, version: null }, paths: { node: "runtime/node/bin/node", cli: "libexec/prism.mjs", server: "x", tsxLoader: "x", web: "x", webNative: "x", launchd: "share/launchd" } }));
  symlinkSync(LAUNCHD_DIR, join(b, "share", "launchd"));
  symlinkSync("0.9.0", layout.current);
  writeFileSync(layout.envFile, freshEnv(layout, { ownerEmail: "owner@example.com", port: 9612 }), { mode: 0o600 });
  const lc = fakeLaunchctl();
  if (o.theirUnit) writeFileSync(join(home, "Library", "LaunchAgents", "computer.parachute.hub.plist"), "<plist/>");
  if (o.theirUnit === "loaded") lc.loaded.add("computer.parachute.hub");
  return { root, home, layout, bin, vaultBin, calls, lc, foreignUp: false };
}

const okProbes: MachineProbes = { hardwareArch: () => "arm64", platform: () => "darwin", macosVersion: () => "15.1", portFree: async () => true, freeBytes: () => 50 * 1024 ** 3, isRoot: () => false };

function ctxFor(w: W): Ctx {
  const up = () => w.foreignUp || w.lc.loaded.has(OUR_HUB) || w.lc.loaded.has("computer.parachute.hub");
  const fetchFn: Fetch = async (url) => {
    const json = (status: number) => ({ status, json: async () => ({}) });
    if (url.startsWith("http://127.0.0.1:1939/") || url.startsWith("http://127.0.0.1:1940/")) {
      if (!up()) throw new Error("ECONNREFUSED");
      return json(200);
    }
    throw new Error(`ECONNREFUSED ${url}`);
  };
  return {
    bundleRoot: join(w.layout.appRoot, "0.9.0"),
    home: w.home,
    uid: 501,
    env: { PATH: "/usr/bin:/bin", HOME: w.home, CALLS: w.calls, PRISM_APPLICATIONS_DIRS: join(w.root, "Applications"), PRISM_TAILSCALE_BIN: join(w.root, "none") },
    runner: w.lc.runner,
    fetch: fetchFn,
    probes: okProbes,
    openSqlite: () => {
      throw new Error("unused");
    },
    copyTree: () => {},
    now: () => NOW,
    log: () => {},
    healthTimeoutMs: 1000,
  };
}

/** The fake CLIs' calls made by the vault step (later steps of the run mint tokens; not looked at here). */
const calls = (w: W) => (existsSync(w.calls) ? readFileSync(w.calls, "utf8").trim().split("\n").filter((l) => l.startsWith("vault ") || (l.startsWith("hub ") && !l.startsWith("hub auth mint-token"))) : []);
const env = (w: W) => parseEnv(readFileSync(w.layout.envFile, "utf8"));
const noSeed: SetupDeps = { seed: async () => ({ created: [], updated: [], unchanged: [], skipped: [], details: {}, dryRun: true }), loadSchemas: () => ({}) };
const vaultStep = async (w: W, extra: string[] = []) => {
  const p = parseArgs(["setup", "--prefix", w.layout.prefix, "--from", "vault", ...extra], { bool: ["dry-run", "json", "no-launchd"], value: ["prefix", "from", "parachute", "parachute-home"] });
  const r = await cmdSetup(ctxFor(w), p, noSeed);
  return { r, v: (r.steps as StepEvent[])[0]! };
};
/** The person ran `auth set-password` in Terminal. */
const personSetsPassword = (home: string) => writeFileSync(join(home, "operator.token"), "jwt\n", { mode: 0o644 });

test("setup vault, stock: no Parachute data → a Prism-owned home; the vault is created, paths recorded, the person creates the admin; then Prism's hub agent starts Parachute; a re-run changes nothing", async () => {
  const w = world();
  const { v: v1 } = await vaultStep(w);
  assert.equal(v1.state, "needs-person");
  const home = w.layout.parachuteHome;
  assert.deepEqual(v1.commands, [setPasswordCommand(w.bin, home)]);
  assert.equal(v1.commands![0]!.who, "person");
  assert.match(v1.commands![0]!.run, /^PATH=[^ ]*\/\.bun\/bin:"\$PATH" PARACHUTE_HOME='?.*\/Host\/parachute'? .*\/\.bun\/bin\/parachute auth set-password$/);
  assert.match(String(v1.next), /never in this conversation/);
  assert.ok(vaultExists(home, "default"));
  assert.deepEqual(calls(w), ["vault create default --no-mirror --json"]);
  assert.deepEqual([env(w).PARACHUTE_BIN, env(w).PARACHUTE_VAULT_BIN, env(w).PARACHUTE_HOME], [w.bin, w.vaultBin, home]);
  assert.equal(readState(w.layout)!.parachute, "stock");
  assert.ok(!w.lc.calls.some((c) => c.startsWith("bootstrap")), "no hub before the admin exists");
  assert.ok(v1.changed!.includes("vault-created") && v1.changed!.includes("parachute-mode:stock"));

  personSetsPassword(home);
  const { v: v2 } = await vaultStep(w);
  assert.equal(v2.state, "done", JSON.stringify(v2));
  assert.ok(v2.changed!.includes("hub-agent"));
  const plist = join(w.home, "Library", "LaunchAgents", `${OUR_HUB}.plist`);
  assert.ok(existsSync(plist), "Prism's hub agent plist");
  assert.ok(w.lc.calls.includes(`bootstrap gui/501 ${plist}`));
  assert.ok(!existsSync(join(w.home, "Library", "LaunchAgents", `${identity.labelPrefix}.vault.plist`)), "no vault agent: the hub runs the vault");
  assert.equal(mode(join(home, "operator.token")), 0o600, "tightened");
  assert.equal(calls(w).length, 1, "the vault was not created twice");

  const before = readFileSync(w.layout.envFile, "utf8");
  const n = w.lc.calls.filter((c) => !c.startsWith("print")).length;
  const { v: v3 } = await vaultStep(w);
  assert.deepEqual([v3.state, v3.changed], ["done", []]);
  assert.equal(readFileSync(w.layout.envFile, "utf8"), before);
  assert.equal(w.lc.calls.filter((c) => !c.startsWith("print")).length, n, "no launchctl change on a re-run");
});

test("setup vault, stock: existing ~/.parachute data is used where it is (never moved)", async () => {
  const w = world({ existingData: true });
  personSetsPassword(join(w.home, ".parachute"));
  const { v } = await vaultStep(w);
  assert.equal(v.state, "done", JSON.stringify(v));
  assert.equal(env(w).PARACHUTE_HOME, join(w.home, ".parachute"));
  assert.match(String(v.detail), /existing Parachute data, left where it is/);
  assert.ok(existsSync(join(w.home, ".parachute", "hub.db")));
  assert.equal(mode(join(w.home, ".parachute", "hub.db")), 0o600);
  assert.equal(mode(join(w.home, ".parachute")), 0o700);
});

test("setup vault: Parachute's own launchd unit runs it → reused as it is: no Prism hub agent, no vault created, no file mode changed, state stays external", async () => {
  const w = world({ existingData: true, theirUnit: "loaded" });
  const { v } = await vaultStep(w);
  assert.equal(v.state, "done", JSON.stringify(v));
  assert.match(String(v.detail), /Parachute's own launchd unit \(computer\.parachute\.hub\) runs it; Prism reuses it/);
  assert.equal(readState(w.layout)!.parachute, "external");
  assert.ok(!existsSync(join(w.home, "Library", "LaunchAgents", `${OUR_HUB}.plist`)));
  assert.deepEqual(calls(w), []);
  assert.equal(mode(join(w.home, ".parachute", "hub.db")), 0o644, "not ours to change");
  assert.deepEqual(w.lc.calls.filter((c) => !c.startsWith("print")), []);
  assert.equal(env(w).PARACHUTE_BIN, w.bin, "the CLI paths are still recorded");
});

test("setup vault: Parachute's unit is installed but not loaded → still reused (it starts at login); the person restarts it — no second hub", async () => {
  const w = world({ theirUnit: "plist" });
  const { v } = await vaultStep(w);
  assert.equal(v.state, "needs-person");
  assert.deepEqual(v.commands, [{ who: "person", run: "launchctl kickstart -k gui/501/computer.parachute.hub" }]);
  assert.ok(!w.lc.calls.some((c) => c.startsWith("bootstrap")));
});

test("setup vault: a Parachute someone else started (no unit) is reused; stock mode never adopted", async () => {
  const w = world();
  w.foreignUp = true;
  const { v } = await vaultStep(w);
  assert.equal(v.state, "done");
  assert.match(String(v.detail), /Prism did not start it/);
  assert.equal(readState(w.layout)!.parachute, "external");
});

test("setup vault, stock: Parachute's own unit appearing beside Prism's hub agent → failed with the person's command (two hubs would fight over :1939)", async () => {
  const w = world();
  personSetsPassword(w.layout.parachuteHome);
  assert.equal((await vaultStep(w)).v.state, "done");
  writeFileSync(join(w.home, "Library", "LaunchAgents", "computer.parachute.hub.plist"), "<plist/>");
  const { v, r } = await vaultStep(w);
  assert.equal(v.state, "failed");
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.deepEqual(v.commands, [{ who: "person", run: "launchctl bootout gui/501/computer.parachute.hub" }]);
});

test("setup vault, stock: a dry run reports the plan and writes, spawns and loads nothing", async () => {
  const w = world();
  const before = readFileSync(w.layout.envFile, "utf8");
  const { v } = await vaultStep(w, ["--dry-run"]);
  assert.equal(v.state, "skipped");
  assert.match(String(v.detail), /create the vault "default".*auth set-password.*hub agent/);
  assert.equal(readFileSync(w.layout.envFile, "utf8"), before);
  assert.deepEqual(calls(w), []);
  assert.equal(readState(w.layout)!.parachute, "external");
  assert.ok(!existsSync(join(w.layout.parachuteHome, "vault")));
});

test("setup vault, stock without launchd: the person runs `prism run hub --foreground`", async () => {
  const w = world({ launchd: false });
  personSetsPassword(w.layout.parachuteHome);
  const { v } = await vaultStep(w);
  assert.equal(v.state, "needs-person");
  assert.match(String(v.next), /prism run hub --foreground/);
  assert.ok(!w.lc.calls.some((c) => c.startsWith("bootstrap")));
});

test("install --parachute stock: refused when Parachute's own unit is here; otherwise the hub + server agents (dry run: printed, nothing loaded)", async () => {
  const w = world({ theirUnit: "loaded" });
  const args = (extra: string[] = []) => parseArgs(["install", "--prefix", w.layout.prefix, "--parachute", "stock", "--skip-checks", ...extra], { bool: ["dry-run", "skip-checks", "no-signin"], value: ["prefix", "parachute", "parachute-bin", "parachute-home"] });
  await assert.rejects(cmdInstall(ctxFor(w), args(["--dry-run"])), (e: { code?: number; message?: string }) => e.code === EXIT.PRECONDITION && /--parachute external/.test(e.message ?? ""));
  w.lc.loaded.delete("computer.parachute.hub");
  rmSync(join(w.home, "Library", "LaunchAgents", "computer.parachute.hub.plist"));
  const r = await cmdInstall(ctxFor(w), args(["--dry-run", "--parachute-bin", w.bin]));
  const actions = (r.actions as string[]).join("\n");
  assert.match(actions, new RegExp(`write .*${OUR_HUB.replace(/\./g, "\\.")}\\.plist`));
  assert.match(actions, new RegExp(`launchctl bootstrap gui/501 .*${OUR_HUB.replace(/\./g, "\\.")}\\.plist`));
  assert.ok(!/\.vault\.plist/.test(actions), "no vault agent in stock mode");
  assert.ok(!w.lc.calls.some((c) => !c.startsWith("print")), "a dry run changes no launchd state");
});

// ── `prism run hub|vault` in stock mode ──────────────────────────────────────

function fakeChild(exitWith: number | null, signal: NodeJS.Signals | null = null): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  (c as unknown as { kill: () => boolean }).kill = () => true;
  setImmediate(() => c.emit("exit", exitWith, signal));
  return c;
}

test("run hub, stock: refuses (exit 0 under launchd) without a CLI/home, and while Parachute's own hub unit is loaded; tightens modes then runs `parachute serve`", async () => {
  const w = world();
  const home = join(w.root, "phome");
  mkdirSync(home, { mode: 0o755 });
  writeFileSync(join(home, "hub.db"), "x", { mode: 0o644 });
  const logs: string[] = [];
  const base = { layout: w.layout, userHome: w.home, parentEnv: { HOME: w.home }, foreground: false, dryRun: false, foreign: [] as ForeignUnit[], log: (s: string) => logs.push(s) };
  assert.equal((await runStockHub({ ...base, bin: undefined, home })).code, EXIT.OK);
  assert.equal((await runStockHub({ ...base, bin: w.bin, home: undefined, foreground: true })).code, EXIT.CONFIG);
  const theirs: ForeignUnit[] = [{ label: "computer.parachute.hub", plist: null, loaded: true, pid: 1 }];
  const refused = await runStockHub({ ...base, bin: w.bin, home, foreign: theirs, spawnChild: () => assert.fail("must not spawn") });
  assert.equal(refused.code, EXIT.OK);
  assert.match(logs.at(-1)!, /not starting a second one/);

  const dry = await runStockHub({ ...base, bin: w.bin, home, dryRun: true, spawnChild: () => assert.fail("a dry run spawns nothing") });
  assert.deepEqual(dry.command?.args, ["serve"]);
  assert.equal(mode(join(home, "hub.db")), 0o644);

  let started: { cmd: string; args: string[] } | undefined;
  const ran = await runStockHub({ ...base, bin: w.bin, home, spawnChild: (c) => ((started = c), fakeChild(1)) });
  assert.deepEqual(started && [started.cmd, started.args], [w.bin, ["serve"]]);
  assert.equal(ran.code, 1, "a crash is passed to launchd (restart)");
  assert.equal(mode(join(home, "hub.db")), 0o600, "tightened before the start");
  assert.equal(mode(home), 0o700);
  const exitedZero = await runStockHub({ ...base, bin: w.bin, home, spawnChild: () => fakeChild(0) });
  assert.equal(exitedZero.code, EXIT.ERROR, "an unexpected exit 0 still counts as a failure for KeepAlive");
});

test("run vault, stock: the hub's supervisor runs the vault; Prism starts none (exit 0)", async () => {
  const w = world();
  const s = readState(w.layout)!;
  s.parachute = "stock";
  writeState(w.layout, s);
  const logs: string[] = [];
  const ctx = { ...ctxFor(w), log: (m: string) => logs.push(m) };
  const r = await cmdRun(ctx, parseArgs(["run", "vault", "--prefix", w.layout.prefix], { bool: ["foreground", "dry-run"], value: ["prefix"] }));
  assert.equal(r.code, EXIT.OK);
  assert.match(logs[0]!, /supervisor runs the vault/);
});

test("supervisor, stock: the server waits for the hub's /api/ready AND the vault (like embedded), bounded → not ready = exit 75", async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  const seen: string[] = [];
  const f: Fetch = async (url) => (seen.push(url), { status: url.endsWith("/api/ready") ? 503 : 200, json: async () => ({}) });
  const r = await waitForParachute("stock", { hub: "http://h", vault: "http://v" }, { fetch: f, ...clock }, { embeddedMs: 6000, externalMs: 0 });
  assert.equal(r.ready, false);
  assert.ok(seen.includes("http://h/api/ready"));
});

// ── the run-wide setup lock ──────────────────────────────────────────────────

test("lock: taken with {pid, startedAt, command}; a live holder refuses (exit 4, holder named, how to clear it); released → free", () => {
  const dir = scratch();
  const path = join(dir, ".setup.lock");
  const a = acquireRunLock(path, { command: "prism setup", now: NOW });
  assert.deepEqual(readRunLock(path), { pid: process.pid, startedAt: NOW.toISOString(), command: "prism setup" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(runLockState(path).state, "held");
  assert.throws(
    () => acquireRunLock(path, { command: "prism setup", now: NOW, pid: 99, alive: () => true }),
    (e: { code?: number; message?: string; detail?: { lock?: { pid?: number; held?: boolean } } }) => e.code === EXIT.PRECONDITION && /pid \d+, since 2026-10-20/.test(e.message ?? "") && /delete .*\.setup\.lock/.test(e.message ?? "") && e.detail?.lock?.held === true,
  );
  a.release();
  assert.equal(existsSync(path), false);
  assert.equal(runLockState(path).state, "free");
  a.release(); // twice is fine
});

test("lock: a holder that is gone (crash) or an unreadable lock is taken over; a released lock never removes a newer holder's file", () => {
  const dir = scratch();
  const path = join(dir, ".setup.lock");
  // a real process that has exited: its pid is no longer alive
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid!;
  writeFileSync(path, JSON.stringify({ pid: dead, startedAt: "2026-10-19T00:00:00.000Z", command: "prism setup" }));
  assert.equal(runLockState(path).state, "stale");
  const a = acquireRunLock(path, { command: "prism setup", now: NOW });
  assert.deepEqual(a.tookOver, { pid: dead, startedAt: "2026-10-19T00:00:00.000Z", command: "prism setup" });
  a.release();
  writeFileSync(path, "{half a lock");
  const b = acquireRunLock(path, { command: "prism setup", now: NOW, alive: () => true });
  assert.equal(b.tookOver, null);
  // someone else's lock replaced ours: our release leaves it alone
  writeFileSync(path, JSON.stringify({ pid: 1, startedAt: "x", command: "prism setup" }));
  b.release();
  assert.equal(existsSync(path), true);
});

test("setup lock: a run holds it and releases it (also when a step throws); a held lock refuses the run before anything happens; a dry run reports it", async () => {
  const w = world();
  personSetsPassword(w.layout.parachuteHome);
  const p = (extra: string[] = []) => parseArgs(["setup", "--prefix", w.layout.prefix, "--from", "server", ...extra], { bool: ["dry-run", "json"], value: ["prefix", "from"] });
  const r = await cmdSetup(ctxFor(w), p(), noSeed);
  assert.deepEqual((r.lock as { state: string }).state, "held-by-this-run");
  assert.equal(existsSync(w.layout.setupLock), false, "released at the end");

  // a step that throws: still released
  const orig = SETUP_STEP_IMPLS.server!;
  SETUP_STEP_IMPLS.server = async () => {
    throw new Error("boom");
  };
  try {
    const t = await cmdSetup(ctxFor(w), p(), noSeed);
    assert.equal((t.steps as StepEvent[])[0]!.state, "failed");
  } finally {
    SETUP_STEP_IMPLS.server = orig;
  }
  assert.equal(existsSync(w.layout.setupLock), false);

  // held by a live process (pid 1 is always alive): refused, exit 4, nothing ran
  writeFileSync(w.layout.setupLock, JSON.stringify({ pid: 1, startedAt: "2026-10-20T00:00:00.000Z", command: "prism setup" }));
  await assert.rejects(cmdSetup(ctxFor(w), p(), noSeed), (e: { code?: number; detail?: { lock?: { pid?: number } } }) => e.code === EXIT.PRECONDITION && e.detail?.lock?.pid === 1);
  const dry = await cmdSetup(ctxFor(w), p(["--dry-run"]), noSeed);
  assert.deepEqual(dry.lock, { state: "held", path: w.layout.setupLock, pid: 1, startedAt: "2026-10-20T00:00:00.000Z", command: "prism setup" });
  assert.equal(readRunLock(w.layout.setupLock)!.pid, 1, "a dry run never touches the lock");
});

test("setup lock: a first run creates the install folder for the lock and removes it again when it wrote nothing else", async () => {
  const root = scratch();
  const prefix = join(root, "Fresh", "Host");
  mkdirSync(join(root, "Fresh"));
  const w = world();
  const ctx = { ...ctxFor(w) };
  const r = await cmdSetup(ctx, parseArgs(["setup", "--prefix", prefix], { bool: ["dry-run", "json"], value: ["prefix", "from"] }), noSeed);
  assert.equal(r.code, EXIT.NEEDS_PERSON, "asks for the owner email");
  assert.equal(existsSync(prefix), false);
});

test("adminExists / vaultExists read the files Parachute writes", () => {
  const h = scratch();
  assert.equal(adminExists(h), false);
  assert.equal(vaultExists(h, "default"), false);
  writeFileSync(join(h, "operator.token"), "x");
  mkdirSync(join(h, "vault", "data", "default"), { recursive: true });
  writeFileSync(join(h, "vault", "data", "default", "vault.db"), "");
  assert.equal(adminExists(h), true);
  assert.equal(vaultExists(h, "default"), true);
});

test("the person's set-password command runs from a Terminal whose PATH has no bun (clean-VM finding)", () => {
  // A fresh Mac account has no ~/.zshrc, so bun's installer leaves ~/.bun/bin off PATH; the stock
  // CLI is `#!/usr/bin/env bun`. The command must work as pasted.
  const root = mkdtempSync(join(tmpdir(), "prism-setpw-"));
  try {
    const bunDir = join(root, "with space", ".bun", "bin");
    mkdirSync(bunDir, { recursive: true });
    writeFileSync(join(bunDir, "bun"), "#!/bin/sh\nexec /bin/sh \"$@\"\n");
    chmodSync(join(bunDir, "bun"), 0o755);
    writeFileSync(join(bunDir, "parachute"), "#!/usr/bin/env bun\necho \"set-password for $PARACHUTE_HOME: $*\"\n");
    chmodSync(join(bunDir, "parachute"), 0o755);
    const cmd = setPasswordCommand(join(bunDir, "parachute"), join(root, "home dir"));
    assert.equal(cmd.who, "person");
    const r = spawnSync("/bin/zsh", ["-f", "-c", cmd.run], { env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `set-password for ${join(root, "home dir")}: auth set-password`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
