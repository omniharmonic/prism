/**
 * The App Review demo server kit (scripts/demo-server/): the seed and the wipe, run against the
 * REAL app over the fake vault — the same HTTP calls the kit makes on the demo host — plus the
 * guards that keep it away from production, and the personal-data rules for its content.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, getUser, listMemberships } from "../src/db";
import { setHostKeyForTests } from "../src/auth/local-signin";
import { resetLocalSigninLimitsForTests } from "../src/routes/local-signin";
import { verifyPassword } from "../src/auth/password";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

const ROOT = resolve(import.meta.dirname, "../../..");
const KIT = join(ROOT, "scripts/demo-server");
// Loaded by path (plain .mjs, outside the server's TypeScript project).
const lib: any = await import(join(KIT, "seed-lib.mjs"));
const content: any = await import(join(KIT, "content.mjs"));

const KEY = "demo-host-key-0123456789abcdefghijklmnopqrstuv";
const BASE = `http://127.0.0.1:${config.port}`;
const REVIEWER = { email: "app-review@example.com", name: "App Review" };

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let calls: Array<{ method: string; path: string }> = [];
/** fetch → the app in-process, as a loopback connection (what the kit's calls are on the demo host). */
const fetchApp = (async (url: string, init: RequestInit = {}) => {
  const u = new URL(url);
  calls.push({ method: (init.method ?? "GET").toUpperCase(), path: u.pathname });
  return app.request(url, init, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
}) as unknown as typeof fetch;

beforeEach(() => {
  resetDb();
  db.exec("DELETE FROM local_signin_links");
  fv = installFakeVault();
  app = createApp();
  setHostKeyForTests(KEY);
  resetLocalSigninLimitsForTests();
  calls = [];
});
afterEach(() => fv.restore());
after(() => setHostKeyForTests(null));

test("seed: sample pages + a reviewer MEMBER (not owner/admin) with edit on the vault, password set, signs in", async () => {
  const r = await lib.seedDemo({ fetch: fetchApp, base: BASE, hostKey: KEY, reviewer: REVIEWER });
  assert.equal(r.reviewerCreated, true);
  assert.equal(typeof r.password, "string");
  assert.ok(r.password.length >= 20);
  const notes = [...fv.notes.values()];
  assert.equal(notes.length, content.sampleNotes().length);
  assert.ok(notes.every((n) => n.tags?.includes(content.SAMPLE_TAG)));
  assert.ok(notes.some((n) => n.metadata?.prism_type === "database"));
  assert.equal(listMemberships("primary").find((m) => m.email === REVIEWER.email)?.role, "member");
  assert.ok(verifyPassword(r.password, getUser(REVIEWER.email)?.password_hash));

  // The reviewer signs in with email + password and sees the sample workspace (not the owner passthrough).
  const login = await fetchApp(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: REVIEWER.email, password: r.password }) });
  assert.equal(login.status, 200);
  const cookie = /prism_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")?.[0];
  assert.ok(cookie);
  const me = (await (await fetchApp(`${BASE}/auth/me`, { headers: { cookie: cookie! } })).json()) as { isOwner?: boolean };
  assert.equal(me.isOwner, false);
  const list = (await (await fetchApp(`${BASE}/api/notes`, { headers: { cookie: cookie! } })).json()) as Array<{ path: string; _caps?: string[] }>;
  assert.ok(list.some((n) => n.path === "Welcome"), "the reviewer sees the welcome page");
  assert.ok(list.every((n) => n._caps?.includes("edit")), "and may edit it");
  // Never the owner's token path: every call was loopback HTTP with a session.
  assert.ok(calls.some((c) => c.path === "/auth/local/link") && calls.some((c) => c.path === "/auth/local/signin"));
});

test("seed again: idempotent pages, the existing reviewer keeps their password", async () => {
  const first = await lib.seedDemo({ fetch: fetchApp, base: BASE, hostKey: KEY, reviewer: REVIEWER });
  const hash = getUser(REVIEWER.email)?.password_hash;
  const second = await lib.seedDemo({ fetch: fetchApp, base: BASE, hostKey: KEY, reviewer: REVIEWER });
  assert.equal(second.reviewerCreated, false);
  assert.equal(second.password, undefined);
  assert.equal(getUser(REVIEWER.email)?.password_hash, hash);
  assert.equal(fv.notes.size, content.sampleNotes().length, "no duplicates");
  assert.ok(first.password);
});

test("wipe: every note goes (the reviewer's own pages too), then the sample comes back", async () => {
  await lib.seedDemo({ fetch: fetchApp, base: BASE, hostKey: KEY, reviewer: REVIEWER });
  fv.put({ id: "mine", path: "Untitled", content: "<p>made by the reviewer</p>", tags: [] });
  const r = await lib.seedDemo({ fetch: fetchApp, base: BASE, hostKey: KEY, reviewer: REVIEWER, wipe: true });
  assert.equal(r.wiped, content.sampleNotes().length + 1);
  assert.ok(![...fv.notes.values()].some((n) => n.path === "Untitled"));
  assert.equal(fv.notes.size, content.sampleNotes().length);
});

test("dry run against the server: health only — no sign-in link, no write", async () => {
  const lines: string[] = [];
  const r = await lib.seedDemo({ fetch: fetchApp, base: BASE, hostKey: "", reviewer: REVIEWER, dryRun: true, wipe: true, log: (s: string) => lines.push(s) });
  assert.equal(r.dryRun, true);
  assert.deepEqual([...new Set(calls.map((c) => `${c.method} ${c.path}`))].sort(), ["GET /health"]);
  assert.equal(fv.notes.size, 0);
  assert.ok(lines.some((l) => /delete EVERY note/.test(l)) && lines.some((l) => /write Welcome/.test(l)));
});

test("a wrong host key gets nothing", async () => {
  await assert.rejects(lib.seedDemo({ fetch: fetchApp, base: BASE, hostKey: "wrong-key-0123456789abcdefghijklmnop", reviewer: REVIEWER }), /refused a sign-in link \(HTTP 401/);
  assert.equal(fv.notes.size, 0);
});

test("guards: production ports, non-loopback targets and a demo .env pointing at production are refused", () => {
  for (const p of [1939, 1940, 8787]) assert.match(lib.baseProblem(`http://127.0.0.1:${p}`), /PRODUCTION/);
  assert.match(lib.baseProblem("https://demo.example.com"), /loopback/);
  assert.match(lib.baseProblem("http://10.0.0.5:18787"), /loopback/);
  assert.equal(lib.baseProblem("http://127.0.0.1:18787"), null);
  const ok = { PORT: "18787", PARACHUTE_URL: "http://127.0.0.1:18940", PARACHUTE_HUB_ORIGIN: "http://127.0.0.1:18939", PARACHUTE_HOME: "/x/parachute" };
  assert.equal(lib.demoEnvProblem(ok), null);
  assert.match(lib.demoEnvProblem({ ...ok, PORT: "8787" }), /production port/);
  assert.match(lib.demoEnvProblem({ ...ok, PARACHUTE_URL: "http://127.0.0.1:1940" }), /PRODUCTION/);
  assert.match(lib.demoEnvProblem({ ...ok, PARACHUTE_HUB_ORIGIN: undefined }), /not set/);
  assert.match(lib.demoEnvProblem({ ...ok, PARACHUTE_HOME: "" }), /PARACHUTE_HOME/);
});

// The scanner is private tooling (left out of the public snapshot), so the public repo skips this.
test("the kit holds no personal data: the public-snapshot patterns find nothing in it (content included)", { skip: !existsSync(join(ROOT, "scripts/public-snapshot/scan.mjs")) && "public-snapshot scanner not in this checkout" }, () => {
  const scan = readFileSync(join(ROOT, "scripts/public-snapshot/scan.mjs"), "utf8");
  const list = (name: string) => {
    const body = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(scan)?.[1] ?? "";
    return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\\\/g, "\\"));
  };
  const patterns = [...list("PERSONAL"), ...list("IDENTITY")];
  assert.ok(patterns.length >= 8, "read the scan's patterns");
  const re = new RegExp(patterns.join("|"));
  const files = readdirSync(KIT).filter((f) => !f.startsWith("."));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const text = readFileSync(join(KIT, f), "utf8");
    const hit = text.split("\n").findIndex((l) => re.test(l));
    assert.equal(hit, -1, `${f}:${hit + 1} matches a personal-data pattern`);
  }
  const rendered = JSON.stringify(content.sampleNotes());
  assert.doesNotMatch(rendered, re);
  // Sample addresses and links stay on reserved example domains.
  for (const m of rendered.matchAll(/https?:\/\/([^/"<\s]+)/g)) assert.match(m[1]!, /(^|\.)example\.(com|org|net)$/);
});

test("the kit's shell scripts pass shellcheck", { skip: !hasShellcheck() && "shellcheck not installed" }, () => {
  const scripts = readdirSync(KIT).filter((f) => f.endsWith(".sh")).map((f) => join(KIT, f));
  assert.ok(scripts.length >= 2);
  const r = spawnSync("shellcheck", ["-x", ...scripts], { encoding: "utf8", cwd: KIT });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

function hasShellcheck(): boolean {
  return spawnSync("shellcheck", ["--version"]).status === 0;
}

test("wipe only: every note goes, nothing is written, no account is made", async () => {
  await lib.seedDemo({ fetch: fetchApp, base: BASE, hostKey: KEY, reviewer: REVIEWER });
  const r = await lib.seedDemo({ fetch: fetchApp, base: BASE, hostKey: KEY, reviewer: { email: "other@example.com", name: "x" }, wipeOnly: true });
  assert.equal(r.wiped, content.sampleNotes().length);
  assert.equal(fv.notes.size, 0);
  assert.ok(!getUser("other@example.com"));
});

/** install.sh / reset.sh dry runs with a throwaway settings file and stand-in binaries. */
function kitDryRun(script: string, overrides: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "demo-kit-"));
  for (const bin of ["bundle/bin/prism", "bundle/runtime/node/bin/node", "bun/parachute", "bun/parachute-vault"]) {
    mkdirSync(join(home, dirname(bin)), { recursive: true });
    writeFileSync(join(home, bin), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const settings: Record<string, string> = {
    DEMO_USER: userInfo().username, DEMO_PREFIX: `${home}/PrismDemo/Host`, DEMO_PARACHUTE_HOME: `${home}/PrismDemo/parachute`,
    DEMO_SERVER_PORT: "28787", DEMO_HUB_PORT: "28939", DEMO_VAULT_PORT: "28940", DEMO_VAULT_NAME: "demo",
    DEMO_HOST: "demo.example.com", DEMO_OWNER_EMAIL: "demo-owner@example.com", DEMO_REVIEWER_EMAIL: "app-review@example.com", DEMO_REVIEWER_NAME: "App Review",
    DEMO_BUNDLE: `${home}/bundle`, PARACHUTE_BIN: `${home}/bun/parachute`, PARACHUTE_VAULT_BIN: `${home}/bun/parachute-vault`, DEMO_PARACHUTE_LABEL: "test.prism-demo.parachute",
    ...overrides,
  };
  writeFileSync(join(home, "demo.env"), Object.entries(settings).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n");
  if (script === "reset.sh") {
    mkdirSync(`${home}/PrismDemo/Host`, { recursive: true });
    writeFileSync(`${home}/PrismDemo/Host/.prism-host`, "");
  }
  const r = spawnSync("bash", [join(KIT, script), "--dry-run"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, DEMO_ENV: join(home, "demo.env"), DEMO_ALLOW_ADMIN: "1" },
  });
  return { status: r.status, out: r.stdout + r.stderr, home };
}

const macOnly = { skip: process.platform !== "darwin" && "macOS only" };

test("install.sh --dry-run: the whole plan on its own ports and prefix, nothing created", macOnly, () => {
  const r = kitDryRun("install.sh");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /write \S+\/hub\/run\/hub\.port = 28939/);
  assert.match(r.out, /parachute-vault create demo --no-mirror --json/);
  assert.match(r.out, /auth set-password/);
  assert.match(r.out, /launchctl bootstrap gui\/\d+ \S+test\.prism-demo\.parachute\.plist/);
  assert.match(r.out, /prism install --prefix \S+PrismDemo\/Host --owner-email demo-owner@example\.com --port 28787 --app-origin https:\/\/demo\.example\.com --parachute external --parachute-url http:\/\/127\.0\.0\.1:28940 /);
  assert.match(r.out, /token mint --prefix/);
  assert.doesNotMatch(r.out, /:(1939|1940|8787)\b/);
  assert.ok(!existsSync(join(r.home, "PrismDemo")), "a dry run creates nothing");
});

test("install.sh refuses: another user, production ports, a prefix outside the home, ~/.parachute, a port twice", macOnly, () => {
  assert.match(kitDryRun("install.sh", { DEMO_USER: "someone-else" }).out, /run this as the demo macOS user/);
  for (const [k, v] of [["DEMO_SERVER_PORT", "8787"], ["DEMO_HUB_PORT", "1939"], ["DEMO_VAULT_PORT", "1940"]] as const) {
    const r = kitDryRun("install.sh", { [k]: v });
    assert.equal(r.status, 4);
    assert.match(r.out, /PRODUCTION port/);
  }
  assert.match(kitDryRun("install.sh", { DEMO_PREFIX: "/tmp/elsewhere" }).out, /must be inside/);
  assert.match(kitDryRun("install.sh", { DEMO_PARACHUTE_HOME: `${homedir()}/.parachute` }).out, /must be inside|its own folder/);
  assert.match(kitDryRun("install.sh", { DEMO_HUB_PORT: "28940" }).out, /used twice/);
});

test("reset.sh --dry-run: wipe, stop, move the database aside, start, seed — in that order", macOnly, () => {
  const r = kitDryRun("reset.sh");
  assert.equal(r.status, 0, r.out);
  const order = ["--wipe-only", "stop --prefix", "mv \\S+prism-server\\.db ", "start --prefix", "seed\\.mjs --prefix \\S+\\n"].map((p) => r.out.search(new RegExp(p)));
  assert.ok(order.every((i) => i >= 0), r.out);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});
