/**
 * `seed` — seed the canonical tag schemas into the vault, WITHOUT rewriting
 * `.env`. The standalone entrypoint the `prism-setup-schema` skill drives (the
 * full `prism-setup.ts` also seeds, but this lets you re-seed/verify on its own).
 * Idempotent + additive-only (see scripts/lib/seed-tag-schemas.ts safety contract).
 *
 *   cd apps/server && node --env-file-if-exists=.env --import tsx scripts/seed.ts
 *   ...                                                          scripts/seed.ts --dry-run
 */
import { seedTagSchemas } from "./lib/seed-tag-schemas";
import { tryMintEphemeralAdminToken } from "../src/mcp-token";

const DRY_RUN = process.argv.includes("--dry-run");
const vaultUrl = process.env.PARACHUTE_URL;
const vault = process.env.PARACHUTE_VAULT;
const token = process.env.PARACHUTE_TOKEN;

if (!vaultUrl || !vault || !token) {
  console.error("✗ Set PARACHUTE_URL, PARACHUTE_VAULT, PARACHUTE_TOKEN (e.g. via apps/server/.env).");
  process.exit(1);
}

// Vault ≥0.7.1 gates schema writes behind vault:<name>:admin — mint a 1h one
// (or honour PARACHUTE_ADMIN_TOKEN); falls back to the write token on 0.6.x.
const adminToken = DRY_RUN ? undefined : await tryMintEphemeralAdminToken(vault);

seedTagSchemas({ vaultUrl, vault, token, adminToken, dryRun: DRY_RUN, log: (m) => console.log("  " + m) })
  .then((r) => {
    console.log(
      `\n${DRY_RUN ? "[dry-run] " : ""}created:${r.created.length} updated:${r.updated.length} unchanged:${r.unchanged.length} skipped:${r.skipped.length}`,
    );
    if (r.created.length) console.log(`  created: ${r.created.join(", ")}`);
    if (r.updated.length) console.log(`  updated: ${r.updated.join(", ")}`);
    // Idempotency hint: a clean second run should be all-unchanged.
    if (!DRY_RUN && (r.created.length || r.updated.length)) {
      console.log("  (run again — a second pass should report created:0 updated:0)");
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error(`✗ seed failed: ${(e as Error).message}`);
    process.exit(1);
  });
