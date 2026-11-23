/**
 * minisign signature verification with `node:crypto` only (docs/host-bundle.md § Update and
 * rollback, "Signed updates"). Format (https://jedisct1.github.io/minisign/):
 *
 *   public key file:   untrusted comment: …
 *                      base64( "Ed" ‖ key id (8) ‖ Ed25519 public key (32) )
 *
 *   signature file:    untrusted comment: …
 *                      base64( alg (2) ‖ key id (8) ‖ signature (64) )
 *                      trusted comment: …
 *                      base64( global signature (64) )
 *
 * `alg` "ED" (what `minisign -S` writes by default since 0.10): the signature is over
 * BLAKE2b-512(file). The legacy "Ed" (signature over the raw file) is REFUSED — our release job
 * never makes one, and accepting it would only widen what verifies. The global signature is
 * over `signature ‖ trusted comment` and binds the trusted comment (version + commit) to the file.
 * The untrusted comment is never trusted for anything.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

export interface MinisignPublicKey {
  keyId: Buffer;
  key: KeyObject;
}

export type MinisignVerdict = { ok: true; trustedComment: string; keyId: string } | { ok: false; reason: string };

const UNTRUSTED = "untrusted comment: ";
const TRUSTED = "trusted comment: ";

function lines(text: string): string[] {
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  while (all.length && all[all.length - 1]!.trim() === "") all.pop();
  return all;
}

function strictBase64(s: string, bytes: number): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  if (b.length !== bytes || b.toString("base64") !== s) return null;
  return b;
}

/** Parse a minisign public key file (or its bare base64 line). Throws on anything else. */
export function parsePublicKey(text: string): MinisignPublicKey {
  const ls = lines(text.trim());
  const line = ls.length === 1 ? ls[0]! : ls.length === 2 && ls[0]!.startsWith(UNTRUSTED) ? ls[1]! : null;
  if (!line) throw new Error("not a minisign public key (expected an untrusted comment and one key line)");
  const raw = strictBase64(line.trim(), 42);
  if (!raw) throw new Error("not a minisign public key (the key line is not 42 bytes of base64)");
  if (raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("not an Ed25519 minisign public key");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10, 42).toString("base64url") }, format: "jwk" });
  return { keyId: Buffer.from(raw.subarray(2, 10)), key };
}

/** Key ids are shown as minisign shows them: the 8 bytes little-endian, upper-case hex. */
export function keyIdHex(id: Buffer): string {
  return Buffer.from(id).reverse().toString("hex").toUpperCase();
}

/** Verify `message` against a minisign signature file's text, with `pub`. Never throws. */
export function verifyMinisign(message: Buffer, signatureText: string, pub: MinisignPublicKey): MinisignVerdict {
  const ls = lines(signatureText);
  if (ls.length < 4) return { ok: false, reason: "the signature file is incomplete (expected 4 lines)" };
  if (!ls[0]!.startsWith(UNTRUSTED)) return { ok: false, reason: "the signature file does not start with an untrusted comment" };
  if (!ls[2]!.startsWith(TRUSTED)) return { ok: false, reason: "the signature file has no trusted comment" };
  if (ls.length > 4) return { ok: false, reason: "the signature file has extra lines" };
  const sigBlob = strictBase64(ls[1]!.trim(), 74);
  if (!sigBlob) return { ok: false, reason: "the signature line is not 74 bytes of base64" };
  const alg = sigBlob.subarray(0, 2).toString("latin1");
  const keyId = sigBlob.subarray(2, 10);
  const sig = sigBlob.subarray(10, 74);
  if (alg === "Ed") return { ok: false, reason: "a legacy (non-prehashed) minisign signature: only prehashed (ED) signatures are accepted" };
  if (alg !== "ED") return { ok: false, reason: `unknown signature algorithm ${JSON.stringify(alg)}` };
  if (!keyId.equals(pub.keyId)) return { ok: false, reason: `signed by key ${keyIdHex(keyId)}, not by the trusted key ${keyIdHex(pub.keyId)}` };
  const digest = createHash("blake2b512").update(message).digest();
  if (!verify(null, digest, pub.key, sig)) return { ok: false, reason: "the signature does not match the file" };
  const trustedComment = ls[2]!.slice(TRUSTED.length);
  const globalSig = strictBase64(ls[3]!.trim(), 64);
  if (!globalSig) return { ok: false, reason: "the global signature line is not 64 bytes of base64" };
  if (!verify(null, Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]), pub.key, globalSig)) return { ok: false, reason: "the trusted comment's signature does not match" };
  return { ok: true, trustedComment, keyId: keyIdHex(keyId) };
}
