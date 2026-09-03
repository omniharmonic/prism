/**
 * One-off cutover: enable SERVER-SIDE Matrix sync for the primary vault.
 *   1. store the Matrix credential (from the desktop config) in the secret store,
 *   2. set the worker's /sync cursor to NOW — so the server takes over for NEW
 *      messages going forward and does NOT re-ingest the backlog the desktop
 *      already wrote (no duplicate/format mess in existing notes).
 *
 * Run against the LIVE server's db + secret key (so the running worker can read
 * what we write):
 *   DB_PATH=/Users/benjaminlife/dev/prism/apps/server/prism-server.db \
 *   node --env-file=/Users/benjaminlife/dev/prism/apps/server/.env \
 *        --import tsx scripts/enable-matrix-cutover.ts
 * Idempotent: re-running won't reset an existing cursor.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

async function main() {
  const { putSecret } = await import("../src/secrets.js");
  const { getWorkerCursor, setWorkerCursor } = await import("../src/db.js");
  const { config } = await import("../src/config.js");
  const { MatrixClient } = await import("../src/worker/matrix.js");

  const cfg = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/prism/prism-config.json`, "utf8"));
  const creds = { homeserver: String(cfg.matrix_homeserver).replace(/\/+$/, ""), accessToken: String(cfg.matrix_access_token) };
  if (!creds.homeserver || !creds.accessToken) throw new Error("no matrix creds in desktop config");

  putSecret("primary", config.ownerEmail, "matrix", JSON.stringify(creds));
  console.log(`✓ stored matrix secret for primary / ${config.ownerEmail}`);

  const existing = getWorkerCursor("primary", "matrix");
  if (existing) {
    console.log(`✓ cursor already set (resuming) — leaving as-is`);
  } else {
    const client = new MatrixClient(creds);
    console.log(`  whoami: ${await client.whoami()}`);
    const { nextBatch, rooms } = await client.sync();
    setWorkerCursor("primary", "matrix", nextBatch);
    const backlog = rooms.reduce((n, r) => n + r.messages.length, 0);
    console.log(`✓ cutover cursor set to NOW — skipped ${backlog} backlog msgs across ${rooms.length} rooms`);
  }
  console.log("Server-side Matrix is enabled; the running worker will ingest new messages on its next tick (≤60s).");
  process.exit(0);
}

main().catch((e) => {
  console.error("cutover failed:", e);
  process.exit(1);
});
