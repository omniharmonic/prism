/**
 * `prism reach` — make the Prism server reachable from the person's phone and other computers
 * (launch plan Phase 2 "Reachability", decision 3 / D-F: Tailscale `serve` by default, Funnel
 * opt-in). Only Prism's own port is ever served; the hub (1939) and the vault (1940) never are.
 *
 * Tailscale CLI targeted: the serve/funnel syntax of **1.52 and later** (the "v2" CLI —
 * `tailscale serve --bg --https=443 <target>`, `… --https=443 off`, `serve status --json`).
 * Older clients used `tailscale serve https / http://…` and are refused with "update Tailscale".
 * Checked against 1.102.2.
 *
 * Everything that touches the machine goes through `ReachDeps`, so tests drive it with a fake
 * `tailscale` and a fake server. Nothing is ever installed and nobody is signed in to Tailscale
 * on the person's behalf: a missing app or a logged-out client is a NEXT STEP for the agent to
 * tell the person.
 */
import { delimiter, isAbsolute, join } from "node:path";
import type { ExecResult, Runner } from "./launchd";
import { setKeys } from "./hostenv";
import { EXIT } from "./exit-codes";
import { parseEnv } from "../../../apps/server/scripts/lib/env-file";

export const TAILSCALE_APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export const MIN_TAILSCALE = [1, 52] as const;

/** Where to look for the CLI, in order. `PRISM_TAILSCALE_BIN` (tests, unusual installs) wins. */
export function tailscaleCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (env.PRISM_TAILSCALE_BIN) return [env.PRISM_TAILSCALE_BIN];
  out.push(TAILSCALE_APP_BIN, "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale");
  // Absolute PATH folders only: a relative one (".", "bin") would run a planted ./tailscale.
  for (const d of (env.PATH ?? "").split(delimiter)) if (d && isAbsolute(d)) out.push(join(d, "tailscale"));
  return [...new Set(out)];
}

export type TailscaleState =
  | { state: "missing" }
  | { state: "not-running"; bin: string; detail: string }
  | { state: "logged-out"; bin: string; backend: string }
  | { state: "too-old"; bin: string; version: string }
  | {
      state: "ready";
      bin: string;
      version: string;
      /** The machine's MagicDNS name, without the trailing dot. */
      dnsName: string;
      addresses: string[];
      magicDns: boolean;
      /** HTTPS certificates are on for the tailnet (needed for serve on 443). */
      https: boolean;
      /** This machine may use Funnel (the tailnet policy's `funnel` node attribute). */
      funnelAllowed: boolean;
    };

function versionOk(v: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v);
  if (!m) return true; // unknown format: do not block on it
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_TAILSCALE[0] || (maj === MIN_TAILSCALE[0] && min >= MIN_TAILSCALE[1]);
}

/** Read `tailscale status --json`. A logged-out client still prints JSON (often with exit 1). */
export function parseStatus(bin: string, r: ExecResult): TailscaleState {
  let j: Record<string, unknown> | null = null;
  try {
    j = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    j = null;
  }
  if (!j || typeof j !== "object") return { state: "not-running", bin, detail: (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 200) ?? "" };
  const version = typeof j.Version === "string" ? j.Version : "";
  if (version && !versionOk(version)) return { state: "too-old", bin, version };
  const backend = typeof j.BackendState === "string" ? j.BackendState : "";
  if (backend !== "Running") return { state: "logged-out", bin, backend: backend || "unknown" };
  const self = (j.Self ?? {}) as Record<string, unknown>;
  const rawDns = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  // It becomes APP_ORIGIN (`https://<name>`): a DNS name and nothing else, or none.
  const dnsName = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(rawDns) ? rawDns : "";
  const capMap = (self.CapMap && typeof self.CapMap === "object" ? Object.keys(self.CapMap) : []) as string[];
  const caps = Array.isArray(self.Capabilities) ? (self.Capabilities as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const has = (k: string) => capMap.includes(k) || caps.includes(k);
  const tailnet = (j.CurrentTailnet ?? {}) as Record<string, unknown>;
  const certDomains = Array.isArray(j.CertDomains) ? (j.CertDomains as unknown[]) : [];
  const addrs = Array.isArray(self.TailscaleIPs) ? (self.TailscaleIPs as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return {
    state: "ready",
    bin,
    version,
    dnsName,
    addresses: addrs,
    magicDns: tailnet.MagicDNSEnabled !== false && dnsName !== "",
    https: certDomains.length > 0 || has("https"),
    funnelAllowed: has("funnel"),
  };
}

/** One plain sentence for the agent to pass on, for every state that is not ready to serve. */
export function nextStepFor(t: TailscaleState, want: "serve" | "funnel" | null = null): string | null {
  switch (t.state) {
    case "missing":
      return "Tailscale is not installed. Ask the person to install the Tailscale app (tailscale.com/download or the Mac App Store), sign in, and install it on their phone with the same account; then run prism reach tailscale again.";
    case "not-running":
      return "Tailscale is installed but not running. Ask the person to open the Tailscale app and sign in; then run prism reach tailscale again.";
    case "logged-out":
      return "Tailscale is not signed in on this Mac. Ask the person to open the Tailscale app and sign in (the same account as on their phone); then run prism reach tailscale again.";
    case "too-old":
      return `Tailscale ${t.version} is too old for prism reach (it needs 1.52 or later). Ask the person to update the Tailscale app.`;
    case "ready":
      if (!t.magicDns) return "MagicDNS is off for this tailnet. Ask the person to turn it on in the Tailscale admin console (DNS → MagicDNS).";
      if (!t.https) return "HTTPS certificates are off for this tailnet. Ask the person to turn them on in the Tailscale admin console (DNS → HTTPS Certificates).";
      if (want === "funnel" && !t.funnelAllowed) return 'This Mac may not use Funnel. Ask the person to allow it in the Tailscale admin console (Access controls: the "funnel" node attribute for this machine).';
      return null;
  }
}

// ── serve configuration ──────────────────────────────────────────────────────

export type ServeState = { kind: "none" } | { kind: "ours"; funnel: boolean } | { kind: "other"; detail: string };

/** Prism's target. Served as an http proxy to loopback only. */
export const serveTarget = (port: number) => `http://127.0.0.1:${port}`;

/**
 * What is configured on HTTPS port 443 for this machine's name (`tailscale serve status --json`,
 * an ipn.ServeConfig: `{TCP: {"443": {HTTPS: true}}, Web: {"<name>:443": {Handlers: {"/": {Proxy}}}},
 * AllowFunnel: {"<name>:443": true}}`). "ours" = exactly one handler at "/" proxying to this
 * server's port; anything else on 443 belongs to someone else and is never touched.
 */
export function parseServe(text: string, dnsName: string, port: number): ServeState {
  let j: Record<string, unknown>;
  try {
    j = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { kind: "other", detail: "tailscale serve status --json could not be read" };
  }
  const hostPort = `${dnsName}:443`;
  const web = (j.Web ?? {}) as Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  const tcp = (j.TCP ?? {}) as Record<string, { HTTPS?: boolean; TCPForward?: string; HTTP?: boolean }>;
  const allow = (j.AllowFunnel ?? {}) as Record<string, boolean>;
  const entry = Object.entries(web).find(([k]) => k.toLowerCase() === hostPort)?.[1];
  const t443 = tcp["443"];
  if (!entry && !t443) return { kind: "none" };
  if (t443 && (t443.TCPForward || t443.HTTPS === false)) return { kind: "other", detail: "port 443 forwards raw TCP" };
  const handlers = Object.entries(entry?.Handlers ?? {});
  if (handlers.length === 0) return t443 ? { kind: "other", detail: "port 443 is configured with no handler for this name" } : { kind: "none" };
  const ok = new Set([serveTarget(port), `http://localhost:${port}`, `127.0.0.1:${port}`, `localhost:${port}`]);
  if (handlers.length === 1 && handlers[0]![0] === "/" && ok.has((handlers[0]![1].Proxy ?? "").replace(/\/+$/, ""))) {
    const funnel = Object.entries(allow).some(([k, v]) => k.toLowerCase() === hostPort && v === true);
    return { kind: "ours", funnel };
  }
  return { kind: "other", detail: `https://${dnsName} already serves ${handlers.map(([p]) => p).join(", ")} (see \`tailscale serve status\`)` };
}

export type ReachMode = "serve" | "funnel";

/** The exact `tailscale` argv lists that take `cur` to `want`. Null = a conflict: change nothing. */
export function planServe(want: ReachMode | "off", cur: ServeState, port: number): string[][] | null {
  const target = serveTarget(port);
  const on = (m: ReachMode) => [m, "--bg", "--https=443", target];
  const off = (m: ReachMode) => [m, "--https=443", "off"];
  if (cur.kind === "other") return want === "off" ? [] : null;
  if (want === "off") return cur.kind === "ours" ? [off(cur.funnel ? "funnel" : "serve")] : [];
  if (cur.kind === "none") return [on(want)];
  const isFunnel = cur.funnel;
  if ((want === "funnel") === isFunnel) return [];
  // Switching between private and public: take ours down, then put it up the other way.
  return [off(isFunnel ? "funnel" : "serve"), on(want)];
}

// ── .env ─────────────────────────────────────────────────────────────────────

export const localOriginFor = (port: number) => `http://localhost:${port}`;

/** Set APP_ORIGIN and nothing else. Returns null when it is already that. */
export function withAppOrigin(envText: string, origin: string): string | null {
  if (parseEnv(envText).APP_ORIGIN === origin) return null;
  return setKeys(envText, [["APP_ORIGIN", origin]]);
}

/** A local origin, or one this command manages (a *.ts.net name): safe to replace without asking. */
export function replaceableOrigin(current: string | undefined, port: number, tailnetOrigin: string): boolean {
  if (!current) return true;
  if (current === tailnetOrigin || current === localOriginFor(port)) return true;
  try {
    const u = new URL(current);
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
    return u.hostname.endsWith(".ts.net");
  } catch {
    return true;
  }
}

// ── the whole command ────────────────────────────────────────────────────────

export interface ReachRecordAnswer {
  appOrigin: string;
  seen: { self?: string; outside?: string; outsideVia?: string };
}

export interface ReachDeps {
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  run: Runner;
  readEnv(): string | null;
  writeEnv(text: string): void;
  /** Restart the server and wait for it; `managed: false` = not under launchd (restart it yourself). */
  restart(): Promise<{ ok: boolean; managed: boolean; reason?: string }>;
  /** POST /auth/local/reach over loopback with the host key. */
  record(body: Record<string, unknown>): Promise<{ ok: true; answer: ReachRecordAnswer } | { ok: false; status?: number; error?: string; appOrigin?: string; problem?: string }>;
  /** GET an https URL (through Tailscale). Resolves the status and parsed JSON, or rejects. */
  httpsGet(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }>;
  sleep(ms: number): Promise<void>;
  log(s: string): void;
  /** Verification attempts (the first HTTPS request may wait for Tailscale to fetch the certificate). */
  attempts?: number;
}

export interface ReachOptions {
  dryRun: boolean;
  yes: boolean;
  port: number;
}

export type ReachResult = { code: number; [k: string]: unknown };

const shell = (bin: string, args: string[]) => [bin, ...args].map((a) => (/^[A-Za-z0-9_./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

export async function detectTailscale(d: ReachDeps): Promise<TailscaleState> {
  const bin = tailscaleCandidates(d.env).find((p) => d.exists(p));
  if (!bin) return { state: "missing" };
  const r = await d.run(bin, ["status", "--json"]);
  return parseStatus(bin, r);
}

async function serveState(d: ReachDeps, t: Extract<TailscaleState, { state: "ready" }>, port: number): Promise<ServeState> {
  const r = await d.run(t.bin, ["serve", "status", "--json"]);
  if (r.code !== 0 && !r.stdout.trim()) return { kind: "other", detail: `tailscale serve status failed: ${r.stderr.trim().slice(0, 200)}` };
  return parseServe(r.stdout, t.dnsName, port);
}

/**
 * The check from this machine: record what is served (the server then knows this machine's
 * own tailnet addresses), GET https://<name>/health?live=1 through Tailscale, and read back
 * what the server saw. `self` set by the server = that request reached THIS server through the
 * Tailscale proxy under that name. It does not show another device can get in.
 */
export async function verifyReach(d: ReachDeps, origin: string, mode: ReachMode, addresses: string[]): Promise<Record<string, unknown>> {
  const rec = await d.record({ origin, mode, selfAddresses: addresses });
  if (!rec.ok) {
    if (rec.error === "origin_mismatch") return { ok: false, reason: `the running server's APP_ORIGIN is ${rec.appOrigin ?? "another address"}; restart it (prism restart)` };
    return { ok: false, reason: rec.problem ?? `the server did not record the check (HTTP ${rec.status ?? "no answer"}${rec.error ? `, ${rec.error}` : ""})` };
  }
  const attempts = d.attempts ?? 6;
  let last = "";
  let https = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await d.httpsGet(`${origin}/health?live=1`, 20_000);
      const b = r.body as { ok?: unknown; live?: unknown } | null;
      if (r.status === 200 && b?.ok === true && b?.live === true) {
        https = true;
        break;
      }
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message.slice(0, 200);
    }
    if (i < attempts - 1) await d.sleep(5000);
  }
  const after = await d.record({});
  const seen = after.ok ? after.answer.seen : {};
  return {
    ok: https && !!seen.self,
    https,
    ...(https ? {} : { reason: `https://…/health?live=1 did not answer through Tailscale (${last || "no answer"})` }),
    throughProxy: !!seen.self,
    ...(https && !seen.self ? { reason: "an answer came back, but the server did not see it arrive through Tailscale (another server on that name?)" } : {}),
    fromAnotherDevice: seen.outside ? { at: seen.outside, via: seen.outsideVia } : null,
    proves: "this Mac reaches Prism at its Tailscale name, with a valid certificate, through Tailscale's proxy",
    doesNotProve: mode === "funnel" ? "that the internet can reach it: from this Mac the name resolves inside the tailnet, so Funnel's public path is not used" : "that another device can reach it (its tailnet membership and access rules)",
  };
}

function seenSummary(seen: ReachRecordAnswer["seen"] | undefined) {
  return seen?.outside ? { at: seen.outside, via: seen.outsideVia } : null;
}

export async function reachStatus(d: ReachDeps, o: ReachOptions): Promise<ReachResult> {
  const t = await detectTailscale(d);
  const envText = d.readEnv() ?? "";
  const appOrigin = parseEnv(envText).APP_ORIGIN ?? localOriginFor(o.port);
  if (t.state !== "ready") return { code: EXIT.OK, tailscale: t, appOrigin, reachable: false, next: nextStepFor(t) };
  const origin = `https://${t.dnsName}`;
  const serve = await serveState(d, t, o.port);
  const tailscale = { state: t.state, bin: t.bin, version: t.version, dnsName: t.dnsName, https: t.https, magicDns: t.magicDns, funnelAllowed: t.funnelAllowed };
  const configured = serve.kind === "ours" && appOrigin === origin;
  let verification: unknown = null;
  let fromAnotherDevice: unknown = null;
  if (configured && !o.dryRun) {
    verification = await verifyReach(d, origin, serve.funnel ? "funnel" : "serve", t.addresses);
    fromAnotherDevice = (verification as { fromAnotherDevice?: unknown }).fromAnotherDevice ?? null;
  } else if (!o.dryRun) {
    const r = await d.record({});
    if (r.ok && r.answer.appOrigin === appOrigin) fromAnotherDevice = seenSummary(r.answer.seen);
  }
  const next =
    nextStepFor(t) ??
    (serve.kind === "other"
      ? `Something else is served at ${origin} (${serve.detail}). Ask the person before changing it; prism reach will not.`
      : serve.kind === "none"
        ? "Not served yet: run prism reach tailscale."
        : appOrigin !== origin
          ? `Tailscale serves Prism, but APP_ORIGIN is ${appOrigin}: run prism reach tailscale to set it.`
          : fromAnotherDevice
            ? null
            : `Open ${origin} on the phone (signed in to the same tailnet) to finish the checklist step.`);
  // `reachable` = what the checklist step will say: served, APP_ORIGIN set, and seen from another device.
  return { code: EXIT.OK, tailscale, origin, serve, appOrigin, reachable: configured && !!fromAnotherDevice, verification, fromAnotherDevice, next };
}

/** `prism reach tailscale` / `prism reach funnel`. */
export async function reachOn(d: ReachDeps, o: ReachOptions, mode: ReachMode): Promise<ReachResult> {
  const t = await detectTailscale(d);
  const step = nextStepFor(t, mode);
  if (t.state !== "ready" || step) return { code: EXIT.PRECONDITION, tailscale: t.state === "ready" ? { state: t.state, dnsName: t.dnsName } : t, next: step };
  const origin = `https://${t.dnsName}`;
  const envText = d.readEnv();
  if (envText === null) return { code: EXIT.NOT_INSTALLED, message: "no .env for this install (prism install first)" };
  const appOrigin = parseEnv(envText).APP_ORIGIN;
  if (mode === "funnel" && !o.yes) {
    return {
      code: EXIT.NEEDS_CONFIRMATION,
      warning: `Funnel puts ${origin} on the PUBLIC INTERNET: anyone with the address reaches Prism's sign-in page (accounts are invite-only, and only Prism's port is exposed — never the vault or the hub). Re-run with --yes to confirm.`,
    };
  }
  if (!replaceableOrigin(appOrigin, o.port, origin) && !o.yes) {
    return { code: EXIT.NEEDS_CONFIRMATION, warning: `APP_ORIGIN is ${appOrigin}, another public address. Switching to ${origin} changes where sign-in links and devices point. Re-run with --yes to switch.` };
  }
  const serve = await serveState(d, t, o.port);
  const plan = planServe(mode, serve, o.port);
  if (!plan) return { code: EXIT.PRECONDITION, serve, next: `Something else is served at ${origin} (${serve.kind === "other" ? serve.detail : ""}). Ask the person before changing it; prism reach changes only its own configuration.` };
  const commands = plan.map((a) => shell(t.bin, a));
  const newEnv = withAppOrigin(envText, origin);
  const actions = [...commands, ...(newEnv ? [`set APP_ORIGIN=${origin} in .env (nothing else changes)`, "restart the Prism server"] : []), `verify: GET ${origin}/health?live=1 through Tailscale`];
  if (o.dryRun) return { code: EXIT.OK, dryRun: true, origin, mode, serve, actions };

  for (const args of plan) {
    const r = await d.run(t.bin, args);
    if (r.code !== 0) return { code: EXIT.ERROR, origin, failed: shell(t.bin, args), error: (r.stderr || r.stdout).trim().slice(0, 400), done: commands.slice(0, plan.indexOf(args)) };
  }
  const end = await serveState(d, t, o.port);
  if (end.kind !== "ours" || end.funnel !== (mode === "funnel")) return { code: EXIT.ERROR, origin, error: `after the commands, serve status shows ${JSON.stringify(end)}`, commands };

  let restart: unknown = "not needed";
  if (newEnv) {
    d.writeEnv(newEnv);
    const r = await d.restart();
    restart = r;
    if (!r.managed) return { code: EXIT.OK, origin, mode, commands, env: { APP_ORIGIN: origin }, restart: "this install is not under launchd: restart the server yourself, then run prism reach status", next: "restart the server, then prism reach status" };
    if (!r.ok) return { code: EXIT.DEGRADED, origin, mode, commands, env: { APP_ORIGIN: origin }, restart: r, next: "the server did not come back healthy: prism status, prism logs" };
  }
  const verification = await verifyReach(d, origin, mode, t.addresses);
  const ok = verification.ok === true;
  return {
    code: ok ? EXIT.OK : EXIT.DEGRADED,
    origin,
    mode,
    commands,
    env: newEnv ? { APP_ORIGIN: origin } : "unchanged",
    restart,
    verification,
    next: ok
      ? verification.fromAnotherDevice
        ? null
        : mode === "funnel"
          ? `Open ${origin} from a device that is NOT on the tailnet (a phone on cellular data) to finish the checklist step.`
          : `Open ${origin} on the phone (Tailscale signed in with the same account) to finish the checklist step. Sign in there with the owner's password.`
      : "Check prism reach status; the Tailscale app may still be fetching the certificate (try again in a minute).",
  };
}

/** `prism reach off`. */
export async function reachOff(d: ReachDeps, o: ReachOptions): Promise<ReachResult> {
  const t = await detectTailscale(d);
  const envText = d.readEnv();
  if (envText === null) return { code: EXIT.NOT_INSTALLED, message: "no .env for this install (prism install first)" };
  const appOrigin = parseEnv(envText).APP_ORIGIN;
  let commands: string[] = [];
  let plan: string[][] = [];
  let origin: string | null = null;
  let serve: ServeState | null = null;
  if (t.state === "ready") {
    origin = `https://${t.dnsName}`;
    serve = await serveState(d, t, o.port);
    plan = planServe("off", serve, o.port) ?? [];
    commands = plan.map((a) => shell(t.bin, a));
  }
  // APP_ORIGIN goes back to the local address only when it is the Tailscale one we set.
  const ours = !!appOrigin && (appOrigin === origin || (() => { try { return new URL(appOrigin).hostname.endsWith(".ts.net"); } catch { return false; } })());
  const newEnv = ours ? withAppOrigin(envText, localOriginFor(o.port)) : null;
  const actions = [...commands, ...(newEnv ? [`set APP_ORIGIN=${localOriginFor(o.port)} in .env`, "restart the Prism server"] : [])];
  if (o.dryRun) return { code: EXIT.OK, dryRun: true, serve, actions, ...(serve?.kind === "other" ? { note: "what is served on 443 is not Prism's; left alone" } : {}) };
  for (const args of plan) {
    const r = await d.run(t.state === "ready" ? t.bin : "tailscale", args);
    if (r.code !== 0) return { code: EXIT.ERROR, failed: shell(t.state === "ready" ? t.bin : "tailscale", args), error: (r.stderr || r.stdout).trim().slice(0, 400) };
  }
  if (t.state === "ready" && plan.length) {
    let end = await serveState(d, t, o.port);
    // `funnel … off` may leave the private handler behind on some versions: take it down too.
    if (end.kind === "ours") {
      const args = ["serve", "--https=443", "off"];
      const r = await d.run(t.bin, args);
      commands.push(shell(t.bin, args));
      if (r.code !== 0) return { code: EXIT.ERROR, failed: shell(t.bin, args), error: (r.stderr || r.stdout).trim().slice(0, 400) };
      end = await serveState(d, t, o.port);
    }
    if (end.kind === "ours") return { code: EXIT.ERROR, error: "Prism is still served after the off commands", commands };
  }
  let restart: unknown = "not needed";
  if (newEnv) {
    d.writeEnv(newEnv);
    const r = await d.restart();
    restart = r.managed ? r : "this install is not under launchd: restart the server yourself";
  }
  await d.record({ origin: null, ...(appOrigin && ours ? { forget: appOrigin } : {}) });
  return {
    code: EXIT.OK,
    commands,
    env: newEnv ? { APP_ORIGIN: localOriginFor(o.port) } : "unchanged",
    restart,
    ...(t.state !== "ready" ? { note: `Tailscale is ${t.state}: nothing to take down there` } : {}),
    ...(serve?.kind === "other" ? { note: "what is served on 443 is not Prism's; left alone" } : {}),
  };
}
