#!/usr/bin/env node
/**
 * asc — the checks and App Store Connect calls behind `ios-release.sh --upload`.
 * Dependency-free (node:crypto, node:fs, fetch). Every network function takes a
 * `fetch` so the tests run without the internet; the pure functions are what the
 * tests pin.
 *
 *   node apps/client/scripts/asc.mjs host-check
 *       refuse on the production host (exit 3) — see productionHostReason()
 *   node apps/client/scripts/asc.mjs key-check
 *       the App Store Connect API key file: present, a regular file, 0600 (or 0400), not in the repository
 *   node apps/client/scripts/asc.mjs build-check --build N [--remote | --dry-run]
 *       the iOS build number must be HIGHER than the last uploaded one: the local
 *       record (~/.prism-release/ios-uploads.json) and, with --remote, App Store Connect's own list
 *   node apps/client/scripts/asc.mjs record --build N --version V
 *       write the local record after a successful upload (0600, in a 0700 folder)
 *   node apps/client/scripts/asc.mjs assign --build N --version V --group NAME [--external]
 *       wait for the build to finish processing, then add it to that TestFlight group.
 *       Internal by default: the group must be an INTERNAL group unless --external.
 *
 * Env (never defaulted for an upload; the .p8 is read only to sign a short-lived token):
 *   ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_API_KEY_PATH
 *   PRISM_IOS_UPLOAD_STATE   where the local upload record lives (default ~/.prism-release/ios-uploads.json)
 *   PRISM_NO_RELEASE_HOSTS   extra host names to refuse (comma list)
 *   PRISM_RELEASE_ALLOW_MAC_MINI=1   a Mac mini that is NOT the production host may build (the marker file still refuses)
 *
 * Why the local record AND the API: the local record works offline and survives
 * worktrees (it lives in the home folder, never in the repository); App Store
 * Connect is the truth when a build was uploaded from somewhere else. Apple also
 * refuses a reused build number at upload time, so a stale record can only cost
 * a refused upload, never a wrong build in TestFlight.
 */
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ASC_API = "https://api.appstoreconnect.apple.com";
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

// ── production-host refusal ─────────────────────────────────────────────────

/** Files whose presence marks the production host. The owner creates one on the Mini (`touch ~/.prism-production-host`). */
export function productionMarkers(home = homedir()) {
  return [join(home, ".prism-production-host"), "/etc/prism-production-host"];
}

/**
 * Why this machine must not build, sign or upload — or null.
 *  - a production marker file exists (no override);
 *  - the hardware is a Mac mini (the production server is one) unless PRISM_RELEASE_ALLOW_MAC_MINI=1;
 *  - a host name is listed in PRISM_NO_RELEASE_HOSTS.
 */
export function productionHostReason({ modelName = "", hostnames = [], markers = [], env = {} } = {}) {
  const marker = markers.find(Boolean);
  if (marker) return `${marker} exists: this is the production host (builds, signing and uploads run on the laptop, never here)`;
  if (/\bmac\s*mini\b/i.test(modelName) && env.PRISM_RELEASE_ALLOW_MAC_MINI !== "1") {
    return `this Mac is a ${modelName.trim()} — the production server runs on a Mac mini, so release builds are refused here (a Mac mini that is not the production host: PRISM_RELEASE_ALLOW_MAC_MINI=1)`;
  }
  const refused = (env.PRISM_NO_RELEASE_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const hit = hostnames.map((h) => String(h).trim().toLowerCase()).find((h) => h && refused.includes(h));
  if (hit) return `host name ${hit} is in PRISM_NO_RELEASE_HOSTS`;
  return null;
}

function hostFacts(env) {
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
    } catch {
      return "";
    }
  };
  const modelName = /Model Name:\s*(.+)/.exec(run("system_profiler", ["SPHardwareDataType"]))?.[1] ?? "";
  const hostnames = [hostname(), run("scutil", ["--get", "LocalHostName"]), run("scutil", ["--get", "ComputerName"]), run("hostname", ["-s"])];
  const markers = productionMarkers(env.HOME || homedir()).map((p) => (existsSync(p) ? p : null));
  return { modelName, hostnames, markers, env };
}

// ── the API key file ────────────────────────────────────────────────────────

/** Why the .p8 at `path` may not be used — or null. `st` = lstat result (injectable). */
export function keyFileProblem(path, { repoRoot = REPO_ROOT, st, real } = {}) {
  if (!path) return "ASC_API_KEY_PATH is not set";
  if (!isAbsolute(path)) return "ASC_API_KEY_PATH must be an absolute path";
  if (!/\.p8$/.test(path)) return "ASC_API_KEY_PATH must name the .p8 file App Store Connect gave you";
  if (!st) return `no API key at ${path}`;
  if (st.isSymbolicLink()) return `${path} is a symbolic link; point ASC_API_KEY_PATH at the file itself`;
  if (!st.isFile()) return `${path} is not a regular file`;
  const mode = st.mode & 0o777;
  if (mode & 0o077) return `${path} is readable by others (mode ${mode.toString(8).padStart(4, "0")}); run: chmod 600 "${path}"`;
  const inRepo = (p) => {
    const rel = relative(repoRoot, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (inRepo(path) || (real && inRepo(real))) return `${path} is inside the repository; keep the key outside it (e.g. ~/.appstoreconnect/private_keys/)`;
  return null;
}

function keyFileCheck(path) {
  let st;
  let real;
  try {
    st = lstatSync(path);
    real = realpathSync(path);
  } catch {
    st = undefined;
  }
  let repoReal = REPO_ROOT;
  try {
    repoReal = realpathSync(REPO_ROOT);
  } catch {
    /* keep */
  }
  return keyFileProblem(path, { repoRoot: repoReal, st, real });
}

// ── build numbers ───────────────────────────────────────────────────────────

/** CFBundleVersion: one to three dot-separated non-negative integers ("8", "1.2", "1.2.3"). */
export function parseBuild(s) {
  const v = String(s ?? "").trim();
  if (!/^\d{1,9}(\.\d{1,9}){0,2}$/.test(v)) return null;
  return v.split(".").map(Number);
}

/** -1 / 0 / 1, numerically per part, missing parts = 0. */
export function compareBuild(a, b) {
  const pa = parseBuild(a);
  const pb = parseBuild(b);
  if (!pa || !pb) throw new Error(`not a build number: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The highest of a list of build numbers (unparseable entries ignored), or null. */
export function maxBuild(list) {
  let best = null;
  for (const b of list) if (parseBuild(b) && (best === null || compareBuild(b, best) > 0)) best = String(b).trim();
  return best;
}

/** Why `candidate` may not be uploaded — or null. `recorded` = the local record, `remote` = App Store Connect's highest. */
export function buildNumberProblem({ candidate, recorded = null, remote = null }) {
  if (!parseBuild(candidate)) return `bundle.iOS.bundleVersion "${candidate}" is not a build number (1, 2, 3… in apps/client/src-tauri/tauri.ios.conf.json)`;
  for (const [what, last] of [["the last upload recorded on this Mac", recorded], ["the highest build App Store Connect has", remote]]) {
    if (last && parseBuild(last) && compareBuild(candidate, last) <= 0) {
      return `build ${candidate} is not higher than ${what} (${last}); raise bundle.iOS.bundleVersion in apps/client/src-tauri/tauri.ios.conf.json`;
    }
  }
  return null;
}

export function uploadStatePath(env = process.env) {
  return env.PRISM_IOS_UPLOAD_STATE || join(env.HOME || homedir(), ".prism-release", "ios-uploads.json");
}

export function readUploadState(file) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Record one upload. Never lowers the recorded number. Atomic, 0600 in a 0700 folder. */
export function recordUpload(file, { bundleId, build, version, at = new Date().toISOString() }) {
  if (!parseBuild(build)) throw new Error(`not a build number: ${build}`);
  const state = readUploadState(file);
  const prev = state[bundleId]?.lastUploadedBuild;
  if (prev && parseBuild(prev) && compareBuild(build, prev) <= 0) return state;
  state[bundleId] = { lastUploadedBuild: String(build), version: String(version), at };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return state;
}

// ── App Store Connect API ───────────────────────────────────────────────────

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * An ES256 JWT for the App Store Connect API (header kid + typ, claims iss/iat/exp/aud;
 * lifetime ≤ 20 minutes, Apple's maximum). The key never leaves this process.
 */
export function ascJwt({ keyId, issuerId, privateKeyPem, nowSec = Math.floor(Date.now() / 1000), ttlSec = 1200 }) {
  if (!/^[A-Z0-9]{8,12}$/.test(keyId ?? "")) throw new Error("ASC_API_KEY_ID does not look like an App Store Connect key id");
  if (!/^[0-9a-f-]{36}$/i.test(issuerId ?? "")) throw new Error("ASC_API_ISSUER_ID does not look like an issuer id (a UUID)");
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: issuerId, iat: nowSec, exp: nowSec + Math.min(ttlSec, 1200), aud: "appstoreconnect-v1" }));
  const input = `${header}.${claims}`;
  const sig = sign("sha256", Buffer.from(input), { key: createPrivateKey(privateKeyPem), dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

async function api(fetchFn, token, path, init = {}) {
  const r = await fetchFn(`${ASC_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    redirect: "error",
  });
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!r.ok) {
    const detail = body?.errors?.[0]?.detail ?? body?.errors?.[0]?.title ?? `HTTP ${r.status}`;
    throw new Error(`App Store Connect ${init.method ?? "GET"} ${path.split("?")[0]}: ${detail}`);
  }
  return body;
}

export async function findApp(fetchFn, token, bundleId) {
  const j = await api(fetchFn, token, `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId,name&limit=2`);
  const app = (j?.data ?? []).find((a) => a?.attributes?.bundleId === bundleId);
  if (!app) throw new Error(`App Store Connect has no app with bundle id ${bundleId}`);
  return app.id;
}

/** The highest build number App Store Connect lists for the app (its latest 200 uploads), or null. */
export async function remoteMaxBuild(fetchFn, token, appId) {
  const j = await api(fetchFn, token, `/v1/builds?filter[app]=${encodeURIComponent(appId)}&sort=-uploadedDate&limit=200&fields[builds]=version,uploadedDate`);
  return maxBuild((j?.data ?? []).map((b) => b?.attributes?.version));
}

export async function findBuild(fetchFn, token, appId, build, version) {
  const q = `/v1/builds?filter[app]=${encodeURIComponent(appId)}&filter[version]=${encodeURIComponent(build)}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&fields[builds]=version,processingState&limit=5`;
  const j = await api(fetchFn, token, q);
  return (j?.data ?? []).find((b) => b?.attributes?.version === String(build)) ?? null;
}

/** Why `group` cannot take the build in this mode — or null. */
export function groupProblem(group, { external }) {
  if (!group) return "no such TestFlight group";
  const internal = group.attributes?.isInternalGroup === true;
  if (!external && !internal) return `TestFlight group "${group.attributes?.name}" is an EXTERNAL group; the default is internal testers only (external needs --external, after the recorded device pass)`;
  if (external && internal) return `TestFlight group "${group.attributes?.name}" is an internal group; --external needs an external group`;
  return null;
}

export async function assignToGroup(fetchFn, token, { appId, build, version, groupName, external, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitMs = 45 * 60_000, pollMs = 30_000, log = () => {} }) {
  const g = await api(fetchFn, token, `/v1/betaGroups?filter[app]=${encodeURIComponent(appId)}&filter[name]=${encodeURIComponent(groupName)}&fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds&limit=10`);
  const group = (g?.data ?? []).find((x) => x?.attributes?.name === groupName);
  const problem = groupProblem(group, { external });
  if (problem) throw new Error(problem);
  const deadline = Date.now() + waitMs;
  let b = null;
  for (;;) {
    b = await findBuild(fetchFn, token, appId, build, version);
    const state = b?.attributes?.processingState;
    if (state === "VALID") break;
    if (state === "FAILED" || state === "INVALID") throw new Error(`build ${build} finished processing as ${state}; see App Store Connect → TestFlight`);
    if (Date.now() >= deadline) throw new Error(`build ${build} is still ${state ?? "not listed"} after ${Math.round(waitMs / 60_000)} min; add it to "${groupName}" in App Store Connect when it is ready`);
    log(`  build ${build}: ${state ?? "not listed yet"} — checking again in ${Math.round(pollMs / 1000)} s`);
    await sleep(pollMs);
  }
  if (group.attributes?.isInternalGroup && group.attributes?.hasAccessToAllBuilds) {
    return { group: groupName, added: false, reason: "this internal group already gets every build" };
  }
  await api(fetchFn, token, `/v1/betaGroups/${encodeURIComponent(group.id)}/relationships/builds`, { method: "POST", body: JSON.stringify({ data: [{ type: "builds", id: b.id }] }) });
  return { group: groupName, added: true };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function bundleId() {
  return JSON.parse(readFileSync(join(REPO_ROOT, "apps/client/src-tauri/tauri.conf.json"), "utf8")).identifier;
}

function tokenFromEnv(env) {
  const path = env.ASC_API_KEY_PATH;
  const problem = keyFileCheck(path);
  if (problem) throw new Error(problem);
  return ascJwt({ keyId: env.ASC_API_KEY_ID, issuerId: env.ASC_API_ISSUER_ID, privateKeyPem: readFileSync(path, "utf8") });
}

async function main(argv, env) {
  const cmd = argv[0];
  const out = (s) => process.stdout.write(`${s}\n`);
  if (cmd === "host-check") {
    const why = productionHostReason(hostFacts(env));
    if (why) {
      process.stderr.write(`REFUSED: ${why}\n`);
      return 3;
    }
    out("✓ not the production host");
    return 0;
  }
  if (cmd === "key-check") {
    for (const k of ["ASC_API_KEY_ID", "ASC_API_ISSUER_ID", "ASC_API_KEY_PATH"]) {
      if (!env[k]) {
        process.stderr.write(`REFUSED: ${k} is not set\n`);
        return 3;
      }
    }
    const problem = keyFileCheck(env.ASC_API_KEY_PATH);
    if (problem) {
      process.stderr.write(`REFUSED: ${problem}\n`);
      return 3;
    }
    out(`✓ API key ${env.ASC_API_KEY_ID}: ${env.ASC_API_KEY_PATH} (0600, outside the repository)`);
    return 0;
  }
  if (cmd === "build-check") {
    const build = arg(argv, "--build");
    const id = bundleId();
    const file = uploadStatePath(env);
    const recorded = readUploadState(file)[id]?.lastUploadedBuild ?? null;
    let remote = null;
    if (argv.includes("--remote")) {
      const token = tokenFromEnv(env);
      remote = await remoteMaxBuild(fetch, token, await findApp(fetch, token, id));
    }
    const problem = buildNumberProblem({ candidate: build, recorded, remote });
    if (problem) {
      process.stderr.write(`REFUSED: ${problem}\n`);
      return 3;
    }
    out(`✓ build ${build} > last recorded upload ${recorded ?? "(none on this Mac)"}${argv.includes("--remote") ? `, > App Store Connect's highest ${remote ?? "(none)"}` : " (App Store Connect not asked)"}`);
    return 0;
  }
  if (cmd === "record") {
    const state = recordUpload(uploadStatePath(env), { bundleId: bundleId(), build: arg(argv, "--build"), version: arg(argv, "--version") });
    out(`✓ recorded upload: build ${state[bundleId()].lastUploadedBuild} (${uploadStatePath(env)})`);
    return 0;
  }
  if (cmd === "assign") {
    const token = tokenFromEnv(env);
    const appId = await findApp(fetch, token, bundleId());
    const r = await assignToGroup(fetch, token, {
      appId,
      build: arg(argv, "--build"),
      version: arg(argv, "--version"),
      groupName: arg(argv, "--group"),
      external: argv.includes("--external"),
      log: out,
    });
    out(r.added ? `✓ build added to TestFlight group "${r.group}"` : `✓ "${r.group}": ${r.reason}`);
    return 0;
  }
  process.stderr.write("usage: asc.mjs host-check | key-check | build-check --build N [--remote] | record --build N --version V | assign --build N --version V --group NAME [--external]\n");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`asc: ${e.message}\n`);
      process.exit(1);
    },
  );
}
