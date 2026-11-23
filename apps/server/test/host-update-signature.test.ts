/**
 * `prism update` checks SHA256SUMS.minisig against the release key shipped in the running
 * bundle (share/minisign.pub). The signatures here are made in the test with node:crypto from a
 * THROWAWAY key pair, in exactly minisign's format (prehashed "ED": Ed25519 over
 * BLAKE2b-512(file); global signature over signature ‖ trusted comment). Never the real key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyIdHex, parsePublicKey, verifyMinisign } from "../../../packaging/host/cli/minisign";
import { checkSignedSums, realUpdateDeps, releaseKeyPath, type Ctx } from "../../../packaging/host/cli/commands";
import { realRunner } from "../../../packaging/host/cli/launchd";
import { layoutFor } from "../../../packaging/host/cli/paths";
import { emptyState } from "../../../packaging/host/cli/state";
import { parseArgs } from "../../../packaging/host/cli/args";

interface TestKey {
  priv: KeyObject;
  keyId: Buffer;
  pubFile: string;
}

function makeKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const blob = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, raw]);
  return { priv: privateKey, keyId, pubFile: `untrusted comment: minisign public key ${keyIdHex(keyId)}\n${blob.toString("base64")}\n` };
}

function minisign(key: TestKey, message: Buffer, trusted: string, opts: { alg?: "ED" | "Ed"; keyId?: Buffer } = {}): string {
  const alg = opts.alg ?? "ED";
  const signed = alg === "ED" ? createHash("blake2b512").update(message).digest() : message;
  const sig = sign(null, signed, key.priv);
  const blob = Buffer.concat([Buffer.from(alg, "latin1"), opts.keyId ?? key.keyId, sig]);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted, "utf8")]), key.priv);
  return `untrusted comment: signature from minisign secret key\n${blob.toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

const SUMS = Buffer.from(`${"a".repeat(64)}  prism-host-0.2.0-darwin-arm64.tar.gz\n`);

test("minisign: a prehashed (ED) signature verifies and yields the trusted comment", () => {
  const k = makeKey();
  const v = verifyMinisign(SUMS, minisign(k, SUMS, "prism-host 0.2.0 abc123"), parsePublicKey(k.pubFile));
  assert.deepEqual(v, { ok: true, trustedComment: "prism-host 0.2.0 abc123", keyId: keyIdHex(k.keyId) });
});

test("minisign: refusals — changed file, other key, edited trusted comment, legacy Ed, garbage", () => {
  const k = makeKey();
  const pub = parsePublicKey(k.pubFile);
  const sig = minisign(k, SUMS, "prism-host 0.2.0 abc123");
  const changed = Buffer.from(SUMS.toString().replace("aaaa", "bbbb"));
  assert.match(String((verifyMinisign(changed, sig, pub) as { reason: string }).reason), /does not match the file/);

  const other = makeKey();
  assert.match(String((verifyMinisign(SUMS, minisign(other, SUMS, "x"), pub) as { reason: string }).reason), /not by the trusted key/);
  // Another key that claims OUR key id: the signature itself fails.
  assert.match(String((verifyMinisign(SUMS, minisign(other, SUMS, "x", { keyId: k.keyId }), pub) as { reason: string }).reason), /does not match the file/);

  const lines = sig.split("\n");
  lines[2] = "trusted comment: prism-host 9.9.9 evil";
  assert.match(String((verifyMinisign(SUMS, lines.join("\n"), pub) as { reason: string }).reason), /trusted comment's signature/);

  assert.match(String((verifyMinisign(SUMS, minisign(k, SUMS, "x", { alg: "Ed" }), pub) as { reason: string }).reason), /legacy/);
  for (const bad of ["", "garbage", sig.split("\n").slice(0, 2).join("\n"), sig.replace(/^untrusted/, "trusted"), sig + "extra line\n"]) {
    assert.equal(verifyMinisign(SUMS, bad, pub).ok, false, JSON.stringify(bad.slice(0, 40)));
  }
  assert.throws(() => parsePublicKey("untrusted comment: x\nnot-base64!\n"));
  assert.throws(() => parsePublicKey("RWQ=\n"));
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "prism-sig-test-"));
  const sumsPath = join(root, "SHA256SUMS");
  writeFileSync(sumsPath, SUMS);
  return { root, sumsPath, sigPath: `${sumsPath}.minisig`, keyPath: join(root, "bundle/share/minisign.pub") };
}
const NAME = "prism-host-0.2.0-darwin-arm64.tar.gz";

test("checkSignedSums: a signed SHA256SUMS gives the expected hash and who signed it", () => {
  const s = scratch();
  try {
    const k = makeKey();
    mkdirSync(join(s.root, "bundle/share"), { recursive: true });
    writeFileSync(s.keyPath, k.pubFile);
    writeFileSync(s.sigPath, minisign(k, SUMS, "prism-host 0.2.0 abc"));
    const r = checkSignedSums({ ...s, allowUnsigned: false, name: NAME });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.expected, "a".repeat(64));
      assert.equal(r.warning, undefined);
      assert.match(String(r.signedBy), /prism-host 0\.2\.0 abc/);
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("checkSignedSums fails closed: no key, no signature, bad signature, bare --sha256", () => {
  const s = scratch();
  try {
    // No key shipped in the bundle (today, until the owner commits it).
    let r = checkSignedSums({ ...s, allowUnsigned: false, name: NAME });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /ships no release key/);
    // ... with --allow-unsigned: accepted, with a warning.
    r = checkSignedSums({ ...s, allowUnsigned: true, name: NAME });
    assert.equal(r.ok, true);
    assert.match(String((r as { warning?: string }).warning), /development builds only/);

    const k = makeKey();
    mkdirSync(join(s.root, "bundle/share"), { recursive: true });
    writeFileSync(s.keyPath, k.pubFile);
    // Key, but SHA256SUMS unsigned.
    r = checkSignedSums({ ...s, allowUnsigned: false, name: NAME });
    assert.match((r as { reason: string }).reason, /is not signed/);
    assert.equal(checkSignedSums({ ...s, allowUnsigned: true, name: NAME }).ok, true);
    // A bad signature is refused even with --allow-unsigned.
    writeFileSync(s.sigPath, minisign(makeKey(), SUMS, "evil"));
    for (const allowUnsigned of [false, true]) {
      r = checkSignedSums({ ...s, allowUnsigned, name: NAME });
      assert.equal(r.ok, false);
      assert.match((r as { reason: string }).reason, /does not verify/);
    }
    // A SHA256SUMS changed after signing.
    writeFileSync(s.sigPath, minisign(k, SUMS, "ok"));
    writeFileSync(s.sumsPath, `${"b".repeat(64)}  ${NAME}\n`);
    assert.match((checkSignedSums({ ...s, allowUnsigned: false, name: NAME }) as { reason: string }).reason, /does not verify/);
    // --sha256 is not a signature.
    r = checkSignedSums({ ...s, sha256Flag: "c".repeat(64), allowUnsigned: false, name: NAME });
    assert.match((r as { reason: string }).reason, /not a signature/);
    r = checkSignedSums({ ...s, sha256Flag: "c".repeat(64), allowUnsigned: true, name: NAME });
    assert.equal(r.ok, true);
    assert.match(String((r as { warning?: string }).warning), /development builds only/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("prism update's verify step uses the key of the RUNNING bundle and refuses with exit 5 semantics", async () => {
  const s = scratch();
  try {
    const tarball = join(s.root, NAME);
    writeFileSync(tarball, "pretend tarball");
    const sum = createHash("sha256").update("pretend tarball").digest("hex");
    const sums = Buffer.from(`${sum}  ${NAME}\n`);
    writeFileSync(s.sumsPath, sums);
    const bundleRoot = join(s.root, "bundle");
    const k = makeKey();
    mkdirSync(join(bundleRoot, "share"), { recursive: true });
    writeFileSync(releaseKeyPath(bundleRoot), k.pubFile);
    const ctx = { bundleRoot, runner: realRunner, log: () => {} } as unknown as Ctx;
    const deps = (argv: string[]) => realUpdateDeps(ctx, layoutFor(join(s.root, "Host")), emptyState("2026-10-20T00:00:00Z", false, "none"), parseArgs(["update", tarball, ...argv], { bool: ["allow-unsigned"], value: ["sums", "sig"] }));

    let v = await deps([]).verify(tarball);
    assert.equal(v.ok, false);
    assert.match(String(v.reason), /is not signed/);

    writeFileSync(s.sigPath, minisign(k, sums, "prism-host 0.2.0 abc"));
    v = await deps([]).verify(tarball);
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.sha256, sum);
    assert.equal(v.warning, undefined);

    // A signature by another key, passed with --sig: refused.
    const elsewhere = join(s.root, "other.minisig");
    writeFileSync(elsewhere, minisign(makeKey(), sums, "evil"));
    v = await deps(["--sig", elsewhere, "--allow-unsigned"]).verify(tarball);
    assert.equal(v.ok, false);
    assert.match(String(v.reason), /does not verify/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
