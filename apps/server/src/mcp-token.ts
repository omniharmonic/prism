/**
 * Scoped MCP-token minting seam (member self-serve vault access for agents).
 *
 * A vault member can mint a hub JWT scoped to exactly ONE vault
 * (`vault:<name>:read|write`) and point their agent's MCP client at the hub's
 * public `/vault/<name>/mcp` endpoint. IMPORTANT TRUST NOTE: such a token
 * grants whole-vault access DIRECTLY at the hub, bypassing Prism's per-note
 * grants — which is why routes/mcp.ts only lets `member`+ roles mint (people
 * the owner already trusts with the vault as a whole), never guests/links.
 *
 * Minting shells out to the Parachute CLI (operator-token identity), same
 * posture as vault-provision.ts:
 *   parachute auth mint-token --scope vault:<name>:<verb> --expires-in <s> --sub <sub>
 * Revocation: parachute auth revoke-token <jti> (hub enforces within ~60s).
 * Both are execFile with ARGS ARRAYS (no shell), and both are INJECTABLE so the
 * routes are unit-testable without the CLI or a live hub.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export interface MintedToken {
  token: string;
  jti: string;
  /** exp claim, in ms since epoch. */
  expiresAt: number;
  scope: string;
}

export type TokenMinter = (opts: { vaultName: string; verb: "read" | "write"; expiresInSeconds: number; sub: string }) => Promise<MintedToken>;
export type TokenRevoker = (jti: string) => Promise<void>;

/** Decode a JWT's payload without verifying — we only need jti/exp/scope of a
 *  token the hub JUST minted for us over a trusted local exec channel. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

const defaultMinter: TokenMinter = async ({ vaultName, verb, expiresInSeconds, sub }) => {
  const scope = `vault:${vaultName}:${verb}`;
  const { stdout } = await pExecFile("parachute", [
    "auth",
    "mint-token",
    "--scope",
    scope,
    "--expires-in",
    String(expiresInSeconds),
    "--sub",
    sub,
  ]);
  const token = stdout.trim();
  if (!token || token.split(".").length !== 3) throw new Error("mint-token did not return a JWT");
  const payload = decodeJwtPayload(token);
  const jti = typeof payload.jti === "string" ? payload.jti : "";
  const exp = typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  if (!jti || !exp) throw new Error("minted token is missing jti/exp");
  return { token, jti, expiresAt: exp, scope };
};

const defaultRevoker: TokenRevoker = async (jti) => {
  await pExecFile("parachute", ["auth", "revoke-token", jti]);
};

let minter: TokenMinter = defaultMinter;
let revoker: TokenRevoker = defaultRevoker;

/** Override the CLI minter (tests). Pass null to restore the default. */
export function setTokenMinter(fn: TokenMinter | null): void {
  minter = fn ?? defaultMinter;
}
/** Override the CLI revoker (tests). Pass null to restore the default. */
export function setTokenRevoker(fn: TokenRevoker | null): void {
  revoker = fn ?? defaultRevoker;
}

export function mintVaultToken(opts: Parameters<TokenMinter>[0]): Promise<MintedToken> {
  return minter(opts);
}
export function revokeVaultToken(jti: string): Promise<void> {
  return revoker(jti);
}
