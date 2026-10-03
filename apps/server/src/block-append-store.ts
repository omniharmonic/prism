/** Idempotency receipts for POST /api/notes/:id/blocks/append (routes/blocks.ts). Kept apart so tests can reset the table without loading the route. */
import { db } from "./db";

db.exec(`
  CREATE TABLE IF NOT EXISTS block_append_receipts (
    vault_id   TEXT NOT NULL,
    note_id    TEXT NOT NULL,
    actor      TEXT NOT NULL,
    request_id TEXT NOT NULL,
    body_hash  TEXT NOT NULL,
    live       INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (vault_id, note_id, actor, request_id)
  );
`);
export const BLOCK_APPEND_TABLE = "block_append_receipts";
