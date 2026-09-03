/**
 * Live integration check for hub vault-token validation (Phase 0.1).
 * Mints a real, short-lived, READ-ONLY hub token and runs it through the same
 * scope-guard path the server will use — proving the full chain end-to-end:
 * JWKS fetch + RS256 signature + issuer pin + audience strict-check + scope.
 *
 * Safe to run against the live local hub: it only mints an EPHEMERAL read token
 * and never reads or writes vault data. Needs the hub reachable (default
 * localhost:1939). Run from apps/server:
 *
 *   node --import tsx scripts/verify-vault-token.ts
 *
 * It sets PARACHUTE_HUB_ORIGIN from the freshly minted token's own `iss` (so it
 * validates against whatever origin the hub stamps) and fetches JWKS over
 * loopback — the exact prod posture.
 */
import { execSync } from "node:child_process";

function decodeClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("not a 3-part JWT");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
}

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
}

async function main() {
  const VAULT = process.env.PARACHUTE_VAULT ?? "default";

  console.log("=== minting an ephemeral read token ===");
  const token = execSync(`parachute auth mint-token --scope vault:${VAULT}:read --ephemeral`, {
    encoding: "utf8",
  }).trim();
  const claims = decodeClaims(token);
  const iss = String(claims.iss);
  console.log(`  iss=${iss}  aud=${claims.aud}  scope=${claims.scope ?? claims.scopes}`);

  // Validate `iss` against the origin the hub actually stamped; fetch JWKS over
  // loopback (the co-located posture). Set BEFORE importing the validator, which
  // reads config at module load — hence the dynamic import below.
  process.env.PARACHUTE_HUB_ORIGIN = iss;
  process.env.PARACHUTE_HUB_JWKS_ORIGIN = process.env.PARACHUTE_HUB_JWKS_ORIGIN ?? "http://127.0.0.1:1939";

  const { verifyVaultToken, HubJwtError } = await import("../src/auth/vault-token.js");

  console.log("\n=== 1. a valid token for this vault verifies ===");
  try {
    const c = await verifyVaultToken(token, VAULT);
    ok("validateHubJwt + scope + audience all pass", true, `sub=${c.sub} scopes=[${c.scopes}]`);
  } catch (e) {
    ok("validateHubJwt + scope + audience all pass", false, `threw ${(e as Error).message}`);
  }

  console.log("\n=== 2. a tampered token is rejected (signature) ===");
  try {
    const [h, p, s] = token.split(".") as [string, string, string];
    // Flip a byte in the payload so the signature no longer matches.
    const badPayload = (p[0] === "a" ? "b" : "a") + p.slice(1);
    await verifyVaultToken(`${h}.${badPayload}.${s}`, VAULT);
    ok("tampered token throws", false, "did NOT throw");
  } catch (e) {
    const code = e instanceof HubJwtError ? e.code : "(non-HubJwtError)";
    ok("tampered token throws HubJwtError", e instanceof HubJwtError, `code=${code}`);
  }

  console.log("\n=== 3. the same token for a DIFFERENT vault is rejected (audience) ===");
  try {
    await verifyVaultToken(token, `${VAULT}-not-a-real-vault`);
    ok("wrong-vault audience throws", false, "did NOT throw");
  } catch (e) {
    const code = e instanceof HubJwtError ? e.code : "(non-HubJwtError)";
    ok("wrong-vault audience throws HubJwtError", e instanceof HubJwtError, `code=${code}`);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-vault-token crashed:", e);
  process.exit(1);
});
