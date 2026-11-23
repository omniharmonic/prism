/**
 * `prism install` over a prefix whose data was kept by `prism uninstall` (clean-VM follow-up,
 * docs/host-bundle.md § uninstall): state.json — which said "stock" — is gone, so install runs
 * setup's own `vault` step and stock Parachute's hub agent comes back before the server starts.
 * When Parachute cannot be brought back, install says so: exit 11 with `next: prism setup --from vault`.
 *
 * No real Parachute, launchd or port: fake `parachute` / `parachute-vault` scripts, an injected
 * `launchctl` that remembers what is loaded, and an injected fetch for the hub, vault and server.
 * No wall-clock assertion: everything answers at once.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { layoutFor, privateDirs, type Layout } from "../../../packaging/host/cli/paths";
import { readState } from "../../../packaging/host/cli/state";
import { freshEnv, setKeys } from "../../../packaging/host/cli/hostenv";
import { parseArgs } from "../../../packaging/host/cli/args";
import { cmdInstall, type Ctx } from "../../../packaging/host/cli/commands";
import { loadIdentity } from "../../../packaging/host/cli/plist";
import { EXIT } from "../../../packaging/host/cli/exit-codes";
import type { Runner } from "../../../packaging/host/cli/launchd";
import type { Fetch } from "../../../packaging/host/cli/health";

const REPO = resolve(import.meta.dirname, "../../..");
const LAUNCHD_DIR = join(REPO, "packaging/host/launchd");
const NOW = new Date("2026-10-20T00:00:00Z");
const PORT = 9613;
const identity = loadIdentity(LAUNCHD_DIR);
const HUB = `${identity.labelPrefix}.hub`;
const SERVER = `${identity.labelPrefix}.server`;
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const FAKE_VAULT = `#!/bin/sh
printf 'vault %s\\n' "$*" >> "$HOME/calls"
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
  bundle: string;
  loaded: Set<string>;
  calls: string[];
}

/** A prefix as `prism uninstall` (without --delete-data) leaves it: config, data, parachute — no app/, no state.json. */
function afterUninstall(o: { parachuteInstalled: boolean }): W {
  const root = mkdtempSync(join(tmpdir(), "prism-reinstall-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const layout = layoutFor(join(root, "Host"));
  for (const d of privateDirs(layout)) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(layout.marker, "x\n");
  const pHome = layout.parachuteHome;
  mkdirSync(join(pHome, "vault", "data", "default"), { recursive: true, mode: 0o700 });
  writeFileSync(join(pHome, "vault", "data", "default", "vault.yaml"), "name: default\n", { mode: 0o600 });
  writeFileSync(join(pHome, "operator.token"), "jwt\n", { mode: 0o600 });
  const bin = join(home, ".bun", "bin", "parachute");
  const vaultBin = join(home, ".bun", "bin", "parachute-vault");
  if (o.parachuteInstalled) {
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    writeFileSync(bin, FAKE_HUB, { mode: 0o755 });
    writeFileSync(vaultBin, FAKE_VAULT, { mode: 0o755 });
  }
  // The .env `prism setup` left: stock paths + a vault token.
  const env = setKeys(freshEnv(layout, { ownerEmail: "owner@example.com", port: PORT, parachuteToken: "vault-token" }), [
    ["PARACHUTE_BIN", bin],
    ["PARACHUTE_VAULT_BIN", vaultBin],
    ["PARACHUTE_HOME", pHome],
  ]);
  writeFileSync(layout.envFile, env, { mode: 0o600 });
  // The bundle being installed, outside the prefix.
  const bundle = join(root, "prism-host-0.9.0-darwin-arm64");
  mkdirSync(join(bundle, "bin"), { recursive: true });
  mkdirSync(join(bundle, "share"), { recursive: true });
  writeFileSync(join(bundle, "bin", "prism"), "#!/bin/sh\n");
  writeFileSync(join(bundle, "build-info.json"), JSON.stringify({ name: "prism-host", version: "0.9.0", platform: "darwin", arch: "arm64", commit: "x", builtAt: "x", node: { version: "22.0.0", sha256: "x" }, parachute: { bundled: false, version: null }, paths: { node: "runtime/node/bin/node", cli: "libexec/prism.mjs", server: "x", tsxLoader: "x", web: "x", webNative: "x", launchd: "share/launchd" } }));
  symlinkSync(LAUNCHD_DIR, join(bundle, "share", "launchd"));
  return { root, home, layout, bundle, loaded: new Set(), calls: [] };
}

function ctxFor(w: W): Ctx {
  const runner: Runner = async (cmd, args) => {
    if (cmd !== "launchctl") return { code: 0, stdout: "", stderr: "" };
    w.calls.push(args.join(" "));
    const [verb, a, b] = args;
    const labelOf = (t: string) => t.split("/").pop()!;
    if (verb === "print") return w.loaded.has(labelOf(a!)) ? { code: 0, stdout: "state = running\n\tpid = 4242\n", stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
    if (verb === "bootstrap") w.loaded.add(basename(b!, ".plist"));
    if (verb === "bootout") w.loaded.delete(labelOf(a!));
    return { code: 0, stdout: "", stderr: "" };
  };
  const parachuteUp = () => w.loaded.has(HUB);
  const fetchFn: Fetch = async (url) => {
    const json = (status: number, body: unknown = {}) => ({ status, json: async () => body });
    if (url.startsWith("http://127.0.0.1:1939/") || url.startsWith("http://127.0.0.1:1940/")) {
      if (!parachuteUp()) throw new Error("ECONNREFUSED");
      return json(200);
    }
    if (url.startsWith(`http://127.0.0.1:${PORT}/`)) {
      if (!w.loaded.has(SERVER)) throw new Error("ECONNREFUSED");
      if (url.endsWith("/health?live=1")) return json(200, { ok: true, live: true });
      if (url.endsWith("/api/version")) return json(200, { version: "0.9.0" });
      if (url.endsWith("/health")) return parachuteUp() ? json(200, { ok: true, vault: true }) : json(503, { ok: false, vault: false });
    }
    throw new Error(`ECONNREFUSED ${url}`);
  };
  return {
    bundleRoot: w.bundle,
    home: w.home,
    uid: 501,
    env: { PATH: "/usr/bin:/bin", HOME: w.home },
    runner,
    fetch: fetchFn,
    probes: { hardwareArch: () => "arm64", platform: () => "darwin", macosVersion: () => "15.1", portFree: async () => true, freeBytes: () => 50 * 1024 ** 3, isRoot: () => false },
    openSqlite: () => {
      throw new Error("unused");
    },
    copyTree: (src, dst) => execFileSync("/bin/cp", ["-R", src, dst]),
    now: () => NOW,
    log: () => {},
    healthTimeoutMs: 1000,
  };
}

const installArgs = (w: W, extra: string[] = []) =>
  parseArgs(["install", "--prefix", w.layout.prefix, "--skip-checks", "--no-signin", ...extra], { bool: ["dry-run", "skip-checks", "no-signin"], value: ["prefix", "parachute", "parachute-bin"] });

test("reinstall over kept data: install runs setup's vault step — stock mode and Prism's hub agent come back, then the server; exit 0, vault reachable", async () => {
  const w = afterUninstall({ parachuteInstalled: true });
  const r = await cmdInstall(ctxFor(w), installArgs(w));
  assert.equal(r.code, EXIT.OK, JSON.stringify(r));
  const p = r.parachute as { step: string; state: string; changed: string[] };
  assert.equal(p.step, "vault");
  assert.equal(p.state, "done");
  assert.ok(p.changed.includes("hub-agent") && p.changed.includes("parachute-mode:stock"), JSON.stringify(p));
  assert.equal(readState(w.layout)!.parachute, "stock");
  assert.ok(w.loaded.has(HUB) && w.loaded.has(SERVER));
  // The hub was loaded once (by the vault step) and not bounced by install's re-load loop.
  assert.equal(w.calls.filter((c) => c.startsWith("bootstrap") && c.includes(`${HUB}.plist`)).length, 1);
  assert.ok(!w.calls.some((c) => c === `bootout gui/501/${HUB}`));
  assert.equal((r.health as { last: { vault: boolean } }).last.vault, true);
  // The vault was not created again: it was kept.
  assert.ok(!existsSync(join(w.home, "calls")) || !/vault create/.test(String(execFileSync("/bin/cat", [join(w.home, "calls")]))));
});

test("reinstall over kept data with Parachute gone: the vault step needs the person; the server runs but cannot reach the vault → exit 11, next: prism setup --from vault", async () => {
  const w = afterUninstall({ parachuteInstalled: false });
  const r = await cmdInstall(ctxFor(w), installArgs(w));
  assert.equal(r.code, EXIT.DEGRADED, JSON.stringify(r));
  assert.equal(r.next, "prism setup --from vault");
  assert.equal((r.parachute as { state: string }).state, "needs-person");
  assert.ok((r.parachute as { commands?: unknown[] }).commands?.length, "the install commands are passed on");
  assert.match((r.warnings as string[]).join(" "), /Parachute is not ready.*prism setup --from vault/);
  assert.ok(!w.loaded.has(HUB));
});

test("reinstall with an explicit --parachute: the vault step is not run (the flag wins)", async () => {
  const w = afterUninstall({ parachuteInstalled: true });
  const r = await cmdInstall(ctxFor(w), installArgs(w, ["--parachute", "external"]));
  assert.equal(r.parachute, undefined);
  assert.ok(!w.loaded.has(HUB));
  assert.equal(r.code, EXIT.DEGRADED);
  assert.equal(r.next, "prism setup --from vault");
});

test("reinstall --dry-run says it will run the vault step and changes nothing", async () => {
  const w = afterUninstall({ parachuteInstalled: true });
  const r = await cmdInstall(ctxFor(w), installArgs(w, ["--dry-run"]));
  assert.match((r.actions as string[]).join("\n"), /reinstall over kept data: run setup's vault step/);
  assert.equal(readState(w.layout), null);
  assert.ok(!w.calls.some((c) => !c.startsWith("print")));
});
