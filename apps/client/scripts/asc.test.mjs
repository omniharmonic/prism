// node --test apps/client/scripts/asc.test.mjs  (npm run test:release -w apps/client)
// The release script's safety checks and App Store Connect calls, without the network,
// without Xcode doing anything, and without a real key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REPO_ROOT, ascJwt, assignToGroup, buildNumberProblem, compareBuild, findApp, groupProblem, keyFileProblem,
  maxBuild, parseBuild, productionHostReason, readUploadState, recordUpload, remoteMaxBuild,
} from "./asc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), "asc-test-"));
const ecKey = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });

test("production host: a marker file always refuses; a Mac mini refuses unless allowed; listed host names refuse", () => {
  assert.match(productionHostReason({ markers: [null, "/etc/prism-production-host"], modelName: "MacBook Pro", env: { PRISM_RELEASE_ALLOW_MAC_MINI: "1" } }), /production host/);
  assert.match(productionHostReason({ modelName: "Mac mini", env: {} }), /Mac mini/);
  assert.equal(productionHostReason({ modelName: "Mac mini", env: { PRISM_RELEASE_ALLOW_MAC_MINI: "1" } }), null);
  assert.match(productionHostReason({ modelName: "MacBook Pro", hostnames: ["Studio-1"], env: { PRISM_NO_RELEASE_HOSTS: "x, studio-1" } }), /studio-1/);
  assert.equal(productionHostReason({ modelName: "MacBook Pro", hostnames: ["laptop"], markers: [null, null], env: {} }), null);
});

test("key file: absolute .p8, a regular file, 0600/0400, never a symlink, never inside the repository", () => {
  const d = scratch();
  const p = join(d, "AuthKey_ABCDEFGH12.p8");
  writeFileSync(p, "x");
  chmodSync(p, 0o644);
  assert.match(keyFileProblem(p, { st: lstatSync(p) }), /readable by others.*0644/);
  chmodSync(p, 0o600);
  assert.equal(keyFileProblem(p, { st: lstatSync(p) }), null);
  chmodSync(p, 0o400);
  assert.equal(keyFileProblem(p, { st: lstatSync(p) }), null);
  assert.match(keyFileProblem(undefined), /not set/);
  assert.match(keyFileProblem("AuthKey.p8"), /absolute/);
  assert.match(keyFileProblem(join(d, "key.pem"), { st: lstatSync(p) }), /\.p8/);
  assert.match(keyFileProblem(join(d, "missing.p8"), { st: undefined }), /no API key/);
  assert.match(keyFileProblem(join(REPO_ROOT, "apps/AuthKey_X.p8"), { st: lstatSync(p) }), /inside the repository/);
  assert.match(keyFileProblem(p, { st: lstatSync(p), real: join(REPO_ROOT, "k.p8") }), /inside the repository/);
});

test("build numbers: compared numerically per part, and must be higher than both the local record and App Store Connect", () => {
  assert.deepEqual(parseBuild("8"), [8]);
  assert.equal(parseBuild("1.2.3.4"), null);
  assert.equal(parseBuild("8a"), null);
  assert.equal(compareBuild("10", "9"), 1);
  assert.equal(compareBuild("1.2", "1.2.0"), 0);
  assert.equal(maxBuild(["7", "10", "9", "junk", null]), "10");
  assert.equal(buildNumberProblem({ candidate: "9", recorded: "8", remote: "8" }), null);
  assert.equal(buildNumberProblem({ candidate: "9" }), null);
  assert.match(buildNumberProblem({ candidate: "8", recorded: "8" }), /not higher than the last upload recorded/);
  assert.match(buildNumberProblem({ candidate: "9", recorded: "3", remote: "12" }), /App Store Connect has \(12\)/);
  assert.match(buildNumberProblem({ candidate: "x" }), /not a build number/);
});

test("upload record: 0600 in a 0700 folder, never lowered, per bundle id", () => {
  const f = join(scratch(), "rel", "ios-uploads.json");
  recordUpload(f, { bundleId: "app.one", build: "8", version: "0.9.0", at: "t" });
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(f)).mode & 0o777, 0o700);
  recordUpload(f, { bundleId: "app.one", build: "7", version: "0.9.0" });
  assert.equal(readUploadState(f)["app.one"].lastUploadedBuild, "8");
  recordUpload(f, { bundleId: "app.one", build: "9", version: "0.9.1" });
  assert.equal(readUploadState(f)["app.one"].lastUploadedBuild, "9");
  assert.deepEqual(readUploadState(join(scratch(), "none.json")), {});
});

test("JWT: ES256 over header.claims, Apple's audience, ≤ 20 minutes, verifies with the public key", () => {
  const { privateKey, publicKey } = ecKey();
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = ascJwt({ keyId: "ABCDEFGH12", issuerId: "11111111-2222-3333-4444-555555555555", privateKeyPem: pem, nowSec: 1000, ttlSec: 99999 });
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "ABCDEFGH12", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(c, "base64url")), { iss: "11111111-2222-3333-4444-555555555555", iat: 1000, exp: 2200, aud: "appstoreconnect-v1" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  assert.throws(() => ascJwt({ keyId: "bad", issuerId: "x", privateKeyPem: pem }), /key id/);
});

/** A fake App Store Connect: routes by method + path prefix, records calls. */
function fakeAsc(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: u.pathname, search: u.search, body: init.body, auth: init.headers?.authorization, redirect: init.redirect });
    for (const [key, answer] of routes) {
      const [m, p] = key.split(" ");
      if ((init.method ?? "GET") === m && u.pathname === p) {
        const a = typeof answer === "function" ? answer(u, calls) : answer;
        const status = a.status ?? 200;
        return new Response(status === 204 ? null : JSON.stringify(a.body ?? {}), { status });
      }
    }
    return new Response(JSON.stringify({ errors: [{ detail: "no route" }] }), { status: 404 });
  };
  return { fn, calls };
}

test("API: app by bundle id, highest build, Bearer token, no redirects followed", async () => {
  const { fn, calls } = fakeAsc([
    ["GET /v1/apps", { body: { data: [{ id: "app1", attributes: { bundleId: "app.one" } }] } }],
    ["GET /v1/builds", { body: { data: [{ attributes: { version: "7" } }, { attributes: { version: "12" } }, { attributes: { version: "9" } }] } }],
  ]);
  assert.equal(await findApp(fn, "tok", "app.one"), "app1");
  assert.equal(await remoteMaxBuild(fn, "tok", "app1"), "12");
  assert.ok(calls.every((c) => c.auth === "Bearer tok" && c.redirect === "error"));
  await assert.rejects(findApp(fakeAsc([["GET /v1/apps", { body: { data: [] } }]]).fn, "tok", "app.one"), /no app with bundle id/);
  await assert.rejects(findApp(fakeAsc([["GET /v1/apps", { status: 401, body: { errors: [{ detail: "Authentication credentials are missing or invalid." }] } }]]).fn, "t", "a"), /credentials/);
});

test("groups: internal by default; an external group needs --external; --external refuses an internal group", () => {
  const internal = { attributes: { name: "Owners", isInternalGroup: true } };
  const external = { attributes: { name: "Beta", isInternalGroup: false } };
  assert.equal(groupProblem(internal, { external: false }), null);
  assert.match(groupProblem(external, { external: false }), /EXTERNAL group.*--external/);
  assert.equal(groupProblem(external, { external: true }), null);
  assert.match(groupProblem(internal, { external: true }), /internal group/);
  assert.match(groupProblem(undefined, { external: false }), /no such/);
});

test("assign: waits for VALID, then adds the build to the group; refuses an external group by default; stops on FAILED", async () => {
  let polls = 0;
  const { fn, calls } = fakeAsc([
    ["GET /v1/betaGroups", { body: { data: [{ id: "g1", attributes: { name: "Owners", isInternalGroup: true, hasAccessToAllBuilds: false } }] } }],
    ["GET /v1/builds", () => ({ body: { data: [{ id: "b8", attributes: { version: "8", processingState: ++polls < 3 ? "PROCESSING" : "VALID" } }] } })],
    ["POST /v1/betaGroups/g1/relationships/builds", { status: 204 }],
  ]);
  const r = await assignToGroup(fn, "tok", { appId: "app1", build: "8", version: "0.9.0", groupName: "Owners", external: false, sleep: async () => {}, pollMs: 1 });
  assert.deepEqual(r, { group: "Owners", added: true });
  assert.equal(polls, 3);
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post.body), { data: [{ type: "builds", id: "b8" }] });

  const ext = fakeAsc([["GET /v1/betaGroups", { body: { data: [{ id: "g2", attributes: { name: "Beta", isInternalGroup: false } }] } }]]);
  await assert.rejects(assignToGroup(ext.fn, "tok", { appId: "a", build: "8", version: "0.9.0", groupName: "Beta", external: false }), /EXTERNAL/);
  assert.ok(!ext.calls.some((c) => c.method === "POST"));

  const failed = fakeAsc([
    ["GET /v1/betaGroups", { body: { data: [{ id: "g1", attributes: { name: "Owners", isInternalGroup: true } }] } }],
    ["GET /v1/builds", { body: { data: [{ id: "b8", attributes: { version: "8", processingState: "INVALID" } }] } }],
  ]);
  await assert.rejects(assignToGroup(failed.fn, "tok", { appId: "a", build: "8", version: "0.9.0", groupName: "Owners", external: false, sleep: async () => {} }), /INVALID/);
  assert.ok(!failed.calls.some((c) => c.method === "POST"));
});

// ── the shell script itself ─────────────────────────────────────────────────

const release = join(here, "ios-release.sh");
const onMacMini = (() => {
  try {
    return /Model Name:\s*Mac mini/i.test(execFileSync("system_profiler", ["SPHardwareDataType"], { encoding: "utf8" }));
  } catch {
    return false;
  }
})();
const hasXcrun = process.platform === "darwin" && spawnSync("xcrun", ["--find", "altool"]).status === 0;

function dryRun(args, extraEnv = {}) {
  const d = scratch();
  const key = join(d, "AuthKey_ABCDEFGH12.p8");
  writeFileSync(key, ecKey().privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const env = {
    PATH: process.env.PATH, HOME: d, TMPDIR: tmpdir(),
    ASC_API_KEY_ID: "ABCDEFGH12", ASC_API_ISSUER_ID: "11111111-2222-3333-4444-555555555555", ASC_API_KEY_PATH: key,
    PRISM_IOS_UPLOAD_STATE: join(d, "uploads.json"), ...extraEnv,
  };
  const r = spawnSync("bash", [release, ...args, "--dry-run"], { cwd: REPO_ROOT, env, encoding: "utf8" });
  return { ...r, out: r.stdout + r.stderr, key, dir: d };
}

const entitlements = () => ["apps/client/src-tauri/gen/apple/prism-client_iOS/prism-client_iOS.entitlements"].map((f) => (existsSync(join(REPO_ROOT, f)) ? readFileSync(join(REPO_ROOT, f), "utf8") : ""));

test("shellcheck passes", { skip: spawnSync("shellcheck", ["--version"]).status !== 0 && "shellcheck not installed" }, () => {
  const r = spawnSync("shellcheck", [release], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("dry run --upload: prints validate + upload-package + record + assign (internal), patches nothing", { skip: (onMacMini || !hasXcrun) && "needs Xcode, and refuses on a Mac mini by design" }, () => {
  const before = entitlements();
  const r = dryRun(["--upload"], { PRISM_ASSOCIATED_DOMAINS: "demo.example.com" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, /✓ not the production host/);
  assert.match(r.out, /✓ version \S+ everywhere/);
  assert.match(r.out, /\+ node \S+universal-links\.mjs --ios --hosts demo\.example\.com/);
  assert.match(r.out, /\+ \(cd \S+ && npx tauri ios build --export-method app-store-connect --ci\)/);
  assert.match(r.out, /\+ xcrun altool --validate-app \S+Prism\.ipa --api-key ABCDEFGH12 /);
  assert.match(r.out, /\+ xcrun altool --upload-package \S+Prism\.ipa --api-key ABCDEFGH12 --api-issuer 11111111-2222-3333-4444-555555555555 --p8-file-path /);
  assert.match(r.out, /\+ node \S+asc\.mjs assign --build \d+ --version \S+ --group Owners\n/);
  assert.match(r.out, /\+ node \S+universal-links\.mjs --ios --none/, "the restore is part of the plan");
  assert.doesNotMatch(r.out, /--external/);
  assert.deepEqual(entitlements(), before, "a dry run never patches the entitlements");
  assert.ok(!existsSync(join(r.dir, "uploads.json")), "a dry run records nothing");
});

test("dry run refusals are reported (key readable by others, build number not higher, external without a group)", { skip: (onMacMini || !hasXcrun) && "needs Xcode, and refuses on a Mac mini by design" }, () => {
  const bundleId = JSON.parse(readFileSync(join(REPO_ROOT, "apps/client/src-tauri/tauri.conf.json"), "utf8")).identifier;
  const build = JSON.parse(readFileSync(join(REPO_ROOT, "apps/client/src-tauri/tauri.ios.conf.json"), "utf8")).bundle.iOS.bundleVersion;
  const d = scratch();
  const state = join(d, "uploads.json");
  writeFileSync(state, JSON.stringify({ [bundleId]: { lastUploadedBuild: String(build), version: "x" } }));
  const r = dryRun(["--upload-only", "--external"], { PRISM_IOS_UPLOAD_STATE: state });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not higher than the last upload recorded/);
  assert.match(r.out, /OWNER RULE/);
  assert.match(r.out, /external only after the recorded device pass|ONLY after the RECORDED device pass/i);
  assert.match(r.out, /PRISM_TESTFLIGHT_EXTERNAL_GROUP/);
  assert.doesNotMatch(r.out, /npx tauri ios build/, "--upload-only builds nothing");
  chmodSync(r.key, 0o644);
  const env = { PATH: process.env.PATH, HOME: d, ASC_API_KEY_ID: "ABCDEFGH12", ASC_API_ISSUER_ID: "11111111-2222-3333-4444-555555555555", ASC_API_KEY_PATH: r.key, PRISM_IOS_UPLOAD_STATE: join(d, "none.json") };
  const r2 = spawnSync("bash", [release, "--upload", "--dry-run"], { cwd: REPO_ROOT, env, encoding: "utf8" });
  assert.equal(r2.status, 1);
  assert.match(r2.stdout + r2.stderr, /readable by others/);
});

test("argument errors: ad hoc is never uploaded, --external needs an upload", () => {
  assert.equal(spawnSync("bash", [release, "-adhoc", "--upload"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("bash", [release, "--external"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("bash", [release, "--bogus"], { encoding: "utf8" }).status, 2);
});
