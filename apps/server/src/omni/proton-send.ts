/**
 * Approved-email executor: the agent repo's `scripts/proton_send.py --approved`
 * (Benjamin's decision 2026-10-08, option B). That script is the one sender with the
 * markdown refusal and the third-party-recipient guard (`--allow-external` AND
 * `PROTON_SEND_ALLOW_EXTERNAL=1` in the AGENT repo's env/.env — this module never sets
 * the variable, so the policy stays where it lives).
 *
 * Invariants:
 *  - Fixed argv; every user value is its own argv element after a flag, the body goes
 *    on stdin. No shell.
 *  - The child gets an allowlisted env (HOME/USER/PATH/locale/TZ) — never a Prism secret.
 *    proton_send.py reads the Bridge password from the Keychain and its Parachute token
 *    from the agent repo's own .env.
 *  - Outcome is conservative: only a refusal that provably happened before the SMTP
 *    socket is `failed`; a refused/broken SMTP exchange, a timeout or a signal is
 *    `unknown` (check Sent before retrying).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { omniConfig } from "./config";
import type { ApprovalKind, ExecOutcome } from "./approvals";

const ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR", "TZ"];

export function protonSendConfigured(): boolean {
  const p = omniConfig.protonSendPath();
  return !!p && isAbsolute(p) && existsSync(p);
}

/** argv for one approved email; null when the payload is not an email kind. */
export function protonSendArgs(kind: ApprovalKind, p: Record<string, unknown>, selfAddress: string): string[] | null {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
  const args = ["send", "--approved", "--json", "--body-file", "-"];
  let to: string[];
  if (kind === "email") {
    to = list(p.to);
    if (typeof p.subject !== "string") return null;
    args.push("--subject", p.subject);
  } else if (kind === "email-reply") {
    // The recipients Benjamin saw on the card are sent explicitly; the note only
    // supplies subject + threading headers.
    if (typeof p.noteId !== "string") return null;
    to = list(p.expectTo);
    args.push("--reply-to-note", p.noteId);
  } else return null;
  if (to.length === 0) return null;
  const cc = list(p.cc);
  for (const t of to) args.push("--to", t);
  for (const t of cc) args.push("--cc", t);
  const self = selfAddress.toLowerCase();
  if ([...to, ...cc].some((a) => a.trim().toLowerCase() !== self)) args.push("--allow-external");
  return args;
}

/** Errors proton_send.py raises before it opens the SMTP socket (nothing left the machine). */
const PRE_SEND = [
  /^ERROR: No recipients/m,
  /^ERROR: Malformed recipient/m,
  /^ERROR: .*(third-party|switched OFF|PROTON_SEND_ALLOW_EXTERNAL)/m,
  /^ERROR: .*markdown/im,
  /^ERROR: No Parachute note/m,
  /^ERROR: Cannot parse a reply address/m,
  /^ERROR: Refusing to send/m,
  /^ERROR: Body is \d+ chars/m,
  /^ERROR: cannot reach Proton Bridge SMTP/m,
  /^ERROR: .*does not offer STARTTLS/m,
  /^ERROR: Bridge SMTP TLS fingerprint/m,
  /^ERROR: no Bridge password/m,
  /^ERROR: Bridge rejected SMTP auth/m,
  /^usage: /m,
];

export type Spawner = (cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; input: string; timeoutMs: number }) => Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }>;

const realSpawner: Spawner = (cmd, args, o) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, d: Buffer) => (s.length < 64_000 ? s + d.toString("utf8") : s);
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, o.timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, signal: "spawn_error", stdout, stderr, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(o.input);
  });

let spawner: Spawner = realSpawner;
export function setProtonSpawnerForTests(s: Spawner | null): void {
  spawner = s ?? realSpawner;
}

const scrub = (s: string): string => s.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(-400);

export async function runProtonSend(kind: ApprovalKind, payload: Record<string, unknown>): Promise<ExecOutcome> {
  const script = omniConfig.protonSendPath();
  if (!script || !protonSendConfigured()) return { status: "disabled", detail: { error: "executor_disabled", executor: "proton-send" } };
  const args = protonSendArgs(kind, payload, omniConfig.ownerEmail());
  const body = typeof payload.body === "string" ? payload.body : "";
  if (!args || !body) return { status: "failed", detail: { error: "invalid_payload", executor: "proton-send" } };
  const env: Record<string, string> = {};
  for (const k of ENV_KEYS) if (process.env[k]) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("LC_") && v) env[k] = v;
  const r = await spawner(omniConfig.protonPython(), [script, ...args], {
    cwd: dirname(dirname(script)), // the agent repo root (scripts/proton_send.py)
    env,
    input: body,
    timeoutMs: omniConfig.protonSendTimeoutMs(),
  });
  const detail: Record<string, unknown> = { executor: "proton-send", exitCode: r.code };
  if (r.code === 0) {
    const m = r.stdout.match(/\{[\s\S]*\}\s*$/);
    try {
      const j = m ? (JSON.parse(m[0]) as Record<string, unknown>) : {};
      if (typeof j.messageId === "string") detail.messageId = j.messageId;
    } catch {
      /* sent; the JSON tail is informational */
    }
    return { status: "sent", detail };
  }
  detail.error = r.timedOut ? "timeout" : r.signal ? `signal ${r.signal}` : scrub(r.stderr.trim()) || "proton_send failed";
  if (r.signal === "spawn_error") return { status: "failed", detail: { ...detail, error: "spawn_error" } };
  if (!r.timedOut && !r.signal && PRE_SEND.some((re) => re.test(r.stderr))) return { status: "failed", detail };
  return { status: "unknown", detail };
}
