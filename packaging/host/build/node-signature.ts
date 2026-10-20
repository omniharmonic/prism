/**
 * Check nodejs.org's SHASUMS256.txt against its detached OpenPGP signature
 * (SHASUMS256.txt.sig), signed by one of the Node.js releasers.
 *
 * The keys are NOT fetched at build time: the active releasers' public keys are vendored in
 * packaging/host/node-release-keys/ (copied from github.com/nodejs/release-keys at the commit
 * named in node-release-keys/SOURCE.json), and their primary-key fingerprints are pinned there
 * too. The check imports ONLY those files into a throwaway GnuPG home and accepts a signature
 * only when gpg reports it good (GOODSIG + VALIDSIG, no BADSIG / ERRSIG / EXPKEYSIG / REVKEYSIG)
 * AND the signing key's PRIMARY fingerprint is one of the pins. A key file whose fingerprint is
 * not pinned is refused before anything is verified.
 *
 * This is the THIRD check of the runtime: the sums file must also list the tarball's hash and
 * that hash must equal the one pinned in node.json (build.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface KeySource {
  repository: string;
  commit: string;
  /** Primary-key fingerprints (40 hex, upper case) of the releasers whose signature is accepted. */
  fingerprints: string[];
}

export type SignatureVerdict = { ok: true; fingerprint: string } | { ok: false; reason: string };

/**
 * Judge gpg's `--status-fd` output (pure; pinned by tests). VALIDSIG's LAST field is the
 * primary-key fingerprint (the signature may come from a subkey).
 */
export function judgeGpgStatus(status: string, pinned: readonly string[]): SignatureVerdict {
  const lines = status.split("\n").filter((l) => l.startsWith("[GNUPG:] "));
  const has = (kw: string) => lines.some((l) => l.split(" ")[1] === kw);
  for (const bad of ["BADSIG", "ERRSIG", "EXPKEYSIG", "REVKEYSIG", "EXPSIG", "NO_PUBKEY"]) {
    if (has(bad)) return { ok: false, reason: `gpg reported ${bad}` };
  }
  if (!has("GOODSIG")) return { ok: false, reason: "gpg reported no good signature" };
  const valid = lines.filter((l) => l.split(" ")[1] === "VALIDSIG");
  if (valid.length !== 1) return { ok: false, reason: `expected exactly one VALIDSIG, got ${valid.length}` };
  const fields = valid[0]!.split(" ").filter(Boolean);
  const primary = (fields[fields.length - 1] ?? "").toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(primary)) return { ok: false, reason: "VALIDSIG carries no primary-key fingerprint" };
  if (!pinned.map((f) => f.toUpperCase()).includes(primary)) return { ok: false, reason: `signed by ${primary}, which is not a pinned Node.js release key` };
  return { ok: true, fingerprint: primary };
}

/** The gpg binary, or null when there is none on PATH. */
export function findGpg(): string | null {
  const r = spawnSync("gpg", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? "gpg" : null;
}

export function readKeySource(keysDir: string): KeySource {
  const src = JSON.parse(readFileSync(join(keysDir, "SOURCE.json"), "utf8")) as KeySource;
  if (!Array.isArray(src.fingerprints) || src.fingerprints.some((f) => !/^[0-9A-F]{40}$/.test(f))) throw new Error(`${keysDir}/SOURCE.json: fingerprints must be 40 upper-case hex characters`);
  return src;
}

/** Verify `sigFile` over `sumsFile` with the vendored keys in `keysDir`. Throws nothing; returns a verdict. */
export function verifyNodeSums(opts: { gpg: string; sumsFile: string; sigFile: string; keysDir: string }): SignatureVerdict {
  let src: KeySource;
  try {
    src = readKeySource(opts.keysDir);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const home = mkdtempSync(join(tmpdir(), "prism-node-gpg-"));
  const gpg = (args: string[]) => spawnSync(opts.gpg, ["--homedir", home, "--batch", "--no-tty", "--no-auto-key-retrieve", ...args], { encoding: "utf8" });
  try {
    const keyFiles = readdirSync(opts.keysDir).filter((f) => f.endsWith(".asc")).sort();
    if (keyFiles.length === 0) return { ok: false, reason: `no key files in ${opts.keysDir}` };
    for (const f of keyFiles) {
      const imp = gpg(["--import", join(opts.keysDir, f)]);
      if (imp.status !== 0) return { ok: false, reason: `importing ${f} failed: ${imp.stderr.trim().slice(-300)}` };
    }
    // Every imported primary key must be pinned (a stray key file is refused, not trusted).
    const list = gpg(["--with-colons", "--fixed-list-mode", "--list-keys"]);
    if (list.status !== 0) return { ok: false, reason: `listing the imported keys failed: ${list.stderr.trim().slice(-300)}` };
    const primaries: string[] = [];
    let wantFpr = false;
    for (const line of list.stdout.split("\n")) {
      const f = line.split(":");
      if (f[0] === "pub") wantFpr = true;
      else if (f[0] === "fpr" && wantFpr) {
        primaries.push((f[9] ?? "").toUpperCase());
        wantFpr = false;
      } else if (f[0] === "sub") wantFpr = false;
    }
    const stray = primaries.filter((p) => !src.fingerprints.includes(p));
    if (stray.length) return { ok: false, reason: `key file(s) hold keys that are not pinned in SOURCE.json: ${stray.join(", ")}` };
    const missing = src.fingerprints.filter((p) => !primaries.includes(p));
    if (missing.length) return { ok: false, reason: `pinned key(s) with no key file: ${missing.join(", ")}` };
    const v = gpg(["--status-fd", "1", "--verify", opts.sigFile, opts.sumsFile]);
    const verdict = judgeGpgStatus(v.stdout, src.fingerprints);
    if (verdict.ok && v.status !== 0) return { ok: false, reason: `gpg --verify exited ${v.status}` };
    return verdict;
  } finally {
    // gpg may have started an agent / keyboxd for this home: stop them before removing it.
    spawnSync("gpgconf", ["--homedir", home, "--kill", "all"], { stdio: "ignore" });
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * What a missing gpg means: in CI (`CI=true`, or `PRISM_REQUIRE_NODE_SIGNATURE=1`) the build
 * fails closed; locally it warns and relies on the two hash checks.
 */
export function signatureRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || env.PRISM_REQUIRE_NODE_SIGNATURE === "1";
}
