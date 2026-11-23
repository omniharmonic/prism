/**
 * The host build's check of nodejs.org's SHASUMS256.txt signature
 * (packaging/host/build/node-signature.ts) against the vendored, pinned release keys.
 * The real-signature cases use the published v22.23.3 sums + signature (fixtures) and run only
 * where gpg is installed; the status-line judge is pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findGpg, judgeGpgStatus, readKeySource, signatureRequired, verifyNodeSums } from "../../../packaging/host/build/node-signature";

const keysDir = resolve(import.meta.dirname, "../../../packaging/host/node-release-keys");
const fixtures = resolve(import.meta.dirname, "fixtures/node-sums");
const node = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../packaging/host/node.json"), "utf8")) as { file: string; sha256: string };
const gpg = findGpg();
const PIN = "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356";

test("node signature: the judge accepts only a good signature from a pinned primary key", () => {
  const good = `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG 20B1A390B168D356 Someone\n[GNUPG:] VALIDSIG ABCDEF0123456789ABCDEF0123456789ABCDEF01 2026-09-23 1790183910 0 4 0 22 8 00 ${PIN}\n`;
  assert.deepEqual(judgeGpgStatus(good, [PIN]), { ok: true, fingerprint: PIN });
  // signed by a subkey: the LAST field (primary) is what is pinned
  assert.equal(judgeGpgStatus(good, ["ABCDEF0123456789ABCDEF0123456789ABCDEF01"]).ok, false);
  assert.equal(judgeGpgStatus(good.replace("GOODSIG", "BADSIG"), [PIN]).ok, false);
  assert.equal(judgeGpgStatus(`${good}[GNUPG:] REVKEYSIG x\n`, [PIN]).ok, false);
  assert.equal(judgeGpgStatus(`${good}[GNUPG:] EXPKEYSIG x\n`, [PIN]).ok, false);
  assert.equal(judgeGpgStatus("[GNUPG:] ERRSIG 20B1A390B168D356 22 8 00 1790183910 9\n[GNUPG:] NO_PUBKEY 20B1A390B168D356\n", [PIN]).ok, false);
  assert.equal(judgeGpgStatus("", [PIN]).ok, false);
  assert.equal(judgeGpgStatus(`${good}${good.split("\n")[2]}\n`, [PIN]).ok, false, "two VALIDSIGs are refused");
  // a status line inside other text is not a status line
  assert.equal(judgeGpgStatus(`note: [GNUPG:] GOODSIG x\nnote: [GNUPG:] VALIDSIG a b c d e f g h i ${PIN}\n`, [PIN]).ok, false);
});

test("node signature: the pins are 40 hex characters, one key file per pin", () => {
  const src = readKeySource(keysDir);
  assert.ok(src.fingerprints.length >= 1);
  assert.match(src.commit, /^[0-9a-f]{40}$/);
  for (const f of src.fingerprints) assert.ok(readFileSync(join(keysDir, `${f}.asc`), "utf8").includes("BEGIN PGP PUBLIC KEY BLOCK"), f);
});

test("node signature: CI requires it, a laptop only warns", () => {
  assert.equal(signatureRequired({ CI: "true" }), true);
  assert.equal(signatureRequired({ PRISM_REQUIRE_NODE_SIGNATURE: "1" }), true);
  assert.equal(signatureRequired({}), false);
});

test("node signature: the published v22 sums verify, and they list the pinned runtime hash", { skip: gpg ? false : "gpg is not installed" }, () => {
  const v = verifyNodeSums({ gpg: gpg!, sumsFile: join(fixtures, "SHASUMS256.txt"), sigFile: join(fixtures, "SHASUMS256.txt.sig"), keysDir });
  assert.deepEqual(v, { ok: true, fingerprint: PIN });
  assert.ok(readFileSync(join(fixtures, "SHASUMS256.txt"), "utf8").includes(`${node.sha256}  ${node.file}`));
});

test("node signature: a tampered sums file and a stray key are refused", { skip: gpg ? false : "gpg is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-sig-test-"));
  try {
    const sums = join(dir, "SHASUMS256.txt");
    writeFileSync(sums, readFileSync(join(fixtures, "SHASUMS256.txt"), "utf8").replace(node.sha256, "0".repeat(64)));
    const tampered = verifyNodeSums({ gpg: gpg!, sumsFile: sums, sigFile: join(fixtures, "SHASUMS256.txt.sig"), keysDir });
    assert.equal(tampered.ok, false);

    // A keys folder whose SOURCE.json does not pin one of its key files: refused before verifying.
    const keys2 = join(dir, "keys");
    const src = readKeySource(keysDir);
    mkdirSync(keys2);
    for (const f of src.fingerprints) copyFileSync(join(keysDir, `${f}.asc`), join(keys2, `${f}.asc`));
    writeFileSync(join(keys2, "SOURCE.json"), JSON.stringify({ ...src, fingerprints: src.fingerprints.filter((f) => f !== PIN) }));
    const stray = verifyNodeSums({ gpg: gpg!, sumsFile: join(fixtures, "SHASUMS256.txt"), sigFile: join(fixtures, "SHASUMS256.txt.sig"), keysDir: keys2 });
    assert.equal(stray.ok, false);
    assert.match((stray as { reason: string }).reason, /not pinned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
