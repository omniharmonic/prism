// Self-tests for the compatibility suite: argument rules, refusals, parsers,
// feature detection, report rendering, and a dry run end to end.
//   node --test scripts/parachute-compat/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHomeAllowed, assertPortAllowed, countResults, decodeJwt, detectFeatures, isLoopbackAddr, isSecretPath,
  modeProblem, parseArgs, parseJsonOut, parseLsof, parseMint, renderMarkdown, scrub, REFUSED_PORTS,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "EdDSA" })}.${b64({ jti: "j", iss: "http://127.0.0.1:20001", scope: "vault:compat:read" })}.c2lnbmF0dXJlc2ln`;

test("args: --home is required; ports validated; unknown flags refused", () => {
  assert.throws(() => parseArgs([]), /--home/);
  assert.throws(() => parseArgs(["--home", "/tmp/x", "--hub-port", "80"]), /1024/);
  assert.throws(() => parseArgs(["--home", "/tmp/x", "--wat"]), /unknown/);
  assert.throws(() => parseArgs(["--home"]), /needs a value/);
  const o = parseArgs(["--home", "/tmp/x", "--bin", "/b/p", "--vault-bin", "/b/v", "--hub-port", "20001", "--reuse", "--dry-run"]);
  assert.equal(o.bin, "/b/p");
  assert.equal(o.vaultBin, "/b/v");
  assert.equal(o.hubPort, 20001);
  assert.equal(o.reuse, true);
  assert.equal(o.dryRun, true);
});

test("ports 1939 / 1940 / 8787 are refused", () => {
  for (const p of REFUSED_PORTS) assert.throws(() => assertPortAllowed(p), /refused/);
  assert.doesNotThrow(() => assertPortAllowed(20001));
});

test("home: the live ~/.parachute, anything inside it, $HOME and a non-empty dir are refused", () => {
  const live = join(homedir(), ".parachute");
  assert.throws(() => assertHomeAllowed(live), /overlaps/);
  assert.throws(() => assertHomeAllowed(join(live, "sub")), /overlaps/);
  assert.throws(() => assertHomeAllowed(homedir()), /overlaps|home directory/);
  assert.throws(() => assertHomeAllowed("relative/dir"), /absolute/);
  const d = mkdtempSync(join(tmpdir(), "pc-home-"));
  try {
    assert.doesNotThrow(() => assertHomeAllowed(d));
    assert.doesNotThrow(() => assertHomeAllowed(join(d, "not-yet")));
    writeFileSync(join(d, "x"), "");
    assert.throws(() => assertHomeAllowed(d), /not empty/);
    assert.doesNotThrow(() => assertHomeAllowed(d, { reuse: true }));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  // A fake $HOME whose .parachute is the target is refused too.
  assert.throws(() => assertHomeAllowed("/fake/home/.parachute", { env: { HOME: "/fake/home" } }), /overlaps/);
});

test("parsers: JSON stdout, mint output (JSON or bare JWT), JWT payload", () => {
  assert.deepEqual(parseJsonOut('Warning: x\n{"name":"v","token":"t"}'), { name: "v", token: "t" });
  assert.equal(parseJsonOut("plain"), undefined);
  assert.deepEqual(parseMint(`${JWT}\n`), { token: JWT, json: false });
  assert.equal(parseMint(`{"token":"${JWT}","jti":"j","exp":1}`).json, true);
  assert.equal(parseMint("error"), undefined);
  assert.equal(decodeJwt(JWT).iss, "http://127.0.0.1:20001");
  assert.equal(decodeJwt("nope"), undefined);
});

test("feature detection reads help / version text", () => {
  const none = detectFeatures({ serve: "parachute serve\n  PORT …", auth: "mint-token --scope <scope> [--aud]", bootstrap: "Unknown command: bootstrap", vaultRoot: "create <name> [--json] [--no-mirror] [--mint]" }, undefined);
  assert.equal(none.serveEmbedded, false);
  assert.equal(none.bootstrapEmbedded, false);
  assert.equal(none.mintJson, false);
  assert.equal(none.vaultCreateJson, true);
  assert.equal(none.versionJson, false);
  const all = detectFeatures({ serve: "serve [--embedded] [--offline]", auth: "mint-token --scope s [--json]", bootstrap: "parachute bootstrap --embedded --password-file <f> --json", vaultRoot: "" }, { hub: "1" });
  assert.equal(all.serveEmbedded, true);
  assert.equal(all.bootstrapEmbedded, true);
  assert.equal(all.bootstrapPasswordFile, true);
  assert.equal(all.mintJson, true);
  assert.equal(all.versionJson, true);
  assert.equal(all.offlineFlag, true);
});

test("security helpers: modes, secret paths, loopback, lsof parsing, scrub", () => {
  assert.equal(modeProblem(0o100644, { isDir: false, secret: true }), "secret file is 0644 (want 0600)");
  assert.equal(modeProblem(0o100600, { isDir: false, secret: true }), undefined);
  assert.equal(modeProblem(0o40755, { isDir: true, secret: false }), "dir is 0755 (want 0700)");
  assert.equal(modeProblem(0o100644, { isDir: false, secret: false }), undefined);
  assert.equal(isSecretPath("hub.db"), true);
  assert.equal(isSecretPath("vault/data/compat/vault.db-wal"), true);
  assert.equal(isSecretPath("operator.token"), true);
  assert.equal(isSecretPath("well-known/parachute.json"), false);
  assert.equal(isLoopbackAddr("127.0.0.1:20001"), true);
  assert.equal(isLoopbackAddr("[::1]:20001"), true);
  assert.equal(isLoopbackAddr("*:20001"), false);
  assert.equal(isLoopbackAddr("192.168.1.2:443"), false);
  const rows = parseLsof("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nbun 123 me 10u IPv4 0x1 0t0 TCP 127.0.0.1:20001 (LISTEN)\nbun 123 me 11u IPv4 0x2 0t0 TCP 10.0.0.2:5000->104.16.1.1:443 (ESTABLISHED)\n");
  assert.deepEqual(rows.map((r) => [r.local, r.remote ?? null, r.state]), [["127.0.0.1:20001", null, "LISTEN"], ["10.0.0.2:5000", "104.16.1.1:443", "ESTABLISHED"]]);
  assert.equal(scrub(`token ${JWT} pw hunter2secret`, ["hunter2secret"]), "token [jwt] pw [secret]");
});

test("report renders with every section and counts", () => {
  const results = [{ area: "a", id: "x|y", status: "PASS", detail: "d" }, { area: "a", id: "z", status: "SKIP", detail: "" }];
  const md = renderMarkdown({
    startedAt: "t", bins: { hub: "h", vault: "v" }, versions: { hub: "1", vault: "2" }, home: "/h", ports: { hub: 1, vault: 2 },
    dryRun: false, mode: "stock", counts: countResults(results), embedded: { E1: { status: "SKIP", detail: "no" } }, results,
    fileModes: [{ path: "hub.db", mode: "0644", problem: "p" }],
  });
  assert.match(md, /1 pass · 0 fail · 1 skip · 0 info/);
  assert.match(md, /\| E1 \| SKIP \| no \|/);
  assert.match(md, /x\\\|y/);
  assert.match(md, /hub\.db \| 0644/);
});

test("run.mjs: a dry run spawns nothing and writes a report; refusals exit 2", () => {
  const d = mkdtempSync(join(tmpdir(), "pc-dry-"));
  try {
    const home = join(d, "home");
    const r = spawnSync(process.execPath, [join(here, "run.mjs"), "--home", home, "--bin", "/nonexistent/parachute", "--vault-bin", "/nonexistent/pv", "--dry-run"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr); // the missing CLIs are reported as FAIL
    assert.equal(existsSync(home), false, "dry run created the home");
    const report = JSON.parse(readFileSync(join(`${home}-report`, "report.json"), "utf8"));
    assert.equal(report.dryRun, true);
    assert.ok(report.results.some((x) => x.area === "plan"));
    assert.ok(Object.values(report.embedded).every((e) => e.status === "SKIP"));
    assert.ok(![1939, 1940, 8787].includes(report.ports.hub) && ![1939, 1940, 8787].includes(report.ports.vault));

    const bad = spawnSync(process.execPath, [join(here, "run.mjs"), "--home", home, "--hub-port", "1939", "--dry-run"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /refused/);
    mkdirSync(join(d, "full"));
    writeFileSync(join(d, "full", "f"), "");
    const full = spawnSync(process.execPath, [join(here, "run.mjs"), "--home", join(d, "full"), "--dry-run"], { encoding: "utf8" });
    assert.equal(full.status, 2);
    assert.match(full.stderr, /not empty/);
    const live = spawnSync(process.execPath, [join(here, "run.mjs"), "--home", join(homedir(), ".parachute"), "--dry-run"], { encoding: "utf8" });
    assert.equal(live.status, 2);
    assert.match(live.stderr, /overlaps/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
