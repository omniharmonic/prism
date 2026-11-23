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
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPO_ROOT, hostFacts, keyFileCheck, productionHostReason, buildNumberProblem, uploadStatePath, readUploadState,
  recordUpload, ascJwt, findApp, remoteMaxBuild, assignToGroup,
} from "../../../scripts/apple/asc.mjs";

// The primitives live in scripts/apple/asc.mjs (one tool for every Apple app); this file keeps
// the Prism Client CLI that ios-release.sh calls, and re-exports them for its tests.
export * from "../../../scripts/apple/asc.mjs";

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
