/**
 * The host bundle's release tooling (packaging/host/release/, .github/workflows/release.yml):
 * which files get signed, the runtime's entitlements, and that the workflow's pieces exist.
 * Nothing here signs anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findMachO, isMachO, kindOf } from "../../../packaging/host/release/macho";

const repo = resolve(import.meta.dirname, "../../..");
const hdr = (...bytes: number[]) => Buffer.from([...bytes, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8));

test("release: Mach-O files are recognised by magic number, Java class files are not", () => {
  assert.equal(isMachO(hdr(0xcf, 0xfa, 0xed, 0xfe)), true); // 64-bit thin
  assert.equal(isMachO(hdr(0xce, 0xfa, 0xed, 0xfe)), true); // 32-bit thin
  assert.equal(isMachO(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])), true); // universal, 2 archs
  assert.equal(isMachO(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52])), false); // Java class, version 52
  assert.equal(isMachO(Buffer.from("#!/bin/sh\n")), false);
  assert.equal(isMachO(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])), false); // ELF
  assert.equal(kindOf("runtime/node/bin/node"), "node");
  assert.equal(kindOf("app/node_modules/x/build/Release/x.node"), "library");
  assert.equal(kindOf("app/node_modules/esbuild/bin/esbuild"), "exec");
});

test("release: every Mach-O in a bundle tree is found, signed inside out (the runtime last)", () => {
  const root = mkdtempSync(join(tmpdir(), "prism-macho-"));
  try {
    const put = (rel: string, head: Buffer) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), Buffer.concat([head, Buffer.alloc(64)]));
    };
    put("runtime/node/bin/node", hdr(0xcf, 0xfa, 0xed, 0xfe));
    put("app/node_modules/better-sqlite3/build/Release/better_sqlite3.node", hdr(0xcf, 0xfa, 0xed, 0xfe));
    put("app/node_modules/tsx/node_modules/esbuild/bin/esbuild", hdr(0xcf, 0xfa, 0xed, 0xfe)); // an install-time copy, not named *.node
    put("app/node_modules/pkg/index.js", Buffer.from("module.exports = 1;\n"));
    symlinkSync("../runtime/node/bin/node", join(root, "app/node-link"));
    const found = findMachO(root);
    assert.deepEqual(found, [
      { path: "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node", kind: "library" },
      { path: "app/node_modules/tsx/node_modules/esbuild/bin/esbuild", kind: "exec" },
      { path: "runtime/node/bin/node", kind: "node" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release: the runtime's entitlements are exactly allow-jit (a valid plist)", () => {
  const plist = join(repo, "packaging/host/release/entitlements/node.plist");
  // Text check everywhere (CI runs this on Linux), plutil's reading as well on a Mac.
  const body = readFileSync(plist, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  assert.deepEqual([...body.matchAll(/<key>([^<]*)<\/key>\s*<(true|false)\/>/g)].map((m) => [m[1], m[2]]), [["com.apple.security.cs.allow-jit", "true"]]);
  assert.equal((body.match(/<key>/g) ?? []).length, 1);
  if (existsSync("/usr/bin/plutil")) {
    execFileSync("/usr/bin/plutil", ["-lint", plist]);
    const json = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" })) as Record<string, unknown>;
    assert.deepEqual(json, { "com.apple.security.cs.allow-jit": true });
  }
});

test("release: the workflow runs the scripts that exist, on the tag that names the version", () => {
  const wf = readFileSync(join(repo, ".github/workflows/release.yml"), "utf8");
  assert.match(wf, /tags: \["prism-host-v\*"\]/);
  for (const script of ["sign-bundle.sh", "notarize.sh", "sign-sums.sh"]) {
    assert.ok(wf.includes(`packaging/host/release/${script}`), script);
    readFileSync(join(repo, "packaging/host/release", script));
  }
  assert.ok(wf.includes("packaging/host/smoke.ts") && wf.includes("npm run build:host") && wf.includes("npm run check"));
  assert.ok(wf.includes("--draft"), "a release is only ever a draft");
  // No secret is ever echoed into a command line: each reaches its step through env.
  for (const line of wf.split("\n")) if (line.includes("secrets.") && !/^\s+[A-Z0-9_]+: \$\{\{ secrets\./.test(line) && !/^\s+HAS_[A-Z_]+: /.test(line)) assert.fail(`secret used outside an env mapping: ${line.trim()}`);
});
