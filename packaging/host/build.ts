/**
 * Build the Prism host bundle: prism-host-<version>-darwin-arm64.tar.gz + SHA256SUMS
 * (docs/host-bundle.md). Run from the repository root on an Apple-silicon Mac:
 *
 *   npm run build:host                        # = node --import tsx packaging/host/build.ts
 *   npm run build:host -- --skip-web-build    # reuse apps/web/dist + dist-native as they are
 *   npm run build:host -- --allow-dirty       # build from uncommitted files (marked -dirty)
 *   npm run build:host -- --out <dir> --cache <dir>
 *
 * Network is used at BUILD time only: the Node runtime (nodejs.org, checked against its
 * SHASUMS256.txt — whose OpenPGP signature is verified against the pinned Node release keys in
 * packaging/host/node-release-keys/ — and the sha256 pinned in packaging/host/node.json, then
 * cached) and the
 * npm registry for `npm ci` (lockfile integrity). Nothing in the bundle downloads anything
 * at install or run time.
 *
 * The server runs from TypeScript through tsx on the bundled Node — the way production runs
 * it today — rather than from a prebuilt JavaScript bundle: the conversion worker threads
 * register tsx themselves (src/transfer/worker-boot.mjs) and import `.ts` files, and the
 * server imports @prism/core's TypeScript (incl. the editor schema). A prebuilt bundle would
 * be a second, untested way of running the server. tsx's transform cache lives in the OS
 * temp folder; no network.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild, type Plugin } from "esbuild";
import { packageName, prunable, reachable, type Lock } from "./build/prune";
import { collectPackages, renderLicenses } from "./build/licenses";
import { findGpg, signatureRequired, verifyNodeSums } from "./build/node-signature";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};

const t0 = Date.now();
const log = (s: string) => console.log(`[build:host +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? repo, env: opts.env ?? process.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: opts.quiet ? "pipe" : ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})${r.stderr ? `: ${r.stderr.slice(-2000)}` : ""}`);
  return r.stdout;
}
async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest("hex");
}
function du(path: string): number {
  let n = 0;
  const walk = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else n += st.size;
  };
  walk(path);
  return n;
}
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("build the host bundle on an Apple-silicon Mac (darwin-arm64): the native modules are installed for the build machine");

// ── 1. version + source ──────────────────────────────────────────────────────
const rootPkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
const version = rootPkg.version;
const name = `prism-host-${version}-darwin-arm64`;
const dirty = run("git", ["status", "--porcelain", "--", "package.json", "package-lock.json", "packages", "apps/server", "apps/web", "packaging/host", "LICENSE.md", "NOTICE.md"], { quiet: true }).trim();
if (dirty && !flag("allow-dirty")) throw new Error(`uncommitted changes (use --allow-dirty to build them anyway):\n${dirty}`);
const commit = run("git", ["rev-parse", "HEAD"], { quiet: true }).trim() + (dirty ? "-dirty" : "");
const out = resolve(opt("out") ?? join(here, "out"));
const cache = resolve(opt("cache") ?? join(homedir(), "Library", "Caches", "prism-host-build"));
const work = join(out, "work");
const stage = join(work, name);
const app = join(stage, "app");
log(`${name} from ${commit.slice(0, 12)} → ${out}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

// ── 2. Node runtime (download once, verify twice) ────────────────────────────
const nodeSpec = JSON.parse(readFileSync(join(here, "node.json"), "utf8")) as { version: string; file: string; sha256: string; baseUrl: string };
mkdirSync(cache, { recursive: true });
const nodeTar = join(cache, nodeSpec.file);
const sumsUrl = `${nodeSpec.baseUrl}/v${nodeSpec.version}/SHASUMS256.txt`;
const sumsFile = join(cache, `SHASUMS256-v${nodeSpec.version}.txt`);
if (!existsSync(sumsFile)) {
  const r = await fetch(sumsUrl);
  if (!r.ok) throw new Error(`${sumsUrl}: HTTP ${r.status}`);
  writeFileSync(sumsFile, await r.text());
}
// The sums file's signature, by a pinned Node.js releaser key (build/node-signature.ts).
// Fetched every build (never trusted from the cache alone, it is 119 bytes); no gpg → CI fails
// closed, a laptop warns and relies on the two hash checks below.
{
  const sigUrl = `${sumsUrl}.sig`;
  const sigFile = join(cache, `SHASUMS256-v${nodeSpec.version}.txt.sig`);
  const r = await fetch(sigUrl);
  if (!r.ok) throw new Error(`${sigUrl}: HTTP ${r.status}`);
  writeFileSync(sigFile, Buffer.from(await r.arrayBuffer()));
  const gpg = findGpg();
  if (!gpg) {
    if (signatureRequired()) throw new Error("gpg is not installed: the Node.js SHASUMS256.txt signature cannot be verified (required in CI; install gnupg)");
    log("WARNING: gpg is not installed — nodejs.org's SHASUMS256.txt signature was NOT verified (the pinned SHA-256 still is). Install gnupg to check it.");
  } else {
    const verdict = verifyNodeSums({ gpg, sumsFile, sigFile, keysDir: join(here, "node-release-keys") });
    if (!verdict.ok) {
      rmSync(sumsFile, { force: true }); // never reuse a sums file that failed its signature
      throw new Error(`nodejs.org's SHASUMS256.txt signature did not verify: ${verdict.reason}`);
    }
    log(`SHASUMS256.txt signed by Node.js release key ${verdict.fingerprint}`);
  }
}
const published = readFileSync(sumsFile, "utf8").split("\n").find((l) => l.endsWith(`  ${nodeSpec.file}`))?.split(/\s+/)[0];
if (!published) throw new Error(`${nodeSpec.file} is not listed in ${sumsUrl}`);
if (published !== nodeSpec.sha256) throw new Error(`nodejs.org lists ${published} for ${nodeSpec.file} but node.json pins ${nodeSpec.sha256}`);
if (!existsSync(nodeTar) || (await sha256(nodeTar)) !== nodeSpec.sha256) {
  log(`downloading ${nodeSpec.file}`);
  const r = await fetch(`${nodeSpec.baseUrl}/v${nodeSpec.version}/${nodeSpec.file}`);
  if (!r.ok) throw new Error(`node download: HTTP ${r.status}`);
  writeFileSync(`${nodeTar}.part`, Buffer.from(await r.arrayBuffer()));
  if ((await sha256(`${nodeTar}.part`)) !== nodeSpec.sha256) throw new Error("the downloaded Node runtime does not match its SHA-256");
  run("mv", [`${nodeTar}.part`, nodeTar]);
}
log(`node ${nodeSpec.version} verified (sha256 ${nodeSpec.sha256.slice(0, 16)}…)`);
const nodeFull = join(work, "node-full");
mkdirSync(nodeFull, { recursive: true });
run("/usr/bin/tar", ["-xzf", nodeTar, "-C", nodeFull, "--strip-components", "1"]);
const nodeBin = join(nodeFull, "bin", "node");
const npmCli = join(nodeFull, "lib", "node_modules", "npm", "bin", "npm-cli.js");

// ── 3. web builds ────────────────────────────────────────────────────────────
if (!flag("skip-web-build")) {
  log("building the web app (dist + dist-native)");
  run("npm", ["run", "build", "-w", "@prism/web"]);
  run("npm", ["run", "build:native", "-w", "@prism/web"]);
}
for (const d of ["dist", "dist-native"]) if (!existsSync(join(repo, "apps/web", d, "index.html"))) throw new Error(`apps/web/${d} is missing (build it, or drop --skip-web-build)`);

// ── 4. source tree (tracked files only) ──────────────────────────────────────
const tracked = run("git", ["ls-files", "-z", "--", "package.json", "package-lock.json", "packages/core", "apps/server", "apps/*/package.json", "packages/*/package.json"], { quiet: true })
  .split("\0")
  .filter(Boolean)
  .filter((f) => !f.startsWith("apps/server/test/") && !/(^|\/)\.env/.test(f) && !f.endsWith(".db") && !f.startsWith("packages/core/test"));
for (const f of tracked) {
  const dst = join(app, f);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(repo, f), dst);
}
log(`copied ${tracked.length} source files`);

// ── 5. production node_modules from the lockfile, on the bundled Node ───────
const npmEnv = { ...process.env, PATH: `${dirname(nodeBin)}:${process.env.PATH}`, npm_config_cache: join(cache, "npm"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
log("npm ci --omit=dev (server + core workspaces)");
run(nodeBin, [npmCli, "ci", "--omit=dev", "--workspace", "@prism/server", "--workspace", "@prism/core", "--include-workspace-root", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app, env: npmEnv });
const installedBytes = du(join(app, "node_modules"));

// ── 6. prune to what the server reaches ──────────────────────────────────────
const entries = ["apps/server/src/index.ts", "apps/server/src/transfer/worker-boot.mjs", "apps/server/src/transfer/worker.ts", "apps/server/scripts/prism-setup.ts", "apps/server/scripts/governance-sign-existing.ts"].map((e) => join(app, e));

/** Bare imports of first-party code, and the resolution problems esbuild reports for the whole graph. */
async function analyse(): Promise<{ roots: Array<{ from: string; name: string }>; unresolved: Set<string> }> {
  const roots = new Map<string, { from: string; name: string }>();
  const collect: Plugin = {
    name: "collect",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (a) => {
        if (a.path.startsWith("node:") || a.importer.includes("/node_modules/")) return undefined;
        const n = packageName(a.path);
        if (n.startsWith("@prism/")) return undefined;
        const rel = relative(app, a.importer);
        const from = rel.startsWith("packages/core/") ? "packages/core" : rel.startsWith("apps/server/") ? "apps/server" : "";
        roots.set(`${from}|${n}`, { from, name: n });
        return undefined;
      });
    },
  };
  const r = await esbuild({ entryPoints: entries, absWorkingDir: app, bundle: true, write: false, platform: "node", format: "esm", target: "node22", outdir: join(work, "esbuild-probe"), logLevel: "silent", external: ["*.node"], plugins: [collect] }).catch((e: { errors?: Array<{ text: string }> }) => ({ errors: e.errors ?? [] }));
  const unresolved = new Set((r.errors ?? []).map((m) => m.text));
  return { roots: [...roots.values()], unresolved };
}
const before = await analyse();
const lock = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8")) as Lock;
const roots = [...before.roots, { from: "apps/server", name: "tsx" }];
// The workspace links stay; core's own declared dependencies (browser UI) are kept only when the server's graph reaches them.
const keep = reachable(lock, roots, (p) => existsSync(join(app, p)), ["node_modules/@prism/core", "node_modules/@prism/server"]);
const drop = prunable(lock, keep).filter((p) => existsSync(join(app, p)));
for (const p of drop) rmSync(join(app, p), { recursive: true, force: true });
for (const bin of ["node_modules/.bin", "apps/server/node_modules/.bin", "packages/core/node_modules/.bin"]) rmSync(join(app, bin), { recursive: true, force: true });
// Workspaces other than server + core: only their package.json was needed by npm ci.
for (const ws of ["apps/web", "apps/desktop", "apps/client", "apps/collab-server"]) rmSync(join(app, ws), { recursive: true, force: true });
for (const l of readdirSync(join(app, "node_modules/@prism"))) if (!["core", "server"].includes(l)) rmSync(join(app, "node_modules/@prism", l), { force: true });
const after = await analyse();
const newProblems = [...after.unresolved].filter((m) => !before.unresolved.has(m));
if (newProblems.length) throw new Error(`pruning broke module resolution:\n${newProblems.slice(0, 20).join("\n")}`);
log(`node_modules ${mb(installedBytes)} → ${mb(du(join(app, "node_modules")))} (${keep.size} packages kept, ${drop.length} folders pruned; ${before.unresolved.size} pre-existing optional-import notes unchanged)`);

// native modules must be darwin-arm64
const natives = run("/usr/bin/find", [join(app, "node_modules"), "-name", "*.node", "-type", "f"], { quiet: true }).split("\n").filter(Boolean);
for (const n of natives) {
  const kind = run("/usr/bin/file", ["-b", n], { quiet: true });
  if (!/arm64/.test(kind)) throw new Error(`${relative(app, n)} is not arm64: ${kind.trim()}`);
}
const nativeExecs = run("/usr/bin/find", [join(app, "node_modules"), "-path", "*/@esbuild/darwin-arm64/bin/esbuild", "-type", "f"], { quiet: true }).split("\n").filter(Boolean);
for (const n of nativeExecs) if (!/arm64/.test(run("/usr/bin/file", ["-b", n], { quiet: true }))) throw new Error(`${relative(app, n)} is not arm64`);
if (nativeExecs.length === 0) throw new Error("no esbuild binary for tsx in the bundle");
log(`native code: ${[...natives, ...nativeExecs].map((n) => relative(app, n)).join(", ")}`);

// web builds
for (const d of ["dist", "dist-native"]) cpSync(join(repo, "apps/web", d), join(app, "apps/web", d), { recursive: true });

// ── 7. runtime, CLI, launchd templates, payload slot, licences ───────────────
const runtime = join(stage, "runtime", "node");
mkdirSync(join(runtime, "bin"), { recursive: true });
copyFileSync(nodeBin, join(runtime, "bin", "node"));
chmodSync(join(runtime, "bin", "node"), 0o755);
for (const f of ["LICENSE", "README.md"]) copyFileSync(join(nodeFull, f), join(runtime, f));

mkdirSync(join(stage, "libexec"), { recursive: true });
await esbuild({ entryPoints: [join(here, "cli/main.ts")], outfile: join(stage, "libexec/prism.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning", legalComments: "none", banner: { js: `// prism ${version} (${commit.slice(0, 12)}) — built from packaging/host/cli. Run through bin/prism.` } });
mkdirSync(join(stage, "bin"), { recursive: true });
copyFileSync(join(here, "bin/prism"), join(stage, "bin/prism"));
chmodSync(join(stage, "bin/prism"), 0o755);
cpSync(join(here, "launchd"), join(stage, "share/launchd"), { recursive: true });
cpSync(join(here, "parachute"), join(stage, "parachute"), { recursive: true });
// The release public key `prism update` verifies SHA256SUMS.minisig against (cli/commands.ts
// releaseKeyPath). Absent until the owner commits it: such a build refuses unsigned updates
// unless `--allow-unsigned` (development builds).
const releaseKey = join(here, "release/minisign.pub");
if (existsSync(releaseKey)) copyFileSync(releaseKey, join(stage, "share/minisign.pub"));
else log("WARNING: packaging/host/release/minisign.pub is missing: this bundle cannot verify signed updates (prism update needs --allow-unsigned)");
for (const f of ["LICENSE.md", "NOTICE.md"]) copyFileSync(join(repo, f), join(stage, f));
const pkgs = collectPackages(join(app, "node_modules"));
writeFileSync(join(stage, "THIRD-PARTY-LICENSES.md"), renderLicenses(pkgs, { version: nodeSpec.version, licenseText: readFileSync(join(nodeFull, "LICENSE"), "utf8") }, name));
const unknown = pkgs.filter((p) => p.license === "UNKNOWN").map((p) => `${p.name}@${p.version}`);
if (unknown.length) log(`WARNING: no declared licence: ${unknown.join(", ")}`);

const info = {
  name: "prism-host",
  version,
  platform: "darwin",
  arch: "arm64",
  commit,
  builtAt: new Date().toISOString(),
  node: { version: nodeSpec.version, sha256: nodeSpec.sha256 },
  parachute: { bundled: false, version: null },
  paths: {
    node: "runtime/node/bin/node",
    cli: "libexec/prism.mjs",
    server: "app/apps/server/src/index.ts",
    tsxLoader: "app/node_modules/tsx/dist/loader.mjs",
    web: "app/apps/web/dist",
    webNative: "app/apps/web/dist-native",
    launchd: "share/launchd",
  },
};
for (const [k, p] of Object.entries(info.paths)) if (!existsSync(join(stage, p))) throw new Error(`build-info path ${k} → ${p} does not exist`);
writeFileSync(join(stage, "build-info.json"), JSON.stringify(info, null, 2) + "\n");

// The bundled CLI and Node work (and load better-sqlite3 from the bundle).
const v = run(join(stage, "bin/prism"), ["version", "--json"], { quiet: true });
if (JSON.parse(v).version !== version) throw new Error(`bin/prism version said ${v}`);
run(join(runtime, "bin/node"), ["-e", "require(process.argv[1]); console.log('better-sqlite3 ok')", join(app, "node_modules/better-sqlite3")], { quiet: true });

// ── 8. tarball + SHA256SUMS ──────────────────────────────────────────────────
const tarball = join(out, `${name}.tar.gz`);
rmSync(tarball, { force: true });
run("/usr/bin/tar", ["--no-mac-metadata", "--no-xattrs", "--uid", "0", "--gid", "0", "--uname", "", "--gname", "", "-czf", tarball, "-C", work, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const sum = await sha256(tarball);
const sumsPath = join(out, "SHA256SUMS");
const others = existsSync(sumsPath) ? readFileSync(sumsPath, "utf8").split("\n").filter((l) => l.trim() && !l.endsWith(`  ${basename(tarball)}`)) : [];
writeFileSync(sumsPath, [...others, `${sum}  ${basename(tarball)}`, ""].join("\n"));
const unpacked = du(stage);
if (!flag("keep-work")) rmSync(work, { recursive: true, force: true });
log(`${basename(tarball)}: ${mb(statSync(tarball).size)} compressed, ${mb(unpacked)} unpacked; sha256 ${sum}`);
console.log(JSON.stringify({ tarball, sha256: sum, version, commit, bytes: statSync(tarball).size }));
