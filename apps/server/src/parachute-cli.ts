/**
 * The ONE place Prism starts a Parachute CLI (launch plan §3.5).
 *
 * Every `parachute …` / `parachute-vault …` spawn in the server and its
 * scripts goes through {@link runParachute} / {@link runParachuteSync}:
 *
 * - **Explicit binary.** `PARACHUTE_BIN` (default `parachute`) and
 *   `PARACHUTE_VAULT_BIN` (default `parachute-vault`). With the defaults the
 *   binary is found on `PATH` exactly as before; a packaged install points
 *   them at absolute paths inside its payload.
 * - **One root.** `PARACHUTE_HOME`, when set, is passed to the child; unset
 *   leaves the CLI on its own default (`~/.parachute`).
 * - **Env allowlist, not inheritance.** The child gets only what the stock CLI
 *   needs to find its install and its hub (see {@link PARACHUTE_ENV_ALLOWLIST})
 *   — never the server's secrets (`PARACHUTE_TOKEN`, `SESSION_SECRET`,
 *   `PARACHUTE_ADMIN_TOKEN`, …) and never Prism's own `PORT` (the vault CLI
 *   reads `PORT` as ITS listen port).
 * - **Timeout.** Every call is bounded (`PARACHUTE_CLI_TIMEOUT_MS`, default
 *   60 s; per call `timeoutMs`): SIGTERM, then SIGKILL after a grace period.
 * - **No secret on argv.** Arguments that look like a credential (a JWT, a
 *   `pvt_`/`pd_`/`pp_` token, `--password`/`--token` with a value) are refused
 *   before anything is spawned; secrets go in through `input` (stdin) only.
 * - **Never log stdout.** It may carry a freshly minted token. Errors carry the
 *   exit code and a scrubbed, truncated stderr — never stdout.
 *
 * Output parsing: {@link parseCliJson} reads the JSON a CLI prints with
 * `--json` (the embedded-mode CLI, E5); {@link parseMintedToken} accepts that
 * JSON (`{token, jti, exp}`) or today's stock text output (the bare JWT on the
 * last line).
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute } from "node:path";

export type ParachuteTool = "hub" | "vault";

export interface ParachuteCliConfig {
  /** `parachute` (hub CLI). */
  bin: string;
  /** `parachute-vault`. */
  vaultBin: string;
  /** Passed as the child's `PARACHUTE_HOME`; undefined = the CLI's default. */
  home?: string;
  /** Default per-call timeout. */
  timeoutMs: number;
  /** Ask `auth mint-token` for `--json` output (embedded-mode CLI). */
  json: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Read the configuration from the environment (at call time, so tests and
 *  scripts that set it after import are honoured). */
export function parachuteCliConfig(env: NodeJS.ProcessEnv = process.env): ParachuteCliConfig {
  const t = Number(env.PARACHUTE_CLI_TIMEOUT_MS);
  const home = env.PARACHUTE_HOME?.trim();
  return {
    bin: env.PARACHUTE_BIN?.trim() || "parachute",
    vaultBin: env.PARACHUTE_VAULT_BIN?.trim() || "parachute-vault",
    home: home || undefined,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS,
    json: /^(1|true|yes)$/i.test(env.PARACHUTE_CLI_JSON?.trim() ?? ""),
  };
}

/** Variables passed through from the parent, by exact name. Everything the
 *  stock CLI needs to locate bun, the user's home and a non-default hub — and
 *  nothing that carries a secret. `LC_*` is passed by prefix. */
export const PARACHUTE_ENV_ALLOWLIST: readonly string[] = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "TMPDIR",
  "TZ",
  "BUN_INSTALL",
  // Non-secret Parachute topology (where the hub is, what issuer to stamp).
  "PARACHUTE_HUB_ORIGIN",
  "PARACHUTE_HUB_ORIGINS",
  "PARACHUTE_HUB_PORT",
  "PARACHUTE_HUB_JWKS_ORIGIN",
];

/** Build the child environment: allowlist + `PARACHUTE_HOME` from config +
 *  explicit `extra` (callers that need e.g. a `PORT` for a vault command). */
export function parachuteEnv(
  parent: NodeJS.ProcessEnv = process.env,
  cfg: ParachuteCliConfig = parachuteCliConfig(parent),
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PARACHUTE_ENV_ALLOWLIST) {
    const v = parent[k];
    if (typeof v === "string") out[k] = v;
  }
  for (const [k, v] of Object.entries(parent)) {
    if (k.startsWith("LC_") && typeof v === "string") out[k] = v;
  }
  if (cfg.home) out.PARACHUTE_HOME = cfg.home;
  for (const [k, v] of Object.entries(extra)) {
    if (SECRET_NAME.test(k)) throw new ParachuteCliError(`refusing to pass ${k} to the Parachute CLI environment`, { code: "secret_env" });
    out[k] = v;
  }
  return out;
}

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|_KEY$|^KEY$|API_KEY|PRIVATE/i;

const JWT_LIKE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const OPAQUE_TOKEN = /^(pvt|pd|pp|sk|ghp|gho)_[A-Za-z0-9_-]{8,}$/;
const SECRET_FLAG = /^--?(password|passwd|token|secret|api-key|key)(=.+)?$/i;

/** Throws when an argument looks like a credential (it would be visible in
 *  `ps` to every user of the machine). Secrets go in via stdin. */
export function assertNoSecretArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const flag = SECRET_FLAG.exec(a);
    if (flag && (flag[2] || i + 1 < args.length)) {
      throw new ParachuteCliError(`refusing to put a secret on the Parachute CLI argv (${a.split("=")[0]})`, { code: "secret_argv" });
    }
    if (JWT_LIKE.test(a) || OPAQUE_TOKEN.test(a)) {
      throw new ParachuteCliError("refusing to put a token on the Parachute CLI argv", { code: "secret_argv" });
    }
  }
}

/** Remove anything token-shaped from text that may reach a log. */
export function scrubCliText(text: string, max = 500): string {
  return text
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
    .replace(/\b(pvt|pd|pp|sk)_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .slice(0, max)
    .trim();
}

export class ParachuteCliError extends Error {
  code: "exit" | "timeout" | "spawn" | "secret_argv" | "secret_env" | "output";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Scrubbed stderr (kept so callers can detect e.g. `unknown flag "--x"`). */
  stderr: string;
  timedOut: boolean;
  constructor(
    message: string,
    o: { code: ParachuteCliError["code"]; exitCode?: number | null; signal?: NodeJS.Signals | null; stderr?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "ParachuteCliError";
    this.code = o.code;
    this.exitCode = o.exitCode ?? null;
    this.signal = o.signal ?? null;
    this.stderr = o.stderr ?? "";
    this.timedOut = o.code === "timeout";
    if (o.cause !== undefined) (this as { cause?: unknown }).cause = o.cause;
  }
}

export interface RunOptions {
  timeoutMs?: number;
  /** Written to the child's stdin, then closed (the ONLY way to pass a secret). */
  input?: string;
  /** Extra non-secret env for this call (e.g. `PORT` for a vault command). */
  env?: Record<string, string>;
  /** Cap on captured stdout/stderr bytes each (default 8 MB). */
  maxBuffer?: number;
  /** Config override (tests). */
  config?: ParachuteCliConfig;
  /** Parent env override (tests). */
  parentEnv?: NodeJS.ProcessEnv;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

const KILL_GRACE_MS = 2_000;

/**
 * The stock CLIs are bun scripts (`#!/usr/bin/env bun`), installed with bun next to `bun`
 * itself (`~/.bun/bin`). A caller whose PATH lacks that folder — an agent's or a fresh
 * Terminal's shell before the person edits their profile, found on the clean-VM run — got
 * `env: bun: No such file or directory` (exit 127). So an explicit binary's own folder goes
 * first on the child's PATH (the folder the person chose, nothing else is added).
 */
export function withBinDirOnPath(env: Record<string, string>, bin: string): Record<string, string> {
  if (!isAbsolute(bin)) return env;
  const dir = dirname(bin);
  const parts = (env.PATH ?? "").split(":").filter(Boolean);
  if (parts.includes(dir)) return env;
  return { ...env, PATH: [dir, ...(parts.length ? parts : ["/usr/bin", "/bin"])].join(":") };
}

function resolveCall(tool: ParachuteTool, args: readonly string[], opts: RunOptions) {
  assertNoSecretArgs(args);
  const parentEnv = opts.parentEnv ?? process.env;
  const cfg = opts.config ?? parachuteCliConfig(parentEnv);
  const bin = tool === "hub" ? cfg.bin : cfg.vaultBin;
  const env = withBinDirOnPath(parachuteEnv(parentEnv, cfg, opts.env), bin);
  return { bin, env, timeoutMs: opts.timeoutMs ?? cfg.timeoutMs, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024 };
}

function label(bin: string, args: readonly string[]): string {
  // The first two words name the command (`parachute auth mint-token`); later
  // arguments are left out of messages on principle.
  const name = bin.split("/").pop() ?? bin;
  return [name, ...args.filter((a) => !a.startsWith("-")).slice(0, 2)].join(" ");
}

/** Run a Parachute CLI. Resolves with stdout/stderr on exit 0; rejects with a
 *  {@link ParachuteCliError} otherwise. */
export function runParachute(tool: ParachuteTool, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  let call: ReturnType<typeof resolveCall>;
  try {
    call = resolveCall(tool, args, opts);
  } catch (e) {
    return Promise.reject(e);
  }
  const { bin, env, timeoutMs, maxBuffer } = call;
  const what = label(bin, args);
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...args], { env, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(new ParachuteCliError(`${what}: could not start (${(e as Error).message})`, { code: "spawn", cause: e }));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.stdout!.on("data", (d: Buffer) => {
      if (outLen < maxBuffer) out.push(d);
      outLen += d.length;
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (errLen < maxBuffer) err.push(d);
      errLen += d.length;
    });
    if (opts.input !== undefined) {
      child.stdin!.on("error", () => {
        /* the child may exit without reading stdin */
      });
      child.stdin!.end(opts.input);
    }
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new ParachuteCliError(
            e.code === "ENOENT" ? `${what}: binary not found (${bin}) — set ${tool === "hub" ? "PARACHUTE_BIN" : "PARACHUTE_VAULT_BIN"}` : `${what}: ${e.message}`,
            { code: "spawn", cause: e },
          ),
        ),
      );
    });
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = scrubCliText(Buffer.concat(err).toString("utf8"), 2000);
      finish(() => {
        if (timedOut) {
          reject(new ParachuteCliError(`${what}: timed out after ${timeoutMs} ms`, { code: "timeout", exitCode: code, signal, stderr }));
        } else if (code !== 0) {
          const tail = scrubCliText(stderr);
          reject(
            new ParachuteCliError(`${what}: exited ${code ?? signal}${tail ? ` — ${tail}` : ""}`, { code: "exit", exitCode: code, signal, stderr }),
          );
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  });
}

/** Synchronous form for one-shot scripts. Same rules as {@link runParachute}. */
export function runParachuteSync(tool: ParachuteTool, args: readonly string[], opts: RunOptions = {}): RunResult {
  const { bin, env, timeoutMs, maxBuffer } = resolveCall(tool, args, opts);
  const what = label(bin, args);
  const r = spawnSync(bin, [...args], {
    env,
    input: opts.input,
    stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer,
    encoding: "utf8",
  });
  const stderr = scrubCliText(r.stderr ?? "", 2000);
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    if (e.code === "ETIMEDOUT") throw new ParachuteCliError(`${what}: timed out after ${timeoutMs} ms`, { code: "timeout", stderr });
    throw new ParachuteCliError(e.code === "ENOENT" ? `${what}: binary not found (${bin})` : `${what}: ${e.message}`, { code: "spawn", cause: e });
  }
  if (r.status !== 0) {
    const tail = scrubCliText(stderr);
    throw new ParachuteCliError(`${what}: exited ${r.status ?? r.signal}${tail ? ` — ${tail}` : ""}`, {
      code: "exit",
      exitCode: r.status,
      signal: r.signal,
      stderr,
    });
  }
  return { stdout: r.stdout ?? "", stderr };
}

/** Parse the JSON a `--json` command printed: the whole of stdout, else the
 *  last line that parses as a JSON object (a CLI may print a notice first).
 *  Returns undefined when nothing parses. */
export function parseCliJson<T = Record<string, unknown>>(stdout: string): T | undefined {
  const whole = stdout.trim();
  if (!whole) return undefined;
  try {
    const v = JSON.parse(whole) as unknown;
    if (v && typeof v === "object") return v as T;
  } catch {
    /* fall through to line scan */
  }
  const lines = whole.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object") return v as T;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export interface MintedOutput {
  token: string;
  /** From the JSON output when the CLI gave one; else undefined (decode the JWT). */
  jti?: string;
  /** Seconds since epoch, from the JSON output when given. */
  exp?: number;
}

/** Read a minted token from `auth mint-token` output: the embedded-mode JSON
 *  (`{token, jti, exp}`) or the stock CLI's text (the JWT alone on the last
 *  non-empty line). Throws a {@link ParachuteCliError} (`output`) that never
 *  contains the output. */
export function parseMintedToken(stdout: string): MintedOutput {
  const j = parseCliJson<Record<string, unknown>>(stdout);
  if (j && typeof j.token === "string") {
    if (j.token.split(".").length !== 3) throw new ParachuteCliError("mint-token did not return a JWT", { code: "output" });
    return {
      token: j.token,
      jti: typeof j.jti === "string" ? j.jti : undefined,
      exp: typeof j.exp === "number" ? j.exp : undefined,
    };
  }
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  if (!last || last.split(".").length !== 3) throw new ParachuteCliError("mint-token did not return a JWT", { code: "output" });
  return { token: last };
}
