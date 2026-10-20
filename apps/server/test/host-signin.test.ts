/**
 * `prism signin` (packaging/host/cli/commands.ts cmdSignin) against a fake server, and end to
 * end against the real app through a loopback fetch adapter. The link is never in the default
 * output; `--print` prints it and warns on stderr.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../../packaging/host/cli/args";
import { cmdSignin, type Ctx } from "../../../packaging/host/cli/commands";
import { EXIT } from "../../../packaging/host/cli/exit-codes";
import { layoutFor, privateDirs } from "../../../packaging/host/cli/paths";
import { emptyState, writeState } from "../../../packaging/host/cli/state";
import type { Fetch } from "../../../packaging/host/cli/health";
import { OPENABLE_URL } from "../scripts/lib/local-signin-client";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { initLocalSignin, setHostKeyForTests } from "../src/auth/local-signin";
import { resetLocalSigninLimitsForTests } from "../src/routes/local-signin";
import { installFakeVault } from "./helpers";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  setHostKeyForTests(null);
});

const KEY = "cli-host-key-0123456789abcdefghijklmnopqrstuvw";
const LINK = "http://localhost:9555/auth/local/signin?token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

/** An installed prefix whose server listens on `port` and keeps its key beside the db. */
function installed(port: number, key: string | null, keyMode = 0o600) {
  const root = mkdtempSync(join(tmpdir(), "prism-signin-test-"));
  roots.push(root);
  const layout = layoutFor(join(root, "Host"));
  for (const d of privateDirs(layout)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const s = emptyState("2026-10-19T00:00:00Z", false, "external");
  s.current = "0.1.0";
  writeState(layout, s);
  writeFileSync(layout.envFile, `PORT=${port}\nDB_PATH=${layout.db}\nOWNER_EMAIL=o@example.com\n`, { mode: 0o600 });
  if (key !== null) {
    writeFileSync(join(layout.data, "host-signin.key"), key + "\n", { mode: keyMode });
    chmodSync(join(layout.data, "host-signin.key"), keyMode);
  }
  return layout;
}

type Call = { url: string; init?: Parameters<Fetch>[1] };
function ctxWith(fetch: Fetch, opened: string[] | null, logs: string[] = []): Ctx {
  return {
    bundleRoot: "/nonexistent",
    home: tmpdir(),
    uid: 501,
    env: {},
    runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    fetch,
    probes: {} as Ctx["probes"],
    openSqlite: () => { throw new Error("unused"); },
    copyTree: () => {},
    now: () => new Date("2026-10-19T00:00:00Z"),
    log: (s) => logs.push(s),
    healthTimeoutMs: 1000,
    ...(opened ? { openUrl: async (u: string) => { opened.push(u); } } : {}),
  };
}

function fakeServer(answer: { status: number; body: unknown }, calls: Call[], live = true): Fetch {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/auth/local/link")) return { status: answer.status, json: async () => answer.body };
    return { status: live ? 200 : 503, json: async () => ({}) };
  };
}

const args = (extra: string[], prefix: string) => parseArgs(["signin", "--prefix", prefix, ...extra], { bool: ["print", "json", "dry-run"], value: ["prefix"] });
const ok = { status: 201, body: { url: LINK, expiresAt: "2026-10-19T00:10:00.000Z", expiresInSeconds: 600, email: "o@example.com", localOrigin: "http://localhost:9555", appOrigin: "http://localhost:9555", appOriginIsLocal: true } };

test("prism signin: loopback POST with the host key, the link goes to the browser and never into the result", async () => {
  const layout = installed(9555, KEY);
  const calls: Call[] = [];
  const opened: string[] = [];
  const r = await cmdSignin(ctxWith(fakeServer(ok, calls), opened), args([], layout.prefix));
  assert.equal(r.code, EXIT.OK);
  assert.deepEqual(opened, [LINK]);
  assert.ok(!JSON.stringify(r).includes("token="), "no link in the output");
  const post = calls.find((c) => c.url.endsWith("/auth/local/link"))!;
  assert.equal(post.url, "http://127.0.0.1:9555/auth/local/link");
  assert.equal(post.init?.method, "POST");
  assert.equal(post.init?.headers?.authorization, `Bearer ${KEY}`);
  assert.equal(post.init?.headers?.["content-type"], "application/json");
});

test("prism signin --print: the link on stdout (the result), a warning on stderr", async () => {
  const layout = installed(9555, KEY);
  const logs: string[] = [];
  const opened: string[] = [];
  const r = await cmdSignin(ctxWith(fakeServer(ok, []), opened, logs), args(["--print"], layout.prefix));
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.url, LINK);
  assert.deepEqual(opened, []);
  assert.match(logs.join("\n"), /do not paste it into a chat/);
});

test("prism signin: no browser here → refuses (and says --print) without asking for a link", async () => {
  const layout = installed(9555, KEY);
  const calls: Call[] = [];
  await assert.rejects(cmdSignin(ctxWith(fakeServer(ok, calls), null), args([], layout.prefix)), (e: { code?: number; message?: string }) => e.code === EXIT.PRECONDITION && /--print/.test(e.message ?? ""));
  assert.equal(calls.filter((c) => c.url.endsWith("/auth/local/link")).length, 0, "no link minted that nobody would use");
});

test("prism signin: server down / no key / a key others can read / refused / limited → the right exit code", async () => {
  const down: Fetch = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(cmdSignin(ctxWith(down, []), args([], installed(9555, null).prefix)), (e: { code?: number }) => e.code === EXIT.NOT_RUNNING);
  await assert.rejects(cmdSignin(ctxWith(down, []), args([], installed(9555, KEY).prefix)), (e: { code?: number }) => e.code === EXIT.NOT_RUNNING);
  await assert.rejects(cmdSignin(ctxWith(fakeServer(ok, []), []), args([], installed(9555, KEY, 0o644).prefix)), (e: { code?: number; message?: string }) => e.code === EXIT.PRECONDITION && /readable by others/.test(e.message ?? ""));
  await assert.rejects(cmdSignin(ctxWith(fakeServer({ status: 401, body: { error: "host_proof_required" } }, []), []), args([], installed(9555, KEY).prefix)), (e: { code?: number }) => e.code === EXIT.PRECONDITION);
  await assert.rejects(cmdSignin(ctxWith(fakeServer({ status: 429, body: { error: "rate_limited", retryAfter: 42 } }, []), []), args(["--print"], installed(9555, KEY).prefix)), (e: { code?: number; message?: string }) => e.code === EXIT.PRECONDITION && /42/.test(e.message ?? ""));
  await assert.rejects(cmdSignin(ctxWith(fakeServer({ status: 503, body: { error: "local_signin_unavailable" } }, []), []), args([], installed(9555, KEY).prefix)), (e: { code?: number }) => e.code === EXIT.PRECONDITION);
});

test("only a sign-in link of this server's shape is ever opened", () => {
  assert.ok(OPENABLE_URL.test(LINK));
  for (const bad of ["https://evil.example/auth/local/signin?token=abcdefghijklmnopqrstuvwxyz", "http://localhost:8787/\" & do shell script \"x", "http://localhost:8787/auth/local/signin?token=a\"b", "javascript:alert(1)", "http://localhost:8787/auth/local/signin?token=short"]) {
    assert.equal(OPENABLE_URL.test(bad), false, bad);
  }
});

test("end to end: the CLI and the real server — the key file the server wrote, a link that signs the owner in once", async () => {
  const fv = installFakeVault();
  try {
    const layout = installed(config.port, null);
    const app = createApp();
    assert.deepEqual(initLocalSignin(join(layout.data, "host-signin.key")), { enabled: true });
    resetLocalSigninLimitsForTests();
    const loop = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    const viaLoopback: Fetch = async (url, init) => {
      const res = await app.request(url, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body }, loop);
      return { status: res.status, json: () => res.json() };
    };
    const opened: string[] = [];
    const r = await cmdSignin(ctxWith(viaLoopback, opened), args([], layout.prefix));
    assert.equal(r.code, EXIT.OK, JSON.stringify(r));
    assert.equal(opened.length, 1);
    assert.ok(OPENABLE_URL.test(opened[0]!), opened[0]);
    const signedIn = await app.request(opened[0]!.replace("http://localhost", "http://127.0.0.1"), {}, loop);
    // The link is made for localhost; spent on that same host it works (here: through 127.0.0.1, also loopback).
    assert.equal(signedIn.status, 302);
    assert.match(signedIn.headers.get("set-cookie") ?? "", /prism_session=/);
    const twice = await app.request(opened[0]!.replace("http://localhost", "http://127.0.0.1"), {}, loop);
    assert.equal(twice.headers.get("location"), "/?login=local-expired");
  } finally {
    fv.restore();
  }
});
