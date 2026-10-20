#!/usr/bin/env node
/**
 * THIRD-PARTY-LICENSES.md for the Prism Client (apps/client/THIRD-PARTY-LICENSES.md).
 *
 *   npm run build:native -w @prism/web          # writes apps/web/dist-native.modules.json
 *   node apps/client/scripts/licenses/generate.mjs [--out <file>] [--check]
 *
 * Rust: `cargo metadata --locked --filter-platform <target>` for macOS (aarch64-apple-darwin) and
 * iOS (aarch64-apple-ios); the crates reached through normal dependency edges from prism-client,
 * with the licence files from each crate's source directory (~/.cargo/registry).
 * npm: the packages whose files the native web build bundled (apps/web/scripts/bundled-modules.ts).
 *
 * FAILS (exit 1) when a component has no recognised licence or only a copyleft one
 * (policy.json: `allowed`, `listed` (MPL-2.0 / EPL-2.0: allowed but named in the file), `denied`).
 * --check: also fail when the file on disk differs from what would be written (nothing is written).
 * tauri.conf.json runs this after the native web build, so every app bundle carries a fresh list.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPolicy, familyOf, mergePlatforms, npmPackages, render, rustCrates } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const tauriDir = resolve(root, "apps/client/src-tauri");
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const out = resolve(arg("out", join(root, "apps/client/THIRD-PARTY-LICENSES.md")));
const modulesFile = resolve(arg("modules", join(root, "apps/web/dist-native.modules.json")));
const check = process.argv.includes("--check");
const policy = JSON.parse(readFileSync(join(here, "policy.json"), "utf8"));

const fail = (m) => {
  console.error(`licenses: ${m}`);
  process.exit(1);
};

// ── Rust ──
const TARGETS = [
  ["aarch64-apple-darwin", "macOS"],
  ["aarch64-apple-ios", "iOS"],
];
const lists = TARGETS.map(([target, platform]) => {
  let json;
  try {
    json = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", target], { cwd: tauriDir, maxBuffer: 256 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    fail(`cargo metadata (${target}) failed: ${String(e.stderr ?? e.message).trim()}`);
  }
  return rustCrates(JSON.parse(json), platform);
});
const crates = mergePlatforms(lists);

// ── npm ──
if (!existsSync(modulesFile)) fail(`${relative(root, modulesFile)} is missing — run \`npm run build:native -w @prism/web\` first`);
const built = join(root, "apps/web/dist-native/index.html");
if (existsSync(built) && statSync(modulesFile).mtimeMs + 5000 < statSync(built).mtimeMs) {
  fail(`${relative(root, modulesFile)} is older than apps/web/dist-native — rebuild the native web build`);
}
const { modules } = JSON.parse(readFileSync(modulesFile, "utf8"));
if (!Array.isArray(modules) || modules.length === 0) fail(`${relative(root, modulesFile)} lists no modules`);
const npm = npmPackages(modules, root);

// ── Policy ──
const { components, findings } = applyPolicy([...crates, ...npm], policy);
for (const f of findings) {
  const who = f.component ? `${f.component.kind} ${f.component.name}@${f.component.version} (${f.component.expression ?? "no licence"})` : "";
  if (f.level === "error") console.error(`✗ ${who}: ${f.why}`);
  else if (f.level === "listed") console.log(`• listed (file-level copyleft): ${who} — ${f.why}`);
  else console.warn(`! ${f.why}`);
}
const errors = findings.filter((f) => f.level === "error");
if (errors.length) fail(`${errors.length} component(s) without an acceptable licence — fix the dependency or add a reviewed entry to apps/client/scripts/licenses/policy.json`);

const lockHash = (f) => createHash("sha256").update(readFileSync(join(root, f))).digest("hex").slice(0, 16);
const md = render(components, {
  title: "Prism Client",
  generator: "apps/client/scripts/licenses/generate.mjs",
  policy,
}).replace(
  /\n/,
  `\n\n<!-- inputs: apps/client/src-tauri/Cargo.lock ${lockHash("apps/client/src-tauri/Cargo.lock")}, package-lock.json ${lockHash("package-lock.json")} -->\n`,
);

const families = new Map();
for (const c of components) for (const f of new Set(c.chosen.map(familyOf))) families.set(f, (families.get(f) ?? 0) + 1);
const summary = `${crates.length} crates, ${npm.length} npm packages; licences: ${[...families].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(", ")}`;

if (check) {
  const have = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (have !== md) fail(`${relative(root, out)} is out of date — run node apps/client/scripts/licenses/generate.mjs`);
  console.log(`licenses: ${relative(root, out)} is up to date (${summary})`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.log(`licenses: wrote ${relative(root, out)} (${summary}; ${Math.round(md.length / 1024)} KB)`);
}
