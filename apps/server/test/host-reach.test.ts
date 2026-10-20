/**
 * `prism reach` (packaging/host/cli/reach.ts + commands.ts cmdReach) and the server half
 * (src/reach.ts, routes/local-reach.ts, the checklist's `reachable` step).
 *
 * Tailscale is a FAKE: a small executable that keeps its serve configuration in a scratch
 * folder and logs every argv it gets (run through the CLI's real runner), plus pure fixtures.
 * Nothing here runs the real `tailscale`.
 */
import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../../packaging/host/cli/args";
import { cmdReach, type Ctx } from "../../../packaging/host/cli/commands";
import { EXIT } from "../../../packaging/host/cli/exit-codes";
import { layoutFor, privateDirs, type Layout } from "../../../packaging/host/cli/paths";
import { emptyState, writeState } from "../../../packaging/host/cli/state";
import { realRunner } from "../../../packaging/host/cli/launchd";
import type { Fetch } from "../../../packaging/host/cli/health";
import { TAILSCALE_APP_BIN, parseServe, parseStatus, planServe, replaceableOrigin, tailscaleCandidates, withAppOrigin, type ReachDeps } from "../../../packaging/host/cli/reach";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { setHostKeyForTests } from "../src/auth/local-signin";
import { resetLocalSigninLimitsForTests } from "../src/routes/local-signin";
import { classifyReachRequest, isTailnetAddress, reachSeen, sameAddress, setReachExpectation } from "../src/reach";
import { setupStatus, type SetupFacts } from "../src/setup-status";
import { readSetupStatus } from "../src/setup-facts";
import { listActionAudit } from "../src/actions/store";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

const NAME = "studio-mac.tail1234.ts.net";
const ORIGIN = `https://${NAME}`;
const SELF4 = "100.101.1.2";
const SELF6 = "fd7a:115c:a1e0::1001:b7c5";
const KEY = "reach-host-key-0123456789abcdefghijklmnopqrstu";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  setHostKeyForTests(null);
});
const scratch = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  roots.push(d);
  return d;
};

// ── fixtures ─────────────────────────────────────────────────────────────────

const loggedIn = (over: Record<string, unknown> = {}) => ({
  Version: "1.102.2-t6cac91817-g6ff0ddc72",
  BackendState: "Running",
  Self: { DNSName: `${NAME}.`, TailscaleIPs: [SELF4, SELF6], CapMap: { https: null, "https://tailscale.com/cap/ssh": null }, Capabilities: ["https"] },
  CertDomains: [NAME],
  MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "person@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  ...over,
});
const loggedOut = { Version: "1.102.2", BackendState: "NeedsLogin", Self: { DNSName: "", TailscaleIPs: [] }, AuthURL: "" };
const res = (stdout: string, code = 0, stderr = "") => ({ code, stdout, stderr });

test("status fixtures: not running, logged out, too old, logged in (name, addresses, https, funnel)", () => {
  assert.deepEqual(parseStatus("/x/tailscale", res("", 1, "failed to connect to local Tailscale daemon")), { state: "not-running", bin: "/x/tailscale", detail: "failed to connect to local Tailscale daemon" });
  assert.equal(parseStatus("/x", res(JSON.stringify(loggedOut), 1)).state, "logged-out");
  assert.equal(parseStatus("/x", res(JSON.stringify({ ...loggedIn(), Version: "1.50.1" }))).state, "too-old");
  const t = parseStatus("/x", res(JSON.stringify(loggedIn())));
  assert.equal(t.state, "ready");
  if (t.state !== "ready") return;
  assert.equal(t.dnsName, NAME);
  assert.deepEqual(t.addresses, [SELF4, SELF6]);
  assert.equal(t.https, true);
  assert.equal(t.funnelAllowed, false);
  const f = parseStatus("/x", res(JSON.stringify(loggedIn({ Self: { ...loggedIn().Self, CapMap: { https: null, funnel: null } } }))));
  assert.equal(f.state === "ready" && f.funnelAllowed, true);
  const noCert = parseStatus("/x", res(JSON.stringify(loggedIn({ CertDomains: [], Self: { ...loggedIn().Self, CapMap: {}, Capabilities: [] } }))));
  assert.equal(noCert.state === "ready" && noCert.https, false);
});

test("the CLI is looked for in the Mac app first, then on PATH; PRISM_TAILSCALE_BIN overrides", () => {
  const c = tailscaleCandidates({ PATH: "/usr/bin:/opt/x/bin" });
  assert.equal(c[0], TAILSCALE_APP_BIN);
  assert.ok(c.includes("/opt/x/bin/tailscale"));
  assert.deepEqual(tailscaleCandidates({ PRISM_TAILSCALE_BIN: "/fake/ts", PATH: "/usr/bin" }), ["/fake/ts"]);
});

test("serve status: none / ours (private or Funnel) / someone else's on 443", () => {
  assert.deepEqual(parseServe("{}", NAME, 8787), { kind: "none" });
  const ours = { TCP: { "443": { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } };
  assert.deepEqual(parseServe(JSON.stringify(ours), NAME, 8787), { kind: "ours", funnel: false });
  assert.deepEqual(parseServe(JSON.stringify({ ...ours, AllowFunnel: { [`${NAME}:443`]: true } }), NAME, 8787), { kind: "ours", funnel: true });
  assert.equal(parseServe(JSON.stringify(ours), NAME, 9000).kind, "other", "another port behind the name is not ours");
  const two = { ...ours, Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" }, "/grafana": { Proxy: "http://127.0.0.1:3000" } } } } };
  assert.equal(parseServe(JSON.stringify(two), NAME, 8787).kind, "other");
  assert.equal(parseServe(JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } }), NAME, 8787).kind, "other");
  // Another port of the name (8443) is not looked at.
  assert.deepEqual(parseServe(JSON.stringify({ TCP: { "8443": { HTTPS: true } }, Web: { [`${NAME}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }), NAME, 8787), { kind: "none" });
});

test("the exact tailscale argv for every move (1.52+ syntax); a conflict is never planned over", () => {
  const T = "http://127.0.0.1:8787";
  assert.deepEqual(planServe("serve", { kind: "none" }, 8787), [["serve", "--bg", "--https=443", T]]);
  assert.deepEqual(planServe("funnel", { kind: "none" }, 8787), [["funnel", "--bg", "--https=443", T]]);
  assert.deepEqual(planServe("serve", { kind: "ours", funnel: false }, 8787), [], "idempotent");
  assert.deepEqual(planServe("funnel", { kind: "ours", funnel: true }, 8787), []);
  assert.deepEqual(planServe("funnel", { kind: "ours", funnel: false }, 8787), [["serve", "--https=443", "off"], ["funnel", "--bg", "--https=443", T]]);
  assert.deepEqual(planServe("serve", { kind: "ours", funnel: true }, 8787), [["funnel", "--https=443", "off"], ["serve", "--bg", "--https=443", T]]);
  assert.deepEqual(planServe("off", { kind: "ours", funnel: false }, 8787), [["serve", "--https=443", "off"]]);
  assert.deepEqual(planServe("off", { kind: "ours", funnel: true }, 8787), [["funnel", "--https=443", "off"]]);
  assert.deepEqual(planServe("off", { kind: "none" }, 8787), []);
  assert.equal(planServe("serve", { kind: "other", detail: "x" }, 8787), null);
  assert.deepEqual(planServe("off", { kind: "other", detail: "x" }, 8787), [], "off never touches what is not ours");
  // Only Prism's port, never the hub's or the vault's.
  for (const plan of [planServe("serve", { kind: "none" }, 8787)!, planServe("funnel", { kind: "none" }, 8787)!]) assert.ok(!JSON.stringify(plan).match(/1939|1940/));
});

test(".env: only APP_ORIGIN changes, every other line kept byte for byte", () => {
  const env = "APP_ORIGIN=http://localhost:8787\nPORT=8787\nNATIVE_ORIGINS=tauri://localhost\n# a comment\nSECRETS_KEY=abc=\n";
  const next = withAppOrigin(env, ORIGIN)!;
  assert.equal(next, env.replace("APP_ORIGIN=http://localhost:8787", `APP_ORIGIN=${ORIGIN}`));
  assert.equal(withAppOrigin(next, ORIGIN), null, "already set: no write");
  assert.equal(withAppOrigin("PORT=8787\n", ORIGIN), `PORT=8787\nAPP_ORIGIN=${ORIGIN}\n`);
  assert.equal(replaceableOrigin("http://localhost:8787", 8787, ORIGIN), true);
  assert.equal(replaceableOrigin("https://other.tail9.ts.net", 8787, ORIGIN), true);
  assert.equal(replaceableOrigin("https://prism.acme.dev", 8787, ORIGIN), false);
});

// ── the command, with a fake tailscale executable ────────────────────────────

/** A fake `tailscale` the CLI's real runner executes. Keeps serve config + an argv log in `dir`. */
function fakeTailscale(status: unknown | null, opts: { funnelOffKeepsServe?: boolean } = {}) {
  const dir = scratch("prism-fake-ts-");
  const bin = join(dir, "tailscale");
  writeFileSync(join(dir, "serve.json"), "{}");
  if (status !== null) writeFileSync(join(dir, "status.json"), JSON.stringify(status));
  const src = `#!${process.execPath}
const fs = require("fs"); const D = ${JSON.stringify(dir)}; const NAME = ${JSON.stringify(NAME)};
const a = process.argv.slice(2);
fs.appendFileSync(D + "/argv.log", JSON.stringify(a) + "\\n");
if (a[0] === "status") {
  if (!fs.existsSync(D + "/status.json")) { process.stderr.write("failed to connect to local Tailscale daemon\\n"); process.exit(1); }
  const s = fs.readFileSync(D + "/status.json", "utf8"); process.stdout.write(s); process.exit(JSON.parse(s).BackendState === "Running" ? 0 : 1);
}
const hp = NAME + ":443";
if ((a[0] === "serve" || a[0] === "funnel") && a[1] === "status") { process.stdout.write(fs.readFileSync(D + "/serve.json", "utf8")); process.exit(0); }
if ((a[0] === "serve" || a[0] === "funnel") && a[1] === "--bg" && a[2] === "--https=443" && a[3]) {
  const c = { TCP: { "443": { HTTPS: true } }, Web: { [hp]: { Handlers: { "/": { Proxy: a[3] } } } } };
  if (a[0] === "funnel") c.AllowFunnel = { [hp]: true };
  fs.writeFileSync(D + "/serve.json", JSON.stringify(c)); process.exit(0);
}
if ((a[0] === "serve" || a[0] === "funnel") && a[1] === "--https=443" && a[2] === "off") {
  const c = JSON.parse(fs.readFileSync(D + "/serve.json", "utf8"));
  if (a[0] === "funnel" && ${opts.funnelOffKeepsServe ? "true" : "false"}) { delete c.AllowFunnel; fs.writeFileSync(D + "/serve.json", JSON.stringify(c)); }
  else fs.writeFileSync(D + "/serve.json", "{}");
  process.exit(0);
}
process.stderr.write("fake tailscale: unexpected " + a.join(" ") + "\\n"); process.exit(2);
`;
  writeFileSync(bin, src);
  chmodSync(bin, 0o755);
  const argv = () => (existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
  const changes = () => argv().filter((x) => x[1] !== "status" && x[0] !== "status");
  const serve = () => JSON.parse(readFileSync(join(dir, "serve.json"), "utf8")) as Record<string, unknown>;
  const setServe = (v: unknown) => writeFileSync(join(dir, "serve.json"), JSON.stringify(v));
  return { bin, dir, argv, changes, serve, setServe };
}

function installed(port: number, appOrigin = `http://localhost:${port}`): Layout {
  const root = scratch("prism-reach-test-");
  const layout = layoutFor(join(root, "Host"));
  for (const d of privateDirs(layout)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const s = emptyState("2026-10-19T00:00:00Z", false, "external");
  s.current = "0.1.0";
  writeState(layout, s);
  writeFileSync(layout.envFile, `APP_ORIGIN=${appOrigin}\nPORT=${port}\nDB_PATH=${layout.db}\nOWNER_EMAIL=o@example.com\nNATIVE_ORIGINS=tauri://localhost\n`, { mode: 0o600 });
  writeFileSync(join(layout.data, "host-signin.key"), KEY + "\n", { mode: 0o600 });
  chmodSync(join(layout.data, "host-signin.key"), 0o600);
  return layout;
}

function ctxFor(fetch: Fetch, env: NodeJS.ProcessEnv): Ctx {
  return {
    bundleRoot: "/nonexistent",
    home: tmpdir(),
    uid: 501,
    env,
    runner: realRunner,
    fetch,
    probes: {} as Ctx["probes"],
    openSqlite: () => { throw new Error("unused"); },
    copyTree: () => {},
    now: () => new Date("2026-10-19T00:00:00Z"),
    log: () => {},
    healthTimeoutMs: 1000,
  };
}

const reachArgs = (sub: string, prefix: string, extra: string[] = []) => parseArgs(["reach", sub, "--prefix", prefix, ...extra], { bool: ["yes", "json", "dry-run"], value: ["prefix"] });

/** Deps as the CLI builds them, with a fake restart (no launchd) and no waiting. */
async function run(ctx: Ctx, layout: Layout, sub: string, extra: string[] = [], restarted: string[] = []) {
  const { reachDeps } = await import("../../../packaging/host/cli/commands");
  const state = { ...emptyState("x", true, "external"), current: "0.1.0" };
  const d: ReachDeps = { ...reachDeps(ctx, layout, state), restart: async () => { restarted.push(readFileSync(layout.envFile, "utf8")); return { ok: true, managed: true }; }, sleep: async () => {}, attempts: 2 };
  return cmdReach(ctx, reachArgs(sub, layout.prefix, extra), d);
}

test("not installed / logged out / not running: a next step for the person, and nothing is changed", async () => {
  const layout = installed(9601);
  const down: Fetch = async () => { throw new Error("unused"); };
  const none = await run(ctxFor(down, { PRISM_TAILSCALE_BIN: "/nonexistent/tailscale" }), layout, "tailscale");
  assert.equal(none.code, EXIT.PRECONDITION);
  assert.match(String(none.next), /not installed.*install the Tailscale app/);
  const stopped = fakeTailscale(null);
  const r1 = await run(ctxFor(down, { PRISM_TAILSCALE_BIN: stopped.bin }), layout, "tailscale");
  assert.equal(r1.code, EXIT.PRECONDITION);
  assert.match(String(r1.next), /not running/);
  const out = fakeTailscale(loggedOut);
  const r2 = await run(ctxFor(down, { PRISM_TAILSCALE_BIN: out.bin }), layout, "tailscale");
  assert.equal(r2.code, EXIT.PRECONDITION);
  assert.match(String(r2.next), /not signed in/);
  assert.deepEqual(out.changes(), [], "nothing but status was run");
  assert.match(readFileSync(layout.envFile, "utf8"), /^APP_ORIGIN=http:\/\/localhost:9601$/m);
  const st = await run(ctxFor(down, { PRISM_TAILSCALE_BIN: out.bin }), layout, "status");
  assert.equal(st.code, EXIT.OK);
  assert.equal(st.reachable, false);
});

test("--dry-run prints the exact commands and changes nothing", async () => {
  const layout = installed(9602);
  const ts = fakeTailscale(loggedIn());
  const r = await run(ctxFor(async () => { throw new Error("no request"); }, { PRISM_TAILSCALE_BIN: ts.bin }), layout, "tailscale", ["--dry-run"]);
  assert.equal(r.code, EXIT.OK);
  assert.deepEqual((r.actions as string[]).slice(0, 2), [`${ts.bin} serve --bg --https=443 http://127.0.0.1:9602`, `set APP_ORIGIN=${ORIGIN} in .env (nothing else changes)`]);
  assert.deepEqual(ts.changes(), []);
  assert.deepEqual(ts.serve(), {});
  assert.match(readFileSync(layout.envFile, "utf8"), /^APP_ORIGIN=http:\/\/localhost:9602$/m);
});

test("Funnel needs --yes (public internet) and the tailnet's funnel attribute; a public APP_ORIGIN needs --yes to replace", async () => {
  const layout = installed(9603);
  const nope: Fetch = async () => { throw new Error("no request"); };
  const ts = fakeTailscale(loggedIn());
  const noCap = await run(ctxFor(nope, { PRISM_TAILSCALE_BIN: ts.bin }), layout, "funnel", ["--yes"]);
  assert.equal(noCap.code, EXIT.PRECONDITION);
  assert.match(String(noCap.next), /funnel/);
  const ts2 = fakeTailscale(loggedIn({ Self: { ...loggedIn().Self, CapMap: { https: null, funnel: null } } }));
  const ask = await run(ctxFor(nope, { PRISM_TAILSCALE_BIN: ts2.bin }), layout, "funnel");
  assert.equal(ask.code, EXIT.NEEDS_CONFIRMATION);
  assert.match(String(ask.warning), /PUBLIC INTERNET/);
  assert.deepEqual(ts2.changes(), []);
  const cf = installed(9604, "https://prism.acme.dev");
  const keep = await run(ctxFor(nope, { PRISM_TAILSCALE_BIN: ts.bin }), cf, "tailscale");
  assert.equal(keep.code, EXIT.NEEDS_CONFIRMATION);
  assert.match(readFileSync(cf.envFile, "utf8"), /^APP_ORIGIN=https:\/\/prism\.acme\.dev$/m);
});

test("someone else's config on 443 is never overwritten", async () => {
  const layout = installed(9605);
  const ts = fakeTailscale(loggedIn());
  const theirs = { TCP: { "443": { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
  ts.setServe(theirs);
  const r = await run(ctxFor(async () => { throw new Error("no request"); }, { PRISM_TAILSCALE_BIN: ts.bin }), layout, "tailscale");
  assert.equal(r.code, EXIT.PRECONDITION);
  assert.deepEqual(ts.changes(), []);
  assert.deepEqual(ts.serve(), theirs);
  const off = await run(ctxFor(async () => { throw new Error("no request"); }, { PRISM_TAILSCALE_BIN: ts.bin }), layout, "off");
  assert.equal(off.code, EXIT.OK);
  assert.deepEqual(ts.serve(), theirs, "off leaves it alone too");
});

// ── end to end against the real app ──────────────────────────────────────────

let fv: FakeVault;
let prevOrigin: string;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  setHostKeyForTests(KEY);
  resetLocalSigninLimitsForTests();
  prevOrigin = config.appOrigin;
});
afterEach(() => {
  fv.restore();
  (config as { appOrigin: string }).appOrigin = prevOrigin;
});

const loop = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

/**
 * The network as the CLI sees it: loopback requests go straight to the app; an https request
 * to the Tailscale name arrives as tailscaled would deliver it (a loopback socket, Host kept,
 * X-Forwarded-For = this machine's tailnet address — a hairpin), but only while Prism is
 * served and the server's APP_ORIGIN has been switched (the "restart").
 */
function network(app: ReturnType<typeof createApp>, ts: ReturnType<typeof fakeTailscale>, port: number, calls: string[]): Fetch {
  return async (url, init) => {
    calls.push(url);
    const u = new URL(url);
    if (u.protocol === "https:") {
      const served = parseServe(JSON.stringify(ts.serve()), NAME, port).kind === "ours";
      if (!served) throw new Error("connect ECONNREFUSED");
      const r = await app.request(`http://${NAME}${u.pathname}${u.search}`, { headers: { host: NAME, "x-forwarded-for": SELF4, "x-forwarded-host": NAME, "x-forwarded-proto": "https" } }, loop);
      return { status: r.status, json: () => r.json() };
    }
    const r = await app.request(url.replace(`127.0.0.1:${port}`, `127.0.0.1:${config.port}`), { method: init?.method ?? "GET", headers: init?.headers, body: init?.body }, loop);
    return { status: r.status, json: () => r.json() };
  };
}

test("prism reach tailscale → status → off: serve, APP_ORIGIN (only), restart, the check through Tailscale, then the phone ticks the step", async () => {
  const port = config.port;
  const layout = installed(port);
  const ts = fakeTailscale(loggedIn());
  const app = createApp();
  const calls: string[] = [];
  const ctx = ctxFor(network(app, ts, port, calls), { PRISM_TAILSCALE_BIN: ts.bin });
  const restarted: string[] = [];
  const before = readFileSync(layout.envFile, "utf8");
  const origRestart = 0;

  // The fake restart = the server reading .env again (it picks up the new APP_ORIGIN).
  const r = await (async () => {
    const { reachDeps } = await import("../../../packaging/host/cli/commands");
    const state = { ...emptyState("x", true, "external"), current: "0.1.0" };
    const d: ReachDeps = {
      ...reachDeps(ctx, layout, state),
      restart: async () => {
        (config as { appOrigin: string }).appOrigin = /^APP_ORIGIN=(.*)$/m.exec(readFileSync(layout.envFile, "utf8"))![1]!;
        restarted.push("restart");
        return { ok: true, managed: true };
      },
      sleep: async () => {},
      attempts: 2,
    };
    const first = await cmdReach(ctx, reachArgs("tailscale", layout.prefix), d);
    const again = await cmdReach(ctx, reachArgs("tailscale", layout.prefix), d);
    return { first, again, d };
  })();
  assert.equal(r.first.code, EXIT.OK, JSON.stringify(r.first));
  assert.deepEqual(ts.changes(), [["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]]);
  assert.equal(readFileSync(layout.envFile, "utf8"), before.replace(`APP_ORIGIN=http://localhost:${port}`, `APP_ORIGIN=${ORIGIN}`), "only APP_ORIGIN changed");
  assert.equal(restarted.length - origRestart, 1);
  const v = r.first.verification as { ok: boolean; https: boolean; throughProxy: boolean; fromAnotherDevice: unknown; doesNotProve: string };
  assert.equal(v.ok, true);
  assert.equal(v.throughProxy, true);
  assert.equal(v.fromAnotherDevice, null);
  assert.match(v.doesNotProve, /another device/);
  assert.ok(calls.includes(`${ORIGIN}/health?live=1`));
  assert.match(String(r.first.next), /Open https:\/\/studio-mac.* on the phone/);
  // Idempotent: nothing more is run, no second restart.
  assert.equal(r.again.code, EXIT.OK);
  assert.equal(ts.changes().length, 1);
  assert.equal(restarted.length - origRestart, 1);

  // The checklist: our own check is not enough.
  let step = (await readSetupStatus()).steps.find((s) => s.id === "reachable")!;
  assert.equal(step.done, false);
  assert.match(step.detail!, /through Tailscale on this computer.*phone/);

  // The phone opens the address: another tailnet address, through tailscaled.
  await app.request(`http://${NAME}/`, { headers: { host: NAME, "x-forwarded-for": "100.88.7.6", "x-forwarded-host": NAME, "x-forwarded-proto": "https", "tailscale-user-login": "person@example.com" } }, loop);
  step = (await readSetupStatus()).steps.find((s) => s.id === "reachable")!;
  assert.equal(step.done, true, JSON.stringify(step));
  assert.equal(reachSeen().outsideVia, "tailnet");
  const st = await cmdReach(ctx, reachArgs("status", layout.prefix), r.d);
  assert.equal(st.next, null, JSON.stringify(st));
  assert.ok(st.fromAnotherDevice);
  assert.equal(st.reachable, true);

  // Off: Tailscale's config for the port goes, APP_ORIGIN goes back, the record is cleared.
  const off = await cmdReach(ctx, reachArgs("off", layout.prefix), r.d);
  assert.equal(off.code, EXIT.OK, JSON.stringify(off));
  assert.deepEqual(ts.serve(), {});
  assert.deepEqual(ts.changes().at(-1), ["serve", "--https=443", "off"]);
  assert.equal(readFileSync(layout.envFile, "utf8"), before);
  assert.equal(config.appOrigin, `http://localhost:${port}`);
  step = (await readSetupStatus()).steps.find((s) => s.id === "reachable")!;
  assert.equal(step.done, false);
  // Audited, with no address of a client.
  assert.ok(listActionAudit({ action: ["auth.local-reach"] }).length >= 2);
  assert.ok(!JSON.stringify(listActionAudit({ action: ["auth.local-reach"] })).includes("100.88.7.6"));
});

test("serve → funnel → serve switches by taking ours down first; funnel off that leaves the private handler is cleaned up", async () => {
  const port = config.port;
  const layout = installed(port);
  const ts = fakeTailscale(loggedIn({ Self: { ...loggedIn().Self, CapMap: { https: null, funnel: null } } }), { funnelOffKeepsServe: true });
  const app = createApp();
  const ctx = ctxFor(network(app, ts, port, []), { PRISM_TAILSCALE_BIN: ts.bin });
  const { reachDeps } = await import("../../../packaging/host/cli/commands");
  const d: ReachDeps = {
    ...reachDeps(ctx, layout, { ...emptyState("x", true, "external"), current: "0.1.0" }),
    restart: async () => {
      (config as { appOrigin: string }).appOrigin = /^APP_ORIGIN=(.*)$/m.exec(readFileSync(layout.envFile, "utf8"))![1]!;
      return { ok: true, managed: true };
    },
    sleep: async () => {},
    attempts: 1,
  };
  assert.equal((await cmdReach(ctx, reachArgs("tailscale", layout.prefix), d)).code, EXIT.OK);
  const f = await cmdReach(ctx, reachArgs("funnel", layout.prefix, ["--yes"]), d);
  assert.equal(f.code, EXIT.OK, JSON.stringify(f));
  assert.match(String((f.verification as { doesNotProve: string }).doesNotProve), /internet/);
  assert.match(String(f.next), /NOT on the tailnet/);
  assert.deepEqual(ts.serve().AllowFunnel, { [`${NAME}:443`]: true });
  // A request from the internet through Funnel ticks the step.
  await app.request(`http://${NAME}/`, { headers: { host: NAME, "x-forwarded-for": "203.0.113.9", "x-forwarded-host": NAME, "x-forwarded-proto": "https", "tailscale-funnel-request": "?1" } }, loop);
  assert.equal(reachSeen().outsideVia, "funnel");
  const off = await cmdReach(ctx, reachArgs("off", layout.prefix), d);
  assert.equal(off.code, EXIT.OK, JSON.stringify(off));
  assert.deepEqual(ts.changes().slice(-2), [["funnel", "--https=443", "off"], ["serve", "--https=443", "off"]]);
  assert.deepEqual(ts.serve(), {});
});

test("a check through Tailscale while the running server still has the old APP_ORIGIN fails and says restart", async () => {
  const port = config.port;
  const layout = installed(port);
  const ts = fakeTailscale(loggedIn());
  const app = createApp();
  const ctx = ctxFor(network(app, ts, port, []), { PRISM_TAILSCALE_BIN: ts.bin });
  const { reachDeps } = await import("../../../packaging/host/cli/commands");
  const d: ReachDeps = { ...reachDeps(ctx, layout, { ...emptyState("x", true, "external"), current: "0.1.0" }), restart: async () => ({ ok: true, managed: true }), sleep: async () => {}, attempts: 1 };
  const r = await cmdReach(ctx, reachArgs("tailscale", layout.prefix), d);
  assert.equal(r.code, EXIT.DEGRADED);
  assert.match(String((r.verification as { reason: string }).reason), /restart/);
});

// ── the server half ──────────────────────────────────────────────────────────

const BASE = `http://127.0.0.1:${config.port}`;
const post = (app: ReturnType<typeof createApp>, body: unknown, opts: { headers?: Record<string, string>; env?: object } = {}) =>
  app.request(`${BASE}/auth/local/reach`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...opts.headers }, body: JSON.stringify(body) }, opts.env ?? loop);

test("POST /auth/local/reach: loopback + host key only; the origin must be APP_ORIGIN; strict body", async () => {
  (config as { appOrigin: string }).appOrigin = ORIGIN;
  const app = createApp();
  const good = { origin: ORIGIN, mode: "serve", selfAddresses: [SELF4, SELF6] };
  assert.equal((await post(app, good, { env: { incoming: { socket: { remoteAddress: "100.88.7.6" } } } })).status, 404, "not loopback");
  assert.equal((await post(app, good, { env: {} })).status, 404, "no socket (in-process)");
  assert.equal((await post(app, good, { headers: { "x-forwarded-for": SELF4 } })).status, 404, "through a proxy (Tailscale serve)");
  assert.equal((await post(app, good, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await post(app, good, { headers: { origin: ORIGIN } })).status, 403, "a browser");
  assert.equal((await post(app, { ...good, origin: "https://elsewhere.tail1.ts.net" })).status, 409);
  assert.equal((await post(app, { ...good, origin: "http://localhost:8787" })).status, 400);
  assert.equal((await post(app, { ...good, selfAddresses: ["not-an-ip"] })).status, 400);
  assert.equal((await post(app, { ...good, extra: 1 })).status, 400);
  const ok = await post(app, good);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { appOrigin: string; expect: { origin: string }; seen: Record<string, unknown> };
  assert.equal(body.appOrigin, ORIGIN);
  assert.equal(body.expect.origin, ORIGIN);
  assert.deepEqual(body.seen, {});
  const read = (await (await post(app, {})).json()) as { expect: unknown };
  assert.ok(read.expect, "{} reads without changing");
  const cleared = (await (await post(app, { origin: null })).json()) as { expect: unknown };
  assert.equal(cleared.expect, null);
});

/** A minimal hono-like context for the classifier. */
const ctxOf = (headers: Record<string, string>, remote = "127.0.0.1") =>
  ({ req: { header: (n: string) => headers[n.toLowerCase()] }, env: { incoming: { socket: { remoteAddress: remote } } } }) as unknown as Parameters<typeof classifyReachRequest>[0];
const expect = { origin: ORIGIN, mode: "serve" as const, selfAddresses: [SELF4, SELF6], at: "x" };
const ts = (xff: string, extra: Record<string, string> = {}) => ({ "x-forwarded-for": xff, "x-forwarded-host": NAME, "x-forwarded-proto": "https", host: NAME, ...extra });

test("classifying a proxied request: this machine, another tailnet device, Funnel, Cloudflare — and what is ignored", () => {
  assert.deepEqual(classifyReachRequest(ctxOf(ts(SELF4)), ORIGIN, expect), { kind: "self" });
  assert.deepEqual(classifyReachRequest(ctxOf(ts("fd7a:115c:a1e0:0:0:0:1001:b7c5")), ORIGIN, expect), { kind: "self" }, "IPv6 compared by value");
  assert.deepEqual(classifyReachRequest(ctxOf(ts("100.88.7.6")), ORIGIN, expect), { kind: "outside", via: "tailnet" });
  assert.deepEqual(classifyReachRequest(ctxOf(ts("203.0.113.9", { "tailscale-funnel-request": "?1" })), ORIGIN, expect), { kind: "outside", via: "funnel" });
  assert.equal(classifyReachRequest(ctxOf(ts("100.88.7.6")), ORIGIN, null), null, "without the CLI's record a tailnet request could be this machine");
  assert.equal(classifyReachRequest(ctxOf(ts("100.88.7.6"), "10.0.0.5"), ORIGIN, expect), null, "a LAN socket can forge nothing");
  assert.equal(classifyReachRequest(ctxOf(ts("100.88.7.6", { "x-forwarded-host": "other.tail1.ts.net", host: "other.tail1.ts.net" })), ORIGIN, expect), null, "another name");
  assert.equal(classifyReachRequest(ctxOf(ts("100.88.7.6", { "x-forwarded-proto": "http" })), ORIGIN, expect), null);
  assert.equal(classifyReachRequest(ctxOf(ts("198.51.100.1")), ORIGIN, expect), null, "not a tailnet address, no Funnel header");
  assert.equal(classifyReachRequest(ctxOf(ts("100.88.7.6, 1.2.3.4")), ORIGIN, expect), null, "not Tailscale's single address");
  assert.equal(classifyReachRequest(ctxOf(ts(SELF4)), "http://localhost:8787", expect), null, "APP_ORIGIN not https");
  const cf = { "cf-connecting-ip": "203.0.113.9", host: "prism.acme.dev" };
  assert.deepEqual(classifyReachRequest(ctxOf(cf), "https://prism.acme.dev", null), { kind: "outside", via: "cloudflare" });
  assert.equal(isTailnetAddress("100.64.0.1") && isTailnetAddress("100.127.255.255") && !isTailnetAddress("100.128.0.1") && !isTailnetAddress("10.0.0.1"), true);
  assert.equal(sameAddress("::ffff:100.101.1.2", SELF4), true);
});

test("a new `prism reach` run earns the self-check again; what came from outside is kept", async () => {
  (config as { appOrigin: string }).appOrigin = ORIGIN;
  const app = createApp();
  setReachExpectation({ origin: ORIGIN, mode: "serve", selfAddresses: [SELF4] });
  await app.request(`http://${NAME}/`, { headers: ts(SELF4) }, loop);
  await app.request(`http://${NAME}/`, { headers: ts("100.88.7.6") }, loop);
  assert.ok(reachSeen().self && reachSeen().outside);
  setReachExpectation({ origin: ORIGIN, mode: "serve", selfAddresses: [SELF4] });
  assert.equal(reachSeen().self, undefined);
  assert.ok(reachSeen().outside);
});

test("the reachable step: placeholder / local → set one up; seen from outside for THIS origin → done", () => {
  const f = (over: Partial<SetupFacts>): SetupFacts => ({ vaultReachable: true, secretsAvailable: true, emailConfigured: false, appOrigin: "http://localhost:8787", agentTokens: 0, agentTokenUsed: false, devices: 0, integrations: {}, ...over });
  const step = (over: Partial<SetupFacts>) => setupStatus(f(over)).steps.find((s) => s.id === "reachable")!;
  assert.match(step({}).detail!, /prism reach tailscale/);
  assert.equal(step({ appOrigin: ORIGIN }).done, false, "an https address alone is not enough");
  assert.match(step({ appOrigin: ORIGIN }).detail!, /No device has opened/);
  assert.equal(step({ appOrigin: ORIGIN, reach: { self: true, outside: false } }).done, false);
  assert.equal(step({ appOrigin: ORIGIN, reach: { self: false, outside: true } }).done, true);
  assert.equal(step({ appOrigin: "https://prism.example.com", reach: { self: true, outside: true } }).done, false, "a placeholder never ticks");
});

test("seen for one origin does not tick another: changing APP_ORIGIN starts the step over", async () => {
  (config as { appOrigin: string }).appOrigin = "https://prism.acme.dev";
  const app = createApp();
  await app.request("http://prism.acme.dev/", { headers: { host: "prism.acme.dev", "cf-connecting-ip": "203.0.113.9" } }, loop);
  assert.equal((await readSetupStatus()).steps.find((s) => s.id === "reachable")!.done, true);
  (config as { appOrigin: string }).appOrigin = ORIGIN;
  assert.equal((await readSetupStatus()).steps.find((s) => s.id === "reachable")!.done, false);
});

test("on the tailnet origin the owner signs in with the password: a Secure session cookie, /auth/me works, and that request ticks the step", async () => {
  (config as { appOrigin: string }).appOrigin = ORIGIN;
  const { ensureUser, setUserPassword } = await import("../src/db");
  const { hashPassword } = await import("../src/auth/password");
  ensureUser(config.ownerEmail);
  setUserPassword(config.ownerEmail, hashPassword("a long enough password 1"));
  setReachExpectation({ origin: ORIGIN, mode: "serve", selfAddresses: [SELF4] });
  const app = createApp();
  const phone = { ...ts("100.88.7.6"), origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const r = await app.request(`http://${NAME}/auth/login`, { method: "POST", headers: phone, body: JSON.stringify({ email: config.ownerEmail, password: "a long enough password 1" }) }, loop);
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie") ?? "";
  assert.match(cookie, /prism_session=/);
  assert.match(cookie, /Secure/i);
  const me = await app.request(`http://${NAME}/auth/me`, { headers: { ...ts("100.88.7.6"), cookie: cookie.split(";")[0]! } }, loop);
  assert.equal(me.status, 200);
  assert.equal(reachSeen().outsideVia, "tailnet");
});
