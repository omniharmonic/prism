/**
 * Enable SERVER-SIDE Fathom transcript sync for the primary vault: store the
 * Fathom API key (from the desktop config) in the secret store, then run one
 * ingest pass to confirm the connection. No cursor needed — Fathom ingest dedupes
 * by source_id, so it's create-only and safe to run alongside the desktop.
 *
 *   DB_PATH=/Users/benjaminlife/dev/prism/apps/server/prism-server.db \
 *   node --env-file=/Users/benjaminlife/dev/prism/apps/server/.env \
 *        --import tsx scripts/enable-fathom-cutover.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

async function main() {
  const { putSecret } = await import("../src/secrets.js");
  const { config } = await import("../src/config.js");
  const { runFathomOnce } = await import("../src/worker/scheduler.js");
  const { resolveVaultEntry } = await import("../src/db.js");

  const cfg = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/prism/prism-config.json`, "utf8"));
  const apiKey = String(cfg.fathom_api_key || "");
  if (!apiKey) throw new Error("no fathom_api_key in desktop config");

  putSecret("primary", config.ownerEmail, "fathom", JSON.stringify({ apiKey }));
  console.log(`✓ stored fathom secret for primary / ${config.ownerEmail}`);

  const created = await runFathomOnce(resolveVaultEntry("primary"));
  console.log(`✓ connection OK — first pass ingested ${created} new transcript(s) (0 = nothing new in the last 7d, expected)`);
  console.log("Server-side Fathom is enabled; the worker will ingest new recordings on its interval.");
  process.exit(0);
}

main().catch((e) => {
  console.error("enable-fathom failed:", e);
  process.exit(1);
});
