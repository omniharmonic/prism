#!/usr/bin/env node
/**
 * updater-manifest — the Prism Client's update manifest (`latest.json`) and the check of the
 * updater archive's signature, for the release workflows (docs/client-app.md § Release (CI)).
 *
 *   node updater-manifest.mjs make  --version 0.9.1 --archive <file.app.tar.gz> --sig <file.sig>
 *                                   --pubkey <updater.key.pub> --url <https download url>
 *                                   [--notes-file <file>] [--pub-date <RFC 3339>] --out latest.json
 *   node updater-manifest.mjs check --manifest latest.json --version 0.9.1 --url-prefix <https …/download/<tag>/>
 *                                   --pubkey <updater.key.pub> --archive <file.app.tar.gz>
 *   node updater-manifest.mjs verify --pubkey <pub> --archive <file> --sig <file.sig> --version 0.9.1
 *   node updater-manifest.mjs newer --manifest latest.json [--current <channel latest.json>]
 *   node updater-manifest.mjs --self-test
 *
 * `make` and `check` refuse unless the archive's signature verifies against the COMMITTED public
 * key AND the signature's trusted comment binds the announced version (`version:<v>`, written by
 * `tauri signer sign --app-version` / `tauri build`; the app runs with `requireSignedVersion`, so
 * an unbound or mismatched signature would be refused by every installed app anyway).
 *
 * Minisign, verified here with node:crypto only (dependency-free):
 *   public key  = "Ed" + key id (8) + Ed25519 key (32), base64 on the second line;
 *   signature   = "Ed" (raw) | "ED" (BLAKE2b-512 prehash) + key id (8) + Ed25519 sig (64);
 *   trusted comment + global signature = Ed25519(sig || trusted comment).
 * Tauri stores both files base64-encoded once more; both forms are read.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const PLATFORM = "darwin-aarch64";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_NOTES = 4000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A Tauri key/signature file is base64 of the minisign text; a plain minisign file is the text. */
function minisignText(raw) {
  const s = String(raw).trim();
  if (s.startsWith("untrusted comment:")) return s;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) throw new Error("not a minisign file (neither text nor base64)");
  const decoded = Buffer.from(s.replace(/\s+/g, ""), "base64").toString("utf8").trim();
  if (!decoded.startsWith("untrusted comment:")) throw new Error("not a minisign file");
  return decoded;
}

function lines(text) {
  return text.split(/\r?\n/);
}

function b64Exact(s, len, what) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s ?? "")) throw new Error(`${what}: not base64`);
  const b = Buffer.from(s, "base64");
  if (b.length !== len) throw new Error(`${what}: ${b.length} bytes, expected ${len}`);
  return b;
}

/** → { keyId: hex, pk: Buffer(32) } */
export function parsePublicKey(raw) {
  const l = lines(minisignText(raw));
  if (l.length < 2) throw new Error("public key: missing key line");
  const b = b64Exact(l[1].trim(), 42, "public key");
  if (b.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("public key: not an Ed25519 minisign key");
  return { keyId: b.subarray(2, 10).toString("hex"), pk: b.subarray(10) };
}

/** → { prehashed, keyId, sig, trustedComment, globalSig } */
export function parseSignature(raw) {
  const l = lines(minisignText(raw));
  if (l.length < 4) throw new Error("signature: expected 4 lines");
  const b = b64Exact(l[1].trim(), 74, "signature");
  const alg = b.subarray(0, 2).toString("latin1");
  if (alg !== "Ed" && alg !== "ED") throw new Error(`signature: unknown algorithm ${JSON.stringify(alg)}`);
  const prefix = "trusted comment: ";
  if (!l[2].startsWith(prefix)) throw new Error("signature: no trusted comment");
  return {
    prehashed: alg === "ED",
    keyId: b.subarray(2, 10).toString("hex"),
    sig: b.subarray(10),
    trustedComment: l[2].slice(prefix.length),
    globalSig: b64Exact(l[3].trim(), 64, "global signature"),
  };
}

/** The `version:` field of a Tauri trusted comment (tab-separated key:value pairs), or null. */
export function signedVersion(trustedComment) {
  for (const f of String(trustedComment).split("\t")) if (f.startsWith("version:")) return f.slice("version:".length);
  return null;
}

function edKey(pk) {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pk]), format: "der", type: "spki" });
}

/**
 * Verify `data` against a minisign signature and public key. Returns
 * { ok: true, trustedComment, version } or { ok: false, reason }.
 */
export function verifyMinisign({ pubkey, signature, data }) {
  let k, s;
  try {
    k = parsePublicKey(pubkey);
    s = parseSignature(signature);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (k.keyId !== s.keyId) return { ok: false, reason: `signed by key ${s.keyId}, not the committed key ${k.keyId}` };
  const key = edKey(k.pk);
  const message = s.prehashed ? createHash("blake2b512").update(data).digest() : Buffer.from(data);
  if (!edVerify(null, message, key, s.sig)) return { ok: false, reason: "signature does not match the file" };
  const global = Buffer.concat([s.sig, Buffer.from(s.trustedComment, "utf8")]);
  if (!edVerify(null, global, key, s.globalSig)) return { ok: false, reason: "trusted comment signature is invalid" };
  return { ok: true, trustedComment: s.trustedComment, version: signedVersion(s.trustedComment) };
}

/** Verify + require the signature to bind exactly `version` (the app's `requireSignedVersion`). */
export function verifyRelease({ pubkey, signature, data, version }) {
  const r = verifyMinisign({ pubkey, signature, data });
  if (!r.ok) return r;
  if (r.version === null) return { ok: false, reason: "the signature binds no version (sign with --app-version / tauri build)" };
  if (r.version.replace(/^v/, "") !== version) return { ok: false, reason: `the signature binds version ${r.version}, not ${version}` };
  return r;
}

function httpsUrl(raw, what) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what}: not a URL`);
  }
  if (u.protocol !== "https:" || u.username || u.password || /\s/.test(raw) || u.href !== raw) throw new Error(`${what}: must be a plain https URL`);
  return raw;
}

function cleanNotes(raw) {
  // Plain text only: control characters (other than line breaks / tabs) and bidi controls go.
  const s = String(raw ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "")
    .trim();
  return s.length > MAX_NOTES ? `${s.slice(0, MAX_NOTES)}…` : s;
}

/** The `latest.json` the Tauri updater reads (static manifest, one platform). */
export function buildManifest({ version, url, signature, notes, pubDate }) {
  if (!SEMVER.test(version ?? "")) throw new Error(`version: ${JSON.stringify(version)} is not semver`);
  httpsUrl(url, "url");
  parseSignature(signature); // shape only; the caller verified it against the archive
  const date = pubDate ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (Number.isNaN(Date.parse(date)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(date)) throw new Error(`pub_date: ${date} is not RFC 3339 UTC`);
  return {
    version,
    notes: cleanNotes(notes),
    pub_date: date,
    platforms: { [PLATFORM]: { signature: String(signature).trim(), url } },
  };
}

/** Check a manifest before it is published to the update channel. Throws on any problem. */
export function checkManifest(manifest, { version, urlPrefix, pubkey, archive }) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest: not an object");
  if (manifest.version !== version) throw new Error(`manifest version ${manifest.version} ≠ ${version}`);
  const keys = Object.keys(manifest.platforms ?? {});
  if (JSON.stringify(keys) !== JSON.stringify([PLATFORM])) throw new Error(`manifest platforms ${JSON.stringify(keys)} ≠ ["${PLATFORM}"]`);
  const p = manifest.platforms[PLATFORM];
  httpsUrl(p.url, "platform url");
  httpsUrl(urlPrefix, "url prefix");
  if (!p.url.startsWith(urlPrefix) || p.url.slice(urlPrefix.length).includes("/")) throw new Error(`platform url ${p.url} is not an asset of ${urlPrefix}`);
  const r = verifyRelease({ pubkey, signature: p.signature, data: archive, version });
  if (!r.ok) throw new Error(`archive signature: ${r.reason}`);
  return true;
}

/** semver precedence: is `next` strictly newer than `current`? (Pre-release < release.) */
export function isNewer(next, current) {
  const parse = (v) => {
    if (!SEMVER.test(v ?? "")) throw new Error(`not semver: ${JSON.stringify(v)}`);
    const [core, pre] = v.split(/-(.*)/s);
    return { nums: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const a = parse(next);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) > Number(y);
    if (nx !== ny) return !nx;
    return x > y;
  }
  return false;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) out[k] = true;
      else {
        out[k] = v;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function need(o, k) {
  if (typeof o[k] !== "string" || !o[k]) throw new Error(`--${k} is required`);
  return o[k];
}

function selfTest() {
  const fx = (f) => readFileSync(join(here, "fixtures", f));
  const pubkey = fx("test.key.pub").toString("utf8");
  const data = fx("payload.bin");
  const sig = fx("payload.bin.sig").toString("utf8");
  let n = 0;
  const eq = (a, b, m) => {
    n++;
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`self-test: ${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  };
  const throws = (fn, re, m) => {
    n++;
    try {
      fn();
    } catch (e) {
      if (re.test(e.message)) return;
      throw new Error(`self-test: ${m}: wrong error ${e.message}`);
    }
    throw new Error(`self-test: ${m}: did not throw`);
  };

  // A real `tauri signer sign --app-version 1.2.3` signature (CLI 2.12.3, throwaway key).
  const ok = verifyMinisign({ pubkey, signature: sig, data });
  eq([ok.ok, ok.version], [true, "1.2.3"], "a genuine version-bound signature verifies");
  eq(verifyRelease({ pubkey, signature: sig, data, version: "1.2.3" }).ok, true, "and binds 1.2.3");
  eq(verifyRelease({ pubkey, signature: sig, data, version: "1.2.4" }).ok, false, "but not another version");
  eq(verifyMinisign({ pubkey, signature: sig, data: Buffer.concat([data, Buffer.from("x")]) }).ok, false, "a changed file fails");
  eq(verifyMinisign({ pubkey, signature: fx("other.bin.sig").toString("utf8"), data }).reason?.startsWith("signed by key"), true, "another key's signature fails");
  const unv = fx("unversioned.bin.sig").toString("utf8");
  eq(verifyMinisign({ pubkey, signature: unv, data }).ok, true, "an unversioned signature verifies cryptographically");
  eq(verifyRelease({ pubkey, signature: unv, data, version: "1.2.3" }).ok, false, "…but is refused as a release (binds no version)");
  // Tampered trusted comment: the version cannot be edited after signing.
  const text = Buffer.from(sig, "base64").toString("utf8").replace("version:1.2.3", "version:9.9.9");
  eq(verifyMinisign({ pubkey, signature: Buffer.from(text).toString("base64"), data }).reason, "trusted comment signature is invalid", "an edited version is detected");
  eq(verifyMinisign({ pubkey, signature: text, data }).ok, false, "plain-text form is read too (and still detected)");
  eq(verifyMinisign({ pubkey: "not a key", signature: sig, data }).ok, false, "garbage key refused");
  eq(signedVersion("timestamp:1\tfile:app-version:2.zip"), null, "a file name is not a version");

  // Manifest
  const url = "https://github.com/acme/prism/releases/download/prism-client-v1.2.3/Prism-Client_1.2.3_aarch64.app.tar.gz";
  const m = buildManifest({ version: "1.2.3", url, signature: sig, notes: "Fixes‮ things\u0007", pubDate: "2026-10-20T10:00:00Z" });
  eq(Object.keys(m), ["version", "notes", "pub_date", "platforms"], "manifest keys");
  eq(m.notes, "Fixes things", "notes are plain text");
  eq(m.platforms[PLATFORM].url, url, "platform url");
  throws(() => buildManifest({ version: "1.2", url, signature: sig }), /semver/, "bad version");
  throws(() => buildManifest({ version: "1.2.3", url: url.replace("https:", "http:"), signature: sig }), /https/, "http url");
  throws(() => buildManifest({ version: "1.2.3", url: "https://u:p@github.com/x", signature: sig }), /https/, "userinfo url");
  throws(() => buildManifest({ version: "1.2.3", url, signature: sig, pubDate: "yesterday" }), /RFC 3339/, "bad date");
  const prefix = "https://github.com/acme/prism/releases/download/prism-client-v1.2.3/";
  eq(checkManifest(m, { version: "1.2.3", urlPrefix: prefix, pubkey, archive: data }), true, "check passes");
  throws(() => checkManifest(m, { version: "1.2.4", urlPrefix: prefix, pubkey, archive: data }), /≠/, "check: other version");
  throws(() => checkManifest(m, { version: "1.2.3", urlPrefix: prefix.replace("v1.2.3", "v1.2.2"), pubkey, archive: data }), /not an asset/, "check: other release");
  throws(() => checkManifest({ ...m, platforms: { ...m.platforms, "darwin-x86_64": m.platforms[PLATFORM] } }, { version: "1.2.3", urlPrefix: prefix, pubkey, archive: data }), /platforms/, "check: extra platform");
  throws(() => checkManifest(m, { version: "1.2.3", urlPrefix: prefix, pubkey, archive: Buffer.from("other") }), /archive signature/, "check: other archive");
  // The update channel only moves forward.
  eq([isNewer("0.9.1", "0.9.0"), isNewer("0.9.0", "0.9.0"), isNewer("0.9.0", "0.9.1"), isNewer("0.10.0", "0.9.9")], [true, false, false, true], "isNewer: release order");
  eq([isNewer("1.0.0", "1.0.0-rc.1"), isNewer("1.0.0-rc.1", "1.0.0"), isNewer("1.0.0-rc.10", "1.0.0-rc.9"), isNewer("1.0.0-rc.1", "1.0.0-beta.9")], [true, false, true, true], "isNewer: pre-releases");
  throws(() => isNewer("latest", "1.0.0"), /semver/, "isNewer: refuses a non-version");
  console.log(`updater-manifest self-test: ${n} checks passed`);
}

function main(argv) {
  const o = args(argv);
  if (o["self-test"]) return selfTest();
  const cmd = o._[0];
  if (cmd === "verify") {
    const r = verifyRelease({
      pubkey: readFileSync(need(o, "pubkey"), "utf8"),
      signature: readFileSync(need(o, "sig"), "utf8"),
      data: readFileSync(need(o, "archive")),
      version: need(o, "version"),
    });
    if (!r.ok) throw new Error(`signature: ${r.reason}`);
    console.log(`updater-manifest: signature verified (key matches, version ${r.version})`);
    return;
  }
  if (cmd === "make") {
    const version = need(o, "version");
    const signature = readFileSync(need(o, "sig"), "utf8");
    const r = verifyRelease({ pubkey: readFileSync(need(o, "pubkey"), "utf8"), signature, data: readFileSync(need(o, "archive")), version });
    if (!r.ok) throw new Error(`signature: ${r.reason}`);
    const notes = typeof o["notes-file"] === "string" ? readFileSync(o["notes-file"], "utf8") : "";
    const m = buildManifest({ version, url: need(o, "url"), signature, notes, pubDate: typeof o["pub-date"] === "string" ? o["pub-date"] : undefined });
    writeFileSync(need(o, "out"), `${JSON.stringify(m, null, 2)}\n`);
    console.log(`updater-manifest: wrote ${o.out} (${version}, ${PLATFORM})`);
    return;
  }
  if (cmd === "check") {
    const manifest = JSON.parse(readFileSync(need(o, "manifest"), "utf8"));
    checkManifest(manifest, {
      version: need(o, "version"),
      urlPrefix: need(o, "url-prefix"),
      pubkey: readFileSync(need(o, "pubkey"), "utf8"),
      archive: readFileSync(need(o, "archive")),
    });
    console.log(`updater-manifest: ${o.manifest} is valid for ${o.version}`);
    return;
  }
  if (cmd === "newer") {
    // Exit 0 when the manifest's version is newer than the channel's current one (or there is none).
    const next = JSON.parse(readFileSync(need(o, "manifest"), "utf8")).version;
    const current = typeof o.current === "string" ? JSON.parse(readFileSync(o.current, "utf8")).version : null;
    if (current !== null && !isNewer(next, current)) throw new Error(`${next} is not newer than the channel's ${current}: the channel only moves forward`);
    console.log(`updater-manifest: ${next} is newer than ${current ?? "(empty channel)"}`);
    return;
  }
  throw new Error("usage: updater-manifest.mjs make|check|verify|newer … | --self-test");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`updater-manifest: ${e.message}`);
    process.exit(1);
  }
}
