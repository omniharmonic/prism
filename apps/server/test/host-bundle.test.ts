/**
 * The host bundle's `prism` CLI (packaging/host, docs/host-bundle.md): plist generation,
 * the version gate, the update/rollback state machine (injected effects), path and
 * permission rules, the install's .env, backups, pruning, doctor and the supervisor pieces.
 * Nothing here touches launchd, the network, the real home folder or a real port.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv as nodeParseEnv } from "node:util";
import Database from "better-sqlite3";

import { compareVersions, maxVersion, parseVersion, versionGate } from "../../../packaging/host/cli/semver";
import { defaultPrefix, layoutFor, prefixProblem, privateDirs, versionDir } from "../../../packaging/host/cli/paths";
import { agentPath, labelFor, loadIdentity, loadTemplate, renderAgent, renderTemplate, xmlEscape, AGENTS } from "../../../packaging/host/cli/plist";
import { Launchd, parsePrint, type Runner } from "../../../packaging/host/cli/launchd";
import { runUpdate, nextDataVersion, type UpdateDeps, type StagedBundle } from "../../../packaging/host/cli/update";
import { EXIT } from "../../../packaging/host/cli/exit-codes";
import { acquireLock, ensureDir, symlinkAtomic, writeFileAtomic } from "../../../packaging/host/cli/fsutil";
import { envFacts, freshEnv, setKeys, updateEnv } from "../../../packaging/host/cli/hostenv";
import { addMissingKeys, generatedSecrets, parseEnv, renderEnv } from "../scripts/lib/env-file";
import { backupLabel, backupStamp, runBackup, selectPrune, type OpenSqlite } from "../../../packaging/host/cli/backup";
import { runDoctor, type MachineProbes } from "../../../packaging/host/cli/doctor";
import { RotatingLog, Watchdog, serverCommand, waitForParachute } from "../../../packaging/host/cli/supervisor";
import { waitHealthy, type Fetch } from "../../../packaging/host/cli/health";
import { packageName, prunable, reachable, resolveFrom, type Lock } from "../../../packaging/host/build/prune";
import { parseArgs } from "../../../packaging/host/cli/args";
import { cmdInstall, cmdUninstall, cmdUpdate, cmdStatus, logFiles, sumFor, tailLines, type Ctx } from "../../../packaging/host/cli/commands";
import type { BuildInfo } from "../../../packaging/host/cli/state";
import { SERVER_VERSION } from "../src/app";

const LAUNCHD_DIR = resolve(import.meta.dirname, "../../../packaging/host/launchd");
const ROOT_PKG = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8")) as { version: string };
const scratch = () => mkdtempSync(join(tmpdir(), "prism-host-test-"));
const modeOf = (p: string) => statSync(p).mode & 0o777;

// ── version ──────────────────────────────────────────────────────────────────

test("one version: /api/version reports the repository root package.json version", () => {
  assert.equal(SERVER_VERSION, ROOT_PKG.version);
});

test("semver: parse, order, pre-releases", () => {
  assert.equal(parseVersion("1.2.3")?.patch, 3);
  assert.equal(parseVersion("v1.2.3-rc.1")?.pre.join("."), "rc.1");
  for (const bad of ["1.2", "1.2.3.4", "x", "", "1.2.3-", " 1 .2.3"]) assert.equal(parseVersion(bad), null, bad);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
  assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-1"), 1);
  assert.equal(maxVersion(null, "0.2.0", "0.10.0", undefined, "junk"), "0.10.0");
  assert.equal(nextDataVersion("0.3.0", "0.2.0"), "0.3.0");
  assert.equal(nextDataVersion(null, "0.2.0"), "0.2.0");
});

test("version gate: fresh, upgrade, same, downgrade, data newer than installed", () => {
  assert.deepEqual(pick(versionGate({ installed: null, candidate: "0.1.0", dataVersion: null })), ["fresh", true]);
  assert.deepEqual(pick(versionGate({ installed: "0.1.0", candidate: "0.2.0", dataVersion: "0.1.0" })), ["upgrade", true]);
  assert.deepEqual(pick(versionGate({ installed: "0.2.0", candidate: "0.2.0", dataVersion: "0.2.0" })), ["same", false]);
  assert.deepEqual(pick(versionGate({ installed: "0.2.0", candidate: "0.2.0", dataVersion: "0.2.0", force: true })), ["same", true]);
  assert.deepEqual(pick(versionGate({ installed: "0.2.0", candidate: "0.1.0", dataVersion: "0.2.0" })), ["downgrade", false]);
  assert.deepEqual(pick(versionGate({ installed: "0.2.0", candidate: "0.1.0", dataVersion: "0.2.0", force: true })), ["downgrade", true]);
  // A rollback left `current` on 0.1.0 while the data saw 0.2.0: 0.1.5 is still a downgrade over the data.
  const g = versionGate({ installed: "0.1.0", candidate: "0.1.5", dataVersion: "0.2.0" });
  assert.deepEqual(pick(g), ["downgrade", false]);
  assert.match(g.reason, /data last used by 0\.2\.0/);
  // …but re-installing exactly the data's version is fine.
  assert.deepEqual(pick(versionGate({ installed: "0.1.0", candidate: "0.2.0", dataVersion: "0.2.0" })), ["upgrade", true]);
  assert.deepEqual(pick(versionGate({ installed: "0.1.0", candidate: "nope", dataVersion: null, force: true })), ["downgrade", false]);
});
function pick(g: { action: string; allowed: boolean }) {
  return [g.action, g.allowed];
}

// ── paths + permissions ──────────────────────────────────────────────────────

test("prefix rules: absolute, its own folder, never a system folder or ~/.parachute", () => {
  const home = "/Users/someone";
  assert.equal(defaultPrefix(home), "/Users/someone/Library/Application Support/Prism/Host");
  assert.equal(prefixProblem(defaultPrefix(home), home), null);
  assert.equal(prefixProblem("/private/tmp/x/Host", home), null);
  for (const [p, why] of [
    ["", /empty/],
    ["relative/path", /absolute/],
    ["/", /may not be \//],
    [home, /home folder/],
    [`${home}/Library`, /own/],
    [`${home}/.parachute/x`, /parachute/],
    ["/usr/local/prism", /under \/usr/],
    ["/System/Prism", /System/],
    [`${home}/a/../b`, /\.\./],
    [`${home}/x\ny`, /control/],
  ] as const) assert.match(prefixProblem(p, home) ?? "", why, p);
});

test("layout: one root, versioned app trees, the .env in config/", () => {
  const l = layoutFor("/tmp/H");
  assert.equal(l.envFile, "/tmp/H/config/.env");
  assert.equal(l.db, "/tmp/H/data/prism-server.db");
  assert.equal(l.current, "/tmp/H/app/current");
  assert.equal(versionDir(l, "1.2.3"), "/tmp/H/app/1.2.3");
  for (const d of privateDirs(l)) assert.ok(d.startsWith("/tmp/H"), d);
});

test("ensureDir creates 0700 and tightens a looser folder; files are written atomically with their mode", () => {
  const root = scratch();
  try {
    const d = join(root, "a", "b");
    ensureDir(d, 0o700);
    assert.equal(modeOf(d), 0o700);
    chmodSync(d, 0o755);
    ensureDir(d, 0o700);
    assert.equal(modeOf(d), 0o700);
    const f = join(d, "secret");
    writeFileAtomic(f, "x=1\n", 0o600);
    assert.equal(modeOf(f), 0o600);
    writeFileAtomic(f, "x=2\n", 0o600);
    assert.equal(readFileSync(f, "utf8"), "x=2\n");
    assert.deepEqual(readdirSync(d), ["secret"]); // no temp file left
    mkdirSync(join(root, "v1"));
    mkdirSync(join(root, "v2"));
    symlinkAtomic("v1", join(root, "current"));
    symlinkAtomic("v2", join(root, "current"));
    assert.equal(readlinkSync(join(root, "current")), "v2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the install lock refuses a second holder and takes over a dead one", () => {
  const root = scratch();
  try {
    const lock = join(root, ".lock");
    const release = acquireLock(lock);
    writeFileSync(lock, "1"); // pid 1 (launchd) is alive and is not us
    assert.throws(() => acquireLock(lock), (e: { code?: number }) => e.code === EXIT.PRECONDITION);
    writeFileSync(lock, "999999999"); // no such process
    const r2 = acquireLock(lock);
    r2();
    assert.equal(existsSync(lock), false);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── plists ───────────────────────────────────────────────────────────────────

test("plists: one label prefix, paths only, escaped, valid XML, never a secret", () => {
  const identity = loadIdentity(LAUNCHD_DIR);
  const layout = layoutFor("/Users/a & b/Library/Application Support/Prism/Host");
  const rendered = AGENTS.map((name) => renderAgent({ name, template: loadTemplate(LAUNCHD_DIR, name), identity, layout, home: "/Users/a & b", launchAgents: "/Users/a & b/Library/LaunchAgents" }));
  const labels = rendered.map((r) => r.label);
  assert.deepEqual(labels, AGENTS.map((n) => `${identity.labelPrefix}.${n}`));
  assert.equal(new Set(labels).size, 3);
  const server = rendered.find((r) => r.name === "server")!;
  assert.equal(server.path, `/Users/a & b/Library/LaunchAgents/${labelFor(identity, "server")}.plist`);
  assert.match(server.xml, /<string>\/Users\/a &amp; b\/Library\/Application Support\/Prism\/Host\/bin\/prism<\/string>\s*<string>run<\/string>\s*<string>server<\/string>/);
  assert.match(server.xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(server.xml, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(server.xml, /<key>WorkingDirectory<\/key>\s*<string>[^<]*\/Host\/config<\/string>/);
  assert.match(server.xml, /<key>StandardOutPath<\/key>\s*<string>[^<]*\/Host\/logs\/server\.launchd\.log<\/string>/);
  assert.doesNotMatch(server.xml.replace(/<!--[\s\S]*?-->/g, ""), /\{\{|SECRET|TOKEN|PASSWORD|\.env/);
  // Only two environment variables, both non-secret.
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(server.xml)![1]!;
  assert.deepEqual([...envBlock.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]), ["PRISM_HOME", "PATH"]);
  assert.ok(agentPath("/h").startsWith("/h/.local/bin:"));
  // plutil (macOS) agrees the XML is a valid property list.
  if (existsSync("/usr/bin/plutil")) {
    const root = scratch();
    try {
      for (const r of rendered) {
        const f = join(root, `${r.name}.plist`);
        writeFileSync(f, r.xml);
        execFileSync("/usr/bin/plutil", ["-lint", f]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("plist templates: a missing value or a control character refuses to render", () => {
  assert.throws(() => renderTemplate("<string>{{NOPE}}</string>", {}), /no value/);
  assert.throws(() => renderTemplate("<string>{{A}}</string>", { A: "x\ny" }), /unsafe/);
  assert.equal(xmlEscape(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
});

// ── launchctl ────────────────────────────────────────────────────────────────

test("launchctl: dry-run records the commands and runs none of the changing ones", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 113, stdout: "", stderr: "Could not find service" };
  };
  const ld = new Launchd(runner, 501, true);
  await ld.bootstrap("x.server", "/p/x.server.plist");
  await ld.bootout("x.server");
  await ld.kickstart("x.server", true);
  assert.deepEqual(ld.changes, ["launchctl bootstrap gui/501 /p/x.server.plist", "launchctl bootout gui/501/x.server", "launchctl kickstart -k gui/501/x.server"]);
  assert.deepEqual(calls, []);
});

test("launchctl: bootstrap skips a loaded job, bootout skips an absent one", async () => {
  const calls: string[] = [];
  let loaded = true;
  const runner: Runner = async (_cmd, args) => {
    calls.push(args.join(" "));
    if (args[0] === "print") return loaded ? { code: 0, stdout: "\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n", stderr: "" } : { code: 113, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const ld = new Launchd(runner, 501, false);
  await ld.bootstrap("x.server", "/p.plist");
  assert.deepEqual(ld.changes, []);
  loaded = false;
  await ld.bootout("x.server");
  assert.deepEqual(ld.changes, []);
  await ld.bootstrap("x.server", "/p.plist");
  assert.deepEqual(ld.changes, ["launchctl bootstrap gui/501 /p.plist"]);
  assert.deepEqual(parsePrint("\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n"), { loaded: true, pid: 4242, state: "running", lastExit: "0" });
});

// ── the update state machine ─────────────────────────────────────────────────

function info(version: string, over: Partial<BuildInfo> = {}): BuildInfo {
  return {
    name: "prism-host",
    version,
    platform: "darwin",
    arch: "arm64",
    commit: "abc",
    builtAt: "2026-10-19T00:00:00Z",
    node: { version: "22.23.3", sha256: "x" },
    parachute: { bundled: false, version: null },
    paths: { node: "runtime/node/bin/node", cli: "libexec/prism.mjs", server: "app/apps/server/src/index.ts", tsxLoader: "app/node_modules/tsx/dist/loader.mjs", web: "app/apps/web/dist", webNative: "app/apps/web/dist-native", launchd: "share/launchd" },
    ...over,
  };
}

interface Fake {
  deps: UpdateDeps;
  calls: string[];
  state: { current: string | null; previous: string | null; dataVersion: string | null };
  recorded: Array<Record<string, unknown>>;
}

function fakeDeps(o: { current: string | null; dataVersion?: string | null; candidate: BuildInfo; verify?: boolean; backupOk?: boolean; healthy?: (v: string) => boolean; managed?: boolean; restartThrows?: boolean }): Fake {
  const calls: string[] = [];
  const state = { current: o.current, previous: null as string | null, dataVersion: o.dataVersion ?? o.current };
  const recorded: Array<Record<string, unknown>> = [];
  const deps: UpdateDeps = {
    log: () => {},
    verify: async () => (o.verify === false ? { ok: false, reason: "SHA-256 mismatch" } : { ok: true, sha256: "f".repeat(64) }),
    unpack: async () => {
      calls.push("unpack");
      return { dir: "/staged", info: o.candidate };
    },
    discard: () => calls.push("discard"),
    installed: () => ({ ...state }),
    backup: async (label) => {
      calls.push(`backup:${label}`);
      return o.backupOk === false ? { ok: false, reason: "disk full" } : { ok: true, dir: "/b" };
    },
    place: (s: StagedBundle) => calls.push(`place:${s.info.version}`),
    pointCurrent: (v) => {
      calls.push(`current:${v}`);
      state.current = v;
    },
    managed: () => o.managed ?? true,
    restart: async () => {
      calls.push("restart");
      if (o.restartThrows) throw new Error("launchctl failed");
    },
    waitHealthy: async (v) => {
      calls.push(`health:${v}`);
      return (o.healthy ?? (() => true))(v) ? { ok: true } : { ok: false, reason: "no answer" };
    },
    record: (r) => {
      recorded.push(r);
      if (r.healthyVersion) state.dataVersion = nextDataVersion(state.dataVersion, r.healthyVersion);
    },
    prune: (keep) => calls.push(`prune:${keep.join(",")}`),
  };
  return { deps, calls, state, recorded };
}

test("update: verify → gate → backup → swap → restart → healthy", async () => {
  const f = fakeDeps({ current: "0.1.0", candidate: info("0.2.0") });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.status, "updated");
  assert.deepEqual(f.calls, ["unpack", "backup:pre-update-0-2-0", "place:0.2.0", "current:0.2.0", "restart", "health:0.2.0", "prune:0.2.0,0.1.0"]);
  assert.equal(f.state.dataVersion, "0.2.0");
  assert.equal(f.recorded.at(-1)!.result, "ok");
});

test("update: a checksum mismatch changes nothing", async () => {
  const f = fakeDeps({ current: "0.1.0", candidate: info("0.2.0"), verify: false });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.VERIFY_FAILED);
  assert.deepEqual(f.calls, []);
});

test("update: a bundle for another platform is refused after unpacking, and discarded", async () => {
  const f = fakeDeps({ current: "0.1.0", candidate: info("0.2.0", { arch: "x64" as "arm64" }) });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.VERIFY_FAILED);
  assert.deepEqual(f.calls, ["unpack", "discard"]);
});

test("update: a downgrade over newer data is refused (exit 6) unless --force", async () => {
  const f = fakeDeps({ current: "0.2.0", candidate: info("0.1.0") });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.VERSION_REFUSED);
  assert.deepEqual(f.calls, ["unpack", "discard"]);
  const g = fakeDeps({ current: "0.2.0", candidate: info("0.1.0") });
  assert.equal((await runUpdate("/x.tar.gz", { force: true }, g.deps)).status, "updated");
  // forced downgrade: the data version does not go backwards
  assert.equal(g.state.dataVersion, "0.2.0");
});

test("update: the same version is a no-op", async () => {
  const f = fakeDeps({ current: "0.2.0", candidate: info("0.2.0") });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.status, "unchanged");
  assert.deepEqual(f.calls, ["unpack", "discard"]);
});

test("update: a failed backup stops before anything changes", async () => {
  const f = fakeDeps({ current: "0.1.0", candidate: info("0.2.0"), backupOk: false });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.status, "backup_failed");
  assert.equal(r.code, EXIT.ERROR);
  assert.deepEqual(f.calls, ["unpack", "backup:pre-update-0-2-0", "discard"]);
  assert.equal(f.state.current, "0.1.0");
});

test("update: not healthy → rolled back to the previous version, which is healthy (exit 7)", async () => {
  const f = fakeDeps({ current: "0.1.0", candidate: info("0.2.0"), healthy: (v) => v === "0.1.0" });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.ROLLED_BACK);
  assert.deepEqual(f.calls, ["unpack", "backup:pre-update-0-2-0", "place:0.2.0", "current:0.2.0", "restart", "health:0.2.0", "current:0.1.0", "restart", "health:0.1.0", "prune:0.1.0"]);
  assert.equal(f.state.current, "0.1.0");
  // DATA_VERSION did not move: the next update to 0.2.x is not "a downgrade".
  assert.equal(f.state.dataVersion, "0.1.0");
});

test("update: a restart that throws counts as unhealthy and is rolled back", async () => {
  let n = 0;
  const f = fakeDeps({ current: "0.1.0", candidate: info("0.2.0") });
  const orig = f.deps.restart;
  f.deps.restart = async () => {
    n++;
    if (n === 1) throw new Error("launchctl kickstart failed");
    return orig();
  };
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.ROLLED_BACK);
  assert.match(String(r.reason), /kickstart failed/);
});

test("update: the rollback is not healthy either → exit 8, current left on the previous version", async () => {
  const f = fakeDeps({ current: "0.1.0", candidate: info("0.2.0"), healthy: () => false });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.ROLLBACK_FAILED);
  assert.equal(f.state.current, "0.1.0");
  assert.match(String(r.reason), /after the rollback/);
});

test("update: an install not run by launchd is swapped only; dry-run changes nothing", async () => {
  const f = fakeDeps({ current: "0.1.0", candidate: info("0.2.0"), managed: false });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.status, "swapped_unmanaged");
  assert.ok(!f.calls.includes("restart"));
  assert.equal(f.state.dataVersion, "0.1.0"); // moved only by a healthy run (the supervisor records it)
  const g = fakeDeps({ current: "0.1.0", candidate: info("0.2.0") });
  const d = await runUpdate("/x.tar.gz", { dryRun: true }, g.deps);
  assert.equal(d.status, "dry_run");
  assert.deepEqual(g.calls, ["unpack", "discard"]);
});

test("SHA256SUMS lines are matched by exact file name", () => {
  const h = "a".repeat(64);
  const sums = `${"b".repeat(64)}  other.tar.gz\n${h}  prism-host-0.1.0-darwin-arm64.tar.gz\n`;
  assert.equal(sumFor(sums, "prism-host-0.1.0-darwin-arm64.tar.gz"), h);
  assert.equal(sumFor(`${h} *x.tgz`, "x.tgz"), h);
  assert.equal(sumFor(sums, "prism-host-0.1.0-darwin-arm64.tar"), null);
});

// ── the install's .env ───────────────────────────────────────────────────────

test(".env: a fresh install needs an owner, writes the install's paths and new secrets", () => {
  const l = layoutFor("/tmp/H");
  assert.throws(() => freshEnv(l, {}), /owner-email/);
  const env = nodeParseEnv(freshEnv(l, { ownerEmail: "Owner@Example.com", port: 9123, parachuteToken: "tok" }));
  assert.equal(env.OWNER_EMAIL, "owner@example.com");
  assert.equal(env.PORT, "9123");
  assert.equal(env.APP_ORIGIN, "http://localhost:9123");
  assert.equal(env.DB_PATH, "/tmp/H/data/prism-server.db");
  assert.equal(env.AGENT_CWD, "/tmp/H/data/agent-cwd");
  assert.equal(env.PARACHUTE_TOKEN, "tok");
  for (const k of ["SESSION_SECRET", "CAPABILITY_SECRET", "COLLAB_TOKEN", "GOVERNANCE_SIGNING_SECRET", "SECRETS_KEY"]) assert.ok((env[k] ?? "").length >= 32, k);
  assert.equal(env.WEB_ROOT, undefined); // an app path: set by the supervisor from the running bundle
  assert.equal(env.PARACHUTE_BIN, undefined);
  const withBins = parseEnv(freshEnv(l, { ownerEmail: "o@x.co", parachuteBin: "/opt/p/bin/parachute", parachuteVaultBin: "/opt/p/bin/parachute-vault", parachuteHome: "/tmp/H/parachute", parachuteHubOrigin: "http://127.0.0.1:5000" }));
  assert.equal(withBins.PARACHUTE_BIN, "/opt/p/bin/parachute");
  assert.equal(withBins.PARACHUTE_VAULT_BIN, "/opt/p/bin/parachute-vault");
  assert.equal(withBins.PARACHUTE_HOME, "/tmp/H/parachute");
  assert.equal(withBins.PARACHUTE_HUB_JWKS_ORIGIN, "http://127.0.0.1:5000");
});

test(".env: an existing file keeps every value; only missing keys are added, only named keys replaced", () => {
  const l = layoutFor("/tmp/H");
  const old = "OWNER_EMAIL=o@x.co\nSECRETS_KEY=keep-me\nPARACHUTE_TOKEN=old\n# a comment\nCUSTOM=1";
  const u = updateEnv(l, old, {});
  const e = parseEnv(u.text);
  assert.equal(e.SECRETS_KEY, "keep-me");
  assert.equal(e.PARACHUTE_TOKEN, "old");
  assert.equal(e.CUSTOM, "1");
  assert.ok(u.text.includes("# a comment"));
  assert.deepEqual(u.added.sort(), ["AGENT_CWD", "CAPABILITY_SECRET", "COLLAB_TOKEN", "DB_PATH", "GOVERNANCE_SIGNING_SECRET", "SESSION_SECRET"]);
  assert.deepEqual(u.replaced, []);
  const again = updateEnv(l, u.text, {});
  assert.equal(again.text, u.text);
  assert.deepEqual(again.added, []);
  const t = updateEnv(l, u.text, { parachuteToken: "new" });
  assert.equal(parseEnv(t.text).PARACHUTE_TOKEN, "new");
  assert.equal(parseEnv(t.text).SECRETS_KEY, "keep-me");
  assert.throws(() => setKeys("A=1\n", [["A", "x\nOWNER_EMAIL=evil"]]), /unsafe/);
  assert.throws(() => renderEnv([["A", "x\ny"]]), /unsafe/);
  assert.deepEqual(addMissingKeys("A=\n", [["A", "x"]]).added, []); // an empty value is still "set"
  assert.equal(generatedSecrets({ SECRETS_KEY: "k", SESSION_SECRET: "s" }).SECRETS_KEY, "k");
  assert.notEqual(generatedSecrets({ SECRETS_KEY: "k", SESSION_SECRET: "s" }).SESSION_SECRET, "s");
  assert.equal(generatedSecrets({ SECRETS_KEY: "k", SESSION_SECRET: "s" }, true).SESSION_SECRET, "s");
  assert.deepEqual(envFacts("PORT=9999\nPARACHUTE_TOKEN=x\nOWNER_EMAIL=a@b.co\n"), { present: true, port: 9999, vaultTokenSet: true, ownerEmailSet: true, parachuteUrl: "http://127.0.0.1:1940", hubOrigin: "http://127.0.0.1:1939" });
  assert.equal(envFacts(null).present, false);
});

// ── backups ──────────────────────────────────────────────────────────────────

test("backup retention: newest N kept, pinned labels and the new one never pruned", () => {
  const names = ["20261001T000000Z-manual", "20261002T000000Z-manual", "20261003T000000Z-pre-update-0-2-0", "20261004T000000Z-keep-this", "20261005T000000Z-manual", "not-a-backup"];
  assert.deepEqual(selectPrune(names, 2, "20261005T000000Z-manual").sort(), ["20261001T000000Z-manual", "20261002T000000Z-manual"]);
  assert.deepEqual(selectPrune(names, 0, "x"), []);
  assert.equal(backupLabel("Pre Update/0.2!"), "pre-update-0-2");
  assert.equal(backupLabel(""), "manual");
  assert.equal(backupStamp(new Date("2026-10-19T12:34:56.789Z")), "20261019T123456Z");
});

test("backup: online snapshot of the server DB and Parachute's, integrity-checked, 0700, manifest, retention", async () => {
  const root = scratch();
  try {
    const l = layoutFor(join(root, "Host"));
    for (const d of privateDirs(l)) ensureDir(d, 0o700);
    const live = new Database(l.db);
    live.pragma("journal_mode = WAL");
    live.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);");
    // Parachute owned by Prism: hub + one vault
    const ph = join(root, "parachute");
    mkdirSync(join(ph, "vault", "data", "default"), { recursive: true });
    new Database(join(ph, "hub.db")).exec("CREATE TABLE tokens(x)").close();
    new Database(join(ph, "vault", "data", "default", "vault.db")).exec("CREATE TABLE notes(x); INSERT INTO notes VALUES (1)").close();
    writeFileSync(join(ph, "vault", "data", "default", "vault.yaml"), "name: default\n");
    writeFileAtomic(l.envFile, "SECRETS_KEY=s\n", 0o600);
    const open: OpenSqlite = (p, o) => new Database(p, o) as unknown as ReturnType<OpenSqlite>;
    const mk = (i: number) => runBackup({ layout: l, open, label: "t", keep: 2, parachuteHome: ph, now: new Date(Date.UTC(2026, 9, 19, 0, 0, i)), versions: { prism: "0.1.0" } });
    const r = await mk(1);
    assert.equal(r.ok, true, r.problems.join(";"));
    assert.deepEqual(r.databases.map((d) => [d.file, d.integrity]), [["prism/prism-server.db", "ok"], ["parachute/hub.db", "ok"], ["parachute/vault/data/default/vault.db", "ok"]]);
    assert.equal(modeOf(r.dir), 0o700);
    assert.equal(modeOf(join(r.dir, "config/.env")), 0o600);
    for (const d of r.databases) assert.equal(modeOf(join(r.dir, d.file)), 0o600, d.file);
    const copy = new Database(join(r.dir, "prism/prism-server.db"), { readonly: true });
    assert.equal((copy.prepare("SELECT count(*) n FROM t").get() as { n: number }).n, 3);
    assert.equal(copy.pragma("journal_mode", { simple: true }), "delete");
    copy.close();
    assert.ok(existsSync(join(r.dir, "parachute/vault/data/default/vault.yaml")));
    const manifest = JSON.parse(readFileSync(join(r.dir, "MANIFEST.json"), "utf8"));
    assert.equal(manifest.ok, true);
    assert.ok(!JSON.stringify(manifest).includes(root), "manifest paths are relative to the prefix");
    await mk(2);
    const third = await mk(3);
    assert.deepEqual(third.pruned, [r.dir.split("/").pop()]);
    live.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── pruning node_modules to what the server reaches ──────────────────────────

test("prune: Node's lookup over the lockfile, links, optional peers, nested copies", () => {
  const lock: Lock = {
    packages: {
      "": {},
      "apps/server": { dependencies: { hono: "*" } },
      "packages/core": { dependencies: { marked: "^14", react: "*" } },
      "node_modules/@prism/core": { link: true, resolved: "packages/core" },
      "node_modules/hono": {},
      "node_modules/marked": { version: "18.0.0" },
      "packages/core/node_modules/marked": { version: "14.0.0" },
      "node_modules/a": { dependencies: { b: "*" }, peerDependencies: { c: "*", react: "*" }, peerDependenciesMeta: { react: { optional: true } } },
      "node_modules/a/node_modules/b": { dependencies: { d: "*" } },
      "node_modules/b": {},
      "node_modules/c": {},
      "node_modules/d": {},
      "node_modules/react": {},
      "node_modules/react/node_modules/loose": {},
      "node_modules/unused": { dependencies: { d: "*" } },
    },
  };
  assert.equal(resolveFrom(lock, "packages/core", "marked"), "packages/core/node_modules/marked");
  assert.equal(resolveFrom(lock, "apps/server", "marked"), "node_modules/marked");
  assert.equal(resolveFrom(lock, "node_modules/a/node_modules/b", "d"), "node_modules/d");
  assert.equal(resolveFrom(lock, "node_modules/a", "b"), "node_modules/a/node_modules/b");
  const keep = reachable(lock, [{ from: "apps/server", name: "hono" }, { from: "packages/core", name: "marked" }, { from: "apps/server", name: "a" }], () => true, ["node_modules/@prism/core"]);
  assert.deepEqual([...keep].sort(), ["node_modules/@prism/core", "node_modules/a", "node_modules/a/node_modules/b", "node_modules/c", "node_modules/d", "node_modules/hono", "packages/core/node_modules/marked"]);
  // core's DECLARED browser deps (react) are not followed through the pinned link; nested folders go with their parent
  assert.deepEqual(prunable(lock, keep), ["node_modules/b", "node_modules/marked", "node_modules/react", "node_modules/unused"]);
  assert.equal(packageName("@tiptap/core/dist/x"), "@tiptap/core");
  assert.equal(packageName("marked"), "marked");
});

// ── doctor ───────────────────────────────────────────────────────────────────

function probes(over: Partial<MachineProbes> = {}): MachineProbes {
  return { hardwareArch: () => "arm64", platform: () => "darwin", macosVersion: () => "15.1", portFree: async () => true, freeBytes: () => 50 * 1024 ** 3, isRoot: () => false, ...over };
}

test("doctor: Apple silicon, macOS 14+, the ports, disk, not root", async () => {
  const ok = await runDoctor(probes(), { ports: [9000], prefix: "/tmp/x" });
  assert.ok(ok.every((c) => c.ok), JSON.stringify(ok));
  const bad = await runDoctor(probes({ hardwareArch: () => "x64", macosVersion: () => "13.6.1", portFree: async (p) => p !== 9000, freeBytes: () => 1024, isRoot: () => true }), { ports: [9000], prefix: "/tmp/x" });
  assert.deepEqual(bad.filter((c) => !c.ok).map((c) => c.id), ["apple-silicon", "macos", "not-root", "port-9000", "disk"]);
  assert.equal((await runDoctor(probes({ macosVersion: () => "14" }), { ports: [], prefix: "/" })).find((c) => c.id === "macos")!.ok, true);
  assert.equal((await runDoctor(probes({ macosVersion: () => null }), { ports: [], prefix: "/" })).find((c) => c.id === "macos")!.ok, false);
});

// ── supervisor pieces ────────────────────────────────────────────────────────

test("supervisor: the server command runs the bundled node + tsx, cwd = config, WEB_ROOT from the bundle", () => {
  const l = layoutFor("/tmp/H");
  const c = serverCommand(l, "/tmp/H/app/0.1.0", info("0.1.0"), { HOME: "/h", WEB_ROOT: "/stale", SECRET_IN_ENV: undefined });
  assert.equal(c.node, "/tmp/H/app/0.1.0/runtime/node/bin/node");
  assert.deepEqual(c.args, ["--env-file=/tmp/H/config/.env", "--import", "file:///tmp/H/app/0.1.0/app/node_modules/tsx/dist/loader.mjs", "/tmp/H/app/0.1.0/app/apps/server/src/index.ts"]);
  assert.equal(c.cwd, "/tmp/H/config");
  assert.equal(c.env.WEB_ROOT, "/tmp/H/app/0.1.0/app/apps/web/dist");
  assert.equal(c.env.PRISM_HOME, "/tmp/H");
  assert.equal("SECRET_IN_ENV" in c.env, false);
});

test("supervisor: the server inherits only an allowlisted environment, and never over a .env key", () => {
  const l = layoutFor("/tmp/H");
  const shell = {
    PATH: "/usr/bin:/bin",
    HOME: "/h",
    USER: "me",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    TZ: "Europe/Berlin",
    TMPDIR: "/tmp/me",
    // What a shell may carry that must never reach the server:
    PARACHUTE_TOKEN: "from-the-shell",
    OWNER_EMAIL: "attacker@example.com",
    APP_ORIGIN: "https://evil.example",
    NODE_OPTIONS: "--require /tmp/evil.js",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    PRISM_TAILSCALE_BIN: "/tmp/x",
    PRISM_MODELS_CONFIG: "/tmp/evil-models.json",
    WEB_ROOT: "/stale",
  };
  const envText = "PARACHUTE_TOKEN=real\nOWNER_EMAIL=owner@example.com\nexport TZ=UTC\n# PATH=/commented\n";
  const c = serverCommand(l, "/tmp/H/app/0.1.0", info("0.1.0"), shell, envText);
  assert.deepEqual(Object.keys(c.env).sort(), ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "PRISM_HOME", "TMPDIR", "USER", "WEB_ROOT"]);
  assert.equal("TZ" in c.env, false, "TZ is set by .env, so the shell's is not passed (node --env-file would not override it)");
  assert.equal(c.env.WEB_ROOT, "/tmp/H/app/0.1.0/app/apps/web/dist");
  for (const k of ["PARACHUTE_TOKEN", "OWNER_EMAIL", "APP_ORIGIN", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "PRISM_TAILSCALE_BIN", "PRISM_MODELS_CONFIG"]) assert.equal(k in c.env, false, k);
  // No .env text: the allowlist alone.
  assert.equal(serverCommand(l, "/tmp/H/app/0.1.0", info("0.1.0"), shell).env.TZ, "Europe/Berlin");
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}
const fetchFrom = (ok: (url: string) => boolean): Fetch => async (url) => ({ status: ok(url) ? 200 : 503, json: async () => ({}) });

test("supervisor: waits for the hub's /api/ready and the vault in embedded mode, bounded", async () => {
  const urls = { hub: "http://h", vault: "http://v" };
  let hubUp = false;
  const c = fakeClock();
  const f: Fetch = async (url) => {
    if (c.now() >= 6000) hubUp = true;
    return { status: url.startsWith("http://h") ? (hubUp ? 200 : 503) : 200, json: async () => ({}) };
  };
  const r = await waitForParachute("embedded", urls, { fetch: f, ...c });
  assert.equal(r.ready, true);
  assert.ok(r.waitedMs >= 6000);
  const never = fakeClock();
  const r2 = await waitForParachute("embedded", urls, { fetch: fetchFrom(() => false), ...never }, { embeddedMs: 10_000, externalMs: 4000 });
  assert.deepEqual(r2.ready, false);
  // external: a vault that never answers is waited for, then the server starts anyway
  const ext = fakeClock();
  const r3 = await waitForParachute("external", urls, { fetch: fetchFrom(() => false), ...ext }, { embeddedMs: 10_000, externalMs: 4000 });
  assert.equal(r3.ready, true);
  assert.ok(r3.waitedMs >= 4000);
  assert.equal((await waitForParachute("none", urls, { fetch: fetchFrom(() => false), ...fakeClock() })).waitedMs, 0);
});

test("supervisor: the watchdog fires after 3 misses in a row only", () => {
  const w = new Watchdog(3);
  assert.deepEqual([false, false, true, false, false].map((l) => w.observe(l)), [false, false, false, false, false]);
  assert.equal(w.observe(false), true);
});

test("supervisor: the log rotates by size and keeps N files", () => {
  const root = scratch();
  try {
    const p = join(root, "server.log");
    const log = new RotatingLog(p, 100, 3);
    for (let i = 0; i < 10; i++) log.write(`${String(i).repeat(60)}\n`);
    log.close();
    const files = readdirSync(root).sort();
    assert.deepEqual(files, ["server.log", "server.log.1", "server.log.2", "server.log.3"]);
    assert.equal(modeOf(p), 0o600);
    const l = layoutFor(join(root, "H"));
    mkdirSync(l.logs, { recursive: true });
    writeFileSync(join(l.logs, "server.log.2"), "a\nb\n");
    writeFileSync(join(l.logs, "server.log.1"), "c\n");
    writeFileSync(join(l.logs, "server.log"), "d\ne\n");
    const fl = logFiles(l, "server.log");
    assert.deepEqual(tailLines(fl, 3), ["c", "d", "e"]);
    assert.deepEqual(tailLines(fl, 10), ["a", "b", "c", "d", "e"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("health wait: live AND the expected version; times out with a reason (fake clock)", async () => {
  const c = fakeClock();
  const f: Fetch = async (url) => ({ status: 200, json: async () => (url.endsWith("/api/version") ? { version: c.now() > 3000 ? "0.2.0" : "0.1.0" } : {}) });
  const r = await waitHealthy(f, "http://x", "0.2.0", { timeoutMs: 60_000, ...c });
  assert.equal(r.ok, true);
  const d = fakeClock();
  const r2 = await waitHealthy(fetchFrom(() => false), "http://x", "0.2.0", { timeoutMs: 5000, ...d });
  assert.equal(r2.ok, false);
  assert.match(r2.reason ?? "", /did not answer/);
});

test("args: strict flags", () => {
  const p = parseArgs(["install", "--port", "9", "--json", "--prefix=/x", "pos"], { bool: ["json"], value: ["port", "prefix"] });
  assert.deepEqual(p, { command: "install", positional: ["pos"], flags: { port: "9", json: true, prefix: "/x" } });
  assert.throws(() => parseArgs(["install", "--nope"], { bool: [], value: [] }), /unknown option/);
  assert.throws(() => parseArgs(["install", "--port"], { bool: [], value: ["port"] }), /needs a value/);
  assert.throws(() => parseArgs(["install", "--json=1"], { bool: ["json"], value: [] }), /no value/);
});

// ── install / uninstall against a scratch prefix, with a tiny fake bundle ────

function fakeBundle(root: string, version: string): string {
  const b = join(root, `bundle-${version}`);
  mkdirSync(join(b, "bin"), { recursive: true });
  mkdirSync(join(b, "share"), { recursive: true });
  writeFileSync(join(b, "bin", "prism"), "#!/bin/sh\n");
  writeFileSync(join(b, "build-info.json"), JSON.stringify(info(version)));
  // the real templates + identity
  symlinkSync(LAUNCHD_DIR, join(b, "share", "launchd"));
  return b;
}

function ctxFor(root: string, bundle: string, runner?: Runner): Ctx & { launchctl: string[][] } {
  const launchctl: string[][] = [];
  return {
    bundleRoot: bundle,
    home: join(root, "home"),
    uid: 501,
    env: {},
    runner: runner ?? (async (cmd, args) => {
      launchctl.push([cmd, ...args]);
      return args[0] === "print" ? { code: 113, stdout: "", stderr: "Could not find service" } : { code: 0, stdout: "", stderr: "" };
    }),
    fetch: fetchFrom(() => false),
    probes: probes(),
    openSqlite: () => ((p: string, o: object) => new Database(p, o)) as unknown as OpenSqlite,
    copyTree: (src, dst) => execFileSync("/bin/cp", ["-R", src, dst]),
    now: () => new Date("2026-10-19T00:00:00Z"),
    log: () => {},
    healthTimeoutMs: 1000,
    launchctl,
  };
}

test("install --no-launchd: 0700 dirs, 0600 .env, versioned app + current, idempotent; uninstall keeps data", async () => {
  const root = scratch();
  try {
    const bundle = fakeBundle(root, "0.1.0");
    const ctx = ctxFor(root, bundle);
    const prefix = join(root, "Host");
    const tok = join(root, "tok");
    writeFileSync(tok, "vault-token\n", { mode: 0o644 });
    const args = (extra: string[] = []) => parseArgs(["install", "--prefix", prefix, "--no-launchd", "--owner-email", "o@example.com", "--port", "9555", ...extra], { bool: ["no-launchd", "dry-run"], value: ["prefix", "owner-email", "port", "parachute-token-file"] });

    const dry = await cmdInstall(ctx, args(["--dry-run"]));
    assert.equal(dry.code, EXIT.OK);
    assert.equal(existsSync(prefix), false);

    const r = await cmdInstall(ctx, args(["--parachute-token-file", tok]));
    assert.equal(r.code, EXIT.OK, JSON.stringify(r));
    assert.match(String((r.warnings as string[])[0]), /readable by others/);
    const l = layoutFor(prefix);
    for (const d of privateDirs(l)) assert.equal(modeOf(d), 0o700, d);
    assert.equal(modeOf(l.envFile), 0o600);
    assert.equal(parseEnv(readFileSync(l.envFile, "utf8")).PARACHUTE_TOKEN, "vault-token");
    assert.equal(readlinkSync(l.current), "0.1.0");
    assert.ok(lstatSync(l.binPrism).isSymbolicLink());
    assert.equal(readlinkSync(l.binPrism), "../app/current/bin/prism");
    assert.ok(existsSync(join(versionDir(l, "0.1.0"), "build-info.json")));
    assert.ok(existsSync(l.marker));
    assert.deepEqual(ctx.launchctl, []); // --no-launchd: launchctl is never run
    const envBefore = readFileSync(l.envFile, "utf8");

    const again = await cmdInstall(ctx, args());
    assert.equal(again.code, EXIT.OK);
    assert.equal(readFileSync(l.envFile, "utf8"), envBefore);

    // another version over this install: refused, use update
    const other = ctxFor(root, fakeBundle(root, "0.2.0"));
    await assert.rejects(cmdInstall(other, args()), (e: { code?: number }) => e.code === EXIT.PRECONDITION);

    // status of an install whose server is not running
    const st = await cmdStatus(ctx, parseArgs(["status", "--prefix", prefix], { bool: [], value: ["prefix"] }));
    assert.equal(st.code, EXIT.NOT_RUNNING);
    assert.equal((st.config as { vaultTokenSet: boolean }).vaultTokenSet, true);

    // uninstall: --delete-data needs --yes; plain uninstall keeps config + data
    const ua = (extra: string[]) => parseArgs(["uninstall", "--prefix", prefix, ...extra], { bool: ["delete-data", "yes", "dry-run"], value: ["prefix"] });
    await assert.rejects(cmdUninstall(ctx, ua(["--delete-data"])), (e: { code?: number }) => e.code === EXIT.NEEDS_CONFIRMATION);
    writeFileSync(l.db, "db");
    const u = await cmdUninstall(ctx, ua([]));
    assert.equal(u.code, EXIT.OK);
    assert.deepEqual(ctx.launchctl, []);
    assert.equal(existsSync(l.appRoot), false);
    assert.equal(existsSync(l.binPrism), false);
    assert.ok(existsSync(l.envFile) && existsSync(l.db));
    // the app can be installed again over the kept data and .env (secrets unchanged)
    assert.equal((await cmdInstall(ctx, args())).code, EXIT.OK);
    assert.equal(parseEnv(readFileSync(l.envFile, "utf8")).SECRETS_KEY, parseEnv(envBefore).SECRETS_KEY);
    const d = await cmdUninstall(ctx, ua(["--delete-data", "--yes"]));
    assert.equal(d.code, EXIT.OK);
    assert.equal(existsSync(prefix), false);
    // a folder that is not an install is never removed
    mkdirSync(prefix);
    writeFileSync(join(prefix, "keep.txt"), "mine");
    await assert.rejects(cmdUninstall(ctx, ua(["--delete-data", "--yes"])), (e: { code?: number }) => e.code === EXIT.NOT_INSTALLED);
    assert.ok(existsSync(join(prefix, "keep.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install with launchd: the plist goes to ~/Library/LaunchAgents and is bootstrapped (through the injected runner)", async () => {
  const root = scratch();
  try {
    const bundle = fakeBundle(root, "0.1.0");
    const ctx = ctxFor(root, bundle);
    const prefix = join(root, "Host");
    const r = await cmdInstall(ctx, parseArgs(["install", "--prefix", prefix, "--owner-email", "o@example.com", "--port", "9556"], { bool: [], value: ["prefix", "owner-email", "port"] }));
    assert.equal(r.code, EXIT.OK, JSON.stringify(r));
    const label = labelFor(loadIdentity(LAUNCHD_DIR), "server");
    const plist = join(ctx.home, "Library/LaunchAgents", `${label}.plist`);
    assert.ok(existsSync(plist));
    assert.equal(modeOf(plist), 0o644);
    assert.ok(ctx.launchctl.some((c) => c.join(" ") === `launchctl bootstrap gui/501 ${plist}`), JSON.stringify(ctx.launchctl));
    // no vault token yet: installed, not started, said so
    assert.match((r.warnings as string[]).join(" "), /PARACHUTE_TOKEN is empty/);
    // update refuses without a checksum
    const up = await cmdUpdate(ctx, parseArgs(["update", join(root, "nope.tar.gz"), "--prefix", prefix], { bool: [], value: ["prefix"] }));
    assert.equal(up.code, EXIT.VERIFY_FAILED);
    const un = await cmdUninstall(ctx, parseArgs(["uninstall", "--prefix", prefix], { bool: [], value: ["prefix"] }));
    assert.equal(un.code, EXIT.OK);
    assert.equal(existsSync(plist), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
