/**
 * Mint a server session for the OWNER and print its id — so an e2e/browser run
 * can drive the owner-only UI (the Network surface, etc.) by setting the
 * `prism_session=<id>` cookie, without the magic-link email round-trip.
 *
 *   node --env-file=.env --import tsx scripts/mk-owner-session.ts
 *   → prints the session id (use as the prism_session cookie value)
 *
 * The session is a normal DB row (revocable by deleting it); pass `--clean` to
 * purge all sessions for the owner email.
 */
import { randomUUID } from "node:crypto";
import { config } from "../src/config";
import { createSession, db } from "../src/db";

if (process.argv.includes("--clean")) {
  db.prepare("DELETE FROM sessions WHERE email = ?").run(config.ownerEmail);
  console.error(`cleaned sessions for ${config.ownerEmail}`);
  process.exit(0);
}

const id = randomUUID();
createSession(id, config.ownerEmail, 24 * 60 * 60 * 1000); // 24h
process.stdout.write(id);
