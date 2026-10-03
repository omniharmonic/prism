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
// `live`: 0 = written to the vault, 1 = through the live document and durable,
// 2 = ENTERED the live document but not yet confirmed durable (the request was
// answered 503 `not_confirmed`). `applied` = "<yjs client>:<clock>" of the live
// document right after the append — the evidence a retry checks instead of
// appending a second copy.
if (!(db.prepare("PRAGMA table_info(block_append_receipts)").all() as Array<{ name: string }>).some((c) => c.name === "applied")) {
  db.exec("ALTER TABLE block_append_receipts ADD COLUMN applied TEXT");
}
export const BLOCK_APPEND_TABLE = "block_append_receipts";
