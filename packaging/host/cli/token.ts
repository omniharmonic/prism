/**
 * `prism token mint|rotate|status` — the server's long-lived Parachute vault token, minted by
 * the Parachute CLI and written STRAIGHT into the install's `.env` (launch plan Phase 2: "tokens
 * are minted straight into .env (0600) by the CLI and never shown in the transcript").
 *
 *  - Every Parachute call goes through `apps/server/src/parachute-cli.ts` (`runParachute`):
 *    explicit `PARACHUTE_BIN`, `PARACHUTE_HOME`, an env allowlist, a timeout, no secret on argv,
 *    stdout never logged. The binary and home come from the install's `.env` first, then the
 *    caller's environment.
 *  - The token never leaves this process except into `.env` (atomic, 0600, every other line kept
 *    byte for byte — `SECRETS_KEY` and the other secrets are never touched). Results, logs and
 *    errors carry only `jti`, `exp` and `scope`.
 *  - A minted token is checked against the vault before it is written; a token the vault refuses
 *    is revoked again and never stored.
 *  - `rotate` = mint → verify → swap into `.env` → restart the server (when it runs) → revoke the
 *    old jti. Parachute caches revocations for about 60 seconds, so the old token keeps working
 *    that long after `rotate` returns.
 */
import { CliError, EXIT } from "./exit-codes";
import { bool, int, type Parsed } from "./args";
import { SECRET_FILE_MODE, type Layout } from "./paths";
import { acquireLock, readTextOrNull, writeFileAtomic } from "./fsutil";
import { setKeys } from "./hostenv";
import { probe, serverBase, type Fetch } from "./health";
import type { HostState } from "./state";
import { parseEnv } from "../../../apps/server/scripts/lib/env-file";
import { parachuteCliConfig, parseMintedToken, runParachute, type ParachuteCliConfig } from "../../../apps/server/src/parachute-cli";
import { decodeJwtPayload } from "../../../apps/server/src/mcp-token";
import { prefixOf, requireInstalled, restartForEnv, serverPort, type Ctx, type Result } from "./commands";

/** One year: the long-lived server token. */
export const DEFAULT_TOKEN_TTL_S = 31_536_000;
/** `status` / `prism setup` say "rotate it" when fewer days are left. */
export const ROTATE_WITHIN_DAYS = 30;
/** How long Parachute keeps accepting a revoked token (its revocation cache), in seconds. */
export const REVOCATION_CACHE_S = 60;

/** Keys of the install's `.env` that say where Parachute is (non-secret topology). */
const PARACHUTE_ENV_KEYS = ["PARACHUTE_BIN", "PARACHUTE_VAULT_BIN", "PARACHUTE_HOME", "PARACHUTE_HUB_ORIGIN", "PARACHUTE_CLI_JSON", "PARACHUTE_CLI_TIMEOUT_MS"] as const;

/** The environment a Parachute call runs from: the caller's, with the install's Parachute keys on top. */
export function parachuteCallEnv(callerEnv: NodeJS.ProcessEnv, envText: string | null): { parentEnv: NodeJS.ProcessEnv; config: ParachuteCliConfig } {
  const e = envText ? parseEnv(envText) : {};
  const parentEnv: NodeJS.ProcessEnv = { ...callerEnv };
  for (const k of PARACHUTE_ENV_KEYS) if (e[k]) parentEnv[k] = e[k];
  return { parentEnv, config: parachuteCliConfig(parentEnv) };
}

export interface TokenFacts {
  jti: string | null;
  /** ISO time, or null when the token is not a readable JWT. */
  exp: string | null;
  scope: string | null;
  expiresInDays: number | null;
}

/** What may be said about a token: its jti, expiry and scope (read, not verified). Never the token. */
export function tokenFacts(token: string, now: Date): TokenFacts {
  try {
    const p = decodeJwtPayload(token);
    const exp = typeof p.exp === "number" ? new Date(p.exp * 1000) : null;
    const scope = typeof p.scope === "string" ? p.scope : Array.isArray(p.scope) ? p.scope.join(" ") : typeof p.scp === "string" ? p.scp : null;
    return {
      jti: typeof p.jti === "string" ? p.jti : null,
      exp: exp ? exp.toISOString() : null,
      scope,
      expiresInDays: exp ? Math.floor((exp.getTime() - now.getTime()) / 86_400_000) : null,
    };
  } catch {
    return { jti: null, exp: null, scope: null, expiresInDays: null };
  }
}

/** The token's issuer, for the one hint that needs it (a vault that refuses the issuer). */
function issuerOf(token: string): string | null {
  try {
    const iss = decodeJwtPayload(token).iss;
    return typeof iss === "string" ? iss : null;
  } catch {
    return null;
  }
}

export type VaultVerdict = "accepted" | "rejected" | "unreachable";

/** Ask the vault whether it accepts `token` (one read-only call). */
export async function checkVaultToken(fetchFn: Fetch, parachuteUrl: string, vault: string, token: string, timeoutMs = 5000): Promise<VaultVerdict> {
  try {
    const r = await fetchFn(`${parachuteUrl.replace(/\/+$/, "")}/vault/${encodeURIComponent(vault)}/api/tags`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status >= 200 && r.status < 300) return "accepted";
    if (r.status === 401 || r.status === 403) return "rejected";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export interface InstallToken {
  envText: string | null;
  vault: string;
  parachuteUrl: string;
  /** The token in `.env`, or null. Stays inside this module's callers; never printed. */
  token: string | null;
}

export function installToken(layout: Layout): InstallToken {
  const envText = readTextOrNull(layout.envFile);
  const e = envText ? parseEnv(envText) : {};
  return {
    envText,
    vault: e.PARACHUTE_VAULT || "default",
    parachuteUrl: (e.PARACHUTE_URL || "http://127.0.0.1:1940").replace(/\/+$/, ""),
    token: e.PARACHUTE_TOKEN || null,
  };
}

export function mintArgs(scope: string, ttlSeconds: number | null, json: boolean): string[] {
  const args = ["auth", "mint-token", "--scope", scope, ...(ttlSeconds === null ? ["--ephemeral"] : ["--expires-in", String(ttlSeconds)])];
  return json ? [...args, "--json"] : args;
}

/** Mint one token with the Parachute CLI. The token is returned to the caller only. */
export async function mintWithParachute(ctx: Ctx, envText: string | null, scope: string, ttlSeconds: number | null): Promise<{ token: string; facts: TokenFacts }> {
  const { parentEnv, config } = parachuteCallEnv(ctx.env, envText);
  const { stdout } = await runParachute("hub", mintArgs(scope, ttlSeconds, config.json), { parentEnv, config });
  const out = parseMintedToken(stdout);
  return { token: out.token, facts: tokenFacts(out.token, ctx.now()) };
}

export async function revokeWithParachute(ctx: Ctx, envText: string | null, jti: string): Promise<void> {
  const { parentEnv, config } = parachuteCallEnv(ctx.env, envText);
  await runParachute("hub", ["auth", "revoke-token", jti], { parentEnv, config });
}

/**
 * A short-lived (`--ephemeral`, 1 h) `vault:<name>:admin` token for one admin operation (tag-schema
 * writes need it on vault ≥ 0.7.1) — the same argv as `mintEphemeralAdminToken` (mcp-token.ts), run
 * with the install's Parachute paths. Held in memory by the caller, never written anywhere.
 * `PARACHUTE_ADMIN_TOKEN` in the caller's environment wins, as on the server.
 */
export async function mintAdminToken(ctx: Ctx, layout: Layout): Promise<string> {
  const override = ctx.env.PARACHUTE_ADMIN_TOKEN?.trim();
  if (override) return override;
  const t = installToken(layout);
  return (await mintWithParachute(ctx, t.envText, `vault:${t.vault}:admin`, null)).token;
}

/** Why a vault refused a freshly minted token, as one sentence the agent can say. */
function refusedHint(token: string, envText: string | null): string {
  const iss = issuerOf(token);
  const hub = (envText ? parseEnv(envText) : {}).PARACHUTE_HUB_ORIGIN || "http://127.0.0.1:1939";
  const portOf = (u: string) => {
    try {
      const x = new URL(u);
      return x.port || (x.protocol === "https:" ? "443" : "80");
    } catch {
      return null;
    }
  };
  if (iss && portOf(iss) !== portOf(hub)) {
    return `The vault refused the new token: its issuer (${iss}) is not the hub (${hub}). Stock Parachute takes the issuer from <PARACHUTE_HOME>/hub/run/hub.port, which \`parachute serve\` does not write; write the hub's port there (one line) and run this again.`;
  }
  return "The vault refused the new token (401/403). Check that PARACHUTE_URL and PARACHUTE_VAULT in the install's .env name this Parachute and that the hub and vault belong together.";
}

export interface WriteTokenOutcome {
  minted: TokenFacts;
  verdict: VaultVerdict;
  restart: { ran: boolean; ok?: boolean; reason?: string; needed?: boolean };
}

/** Restart the server after `.env` changed — only when it is running. */
export async function restartIfRunning(ctx: Ctx, layout: Layout, state: HostState): Promise<WriteTokenOutcome["restart"]> {
  const live = (await probe(ctx.fetch, serverBase(serverPort(layout)), 1500)).live;
  if (!live) return { ran: false };
  if (!state.launchd) return { ran: false, needed: true, reason: "this install does not use launchd: restart `prism run server` yourself so it reads the new .env" };
  const r = await restartForEnv(ctx, layout, state);
  return { ran: true, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) };
}

/**
 * Mint the server's write token, check it, and put it in `.env`. `requireVerified`: refuse to
 * write when the vault cannot be asked (rotate). The previous token, if any, is NOT revoked here.
 */
export async function mintIntoEnv(ctx: Ctx, layout: Layout, state: HostState, o: { ttlSeconds: number; requireVerified: boolean }): Promise<WriteTokenOutcome & { previous: TokenFacts | null }> {
  const t = installToken(layout);
  if (t.envText === null) throw new CliError(EXIT.NOT_INSTALLED, `${layout.envFile} does not exist (run \`prism install\`)`);
  const scope = `vault:${t.vault}:write`;
  let minted: { token: string; facts: TokenFacts };
  try {
    minted = await mintWithParachute(ctx, t.envText, scope, o.ttlSeconds);
  } catch (e) {
    throw new CliError(EXIT.PRECONDITION, `could not mint a vault token: ${(e as Error).message}`);
  }
  const verdict = await checkVaultToken(ctx.fetch, t.parachuteUrl, t.vault, minted.token);
  if (verdict === "rejected" || (verdict === "unreachable" && o.requireVerified)) {
    if (minted.facts.jti) await revokeWithParachute(ctx, t.envText, minted.facts.jti).catch(() => {});
    if (verdict === "rejected") throw new CliError(EXIT.VERIFY_FAILED, refusedHint(minted.token, t.envText), { jti: minted.facts.jti });
    throw new CliError(EXIT.PRECONDITION, `the vault at ${t.parachuteUrl} does not answer, so the new token could not be checked; nothing was changed (the new token was revoked)`, { jti: minted.facts.jti });
  }
  const previous = t.token ? tokenFacts(t.token, ctx.now()) : null;
  // Re-read just before the write: only PARACHUTE_TOKEN changes, every other line is kept.
  const fresh = readTextOrNull(layout.envFile) ?? t.envText;
  writeFileAtomic(layout.envFile, setKeys(fresh, [["PARACHUTE_TOKEN", minted.token]]), SECRET_FILE_MODE);
  const restart = await restartIfRunning(ctx, layout, state);
  return { minted: minted.facts, verdict, restart, previous };
}

export interface TokenStatus {
  set: boolean;
  token: TokenFacts | null;
  vault: VaultVerdict | null;
  /** Set when something should be done: one sentence. */
  next?: string;
  /** "fine" = set, not expired, not refused. */
  fine: boolean;
}

export async function tokenStatus(ctx: Ctx, layout: Layout): Promise<TokenStatus> {
  const t = installToken(layout);
  if (!t.token) return { set: false, token: null, vault: null, fine: false, next: "No vault token is set: run prism token mint." };
  const facts = tokenFacts(t.token, ctx.now());
  const vault = await checkVaultToken(ctx.fetch, t.parachuteUrl, t.vault, t.token);
  if (vault === "rejected") return { set: true, token: facts, vault, fine: false, next: "The vault refuses the token: run prism token rotate (or prism token mint --force if Parachute was set up again)." };
  if (facts.expiresInDays !== null && facts.expiresInDays < 0) return { set: true, token: facts, vault, fine: false, next: "The vault token has expired: run prism token mint --force." };
  const next =
    facts.expiresInDays !== null && facts.expiresInDays < ROTATE_WITHIN_DAYS
      ? `The vault token expires in ${facts.expiresInDays} days: run prism token rotate.`
      : vault === "unreachable"
        ? `The vault at ${t.parachuteUrl} does not answer, so the token could not be checked.`
        : facts.exp === null
          ? "The token is not a readable JWT, so its expiry is unknown; prism token rotate replaces it with one that is."
          : undefined;
  return { set: true, token: facts, vault, fine: true, ...(next ? { next } : {}) };
}

/** `prism token mint|rotate|status [--force] [--expires-in S] [--dry-run]`. */
export async function cmdToken(ctx: Ctx, p: Parsed): Promise<Result> {
  const sub = p.positional[0];
  if (!sub || !["mint", "rotate", "status"].includes(sub)) throw new CliError(EXIT.USAGE, "usage: prism token mint|rotate|status [--force] [--expires-in SECONDS] [--dry-run]");
  const layout = prefixOf(ctx, p);
  const state = requireInstalled(layout);
  const dryRun = bool(p, "dry-run");
  const ttl = int(p, "expires-in", 3600, 5 * 31_536_000) ?? DEFAULT_TOKEN_TTL_S;

  if (sub === "status") {
    const s = await tokenStatus(ctx, layout);
    return { code: s.fine ? EXIT.OK : EXIT.PRECONDITION, ...s };
  }

  const t = installToken(layout);
  if (sub === "mint" && t.token && !bool(p, "force")) {
    const s = await tokenStatus(ctx, layout);
    if (s.fine) return { code: EXIT.OK, action: "unchanged", token: s.token, vault: s.vault, note: "A working vault token is already set; prism token rotate replaces it, prism token mint --force mints a new one regardless.", ...(s.next ? { next: s.next } : {}) };
  }
  if (sub === "rotate" && !t.token) throw new CliError(EXIT.PRECONDITION, "no vault token is set yet: run prism token mint");
  const scope = `vault:${t.vault}:write`;
  if (dryRun) {
    const old = t.token ? tokenFacts(t.token, ctx.now()) : null;
    return {
      code: EXIT.OK,
      dryRun: true,
      actions: [
        `parachute ${mintArgs(scope, ttl, false).join(" ")}`,
        `check it against ${t.parachuteUrl}/vault/${t.vault}`,
        `write PARACHUTE_TOKEN into ${layout.envFile} (0600; nothing else changes)`,
        "restart the server if it is running",
        ...(sub === "rotate" && old?.jti ? [`parachute auth revoke-token ${old.jti} (Parachute enforces it within ~${REVOCATION_CACHE_S} s)`] : []),
      ],
    };
  }

  const release = acquireLock(layout.lock);
  try {
    const out = await mintIntoEnv(ctx, layout, state, { ttlSeconds: ttl, requireVerified: sub === "rotate" });
    const base = { action: sub === "rotate" ? "rotated" : "minted", token: out.minted, vault: out.verdict, envFile: layout.envFile, restart: out.restart };
    const warnings: string[] = [];
    if (out.verdict === "unreachable") warnings.push("The vault did not answer, so the new token was written without being checked: run prism token status once Parachute runs.");
    if (out.restart.needed) warnings.push(out.restart.reason!);
    if (out.restart.ran && !out.restart.ok) warnings.push(`The server did not come back after the restart: ${out.restart.reason ?? "unknown"} (prism status, prism logs).`);

    if (sub === "mint") {
      // A replaced token (mint --force, or one the vault refused / that expired) is revoked best effort.
      let revoked: unknown;
      if (out.previous?.jti && out.previous.jti !== out.minted.jti) {
        revoked = await revokeWithParachute(ctx, t.envText, out.previous.jti).then(
          () => ({ jti: out.previous!.jti, ok: true }),
          (e: Error) => ({ jti: out.previous!.jti, ok: false, reason: e.message }),
        );
      }
      return { code: out.restart.ran && !out.restart.ok ? EXIT.DEGRADED : EXIT.OK, ...base, ...(revoked ? { revoked } : {}), warnings };
    }

    // rotate: revoke the old one only once the server runs on the new one (or does not run at all).
    const old = out.previous;
    if (out.restart.ran && !out.restart.ok) {
      warnings.push(`The old token (jti ${old?.jti ?? "?"}) was NOT revoked because the server is not healthy; it is no longer in .env. Run prism token rotate again once the server is healthy.`);
      return { code: EXIT.DEGRADED, ...base, revoked: { jti: old?.jti ?? null, ok: false }, warnings };
    }
    if (!old?.jti) {
      warnings.push("The old token was not a readable JWT, so it could not be revoked by jti; revoke it in Parachute if it was ever shared.");
      return { code: EXIT.OK, ...base, revoked: { jti: null, ok: false }, warnings };
    }
    try {
      await revokeWithParachute(ctx, t.envText, old.jti);
    } catch (e) {
      warnings.push(`The new token is in place, but revoking the old one failed: ${(e as Error).message}. Run: parachute auth revoke-token ${old.jti}`);
      return { code: EXIT.ERROR, ...base, revoked: { jti: old.jti, ok: false }, warnings };
    }
    return {
      code: EXIT.OK,
      ...base,
      revoked: { jti: old.jti, ok: true },
      note: `Parachute keeps accepting a revoked token for about ${REVOCATION_CACHE_S} seconds (its revocation cache).`,
      warnings,
    };
  } finally {
    release();
  }
}
