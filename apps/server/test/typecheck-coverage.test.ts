/**
 * The server's type check must cover its tests and scripts. A test file with type
 * errors once reached main because nothing type-checked it; `node --import tsx`
 * strips types without checking them, so the suite alone never notices.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repo = resolve(root, "../..");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

test("the server type check is the whole project: src, test and scripts, with no narrower -p", () => {
  const scripts = json(join(root, "package.json")).scripts as Record<string, string>;
  assert.equal(scripts.typecheck, "tsc --noEmit", "the default project (tsconfig.json), nothing narrower");
  const include = json(join(root, "tsconfig.json")).include as string[];
  for (const dir of ["src", "test", "scripts"]) assert.ok(include.includes(dir), `tsconfig.json includes ${dir}`);
  assert.equal(json(join(root, "tsconfig.json")).exclude, undefined, "nothing is excluded");
});

test("every test file is among the files the type check reads", { timeout: 300_000 }, () => {
  const tsc = join(repo, "node_modules", ".bin", "tsc");
  const listed = new Set(execFileSync(tsc, ["--noEmit", "--listFilesOnly"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").map((l) => l.trim()));
  const tests = readdirSync(here).filter((f) => f.endsWith(".ts"));
  assert.ok(tests.length > 100, "the test directory was read");
  const missing = tests.filter((f) => !listed.has(join(here, f)));
  assert.deepEqual(missing, [], "test files the type check does not cover");
});

test("the root check runs every workspace's type check, the e2e specs' type check and the static guards", () => {
  const scripts = json(join(repo, "package.json")).scripts as Record<string, string>;
  assert.match(scripts.typecheck ?? "", /-w @prism\/server/);
  const check = scripts.check ?? "";
  for (const part of ["npm run typecheck", "npm run typecheck:e2e", "check:dialogs", "check:sw", "check:initial"]) assert.ok(check.includes(part), `npm run check runs ${part}`);
  const web = json(join(repo, "apps/web/package.json")).scripts as Record<string, string>;
  for (const s of ["typecheck:e2e", "check:sw", "check:initial"]) assert.ok(web[s], `@prism/web has ${s}`);
});
