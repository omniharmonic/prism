/**
 * `render:mcp` — render the project `.mcp.json` from the template using the
 * Parachute config in the environment (e.g. apps/server/.env). Idempotent.
 *
 *   cd apps/server && node --env-file-if-exists=.env --import tsx scripts/render-mcp.ts
 *   ...                                                                    scripts/render-mcp.ts --dry-run
 */
import { renderMcp } from "./lib/render-mcp";

const DRY_RUN = process.argv.includes("--dry-run");
const url = process.env.PARACHUTE_URL;
const vault = process.env.PARACHUTE_VAULT;
const token = process.env.PARACHUTE_TOKEN;

if (!url || !vault || !token) {
  console.error("✗ Set PARACHUTE_URL, PARACHUTE_VAULT, PARACHUTE_TOKEN (e.g. via apps/server/.env).");
  process.exit(1);
}

try {
  const r = renderMcp({ url, vault, token, dryRun: DRY_RUN });
  const masked = r.content.replace(token, `${token.slice(0, 4)}…${token.slice(-2)}`);
  console.log(`${DRY_RUN ? "[dry-run] would write" : "✓ Wrote"} ${r.outPath}`);
  console.log(masked);
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
