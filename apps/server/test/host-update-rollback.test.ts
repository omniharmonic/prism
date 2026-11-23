/**
 * `prism update` housekeeping after a rollback (clean-VM follow-up, docs/host-bundle.md
 * § Update and rollback): the failed version is never reported as `previous`, its tree is
 * pruned after a healthy rollback (kept after an unhealthy one), the healthy previous tree is
 * never removed; and the health wait ends early when the new server's PROCESS keeps exiting.
 * Effects are injected (fake deps, a fake clock, a fake launchctl); nothing reads the wall clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runUpdate, nextDataVersion, type UpdateDeps, type StagedBundle } from "../../../packaging/host/cli/update";
import { EXIT } from "../../../packaging/host/cli/exit-codes";
import { ExitWatch, waitHealthy, type Fetch } from "../../../packaging/host/cli/health";
import { layoutFor, versionDir } from "../../../packaging/host/cli/paths";
import { emptyState, readState, writeState, type BuildInfo } from "../../../packaging/host/cli/state";
import { symlinkAtomic } from "../../../packaging/host/cli/fsutil";
import { parseArgs } from "../../../packaging/host/cli/args";
import { cmdStatus, realUpdateDeps, serverExitWatch, type Ctx } from "../../../packaging/host/cli/commands";
import { labelFor, loadIdentity } from "../../../packaging/host/cli/plist";

const LAUNCHD_DIR = resolve(import.meta.dirname, "../../../packaging/host/launchd");

function info(version: string): BuildInfo {
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
  };
}

function fake(o: { current: string; previous: string | null; candidate: string; healthy: (v: string) => boolean }) {
  const calls: string[] = [];
  const recorded: Array<Parameters<UpdateDeps["record"]>[0]> = [];
  const state = { current: o.current as string | null, previous: o.previous, dataVersion: o.current as string | null };
  const deps: UpdateDeps = {
    log: () => {},
    verify: async () => ({ ok: true, sha256: "f".repeat(64) }),
    unpack: async () => ({ dir: "/staged", info: info(o.candidate) }),
    discard: () => calls.push("discard"),
    installed: () => ({ ...state }),
    backup: async () => ({ ok: true, dir: "/b" }),
    place: (s: StagedBundle) => calls.push(`place:${s.info.version}`),
    pointCurrent: (v) => {
      calls.push(`current:${v}`);
      state.current = v;
    },
    managed: () => true,
    restart: async () => void calls.push("restart"),
    waitHealthy: async (v) => (o.healthy(v) ? { ok: true } : { ok: false, reason: "the server process exited 2 times while starting" }),
    record: (r) => {
      recorded.push(r);
      state.previous = r.previous;
      if (r.healthyVersion) state.dataVersion = nextDataVersion(state.dataVersion, r.healthyVersion);
    },
    prune: (keep) => calls.push(`prune:${keep.join(",")}`),
  };
  return { deps, calls, recorded, state };
}

test("rollback: previous stays the healthy earlier version, the failure is recorded, only the failed tree is pruned", async () => {
  const f = fake({ current: "0.2.0", previous: "0.1.0", candidate: "0.3.0", healthy: (v) => v !== "0.3.0" });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.ROLLED_BACK);
  const last = f.recorded.at(-1)!;
  assert.equal(last.current, "0.2.0");
  assert.equal(last.previous, "0.1.0"); // never the failed 0.3.0
  assert.deepEqual(last.failed, { version: "0.3.0", reason: "the server process exited 2 times while starting", treeKept: false });
  // keep = current + the healthy previous: 0.3.0 is the only tree that goes.
  assert.equal(f.calls.at(-1), "prune:0.2.0,0.1.0");
  assert.ok(r.steps.some((s) => /removed the failed 0\.3\.0 tree/.test(s)));
  assert.equal(f.state.dataVersion, "0.2.0");
});

test("rollback with no earlier previous: previous is null, not the failed version", async () => {
  const f = fake({ current: "0.1.0", previous: null, candidate: "0.2.0", healthy: (v) => v === "0.1.0" });
  await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(f.recorded.at(-1)!.previous, null);
  assert.equal(f.calls.at(-1), "prune:0.1.0");
});

test("rollback of a forced downgrade to the previous version never removes that (once healthy) tree", async () => {
  const f = fake({ current: "0.2.0", previous: "0.1.0", candidate: "0.1.0", healthy: (v) => v === "0.2.0" });
  const r = await runUpdate("/x.tar.gz", { force: true }, f.deps);
  assert.equal(r.code, EXIT.ROLLED_BACK);
  assert.equal(f.calls.at(-1), "prune:0.2.0,0.1.0");
  assert.equal(f.recorded.at(-1)!.failed!.treeKept, true);
});

test("a rollback that is not healthy prunes nothing and still does not call the failed version previous", async () => {
  const f = fake({ current: "0.2.0", previous: "0.1.0", candidate: "0.3.0", healthy: () => false });
  const r = await runUpdate("/x.tar.gz", {}, f.deps);
  assert.equal(r.code, EXIT.ROLLBACK_FAILED);
  assert.ok(!f.calls.some((c) => c.startsWith("prune:")));
  const last = f.recorded.at(-1)!;
  assert.equal(last.previous, "0.1.0");
  assert.equal(last.failed!.treeKept, true);
});

// ── the exit watch ───────────────────────────────────────────────────────────

const running = (pid: number) => ({ loaded: true, pid, lastExit: "(never exited)" });
const stopped = (lastExit = "1") => ({ loaded: true, pid: null, lastExit });

test("exit watch: a process that keeps running (healthy or not yet) never ends the wait", () => {
  const w = new ExitWatch();
  for (let i = 0; i < 50; i++) assert.equal(w.observe(running(100)), null);
  // never started yet (no pid at all) is not an exit either
  const v = new ExitWatch();
  for (let i = 0; i < 50; i++) assert.equal(v.observe(stopped("(never exited)")), null);
});

test("exit watch: one exit is not enough (the instance kickstart replaced); two end the wait with launchd's code", () => {
  const w = new ExitWatch();
  assert.equal(w.observe(running(100)), null);
  assert.equal(w.observe(stopped()), null); // exit 1 (throttled)
  assert.equal(w.observe(running(101)), null); // launchd restarted it
  const r = w.observe(stopped("1")); // exit 2
  assert.match(String(r), /exited 2 times while starting.*last exit code: 1/);
});

test("exit watch: a pid replaced between two readings counts as an exit; an unloaded agent ends it at once", () => {
  const w = new ExitWatch();
  w.observe(running(1));
  assert.equal(w.observe(running(2)), null);
  assert.match(String(w.observe(running(3))), /exited 2 times/);
  assert.match(String(new ExitWatch().observe({ loaded: false, pid: null, lastExit: null })), /no longer loaded/);
});

// ── waitHealthy with a failFast hook (fake clock) ────────────────────────────

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}
const dead: Fetch = async () => {
  throw new Error("ECONNREFUSED");
};

test("health wait: failFast ends it early, with its reason; null keeps the full wait", async () => {
  const c = fakeClock();
  let rounds = 0;
  const r = await waitHealthy(dead, "http://x", "0.2.0", { timeoutMs: 120_000, ...c, failFast: async () => (++rounds >= 3 ? "the server process exited 2 times while starting" : null) });
  assert.equal(r.ok, false);
  assert.equal(r.exited, true);
  assert.match(String(r.reason), /exited 2 times/);
  assert.equal(rounds, 3);
  assert.ok(c.now() < 120_000);

  const d = fakeClock();
  const r2 = await waitHealthy(dead, "http://x", "0.2.0", { timeoutMs: 10_000, ...d, failFast: async () => null });
  assert.equal(r2.ok, false);
  assert.equal(r2.exited, undefined);
  assert.ok(d.now() >= 10_000);
  assert.match(String(r2.reason), /did not answer/);
});

test("health wait: a healthy answer wins over the hook (asked only while not healthy)", async () => {
  let asked = 0;
  const ok: Fetch = async (url) => ({ status: 200, json: async () => (url.endsWith("/api/version") ? { version: "0.2.0" } : {}) });
  const r = await waitHealthy(ok, "http://x", "0.2.0", { timeoutMs: 1000, ...fakeClock(), failFast: async () => (asked++, "dead") });
  assert.equal(r.ok, true);
  assert.equal(asked, 0);
});

// ── the real deps against a scratch prefix ───────────────────────────────────

function tree(root: string, version: string) {
  const d = versionDir(layoutFor(root), version);
  mkdirSync(join(d, "share"), { recursive: true });
  writeFileSync(join(d, "build-info.json"), JSON.stringify(info(version)));
  symlinkSync(LAUNCHD_DIR, join(d, "share", "launchd"));
}

function ctxWith(root: string, runner: Ctx["runner"]): Ctx {
  return {
    bundleRoot: versionDir(layoutFor(join(root, "H")), "0.2.0"),
    home: join(root, "home"),
    uid: 501,
    env: {},
    runner,
    fetch: async () => ({ status: 503, json: async () => ({}) }),
    probes: { hardwareArch: () => "arm64", platform: () => "darwin", macosVersion: () => "15.1", portFree: async () => true, freeBytes: () => 50 * 1024 ** 3, isRoot: () => false },
    openSqlite: () => {
      throw new Error("not used");
    },
    copyTree: () => {},
    now: () => new Date("2026-10-20T00:00:00Z"),
    log: () => {},
    healthTimeoutMs: 1000,
  };
}

test("real deps: record + prune after a healthy rollback leave current and the healthy previous; status reports the failure as failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-rollback-"));
  try {
    const prefix = join(root, "H");
    const l = layoutFor(prefix);
    for (const v of ["0.1.0", "0.2.0", "0.3.0"]) tree(prefix, v);
    mkdirSync(l.data, { recursive: true });
    symlinkAtomic("0.2.0", l.current);
    const state = { ...emptyState("2026-10-20T00:00:00Z", true, "external"), current: "0.2.0", previous: "0.1.0", installed: ["0.1.0", "0.2.0", "0.3.0"] };
    writeState(l, state);
    const ctx = ctxWith(root, async () => ({ code: 113, stdout: "", stderr: "" }));
    const p = parseArgs(["update", "x", "--prefix", prefix], { bool: [], value: ["prefix"] });
    const d = realUpdateDeps(ctx, l, state, p);
    d.record({ current: "0.2.0", previous: "0.1.0", healthyVersion: null, action: "update", result: "rolled back: x", from: "0.2.0", to: "0.3.0", failed: { version: "0.3.0", reason: "x", treeKept: false } });
    d.prune(["0.2.0", "0.1.0"]);
    assert.ok(existsSync(versionDir(l, "0.1.0")));
    assert.ok(existsSync(versionDir(l, "0.2.0")));
    assert.equal(existsSync(versionDir(l, "0.3.0")), false);
    const saved = readState(l)!;
    assert.equal(saved.previous, "0.1.0");
    assert.deepEqual(saved.installed, ["0.1.0", "0.2.0"]);
    assert.deepEqual(saved.lastFailedUpdate, { version: "0.3.0", at: "2026-10-20T00:00:00.000Z", reason: "x", treeKept: false });
    const st = await cmdStatus(ctx, parseArgs(["status", "--prefix", prefix], { bool: [], value: ["prefix"] }));
    assert.equal(st.previous, "0.1.0");
    assert.equal((st.lastFailedUpdate as { status: string; version: string }).status, "failed");
    assert.equal((st.lastFailedUpdate as { version: string }).version, "0.3.0");

    // a later healthy update clears it
    d.record({ current: "0.4.0", previous: "0.2.0", healthyVersion: "0.4.0", action: "update", result: "ok", from: "0.2.0", to: "0.4.0" });
    assert.equal(readState(l)!.lastFailedUpdate, undefined);
    assert.match(readFileSync(l.dataVersionFile, "utf8"), /0\.4\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real deps: the exit watch reads the server agent through launchctl print (read-only)", async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-rollback-"));
  try {
    const prefix = join(root, "H");
    const l = layoutFor(prefix);
    tree(prefix, "0.2.0");
    symlinkAtomic("0.2.0", l.current);
    const label = labelFor(loadIdentity(LAUNCHD_DIR), "server");
    const prints = ["pid = 10\n\tstate = running", "state = not running\n\tlast exit code = 1", "pid = 11\n\tstate = running", "state = not running\n\tlast exit code = 1"];
    const seen: string[][] = [];
    const ctx = ctxWith(root, async (cmd, args) => {
      seen.push([cmd, ...args]);
      return { code: 0, stdout: prints.shift() ?? "", stderr: "" };
    });
    const watch = serverExitWatch(ctx, l);
    assert.equal(await watch(), null);
    assert.equal(await watch(), null);
    assert.equal(await watch(), null);
    assert.match(String(await watch()), /exited 2 times.*last exit code: 1/);
    assert.ok(seen.every((c) => c[0] === "launchctl" && c[1] === "print" && c[2] === `gui/501/${label}`), JSON.stringify(seen));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
