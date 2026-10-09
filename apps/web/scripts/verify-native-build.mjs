#!/usr/bin/env node
/**
 * verify:native — guards the native-shell build (WP2.2).
 *
 *   node scripts/verify-native-build.mjs            build native, then assert
 *   node scripts/verify-native-build.mjs --no-build assert against an existing dist-native/
 *
 * Asserts:
 *  1. the native build has NO service worker, workbox, manifest or SW registration;
 *  2. the transport helper is the only server-fetch path: `credentials: "include"`
 *     appears only in its PWA branch, the native branch sets "omit" + Bearer, and
 *     no other source file calls bare fetch() for the server (allowlist below);
 *  3. the host hook contract (window.__PRISM_HOST__: getToken, onUnauthorized,
 *     apiOrigin) is present in source and in the built bundle;
 *  4. no EventSource (can't send Authorization) anywhere in apps/web or @prism/core.
 * Dependency-free (node:fs + child_process).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const coreSrc = resolve(webRoot, "../../packages/core/src");
const webSrc = resolve(webRoot, "src");
const dist = resolve(webRoot, "dist-native");

let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => {
  console.error(`✗ ${m}`);
  failed++;
};
const check = (cond, pass, fail) => (cond ? ok(pass) : bad(fail));

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules") continue;
    const p = join(dir, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const srcFiles = (dir) => walk(dir).filter((f) => /\.(ts|tsx)$/.test(f));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

if (!process.argv.includes("--no-build")) {
  console.log("building native mode…");
  execSync("npm run build:native", { cwd: webRoot, stdio: "inherit" });
}

// 1. no service worker in the output
check(existsSync(dist), "dist-native/ exists", "dist-native/ missing — build failed?");
if (existsSync(dist)) {
  const files = walk(dist).map((f) => relative(dist, f));
  const swFiles = files.filter((f) => /(^|\/)(sw|workbox-[^/]*|registerSW)\.js$|\.webmanifest$/.test(f));
  check(swFiles.length === 0, "no sw.js / workbox / manifest in native output", `service-worker artifacts present: ${swFiles.join(", ")}`);
  const js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dist, f), "utf8"));
  check(!js.some((t) => /serviceWorker\s*\.\s*register\s*\(/.test(t)), "no serviceWorker.register() in bundle", "bundle registers a service worker");
  check(js.some((t) => t.includes("__PRISM_HOST__")), "host hook (__PRISM_HOST__) is in the bundle", "host hook missing from bundle");
  check(js.some((t) => /credentials:\s*"omit"/.test(t)), 'native transport sends credentials:"omit"', 'bundle lacks credentials:"omit"');
  const html = readFileSync(join(dist, "index.html"), "utf8");
  check(!/manifest|registerSW/.test(html), "index.html has no manifest/SW hooks", "index.html references manifest/SW");
}

// 2. one request path
const transport = readFileSync(join(webSrc, "transport.ts"), "utf8");
const tCode = strip(transport);
const includeCount = (tCode.match(/credentials:\s*init\.credentials\s*\?\?\s*"include"|credentials:\s*"include"/g) ?? []).length;
check(includeCount === 1, 'transport.ts has exactly one credentials:"include" (the PWA branch)', `transport.ts has ${includeCount} credentials:"include" (expected 1, PWA branch only)`);
check(/credentials:\s*"omit"/.test(tCode) && /Bearer \$\{token\}/.test(tCode), "native branch = omit + Bearer token", "native branch must set credentials:omit and Authorization: Bearer");
check(/isOurServer\(/.test(tCode), "bearer only attached to our own origin", "missing own-origin guard for the bearer token");
// A 401 is CONFIRMED before the session ends (native/sessionGuard.ts states the rule;
// `npm run verify:session` pins it): the transport hands the refused token to the guard,
// only the guard reaches onUnauthorized, and nothing in the transport's 401 path signs in.
check(/resp\.status === 401 && sent\) void guard\.unauthorized\(sent\)/.test(tCode), "a 401 goes to the session guard with the token that was refused", "401 is not routed to the session guard");
check((tCode.match(/onUnauthorized\?\.\(\)/g) ?? []).length === 2 && /forget: async \(\) => \{ await getHost\(\)\?\.onUnauthorized\?\.\(\); \}/.test(tCode), "onUnauthorized is reached only through the guard's forget (and the no-signIn fallback)", "onUnauthorized is called outside the session guard");
check((tCode.match(/\.signIn\(\)/g) ?? []).length === 1 && /export function startNativeSignIn/.test(tCode), "signIn is called from startNativeSignIn only (a person's press)", "signIn is called outside startNativeSignIn");
check(/if \(guard\.over\(\)\) return signedOutResponse\(\)/.test(tCode) && /else if \(guard\.missing\(\)\)/.test(tCode), "no request leaves without a bearer once the session is over", "the signed-out request block is missing");
const guardSrc = strip(readFileSync(join(webSrc, "native/sessionGuard.ts"), "utf8"));
check(!/signIn|sign_in|fetch\(/.test(guardSrc), "the session guard cannot start a sign-in (and makes no request itself)", "native/sessionGuard.ts mentions sign-in or fetch");

// Files allowed to call bare fetch(): the helpers themselves, the legacy public ShareView
// (talks to a vault URL directly, not the gateway) and the cross-origin federation pairing call.
const BARE_FETCH_OK = new Set(["transport.ts", "share/ShareView.tsx", "collab/grant.ts"]);
for (const f of srcFiles(webSrc)) {
  const rel = relative(webSrc, f);
  const n = (strip(readFileSync(f, "utf8")).match(/(^|[^\w.])fetch\(/g) ?? []).length;
  if (n && !BARE_FETCH_OK.has(rel)) bad(`${rel}: bare fetch() — route it through serverFetch (src/transport.ts)`);
}
const grantBare = (strip(readFileSync(join(webSrc, "collab/grant.ts"), "utf8")).match(/(^|[^\w.])fetch\(/g) ?? []).length;
check(grantBare === 1, "grant.ts: only the cross-origin peer-pairing fetch is bare", `grant.ts has ${grantBare} bare fetch() (expected 1: federation pairing)`);
for (const f of srcFiles(coreSrc)) {
  const rel = relative(coreSrc, f);
  if (rel.startsWith("lib/transport/")) continue;
  if (/(^|[^\w.])fetch\(/.test(strip(readFileSync(f, "utf8")))) bad(`@prism/core ${rel}: bare fetch() — use serverFetch (lib/transport/serverFetch.ts)`);
}
ok("no stray fetch() in apps/web + @prism/core server paths (see allowlist)");

// 2b. no browser dialogs: the app's web view (wry, macOS + iOS) shows none of window.prompt /
// confirm / alert — the action behind one silently does nothing (check-no-browser-dialogs.mjs).
{
  const run = spawnSync(process.execPath, [join(here, "check-no-browser-dialogs.mjs")], { encoding: "utf8" });
  if (run.status === 0) ok(run.stdout.trim());
  else bad(`browser dialogs in shipped UI:\n${(run.stderr || run.stdout).trim()}`);
}
// 2c. every clipboard write goes through lib/clipboard.ts `copyText` (inside the gesture, honest result).
{
  const run = spawnSync(process.execPath, [join(here, "check-clipboard.mjs")], { encoding: "utf8" });
  if (run.status === 0) ok(run.stdout.trim());
  else bad(`clipboard writes outside the helper:\n${(run.stderr || run.stdout).trim()}`);
}

// 3. host contract in source
for (const k of ["__PRISM_HOST__", "getToken", "onUnauthorized", "apiOrigin", "signIn"]) {
  check(transport.includes(k), `host contract mentions ${k}`, `host contract missing ${k}`);
}

// 4. no EventSource
for (const f of [...srcFiles(webSrc), ...srcFiles(coreSrc)]) {
  if (/new\s+EventSource\s*\(/.test(strip(readFileSync(f, "utf8")))) bad(`${relative(webRoot, f)}: EventSource can't send Authorization — use streamSSE`);
}
ok("no EventSource usage");

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nverify:native — all checks passed");
