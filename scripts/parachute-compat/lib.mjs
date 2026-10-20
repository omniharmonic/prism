// Pure helpers for the Parachute compatibility suite (no spawning, no network
// except `portFree`). Unit-tested by `selftest.test.mjs`.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Ports the suite never binds or talks to: the live hub, vault and Prism server. */
export const REFUSED_PORTS = Object.freeze([1939, 1940, 8787]);

/** Prism's agent tool allowlists (apps/server/src/agent-profiles.ts), compared
 *  against `tools/list`. */
export const PRISM_VAULT_RO = ["query-notes", "list-tags", "find-path", "vault-info", "doctor"];
export const PRISM_VAULT_RW = [
  "query-notes", "create-note", "update-note", "delete-note", "list-tags", "find-path", "vault-info", "doctor",
  "read-attachment", "request-attachment-download",
];
/** Must stay hidden from non-admin tokens. */
export const ADMIN_ONLY_TOOLS = ["update-tag", "delete-tag", "rename-tag", "merge-tags", "prune-schema", "manage-token"];

/** The embedded-mode requirements the suite reports on (launch plan §3.1). */
export const EMBEDDED_ITEMS = Object.freeze({
  E1: "serve --embedded (foreground, refuses install/upgrade/expose, SIGTERM → 0, /api/ready, exit codes)",
  E2: "one root: every file under PARACHUTE_HOME, required in embedded mode",
  E3: "pinned darwin-arm64 artifact with SHA-256 sums",
  E4: "non-interactive idempotent bootstrap --embedded (password from file/fd, --json)",
  E5: "token CLI --json (mint-token, vault create) honouring PARACHUTE_HOME",
  E6: "loopback-only binds, issuer = PARACHUTE_HUB_ORIGIN",
  E7: "version --json + newer-schema guard (exit 6)",
  E8: "secret files 0600 in 0700 dirs",
  E9: "no outbound connections unless a feature asks",
});

const USAGE = `usage: node scripts/parachute-compat/run.mjs --home <throwaway dir> [options]

  --home <dir>          throwaway PARACHUTE_HOME (must not exist, or be empty; refused: ~/.parachute)
  --bin <path>          parachute (hub) CLI            (default: \`parachute\` on PATH)
  --vault-bin <path>    parachute-vault CLI            (default: \`parachute-vault\` on PATH)
  --hub-port <n>        hub port   (default: a free port; 1939/1940/8787 refused)
  --vault-port <n>      vault port (default: a free port)
  --out <dir>           report + logs directory        (default: <home>-report)
  --reuse               allow a non-empty --home (a previous run's)
  --real-home           keep the real HOME for the children (default: HOME=<home>/../<home>-fakehome)
  --revoke-wait <s>     how long to wait for a revoked token to be refused (default 90)
  --artifact <path>     a release artifact to check (E3: checksum file next to it)
  --dry-run             validate and print the plan; spawn nothing
  -h, --help`;

export function usage() {
  return USAGE;
}

/** Parse argv into options. Throws an Error with a usage hint on bad input. */
export function parseArgs(argv) {
  const o = { bin: "parachute", vaultBin: "parachute-vault", reuse: false, dryRun: false, realHome: false, revokeWait: 90, help: false };
  const need = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--home": o.home = need(i, a); i++; break;
      case "--bin": o.bin = need(i, a); i++; break;
      case "--vault-bin": o.vaultBin = need(i, a); i++; break;
      case "--hub-port": o.hubPort = parsePort(need(i, a), a); i++; break;
      case "--vault-port": o.vaultPort = parsePort(need(i, a), a); i++; break;
      case "--out": o.out = need(i, a); i++; break;
      case "--revoke-wait": o.revokeWait = Number(need(i, a)); i++; break;
      case "--artifact": o.artifact = need(i, a); i++; break;
      case "--reuse": o.reuse = true; break;
      case "--real-home": o.realHome = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "-h": case "--help": o.help = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!o.help && !o.home) throw new Error("--home <throwaway dir> is required");
  if (!Number.isFinite(o.revokeWait) || o.revokeWait < 0) throw new Error("--revoke-wait must be a number of seconds");
  return o;
}

function parsePort(v, flag) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`${flag} must be a port 1024–65535`);
  return n;
}

/** Throws unless the port may be used by the suite. */
export function assertPortAllowed(port) {
  if (REFUSED_PORTS.includes(port)) throw new Error(`port ${port} is refused (live Parachute / Prism port)`);
}

/** The real Parachute home this user has (never to be touched). */
export function liveParachuteHome(env = process.env) {
  return join(env.HOME || homedir(), ".parachute");
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function inside(child, parent) {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Throws unless `home` is a safe throwaway PARACHUTE_HOME. */
export function assertHomeAllowed(home, { reuse = false, env = process.env } = {}) {
  if (!isAbsolute(home)) throw new Error("--home must be an absolute path");
  const live = real(liveParachuteHome(env));
  const h = real(home);
  if (inside(h, live) || inside(live, h)) throw new Error(`--home ${home} overlaps the live Parachute home ${live}`);
  const userHome = real(env.HOME || homedir());
  if (h === userHome) throw new Error("--home must not be your home directory");
  if (h === "/" || h === real("/tmp")) throw new Error("--home must be a dedicated directory");
  if (existsSync(home)) {
    if (!statSync(home).isDirectory()) throw new Error(`--home ${home} exists and is not a directory`);
    if (readdirSync(home).length > 0 && !reuse) throw new Error(`--home ${home} exists and is not empty (pass --reuse to use a previous run's)`);
  }
}

/** True when nothing listens on 127.0.0.1:port. */
export function portFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}

/** Pick a free port in [lo, hi) that is not refused, starting from a seed. */
export async function pickPort(seed, taken = [], lo = 20000, hi = 40000) {
  for (let i = 0; i < 200; i++) {
    const p = lo + ((seed + i * 7919) % (hi - lo));
    if (REFUSED_PORTS.includes(p) || taken.includes(p)) continue;
    if (await portFree(p)) return p;
  }
  throw new Error("no free port found");
}

/** Decode a JWT payload without verifying (the token was just minted for us). */
export function decodeJwt(token) {
  const part = String(token).split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** JSON on stdout: the whole of it, else the last line that parses as an object. */
export function parseJsonOut(stdout) {
  const s = String(stdout ?? "").trim();
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object") return v;
  } catch { /* line scan */ }
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith("{")) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object") return v;
    } catch { /* keep looking */ }
  }
  return undefined;
}

/** A minted token from `auth mint-token` output: `--json` or the bare JWT. */
export function parseMint(stdout) {
  const j = parseJsonOut(stdout);
  if (j && typeof j.token === "string") return { token: j.token, json: true, jti: j.jti, exp: j.exp };
  const lines = String(stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last && last.split(".").length === 3) return { token: last, json: false };
  return undefined;
}

/** Which embedded-mode features the binary ADVERTISES (help / version text).
 *  `help` = { root, serve, auth, bootstrap, vaultRoot, vaultCreate } strings;
 *  `versionJson` = the parsed `parachute version --json` (or undefined). */
export function detectFeatures(help, versionJson) {
  const has = (s, re) => typeof s === "string" && re.test(s);
  const bootstrapKnown = has(help.bootstrap, /bootstrap/i) && !has(help.bootstrap, /unknown command/i);
  return {
    serveEmbedded: has(help.serve, /--embedded/),
    bootstrapEmbedded: bootstrapKnown && has(help.bootstrap, /--embedded/),
    bootstrapPasswordFile: bootstrapKnown && has(help.bootstrap, /--password-(file|fd|stdin)/),
    mintJson: has(help.auth, /mint-token[\s\S]{0,600}--json/),
    vaultCreateJson: has(help.vaultCreate ?? help.vaultRoot, /create[^\n]*--json/),
    vaultCreateMint: has(help.vaultCreate ?? help.vaultRoot, /create[^\n]*--mint/),
    versionJson: Boolean(versionJson && typeof versionJson === "object"),
    offlineFlag: has(help.serve, /--offline/),
  };
}

/** Classify a file mode for E8. `secret` = a file that holds a key/token/hash. */
export function modeProblem(mode, { isDir, secret }) {
  const m = mode & 0o777;
  if (isDir) return m & 0o077 ? `dir is ${fmtMode(m)} (want 0700)` : undefined;
  if (secret) return m & 0o077 ? `secret file is ${fmtMode(m)} (want 0600)` : undefined;
  return undefined;
}

export function fmtMode(m) {
  return "0" + (m & 0o777).toString(8).padStart(3, "0");
}

/** Files under PARACHUTE_HOME that hold secrets (signing keys, tokens, password hashes). */
export function isSecretPath(rel) {
  return /(^|\/)(hub\.db|operator\.token|[^/]*\.token|[^/]*\.nsec|\.env|[^/]*\.key|vault\.db|[^/]*\.db)(-wal|-shm)?$/.test(rel) || /config\.yaml$/.test(rel);
}

/** True for a loopback listener address as lsof prints it (`127.0.0.1:1`, `[::1]:1`, `localhost:1`). */
export function isLoopbackAddr(addr) {
  return /^(127\.\d+\.\d+\.\d+|\[::1\]|localhost|::1):\d+$/.test(addr);
}

/** Parse `lsof -nP -iTCP` lines into {pid, name, state, local, remote}. */
export function parseLsof(text) {
  const out = [];
  for (const line of String(text).split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const nameIdx = cols.findIndex((c, i) => i >= 8 && /:\d+/.test(c));
    if (nameIdx < 0) continue;
    const addr = cols[nameIdx];
    const state = (cols.slice(nameIdx + 1).join(" ").match(/\(([A-Z_]+)\)/) || [])[1];
    const [local, remote] = addr.split("->");
    out.push({ cmd: cols[0], pid: Number(cols[1]), state, local, remote });
  }
  return out;
}

/** Remove anything token- or password-shaped before text reaches the report. */
export function scrub(text, secrets = []) {
  let s = String(text ?? "");
  for (const v of secrets) if (v && v.length >= 6) s = s.split(v).join("[secret]");
  return s
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]")
    .replace(/\b(pvt|pd|pp|sk)_[A-Za-z0-9_-]{8,}/g, "[token]");
}

const ICON = { PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP", INFO: "INFO" };

/** Render the report as Markdown. */
export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Parachute compatibility report`, "");
  lines.push(`- When: ${report.startedAt}`);
  lines.push(`- Hub CLI: \`${report.bins.hub}\` — ${report.versions.hub ?? "?"}`);
  lines.push(`- Vault CLI: \`${report.bins.vault}\` — ${report.versions.vault ?? "?"}`);
  lines.push(`- PARACHUTE_HOME: \`${report.home}\` · hub port ${report.ports.hub} · vault port ${report.ports.vault}`);
  lines.push(`- Mode: ${report.dryRun ? "dry run (nothing spawned)" : report.mode}`);
  const c = report.counts;
  lines.push(`- Result: ${c.PASS} pass · ${c.FAIL} fail · ${c.SKIP} skip · ${c.INFO} info`, "");
  lines.push(`## Embedded-mode items`, "", "| Item | Status | Detail |", "|---|---|---|");
  for (const [id, e] of Object.entries(report.embedded)) lines.push(`| ${id} | ${ICON[e.status]} | ${mdCell(e.detail)} |`);
  lines.push("", `## Checks`, "", "| Area | Check | Status | Detail |", "|---|---|---|---|");
  for (const r of report.results) lines.push(`| ${r.area} | ${mdCell(r.id)} | ${ICON[r.status]} | ${mdCell(r.detail)} |`);
  if (report.fileModes?.length) {
    lines.push("", `## File modes under PARACHUTE_HOME`, "", "| Path | Mode | Note |", "|---|---|---|");
    for (const f of report.fileModes) lines.push(`| ${mdCell(f.path)} | ${f.mode} | ${mdCell(f.problem ?? "")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function mdCell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Tally results. */
export function countResults(results) {
  const c = { PASS: 0, FAIL: 0, SKIP: 0, INFO: 0 };
  for (const r of results) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}
