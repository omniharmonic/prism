/**
 * Vault provisioning seam for in-app vault CREATE (the LINK path needs no CLI —
 * it just persists {url,vault,token}).
 *
 * Creating a new vault shells out to the Parachute CLI:
 *   parachute-vault create <name> --mint --scope write --no-mirror --json
 * which authenticates via the host operator token (~/.parachute/operator.token)
 * and emits `{ name, token, ... }` on stdout. We use execFile with an ARGS ARRAY
 * (never a shell string) so a vault name can't be a shell-injection vector — the
 * route also validates the name against ^[a-z0-9_-]+$ as defense-in-depth.
 *
 * The creator and the schema-seeder are both INJECTABLE (setVaultCreator /
 * setVaultSeeder) so the create path is unit-testable without spawning the CLI or
 * touching a live hub.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { seedTagSchemas, type SeedResult } from "../scripts/lib/seed-tag-schemas";

const pExecFile = promisify(execFile);

export interface CreatedVault {
  name: string;
  token: string;
  [k: string]: unknown;
}

export type VaultCreator = (name: string) => Promise<CreatedVault>;
export type VaultSeeder = (opts: { vaultUrl: string; vault: string; token: string }) => Promise<SeedResult>;

const defaultCreator: VaultCreator = async (name) => {
  const { stdout } = await pExecFile("parachute-vault", [
    "create",
    name,
    "--mint",
    "--scope",
    "write",
    "--no-mirror",
    "--json",
  ]);
  let parsed: CreatedVault;
  try {
    parsed = JSON.parse(stdout) as CreatedVault;
  } catch {
    throw new Error("parachute-vault create did not return JSON");
  }
  if (!parsed?.token || !parsed?.name) {
    // Never echo stdout here — it carries the freshly minted token.
    throw new Error("parachute-vault create returned no token");
  }
  return parsed;
};

const defaultSeeder: VaultSeeder = (opts) => seedTagSchemas(opts);

let creator: VaultCreator = defaultCreator;
let seeder: VaultSeeder = defaultSeeder;

/** Override the CLI creator (tests). Pass null to restore the default. */
export function setVaultCreator(fn: VaultCreator | null): void {
  creator = fn ?? defaultCreator;
}
/** Override the schema seeder (tests). Pass null to restore the default. */
export function setVaultSeeder(fn: VaultSeeder | null): void {
  seeder = fn ?? defaultSeeder;
}

export function createVaultViaCli(name: string): Promise<CreatedVault> {
  return creator(name);
}
export function seedVault(opts: { vaultUrl: string; vault: string; token: string }): Promise<SeedResult> {
  return seeder(opts);
}
