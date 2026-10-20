#!/usr/bin/env node
/**
 * One version for Prism (launch plan §5 decision 9): the root package.json is the source;
 * every workspace package, the Rust crates, the Tauri configs and package-lock.json follow it.
 * Tester builds are 0.9.x, the public release 1.0.0. The iOS build number
 * (tauri.ios.conf.json bundle.iOS.bundleVersion) is separate: it only has to grow per upload.
 *
 *   node scripts/version.mjs check        # exit 1 when anything disagrees (part of `npm run check`)
 *   node scripts/version.mjs set 0.9.0    # write the version everywhere
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const PACKAGES = [
  "apps/client/package.json",
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/core/package.json",
  "packages/push-relay/package.json",
];
const TAURI = ["apps/client/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/tauri.conf.json"];
const CRATES = [
  { toml: "apps/client/src-tauri/Cargo.toml", lock: "apps/client/src-tauri/Cargo.lock" },
  { toml: "apps/client/src-tauri/plugins/prism-ios/Cargo.toml", lock: "apps/client/src-tauri/Cargo.lock" },
  { toml: "apps/desktop/src-tauri/Cargo.toml", lock: "apps/desktop/src-tauri/Cargo.lock" },
];

const read = (rel) => readFileSync(join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const crateName = (toml) => /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(toml)?.[1];
const crateVersion = (toml) => /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(toml)?.[1];

/** Every place a version lives: [label, current value, write(next)]. */
function places() {
  const out = [];
  for (const rel of PACKAGES) {
    out.push([rel, json(rel).version, (v) => {
      const j = json(rel);
      j.version = v;
      writeFileSync(join(root, rel), `${JSON.stringify(j, null, 2)}\n`);
    }]);
  }
  for (const rel of TAURI) {
    out.push([rel, json(rel).version, (v) => {
      writeFileSync(join(root, rel), read(rel).replace(/("version"\s*:\s*)"[^"]*"/, `$1"${v}"`));
    }]);
  }
  for (const { toml, lock } of CRATES) {
    const text = read(toml);
    const name = crateName(text);
    out.push([toml, crateVersion(text), (v) => {
      writeFileSync(join(root, toml), read(toml).replace(/^(\[package\][^[]*?^version\s*=\s*)"[^"]*"/ms, `$1"${v}"`));
    }]);
    const entry = new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = )"([^"]*)"`);
    out.push([`${lock} (${name})`, entry.exec(read(lock))?.[2], (v) => {
      writeFileSync(join(root, lock), read(lock).replace(entry, `$1"${v}"`));
    }]);
  }
  out.push(["package-lock.json", null, (v) => {
    const lock = json("package-lock.json");
    lock.version = v;
    if (lock.packages?.[""]) lock.packages[""].version = v;
    for (const rel of PACKAGES) {
      const key = dirname(rel);
      if (lock.packages?.[key]) lock.packages[key].version = v;
    }
    writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  }]);
  return out;
}

function lockVersions() {
  const lock = json("package-lock.json");
  const out = [["package-lock.json (root)", lock.packages?.[""]?.version ?? lock.version]];
  for (const rel of PACKAGES) out.push([`package-lock.json (${dirname(rel)})`, lock.packages?.[dirname(rel)]?.version]);
  return out;
}

const [cmd, arg] = process.argv.slice(2);
const want = json("package.json").version;

if (cmd === "set") {
  if (!arg || !SEMVER.test(arg)) {
    console.error("usage: node scripts/version.mjs set <x.y.z>");
    process.exit(2);
  }
  const rootPkg = json("package.json");
  rootPkg.version = arg;
  writeFileSync(join(root, "package.json"), `${JSON.stringify(rootPkg, null, 2)}\n`);
  for (const [, , write] of places()) write(arg);
  console.log(`version ${arg} written everywhere (iOS build number unchanged)`);
} else if (cmd === "check" || cmd === undefined) {
  const wrong = [...places().filter(([label]) => label !== "package-lock.json"), ...lockVersions()]
    .filter(([, v]) => v !== want)
    .map(([label, v]) => `  ${label}: ${v ?? "(missing)"}`);
  if (wrong.length) {
    console.error(`version ${want} (root package.json) disagrees with:\n${wrong.join("\n")}\nfix: node scripts/version.mjs set ${want}`);
    process.exit(1);
  }
  console.log(`✓ version ${want} everywhere`);
} else {
  console.error("usage: node scripts/version.mjs check | set <x.y.z>");
  process.exit(2);
}
