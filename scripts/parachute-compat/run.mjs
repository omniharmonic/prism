#!/usr/bin/env node
// Parachute compatibility suite (launch plan §3.4/§3.5; request §5).
//
// Runs a given Parachute install — hub + vault CLIs — inside a THROWAWAY
// PARACHUTE_HOME on ports it chooses, and checks the behaviours Prism relies on.
// It never uses ~/.parachute, never binds or calls 1939/1940/8787, and by
// default gives the children a throwaway HOME too, so nothing the CLIs resolve
// from `homedir()` (launchd plists, ~/.claude.json, ~/.bun discovery) lands in
// the real one. Writes report.json + report.md to --out.
//
//   node scripts/parachute-compat/run.mjs --home /tmp/pc/home [--bin …] [--vault-bin …] [--dry-run]
//
// See README.md next to this file.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import {
  ADMIN_ONLY_TOOLS, EMBEDDED_ITEMS, PRISM_VAULT_RO, PRISM_VAULT_RW,
  assertHomeAllowed, assertPortAllowed, countResults, decodeJwt, detectFeatures, fmtMode, isLoopbackAddr, isSecretPath,
  liveParachuteHome, modeProblem, parseArgs, parseJsonOut, parseLsof, parseMint, pickPort, portFree, renderMarkdown, scrub, usage,
} from "./lib.mjs";

const VAULT = "compat";
const results = [];
const secrets = [];
const procs = [];
let opts;

function rec(area, id, status, detail = "") {
  results.push({ area, id, status, detail: scrub(detail, secrets) });
  const line = `  ${status.padEnd(4)} ${area} · ${id}${detail ? ` — ${scrub(detail, secrets)}` : ""}`;
  (status === "FAIL" ? console.error : console.log)(line);
}

function which(bin) {
  if (isAbsolute(bin)) return existsSync(bin) ? bin : undefined;
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(d, bin);
    if (existsSync(p)) return p;
  }
  return undefined;
}

// ── child environment: an allowlist, the throwaway home, our ports ──────────
let baseEnv;
function childEnv(extra = {}) {
  return { ...baseEnv, ...extra };
}

/** Run a CLI to completion. stdout is returned to the caller but never logged. */
function run(bin, args, { env = {}, input, timeoutMs = 60_000 } = {}) {
  const t0 = Date.now();
  const r = spawnSync(bin, args, {
    env: childEnv(env),
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    cwd: opts.out,
  });
  return {
    code: r.status,
    signal: r.signal,
    timedOut: r.error?.code === "ETIMEDOUT",
    error: r.error && r.error.code !== "ETIMEDOUT" ? r.error.message : undefined,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ms: Date.now() - t0,
  };
}

function short(r) {
  if (r.error) return r.error;
  if (r.timedOut) return "timed out";
  const err = scrub(r.stderr, secrets).trim().split("\n").slice(-2).join(" / ");
  return `exit ${r.code ?? r.signal}${err ? ` — ${err.slice(0, 240)}` : ""}`;
}

/** Start a long-running process with its output in a log file. */
function start(name, bin, args, env) {
  const log = join(opts.out, `${name}.log`);
  const fd = openSync(log, "a", 0o600);
  const child = spawn(bin, args, { env: childEnv(env), stdio: ["ignore", fd, fd], cwd: opts.out });
  closeSync(fd);
  const p = { name, child, log, exited: null };
  child.on("exit", (code, signal) => {
    p.exited = { code, signal, at: Date.now() };
  });
  procs.push(p);
  return p;
}

function killAll() {
  for (const p of procs) {
    if (!p.exited) {
      try {
        p.child.kill("SIGKILL");
      } catch { /* gone */ }
    }
  }
}
process.on("exit", killAll);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { killAll(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, init = {}, timeoutMs = 10_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, redirect: "manual" });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json, headers: res.headers };
  } catch (e) {
    return { status: 0, text: String(e?.message ?? e), error: true };
  } finally {
    clearTimeout(t);
  }
}

async function waitFor(url, { timeoutMs = 30_000, ok = (r) => r.status === 200, proc } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc?.exited) return { ok: false, ms: Date.now() - t0, exited: proc.exited };
    const r = await http(url, {}, 2000);
    if (ok(r)) return { ok: true, ms: Date.now() - t0, res: r };
    await sleep(250);
  }
  return { ok: false, ms: Date.now() - t0 };
}

const bearer = (t) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

// ── isolation evidence ──────────────────────────────────────────────────────
function launchctlParachute() {
  const r = spawnSync("launchctl", ["list"], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").filter((l) => /parachute/i.test(l)).map((l) => l.split(/\s+/).pop()).sort();
}
function liveHomeEntries() {
  const live = liveParachuteHome();
  try { return readdirSync(live).sort(); } catch { return []; }
}

function pidsOf(rootPid) {
  const all = [rootPid];
  for (let i = 0; i < all.length; i++) {
    const r = spawnSync("pgrep", ["-P", String(all[i])], { encoding: "utf8" });
    for (const l of (r.stdout ?? "").split("\n")) if (l.trim()) all.push(Number(l.trim()));
  }
  return all;
}
function lsofTcp(pids, state) {
  if (!pids.length) return [];
  const r = spawnSync("lsof", ["-nP", "-a", "-p", pids.join(","), "-iTCP", `-sTCP:${state}`], { encoding: "utf8" });
  return parseLsof(r.stdout ?? "");
}
const outbound = new Map();
let sampler;
function startOutboundSampler() {
  sampler = setInterval(() => {
    const pids = procs.filter((p) => !p.exited).flatMap((p) => pidsOf(p.child.pid));
    for (const c of lsofTcp(pids, "ESTABLISHED")) {
      if (c.remote && !isLoopbackAddr(c.remote)) outbound.set(`${c.cmd}→${c.remote}`, (outbound.get(`${c.cmd}→${c.remote}`) ?? 0) + 1);
    }
  }, 1000);
  sampler.unref();
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    const rel = relative(base, p);
    out.push({ rel, mode: st.mode, isDir: st.isDirectory() });
    if (st.isDirectory() && !st.isSymbolicLink()) walk(p, base, out);
  }
  return out;
}

// ── the suite ───────────────────────────────────────────────────────────────
async function main() {
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${usage()}`);
    process.exit(2);
  }
  if (opts.help) { console.log(usage()); return; }

  // Refusals first — before anything is created or spawned.
  try {
    assertHomeAllowed(opts.home, { reuse: opts.reuse });
    if (opts.hubPort) assertPortAllowed(opts.hubPort);
    if (opts.vaultPort) assertPortAllowed(opts.vaultPort);
    if (opts.hubPort && opts.hubPort === opts.vaultPort) throw new Error("--hub-port and --vault-port must differ");
  } catch (e) {
    console.error(`refused: ${e.message}`);
    process.exit(2);
  }
  opts.out = opts.out ?? `${opts.home}-report`;
  if (!isAbsolute(opts.out)) { console.error("refused: --out must be absolute"); process.exit(2); }
  if (existsSync(opts.out) && readdirSync(opts.out).length && !opts.reuse) {
    console.error(`refused: --out ${opts.out} is not empty (pass --reuse)`);
    process.exit(2);
  }
  const seed = randomBytes(2).readUInt16BE(0);
  const hubPort = opts.hubPort ?? (await pickPort(seed));
  const vaultPort = opts.vaultPort ?? (await pickPort(seed + 1, [hubPort]));
  for (const [n, p] of [["hub", hubPort], ["vault", vaultPort]]) {
    if (!(await portFree(p))) { console.error(`refused: ${n} port ${p} is in use`); process.exit(2); }
  }
  const hubBin = which(opts.bin);
  const vaultBin = which(opts.vaultBin);
  const hubOrigin = `http://127.0.0.1:${hubPort}`;
  const vaultOrigin = `http://127.0.0.1:${vaultPort}`;
  const fakeHome = join(opts.out, "fakehome");
  const report = {
    startedAt: new Date().toISOString(),
    dryRun: opts.dryRun,
    mode: "",
    home: opts.home,
    out: opts.out,
    bins: { hub: hubBin ?? opts.bin, vault: vaultBin ?? opts.vaultBin },
    versions: {},
    ports: { hub: hubPort, vault: vaultPort },
    childHome: opts.realHome ? "(real HOME)" : fakeHome,
    features: {},
    embedded: {},
    results,
    fileModes: [],
  };

  if (opts.dryRun) {
    report.mode = "dry run";
    const plan = [
      `mkdir ${opts.home} (0700), ${opts.out}, ${fakeHome}`,
      `${report.bins.hub} --version ; ${report.bins.vault} --version ; ${report.bins.hub} version --json`,
      `help scan: serve / auth / bootstrap / vault create`,
      `write ${join(opts.home, "vault", "config.yaml")} (port ${vaultPort}, autostart false, embeddings off)`,
      `PORT=${hubPort} PARACHUTE_HOME=${opts.home} PARACHUTE_HUB_ORIGIN=${hubOrigin} ${report.bins.hub} serve [--embedded]  (admin seeded from env)`,
      `${report.bins.hub} auth rotate-operator  (or bootstrap --embedded --json, twice, when supported)`,
      `PORT=${vaultPort} ${report.bins.vault} create ${VAULT} --mint --scope write --no-mirror --json ; then ${report.bins.vault} serve`,
      `mint read / write / admin tokens; JWKS; REST CRUD + if_updated_at 409; tag schema 403/200; MCP tools/list ×3`,
      `revoke-token + revocation list + refusal latency; listeners (lsof); file modes; SIGTERM; isolation checks`,
    ];
    for (const p of plan) rec("plan", p, "INFO");
    if (!hubBin) rec("preflight", "hub CLI found", "FAIL", `${opts.bin} not found`);
    else rec("preflight", "hub CLI found", "PASS", hubBin);
    if (!vaultBin) rec("preflight", "vault CLI found", "FAIL", `${opts.vaultBin} not found`);
    else rec("preflight", "vault CLI found", "PASS", vaultBin);
    for (const id of Object.keys(EMBEDDED_ITEMS)) report.embedded[id] = { status: "SKIP", detail: "dry run" };
    return finish(report);
  }

  if (!hubBin || !vaultBin) {
    rec("preflight", "CLIs found", "FAIL", `hub ${hubBin ?? "missing"}, vault ${vaultBin ?? "missing"}`);
    for (const id of Object.keys(EMBEDDED_ITEMS)) report.embedded[id] = { status: "SKIP", detail: "CLI missing" };
    return finish(report);
  }

  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  mkdirSync(opts.out, { recursive: true, mode: 0o700 });
  mkdirSync(fakeHome, { recursive: true, mode: 0o700 });
  baseEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: opts.realHome ? process.env.HOME : fakeHome,
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: join(opts.out, "tmp"),
    TZ: process.env.TZ ?? "UTC",
    PARACHUTE_HOME: opts.home,
    PARACHUTE_HUB_ORIGIN: hubOrigin,
    PARACHUTE_HUB_PORT: String(hubPort),
    PARACHUTE_HUB_JWKS_ORIGIN: hubOrigin,
  };
  mkdirSync(baseEnv.TMPDIR, { recursive: true, mode: 0o700 });
  const launchdBefore = launchctlParachute();
  const liveBefore = liveHomeEntries();

  // ── versions + advertised features ──
  const hv = run(hubBin, ["--version"]);
  const vv = run(vaultBin, ["--version"]);
  report.versions.hub = hv.code === 0 ? hv.stdout.trim().split("\n").pop() : `(${short(hv)})`;
  report.versions.vault = vv.code === 0 ? vv.stdout.trim().split("\n").pop() : `(${short(vv)})`;
  rec("version", "parachute --version", hv.code === 0 ? "PASS" : "FAIL", report.versions.hub);
  rec("version", "parachute-vault --version", vv.code === 0 ? "PASS" : "FAIL", report.versions.vault);
  const vj = run(hubBin, ["version", "--json"]);
  const versionJson = vj.code === 0 ? parseJsonOut(vj.stdout) : undefined;
  rec("version", "parachute version --json", versionJson ? "PASS" : "SKIP", versionJson ? JSON.stringify(versionJson).slice(0, 200) : `not supported (${short(vj)})`);
  const help = {
    root: run(hubBin, ["--help"]).stdout,
    serve: run(hubBin, ["serve", "--help"]).stdout,
    auth: (() => { const r = run(hubBin, ["auth", "--help"]); return r.stdout + r.stderr; })(),
    bootstrap: (() => { const r = run(hubBin, ["bootstrap", "--help"]); return r.stdout + r.stderr; })(),
    vaultRoot: (() => { const r = run(vaultBin, ["--help"]); return r.stdout + r.stderr; })(),
  };
  const f = (report.features = detectFeatures(help, versionJson));
  rec("features", "advertised", "INFO", Object.entries(f).map(([k, v]) => `${k}=${v ? "yes" : "no"}`).join(", "));
  report.mode = f.serveEmbedded ? "embedded (serve --embedded)" : "stock (serve, admin seeded from env, operator token via rotate-operator)";

  // ── configure the vault's port in the throwaway home BEFORE anything else ──
  mkdirSync(join(opts.home, "vault"), { recursive: true, mode: 0o700 });
  const vcfg = join(opts.home, "vault", "config.yaml");
  if (!existsSync(vcfg)) writeFileSync(vcfg, `port: ${vaultPort}\nautostart: false\nembeddings_enabled: false\n`, { mode: 0o600 });

  // ── hub lifecycle ──
  const adminPassword = randomBytes(18).toString("base64url");
  secrets.push(adminPassword);
  const hubArgs = f.serveEmbedded ? ["serve", "--embedded"] : ["serve"];
  // PARACHUTE_BIND_HOST keeps this throwaway hub off the LAN (stock 0.7.x binds
  // wide without it); E6 then checks the listeners anyway.
  const hubEnv = { PORT: String(hubPort), PARACHUTE_BIND_HOST: "127.0.0.1", PARACHUTE_INITIAL_ADMIN_USERNAME: "compat", PARACHUTE_INITIAL_ADMIN_PASSWORD: adminPassword };
  if (f.serveEmbedded) delete hubEnv.PARACHUTE_INITIAL_ADMIN_PASSWORD; // bootstrap does it
  startOutboundSampler();
  const hub = start("hub", hubBin, hubArgs, hubEnv);
  const hubUp = await waitFor(`${hubOrigin}/health`, { proc: hub, timeoutMs: 45_000 });
  rec("lifecycle", `hub ${hubArgs.join(" ")} → /health`, hubUp.ok ? "PASS" : "FAIL", hubUp.ok ? `${hubUp.ms} ms` : hubUp.exited ? `exited ${JSON.stringify(hubUp.exited)} (see hub.log)` : "no answer in 45 s");
  if (!hubUp.ok) return finishWithEmbedded(report, f, {});
  const ready = await http(`${hubOrigin}/api/ready`);
  rec("lifecycle", "hub GET /api/ready", ready.status === 200 ? "PASS" : ready.status === 404 ? "SKIP" : "FAIL", `HTTP ${ready.status} ${scrub(ready.text).slice(0, 120)}`);

  // ── bootstrap / operator token ──
  let bootstrapIdempotent;
  if (f.bootstrapEmbedded) {
    const pwFile = join(opts.out, "admin-password");
    writeFileSync(pwFile, adminPassword, { mode: 0o600 });
    const args = ["bootstrap", "--embedded", "--username", "compat", "--password-file", pwFile, "--vault", VAULT, "--json"];
    const b1 = run(hubBin, args);
    const b2 = run(hubBin, args);
    const j1 = parseJsonOut(b1.stdout);
    const j2 = parseJsonOut(b2.stdout);
    rec("bootstrap", "bootstrap --embedded --json (1st)", b1.code === 0 && j1 ? "PASS" : "FAIL", b1.code === 0 ? `created=${j1?.created}` : short(b1));
    bootstrapIdempotent = b2.code === 0 && j2?.created === false;
    rec("bootstrap", "bootstrap again reports created:false", bootstrapIdempotent ? "PASS" : "FAIL", b2.code === 0 ? `created=${j2?.created}` : short(b2));
  } else {
    rec("bootstrap", "bootstrap --embedded", "SKIP", "not supported — admin seeded from PARACHUTE_INITIAL_ADMIN_* env on serve");
  }
  const opTok = join(opts.home, "operator.token");
  if (!existsSync(opTok)) {
    const r = run(hubBin, ["auth", "rotate-operator"]);
    rec("bootstrap", "auth rotate-operator writes operator.token", r.code === 0 && existsSync(opTok) ? "PASS" : "FAIL", r.code === 0 ? "" : short(r));
  } else {
    rec("bootstrap", "operator.token present after bootstrap", "PASS");
  }
  // The CLI stamps `iss` on the operator token (and on every token it mints)
  // from expose-state or the hub's run/hub.port file — NOT PARACHUTE_HUB_ORIGIN.
  // Stock `parachute serve` writes no hub.port, so a hub on a non-default port
  // gets tokens with iss=http://127.0.0.1:1939 that its own vault refuses.
  // Record it, then write the port file and re-mint so the suite can go on.
  report.issuerShim = false;
  if (existsSync(opTok)) {
    const iss = decodeJwt(readFileSync(opTok, "utf8").trim())?.iss;
    rec("tokens", "CLI issuer follows PARACHUTE_HUB_ORIGIN (operator.token iss)", iss === hubOrigin ? "PASS" : "FAIL", `iss=${iss}`);
    const portFile = join(opts.home, "hub", "run", "hub.port");
    if (iss !== hubOrigin && !existsSync(portFile)) {
      mkdirSync(dirname(portFile), { recursive: true, mode: 0o700 });
      writeFileSync(portFile, `${hubPort}\n`, { mode: 0o600 });
      report.issuerShim = true;
      const r = run(hubBin, ["auth", "rotate-operator"]);
      const iss2 = r.code === 0 ? decodeJwt(readFileSync(opTok, "utf8").trim())?.iss : undefined;
      rec("tokens", "shim: wrote $PARACHUTE_HOME/hub/run/hub.port, rotated the operator token", iss2 === hubOrigin ? "INFO" : "FAIL", r.code === 0 ? `iss=${iss2}` : short(r));
    }
  }
  if (existsSync(opTok)) {
    secrets.push(readFileSync(opTok, "utf8").trim());
    const m = statSync(opTok).mode & 0o777;
    rec("security", "operator.token mode", m & 0o077 ? "FAIL" : "PASS", fmtMode(m));
  }
  const hubLogSoFar = existsSync(hub.log) ? readFileSync(hub.log, "utf8") : "";
  rec("security", "no wizard bootstrap token printed by serve", /setup[- ]?token|bootstrap token|\/admin\/setup\?/i.test(hubLogSoFar) ? "FAIL" : "PASS", "scanned hub.log");

  // ── vault create ──
  let vaultToken;
  if (!f.bootstrapEmbedded) {
    const args = ["create", VAULT, "--mint", "--scope", "write", "--no-mirror", "--json"];
    const c = run(vaultBin, args, { env: { PORT: String(vaultPort) } });
    const j = parseJsonOut(c.stdout);
    if (j?.token) { vaultToken = j.token; secrets.push(j.token); }
    rec("vault", `parachute-vault create ${VAULT} --mint --scope write --no-mirror --json`, c.code === 0 && j?.token && j?.name === VAULT ? "PASS" : "FAIL",
      c.code === 0 ? `keys: ${Object.keys(j ?? {}).join(",")}${j?.token ? "" : `; no token minted${j?.token_guidance ? ` (${String(j.token_guidance).slice(0, 160)})` : ""}${c.stderr.trim() ? ` stderr: ${c.stderr.trim().split("\n").slice(-2).join(" / ").slice(0, 200)}` : ""}`}` : short(c));
    if (j?.token) {
      const iss = decodeJwt(j.token)?.iss;
      rec("vault", "create --mint token issuer = PARACHUTE_HUB_ORIGIN", iss === hubOrigin ? "PASS" : "FAIL", String(iss));
    }
    const c2 = run(vaultBin, args, { env: { PORT: String(vaultPort) } });
    const j2 = parseJsonOut(c2.stdout);
    if (j2?.token) secrets.push(j2.token);
    rec("vault", "create again (idempotency)", "INFO", c2.code === 0 ? `exit 0, created=${j2?.created ?? "?"}` : short(c2));
  }

  // ── vault serve (supervised by the hub, or started by us) ──
  let vaultUp = await waitFor(`${vaultOrigin}/health`, { timeoutMs: 8_000 });
  let vaultProc;
  if (vaultUp.ok) {
    rec("lifecycle", "vault started by the hub's supervisor", "INFO", `on ${vaultPort}`);
  } else {
    vaultProc = start("vault", vaultBin, ["serve"], { PORT: String(vaultPort) });
    vaultUp = await waitFor(`${vaultOrigin}/health`, { proc: vaultProc, timeoutMs: 45_000 });
    rec("lifecycle", "parachute-vault serve → /health", vaultUp.ok ? "PASS" : "FAIL", vaultUp.ok ? `${vaultUp.ms} ms` : vaultUp.exited ? `exited ${JSON.stringify(vaultUp.exited)} (see vault.log)` : "no answer in 45 s");
  }
  const vh = await http(`${vaultOrigin}/health`);
  rec("vault", "GET /health (unauthenticated)", vh.status === 200 ? "PASS" : "FAIL", `HTTP ${vh.status}`);

  // ── tokens ──
  const mint = (scope, extra) => {
    const args = ["auth", "mint-token", "--scope", scope, ...extra, ...(f.mintJson ? ["--json"] : [])];
    const r = run(hubBin, args);
    const m = r.code === 0 ? parseMint(r.stdout) : undefined;
    if (m?.token) secrets.push(m.token);
    return { r, m };
  };
  const tokens = {};
  for (const [verb, extra] of [["write", ["--expires-in", "3600"]], ["read", ["--expires-in", "3600", "--service", "agent-session:compat"]], ["admin", ["--ephemeral"]]]) {
    const scope = `vault:${VAULT}:${verb}`;
    const { r, m } = mint(scope, extra);
    const claims = m ? decodeJwt(m.token) : undefined;
    tokens[verb] = m?.token;
    if (claims) tokens[`${verb}Claims`] = claims;
    const scopes = String(claims?.scope ?? claims?.scopes ?? "");
    const ok = Boolean(m && claims && claims.iss === hubOrigin && scopes.split(/\s+/).includes(scope) && claims.jti && claims.exp);
    rec("tokens", `mint-token ${scope} ${extra.join(" ")}`, ok ? "PASS" : "FAIL",
      m ? `iss=${claims?.iss} aud=${JSON.stringify(claims?.aud)} sub=${claims?.sub ?? "-"} ttl=${claims?.exp && claims?.iat ? claims.exp - claims.iat : "?"}s json=${m.json}` : short(r));
  }
  rec("tokens", "issuer equals PARACHUTE_HUB_ORIGIN", tokens.writeClaims?.iss === hubOrigin ? "PASS" : "FAIL", String(tokens.writeClaims?.iss));
  rec("tokens", "mint-token --json", f.mintJson ? "PASS" : "SKIP", f.mintJson ? "" : "not advertised; the bare JWT on stdout was parsed");
  const jwks = await http(`${hubOrigin}/.well-known/jwks.json`);
  const kid = decodeJwtHeader(tokens.write)?.kid;
  rec("tokens", "JWKS has the signing key", jwks.json?.keys?.some((k) => !kid || k.kid === kid) ? "PASS" : "FAIL", `HTTP ${jwks.status}, ${jwks.json?.keys?.length ?? 0} key(s)${kid ? `, kid ${kid}` : ""}`);

  // ── REST wire contract ──
  const api = `${vaultOrigin}/vault/${VAULT}/api`;
  const noAuth = await http(`${api}/notes?limit=1`);
  rec("rest", "no token → 401", noAuth.status === 401 ? "PASS" : "FAIL", `HTTP ${noAuth.status}`);
  const W = tokens.write ?? vaultToken;
  if (W) {
    const created = await http(`${api}/notes`, { method: "POST", headers: bearer(W), body: JSON.stringify({ content: "compat note", path: "compat/one", tags: ["compat"] }) });
    const note = created.json?.notes?.[0] ?? created.json;
    rec("rest", "POST /notes", created.status < 300 && note?.id ? "PASS" : "FAIL", `HTTP ${created.status}`);
    if (note?.id) {
      const got = await http(`${api}/notes/${encodeURIComponent(note.id)}`, { headers: bearer(W) });
      rec("rest", "GET /notes/:id", got.status === 200 && got.json?.content === "compat note" ? "PASS" : "FAIL", `HTTP ${got.status}`);
      const stamp = got.json?.updatedAt ?? got.json?.updated_at ?? note.updatedAt;
      const p1 = await http(`${api}/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", headers: bearer(W), body: JSON.stringify({ content: "compat note v2", if_updated_at: stamp }) });
      rec("rest", "PATCH with current if_updated_at", p1.status === 200 ? "PASS" : "FAIL", `HTTP ${p1.status}`);
      const p2 = await http(`${api}/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", headers: bearer(W), body: JSON.stringify({ content: "stale", if_updated_at: stamp }) });
      rec("rest", "PATCH with stale if_updated_at → 409", p2.status === 409 ? "PASS" : "FAIL", `HTTP ${p2.status} ${p2.json?.error_type ?? p2.json?.error ?? ""}`);
      const dup = await http(`${api}/notes`, { method: "POST", headers: bearer(W), body: JSON.stringify({ content: "x", path: "compat/one", if_exists: "error" }) });
      rec("rest", "POST same path, if_exists:error → 409", dup.status === 409 ? "PASS" : "FAIL", `HTTP ${dup.status}`);
      const list = await http(`${api}/notes?tag=compat&include_content=false&limit=10`, { headers: bearer(W) });
      rec("rest", "GET /notes?tag&include_content=false is a flat array", Array.isArray(list.json) && list.json.length >= 1 ? "PASS" : "FAIL", `HTTP ${list.status}`);
      const vers = await http(`${api}/notes/${encodeURIComponent(note.id)}/versions`, { headers: bearer(W) });
      rec("rest", "GET /notes/:id/versions (history)", vers.status === 200 ? "PASS" : "FAIL", `HTTP ${vers.status}`);
      if (tokens.read) {
        const ro = await http(`${api}/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", headers: bearer(tokens.read), body: JSON.stringify({ content: "ro", force: true }) });
        rec("rest", "read token cannot write", ro.status === 403 || ro.status === 401 ? "PASS" : "FAIL", `HTTP ${ro.status}`);
      }
      const del = await http(`${api}/notes/${encodeURIComponent(note.id)}`, { method: "DELETE", headers: bearer(W) });
      rec("rest", "DELETE /notes/:id", del.status < 300 ? "PASS" : "FAIL", `HTTP ${del.status}`);
    }
    // tag schema: write → 403, admin → 2xx
    const schema = JSON.stringify({ description: "compat", fields: { compat_field: { type: "string" } } });
    const tw = await http(`${api}/tags/compat-schema`, { method: "PUT", headers: bearer(W), body: schema });
    rec("rest", "PUT /tags/:name with a write token → 403", tw.status === 403 ? "PASS" : "FAIL", `HTTP ${tw.status} ${tw.json?.error ?? ""}`);
    if (tokens.admin) {
      const ta = await http(`${api}/tags/compat-schema`, { method: "PUT", headers: bearer(tokens.admin), body: schema });
      rec("rest", "PUT /tags/:name with an admin token", ta.status < 300 ? "PASS" : "FAIL", `HTTP ${ta.status}`);
    }
  } else {
    rec("rest", "REST checks", "SKIP", "no write token");
  }

  // ── MCP tools/list per scope ──
  for (const verb of ["read", "write", "admin"]) {
    const t = tokens[verb];
    if (!t) { rec("mcp", `tools/list (${verb})`, "SKIP", "no token"); continue; }
    const names = await mcpTools(`${vaultOrigin}/vault/${VAULT}/mcp`, t);
    if (!names) { rec("mcp", `tools/list (${verb})`, "FAIL", "no tools/list answer"); continue; }
    const need = verb === "read" ? PRISM_VAULT_RO : PRISM_VAULT_RW;
    const missing = need.filter((n) => !names.includes(n));
    const leaked = verb === "admin" ? [] : ADMIN_ONLY_TOOLS.filter((n) => names.includes(n));
    rec("mcp", `tools/list (${verb}) has Prism's allowlist${verb === "admin" ? "" : ", no admin verbs"}`, missing.length || leaked.length ? "FAIL" : "PASS",
      `${names.length} tools${missing.length ? `; missing ${missing.join(",")}` : ""}${leaked.length ? `; admin verbs visible ${leaked.join(",")}` : ""}`);
    if (verb === "admin") rec("mcp", "admin token sees the admin verbs", ADMIN_ONLY_TOOLS.some((n) => names.includes(n)) ? "PASS" : "INFO", ADMIN_ONLY_TOOLS.filter((n) => names.includes(n)).join(","));
  }

  // ── revocation ──
  const readJti = tokens.readClaims?.jti;
  if (readJti && tokens.read) {
    const before = await http(`${api}/notes?limit=1`, { headers: bearer(tokens.read) });
    const rv = run(hubBin, ["auth", "revoke-token", readJti]);
    rec("tokens", "auth revoke-token <jti>", rv.code === 0 ? "PASS" : "FAIL", rv.code === 0 ? "" : short(rv));
    const rl = await http(`${hubOrigin}/.well-known/parachute-revocation.json`);
    rec("tokens", "revocation list names the jti", rl.status === 200 && rl.text.includes(readJti) ? "PASS" : "FAIL", `HTTP ${rl.status}`);
    const t0 = Date.now();
    let refusedAt;
    while (Date.now() - t0 < opts.revokeWait * 1000) {
      const r = await http(`${api}/notes?limit=1`, { headers: bearer(tokens.read) });
      if (r.status === 401 || r.status === 403) { refusedAt = Date.now() - t0; break; }
      await sleep(2000);
    }
    rec("tokens", "revoked token refused by the vault", before.status === 200 && refusedAt !== undefined ? "PASS" : "FAIL",
      `before revoke HTTP ${before.status}; ${refusedAt !== undefined ? `refused after ~${Math.round(refusedAt / 1000)} s` : `still accepted after ${opts.revokeWait} s`}`);
  }

  // ── security posture ──
  const listen = procs.filter((p) => !p.exited).flatMap((p) => lsofTcp(pidsOf(p.child.pid), "LISTEN"));
  const wide = listen.filter((l) => !isLoopbackAddr(l.local));
  rec("security", "all listeners loopback-only (E6)", listen.length && !wide.length ? "PASS" : listen.length ? "FAIL" : "INFO",
    listen.length ? [...new Set(listen.map((l) => `${l.cmd} ${l.local}`))].join(", ") : "lsof saw no listeners");
  const modes = walk(opts.home);
  for (const m of modes) {
    const problem = modeProblem(m.mode, { isDir: m.isDir, secret: !m.isDir && isSecretPath(m.rel) });
    report.fileModes.push({ path: m.rel + (m.isDir ? "/" : ""), mode: fmtMode(m.mode), problem });
  }
  const modeFails = report.fileModes.filter((m) => m.problem);
  rec("security", "secret files 0600 in 0700 dirs (E8)", modeFails.length ? "FAIL" : "PASS", modeFails.length ? `${modeFails.length} problem(s): ${modeFails.slice(0, 6).map((m) => `${m.path} ${m.mode}`).join(", ")}` : `${modes.length} entries checked`);
  const logs = procs.map((p) => (existsSync(p.log) ? readFileSync(p.log, "utf8") : "")).join("\n");
  const leakedSecrets = secrets.filter((s) => s && s.length >= 12 && logs.includes(s)).length;
  rec("security", "no minted token / admin password in logs", leakedSecrets ? "FAIL" : "PASS", `${leakedSecrets} found`);
  const ps = spawnSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" }).stdout ?? "";
  rec("security", "no secret in ps argv", secrets.some((s) => s && s.length >= 12 && ps.includes(s)) ? "FAIL" : "PASS");
  const outs = [...outbound.keys()];
  rec("security", "no outbound connections (E9)", outs.length ? "FAIL" : "PASS", outs.length ? outs.slice(0, 8).join(", ") : "sampled every 1 s while running");
  // bun's own transpiler cache (Library/Caches/bun) is the runtime's, not Parachute state.
  const allFake = existsSync(fakeHome) ? walk(fakeHome).map((e) => e.rel) : [];
  const bunCache = allFake.filter((r) => /^Library(\/Caches(\/bun(\/|$)|$)|$)/.test(r));
  const fakeEntries = allFake.filter((r) => !bunCache.includes(r));
  rec("isolation", "Parachute files written to the children's HOME (outside PARACHUTE_HOME, E2)", fakeEntries.length ? "FAIL" : "PASS", fakeEntries.length ? fakeEntries.slice(0, 10).join(", ") : "none");
  if (bunCache.length) rec("isolation", "bun runtime cache under HOME", "INFO", `${bunCache.length} entries in Library/Caches/bun (bun's transpiler cache, not Parachute state)`);

  // ── SIGTERM ──
  for (const p of [...procs].reverse()) {
    if (p.exited) { rec("lifecycle", `${p.name} still running at the end`, "FAIL", `exited early ${JSON.stringify(p.exited)}`); continue; }
    const t0 = Date.now();
    p.child.kill("SIGTERM");
    while (!p.exited && Date.now() - t0 < 15_000) await sleep(100);
    const ms = Date.now() - t0;
    if (!p.exited) { p.child.kill("SIGKILL"); rec("lifecycle", `${p.name} SIGTERM → exit within 10 s`, "FAIL", "still running after 15 s (killed)"); continue; }
    rec("lifecycle", `${p.name} SIGTERM → exit 0 within 10 s`, p.exited.code === 0 && ms <= 10_000 ? "PASS" : "FAIL", `code ${p.exited.code} signal ${p.exited.signal ?? "-"} after ${ms} ms`);
  }
  clearInterval(sampler);

  // ── isolation evidence ──
  const launchdAfter = launchctlParachute();
  const newJobs = launchdAfter.filter((j) => !launchdBefore.includes(j));
  rec("isolation", "no launchd job registered", newJobs.length ? "FAIL" : "PASS", newJobs.join(", ") || "launchctl list unchanged");
  const liveAfter = liveHomeEntries();
  const liveNew = liveAfter.filter((e) => !liveBefore.includes(e));
  rec("isolation", "no new entries in the live ~/.parachute", liveNew.length ? "FAIL" : "PASS", liveNew.join(", ") || "top-level listing unchanged");

  return finishWithEmbedded(report, f, { bootstrapIdempotent, listenOk: listen.length && !wide.length, modeFails, outs, fakeEntries, ready });
}

function decodeJwtHeader(t) {
  try { return JSON.parse(Buffer.from(String(t).split(".")[0], "base64url").toString("utf8")); } catch { return undefined; }
}

async function mcpTools(url, token) {
  const headers = { ...bearer(token), accept: "application/json, text/event-stream" };
  await http(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prism-parachute-compat", version: "1" } } }) });
  const r = await http(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
  let j = r.json;
  if (!j && /data:/.test(r.text)) j = parseJsonOut(r.text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("\n"));
  const tools = j?.result?.tools;
  return Array.isArray(tools) ? tools.map((t) => t.name) : undefined;
}

function finishWithEmbedded(report, f, m) {
  const e = report.embedded;
  const rs = (area, idPart) => results.filter((r) => r.area === area && r.id.includes(idPart));
  const sigterm = results.filter((r) => /SIGTERM/.test(r.id));
  e.E1 = f.serveEmbedded
    ? { status: sigterm.every((r) => r.status === "PASS") && m.ready?.status === 200 ? "PASS" : "FAIL", detail: `serve --embedded; /api/ready HTTP ${m.ready?.status}; SIGTERM ${sigterm.map((r) => r.status).join("/")}. Exit-code fixtures (4/5/6) and install/upgrade refusals not exercised yet.` }
    : { status: "SKIP", detail: `serve has no --embedded flag. Observed with plain serve: /api/ready HTTP ${m.ready?.status ?? "-"}; SIGTERM ${sigterm.map((r) => `${r.id.split(" ")[0]} ${r.status}`).join(", ") || "-"}` };
  e.E2 = { status: m.fakeEntries ? (m.fakeEntries.length ? "FAIL" : "PASS") : "SKIP", detail: m.fakeEntries ? (m.fakeEntries.length ? `wrote outside PARACHUTE_HOME: ${m.fakeEntries.slice(0, 5).join(", ")}` : "nothing written to the children's HOME; PARACHUTE_HOME honoured") + (f.serveEmbedded ? "" : " (\"required in embedded mode\" not testable: no embedded mode)") : "not run" };
  e.E3 = { status: "SKIP", detail: report.artifactCheck ?? "no --artifact given (stock install is a bun global package, not a pinned artifact)" };
  e.E4 = f.bootstrapEmbedded
    ? { status: m.bootstrapIdempotent ? "PASS" : "FAIL", detail: `bootstrap --embedded present; password-file flag ${f.bootstrapPasswordFile ? "advertised" : "not advertised"}` }
    : { status: "SKIP", detail: "no `bootstrap` command; stock set-password takes --password on argv when stdin is not a TTY (env seeding used instead)" };
  const mintRows = rs("tokens", "mint-token vault");
  e.E5 = f.mintJson
    ? { status: mintRows.every((r) => r.status === "PASS") ? "PASS" : "FAIL", detail: "mint-token --json advertised and used" }
    : { status: "SKIP", detail: `mint-token has no --json (bare JWT parsed); vault create --json ${f.vaultCreateJson ? "supported" : "not advertised"}; PARACHUTE_HOME honoured by both CLIs: ${mintRows.length && mintRows.every((r) => r.status === "PASS") ? "yes" : "unclear"}` };
  const iss = results.filter((r) => r.area === "tokens" && /issuer/.test(r.id));
  e.E6 = {
    status: m.listenOk === undefined ? "SKIP" : m.listenOk && iss.every((r) => r.status === "PASS") ? "PASS" : "FAIL",
    detail: `listeners: ${rs("security", "loopback")[0]?.detail ?? "-"} (the suite sets PARACHUTE_BIND_HOST=127.0.0.1); issuer: ${iss.map((r) => `${r.id} ${r.status}`).join("; ") || "-"}${report.issuerShim ? " — tokens minted after writing hub/run/hub.port" : ""}`,
  };
  e.E7 = f.versionJson ? { status: "PASS", detail: "version --json present (newer-schema guard not exercised: needs fixtures)" } : { status: "SKIP", detail: "no `version --json`" };
  e.E8 = m.modeFails ? { status: m.modeFails.length ? "FAIL" : "PASS", detail: m.modeFails.length ? m.modeFails.slice(0, 6).map((x) => `${x.path} ${x.mode}`).join(", ") : "all secret files 0600, dirs 0700" } : { status: "SKIP", detail: "not run" };
  e.E9 = m.outs ? { status: m.outs.length ? "FAIL" : "PASS", detail: m.outs.length ? m.outs.slice(0, 6).join(", ") : "no non-loopback TCP seen (lsof sampled 1/s; embeddings disabled in config)" } : { status: "SKIP", detail: "not run" };
  return finish(report);
}

function finish(report) {
  if (opts.artifact && !report.dryRun) {
    // E3: a checksum file next to the artifact (`<artifact>.sha256` or SHA256SUMS).
    const sumFile = [`${opts.artifact}.sha256`, join(dirname(opts.artifact), "SHA256SUMS")].find((p) => existsSync(p));
    if (!existsSync(opts.artifact)) report.embedded.E3 = { status: "FAIL", detail: "artifact not found" };
    else if (!sumFile) report.embedded.E3 = { status: "FAIL", detail: "no .sha256 / SHA256SUMS next to the artifact" };
    else {
      const h = createHash("sha256").update(readFileSync(opts.artifact)).digest("hex");
      report.embedded.E3 = { status: readFileSync(sumFile, "utf8").includes(h) ? "PASS" : "FAIL", detail: `sha256 ${h.slice(0, 16)}… vs ${sumFile}` };
    }
  }
  report.counts = countResults(results);
  report.finishedAt = new Date().toISOString();
  mkdirSync(opts.out, { recursive: true, mode: 0o700 });
  const json = scrub(JSON.stringify(report, null, 2), secrets);
  writeFileSync(join(opts.out, "report.json"), json + "\n", { mode: 0o600 });
  writeFileSync(join(opts.out, "report.md"), scrub(renderMarkdown(JSON.parse(json)), secrets), { mode: 0o600 });
  console.log(`\nreport: ${join(opts.out, "report.md")} · ${report.counts.PASS} pass, ${report.counts.FAIL} fail, ${report.counts.SKIP} skip, ${report.counts.INFO} info`);
  killAll();
  process.exitCode = report.counts.FAIL ? 1 : 0;
}

main().catch((e) => {
  console.error(scrub(e?.stack ?? String(e), secrets));
  killAll();
  process.exit(1);
});
