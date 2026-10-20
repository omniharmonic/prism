#!/usr/bin/env node
// Seed the reviewer demo server: sample pages (fictional) + the App Review account.
// Run AS THE DEMO macOS USER, on the machine the demo runs on (see README.md):
//
//   node scripts/demo-server/seed.mjs --prefix "$DEMO_PREFIX" [--dry-run] [--wipe]
//
//   --dry-run  check the demo server is up and print what would be written; writes nothing
//   --wipe       delete EVERY note in the demo vault first
//   --wipe-only  delete every note and stop (reset.sh's first step; no account, no password)
//
// Reads the demo install's own config/.env (PORT, DB_PATH, the Parachute settings) — and
// refuses production ports — and DEMO_REVIEWER_EMAIL / DEMO_REVIEWER_NAME from the
// environment (demo.env). A NEW reviewer account gets a generated password that is printed
// ONCE to this terminal (for App Store Connect → App Review Information → Sign-in required);
// it is stored nowhere and never logged. The seed therefore refuses to run when its output is
// not a terminal, before anything is created.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { demoEnvProblem, hostKeyFile, seedDemo } from "./seed-lib.mjs";

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

async function main(argv) {
  const prefix = argv[argv.indexOf("--prefix") + 1];
  if (!argv.includes("--prefix") || !prefix) {
    process.stderr.write("usage: seed.mjs --prefix <demo install prefix> [--dry-run] [--wipe | --wipe-only]\n");
    return 2;
  }
  const dryRun = argv.includes("--dry-run");
  const wipeOnly = argv.includes("--wipe-only");
  const wipe = wipeOnly || argv.includes("--wipe");
  const configDir = join(prefix, "config");
  let env;
  try {
    env = parseEnvFile(readFileSync(join(configDir, ".env"), "utf8"));
  } catch {
    process.stderr.write(`seed: no ${join(configDir, ".env")} (is this the demo install's prefix?)\n`);
    return 3;
  }
  const problem = demoEnvProblem(env);
  if (problem) {
    process.stderr.write(`seed: REFUSED: ${problem}\n`);
    return 4;
  }
  const reviewer = { email: process.env.DEMO_REVIEWER_EMAIL || "app-review@example.com", name: process.env.DEMO_REVIEWER_NAME || "App Review" };
  if (!dryRun && !wipeOnly && !process.stdout.isTTY) {
    process.stderr.write("seed: REFUSED: run this in a terminal — a new reviewer password is printed once and must not land in a log\n");
    return 4;
  }
  const keyFile = hostKeyFile(env, configDir);
  let hostKey = "";
  if (!dryRun) {
    if (!keyFile) {
      process.stderr.write("seed: the demo server keeps no host key (DB_PATH)\n");
      return 4;
    }
    try {
      const st = statSync(keyFile);
      if (st.mode & 0o077) throw new Error(`${keyFile} is readable by others; restart the demo server`);
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${keyFile} belongs to another user — run the seed as the demo user`);
      hostKey = readFileSync(keyFile, "utf8").trim();
    } catch (e) {
      process.stderr.write(`seed: ${e.code === "ENOENT" ? `no host key at ${keyFile} — is the demo server running?` : e.message}\n`);
      return 4;
    }
  }
  const base = `http://127.0.0.1:${env.PORT}`;
  const r = await seedDemo({ fetch, base, hostKey, reviewer, wipe, wipeOnly, dryRun, log: (s) => process.stderr.write(`${s}\n`) });
  if (r.dryRun) return 0;
  if (wipeOnly) {
    process.stderr.write(`seed: ${r.wiped} note(s) deleted.\n`);
    return 0;
  }
  process.stderr.write(`seed: done (${r.written} pages${wipe ? `, ${r.wiped} deleted first` : ""}).\n`);
  if (r.password) {
    process.stderr.write("\nApp Review sign-in — copy it into App Store Connect now; it is not stored anywhere:\n");
    process.stdout.write(`  email:    ${reviewer.email}\n  password: ${r.password}\n\n`);
  } else {
    process.stderr.write(`The reviewer account ${reviewer.email} already exists; its password was NOT changed (reset.sh makes a new one).\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`seed: ${e.message}\n`);
    process.exit(1);
  },
);
