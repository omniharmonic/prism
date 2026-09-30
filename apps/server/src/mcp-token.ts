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
 *   parachute auth mint-token --scope vault:<name>:<verb> --expires-in <s> --service <sub>
 * `--service` is what keeps `sub = mcp:<email>` on hub ≥0.7.18 — there `--sub`
 * is deprecated and silently becomes a LABEL, stamping the OPERATOR's account id
 * as `sub` (hub#872), so the vault would attribute a member agent's writes to
 * the owner. Hub 0.7.1 has no `--service` (it rejects it as `unknown flag`),
 * so on that exact error we retry once with `--sub`, which 0.7.1 honours.
 * Revocation: parachute auth revoke-token <jti> (hub enforces within ~60s).
 * Both are execFile with ARGS ARRAYS (no shell), and both are INJECTABLE so the
 * routes are unit-testable without the CLI or a live hub.
 *
 * `mintEphemeralAdminToken` is the admin seam for the operations vault 0.7.9
 * gates behind `vault:<name>:admin` (tag-schema writes, history compaction):
 * a 1h `--ephemeral` token minted per use, so no standing admin credential is
 * stored anywhere. `PARACHUTE_ADMIN_TOKEN` overrides it (e.g. a box without the
 * CLI) — it is used verbatim for every vault, so scope it to match.
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

/** Runs the `parachute` CLI and returns stdout. Injectable for tests. */
export type CliRunner = (args: string[]) => Promise<string>;
const defaultCli: CliRunner = async (args) => (await pExecFile("parachute", args)).stdout;
let cli: CliRunner = defaultCli;
/** Override the CLI runner (tests). Pass null to restore the default. */
export function setCliRunner(fn: CliRunner | null): void {
  cli = fn ?? defaultCli;
}

/** True when the CLI failed because it doesn't know `flag` (hub 0.7.1 prints
 *  `parachute auth mint-token: unknown flag "--service"` and exits 1). */
function isUnknownFlag(err: unknown, flag: string): boolean {
  const e = err as { stderr?: unknown; message?: unknown };
  const text = `${typeof e?.stderr === "string" ? e.stderr : ""} ${typeof e?.message === "string" ? e.message : ""}`;
  return text.includes(`unknown flag "${flag}"`);
}

function parseMinted(stdout: string, scope: string): MintedToken {
  const token = stdout.trim();
  if (!token || token.split(".").length !== 3) throw new Error("mint-token did not return a JWT");
  const payload = decodeJwtPayload(token);
  const jti = typeof payload.jti === "string" ? payload.jti : "";
  const exp = typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  if (!jti || !exp) throw new Error("minted token is missing jti/exp");
  return { token, jti, expiresAt: exp, scope };
}

const defaultMinter: TokenMinter = async ({ vaultName, verb, expiresInSeconds, sub }) => {
  const scope = `vault:${vaultName}:${verb}`;
  const base = ["auth", "mint-token", "--scope", scope, "--expires-in", String(expiresInSeconds)];
  let stdout: string;
  try {
    stdout = await cli([...base, "--service", sub]);
  } catch (err) {
    if (!isUnknownFlag(err, "--service")) throw err;
    stdout = await cli([...base, "--sub", sub]); // hub < 0.7.18
  }
  return parseMinted(stdout, scope);
};

/**
 * Mint a short-lived (1h, `--ephemeral`) `vault:<name>:admin` token for one
 * admin operation. `PARACHUTE_ADMIN_TOKEN` (if set) wins and is returned as-is.
 */
export async function mintEphemeralAdminToken(vaultName: string): Promise<string> {
  const override = process.env.PARACHUTE_ADMIN_TOKEN?.trim();
  if (override) return override;
  const scope = `vault:${vaultName}:admin`;
  return parseMinted(await cli(["auth", "mint-token", "--scope", scope, "--ephemeral"]), scope).token;
}

const defaultRevoker: TokenRevoker = async (jti) => {
  await cli(["auth", "revoke-token", jti]);
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

/** Best-effort {@link mintEphemeralAdminToken}: `undefined` when the CLI isn't
 *  available or refuses (callers then fall back to their write token, which is
 *  still enough on vault 0.6.x). */
export async function tryMintEphemeralAdminToken(vaultName: string): Promise<string | undefined> {
  try {
    return await mintEphemeralAdminToken(vaultName);
  } catch {
    return undefined;
  }
}
