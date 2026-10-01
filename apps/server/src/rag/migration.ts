import type Database from "better-sqlite3";

/** Bump whenever chunk boundaries or normalization change. */
export const CHUNKER_ID = "paragraph-1200-200-v1";

/** Additive, one-time migration. Retain the previous primary index for rollback. */
export function initializeScopedIndex(db: Database.Database, primaryVaultId: string): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, idx INTEGER NOT NULL,
        model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL,
        text TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS embeddings_v2 (
        vault_id TEXT NOT NULL, model TEXT NOT NULL, chunker TEXT NOT NULL,
        note_id TEXT NOT NULL, idx INTEGER NOT NULL, dim INTEGER NOT NULL,
        vec BLOB NOT NULL, text TEXT NOT NULL, content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (vault_id, model, chunker, note_id, idx)
      );
      CREATE INDEX IF NOT EXISTS embeddings_v2_note ON embeddings_v2(vault_id, note_id);
      CREATE TABLE IF NOT EXISTS search_index_migrations (
        id TEXT PRIMARY KEY, primary_vault_id TEXT NOT NULL, applied_at INTEGER NOT NULL
      );
    `);
    if (!db.prepare("SELECT 1 FROM search_index_migrations WHERE id = 'scoped-v2'").get()) {
      db.prepare(`INSERT INTO embeddings_v2
        (vault_id, model, chunker, note_id, idx, dim, vec, text, content_hash, updated_at)
        SELECT ?, model, ?, note_id, idx, dim, vec, text, content_hash, updated_at FROM embeddings`).run(primaryVaultId, CHUNKER_ID);
      db.prepare("INSERT INTO search_index_migrations VALUES ('scoped-v2', ?, ?)").run(primaryVaultId, Date.now());
    }
  })();
}
