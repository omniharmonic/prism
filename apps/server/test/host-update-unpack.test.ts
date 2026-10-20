/**
 * `prism update`'s unpack step (launch security review), against real archives made with
 * /usr/bin/tar in a scratch folder:
 *  - it unpacks a private COPY whose hash must be the one `verify` accepted (the file at the
 *    given path can be rewritten after the check);
 *  - it refuses a bundle holding a symlink that is absolute or leaves the bundle, or a
 *    special file (macOS tar creates such symlink entries as they are);
 *  - relative links inside the bundle (workspace links in node_modules) are fine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realUpdateDeps, unsafeBundleEntries, type Ctx } from "../../../packaging/host/cli/commands";
import { realRunner } from "../../../packaging/host/cli/launchd";
import { layoutFor } from "../../../packaging/host/cli/paths";
import { emptyState } from "../../../packaging/host/cli/state";
import { parseArgs } from "../../../packaging/host/cli/args";

const scratch = () => mkdtempSync(join(tmpdir(), "prism-unpack-test-"));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function bundleTree(root: string, extra?: (dir: string) => void): string {
  const src = join(root, "src");
  const dir = join(src, "prism-host-0.2.0");
  mkdirSync(join(dir, "packages/core"), { recursive: true });
  mkdirSync(join(dir, "node_modules/@prism"), { recursive: true });
  writeFileSync(join(dir, "build-info.json"), JSON.stringify({ name: "prism-host", version: "0.2.0", platform: "darwin", arch: "arm64", commit: "abc" }));
  symlinkSync("../../packages/core", join(dir, "node_modules/@prism/core"));
  extra?.(dir);
  const tgz = join(root, "prism-host-0.2.0.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", tgz, "-C", src, "prism-host-0.2.0"]);
  return tgz;
}

function deps(root: string, sha256?: string) {
  const prefix = join(root, "Host");
  const ctx = { bundleRoot: join(root, "running-bundle"), runner: realRunner, log: () => {} } as unknown as Ctx;
  const layout = layoutFor(prefix);
  const args = parseArgs(["update", "x", ...(sha256 ? ["--sha256", sha256, "--allow-unsigned"] : [])], { bool: ["allow-unsigned"], value: ["sha256"] });
  return { d: realUpdateDeps(ctx, layout, emptyState("2026-10-20T00:00:00Z", false, "none"), args), layout };
}

test("a good bundle (relative links inside it) unpacks from the verified copy; the copy is removed", async () => {
  const root = scratch();
  try {
    const tgz = bundleTree(root);
    const { d, layout } = deps(root, sha(tgz));
    assert.equal((await d.verify(tgz)).ok, true);
    const staged = await d.unpack(tgz);
    assert.equal(staged.info.version, "0.2.0");
    assert.ok(existsSync(join(staged.dir, "node_modules/@prism/core")));
    const incoming = readdirSync(layout.appRoot).filter((n) => n.startsWith(".incoming-"));
    assert.equal(incoming.length, 1);
    assert.deepEqual(readdirSync(join(layout.appRoot, incoming[0]!)), ["prism-host-0.2.0"], "the private archive copy is gone");
    d.discard(staged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, plant] of [
  ["an absolute symlink", (dir: string) => symlinkSync("/etc", join(dir, "evil"))],
  ["a symlink that climbs out of the bundle", (dir: string) => symlinkSync("../../../../..", join(dir, "packages/up"))],
  ["a FIFO", (dir: string) => execFileSync("/usr/bin/mkfifo", [join(dir, "pipe")])],
] as const) {
  test(`a bundle holding ${label} is refused and nothing is left behind`, async () => {
    const root = scratch();
    try {
      const tgz = bundleTree(root, plant);
      const { d, layout } = deps(root, sha(tgz));
      assert.equal((await d.verify(tgz)).ok, true);
      await assert.rejects(d.unpack(tgz), /leave the bundle/);
      assert.deepEqual(readdirSync(layout.appRoot).filter((n) => n.startsWith(".incoming-")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("an archive rewritten after it was verified is refused; an unverified one is never unpacked", async () => {
  const root = scratch();
  try {
    const tgz = bundleTree(root);
    const { d } = deps(root, sha(tgz));
    assert.equal((await d.verify(tgz)).ok, true);
    writeFileSync(tgz, Buffer.concat([readFileSync(tgz), Buffer.from("tampered")]));
    await assert.rejects(d.unpack(tgz), /changed after it was verified/);
    const fresh = deps(root).d;
    await assert.rejects(fresh.unpack(tgz), /not verified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafeBundleEntries: names what escapes, never follows a link", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "a/b"), { recursive: true });
    symlinkSync("../b", join(root, "a/b/self"));
    symlinkSync("..", join(root, "a/b/up-but-inside"));
    symlinkSync("../../..", join(root, "a/b/out"));
    symlinkSync("/tmp", join(root, "abs"));
    assert.deepEqual(unsafeBundleEntries(root).sort(), ["a/b/out", "abs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
