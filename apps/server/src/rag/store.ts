/**
 * Vector store for semantic search, on the same SQLite db as identity/ACL.
 * One row per (note, chunk): the normalized embedding as a BLOB plus the chunk
 * text and a content hash for incremental re-indexing (skip notes whose content
 * is unchanged). Retrieval is brute-force cosine top-K — exact and simple, and
 * fine for a personal vault (thousands of notes × a few chunks). An ANN index
 * (HNSW / sqlite-vec) is a drop-in upgrade behind `queryTopK` if scale demands.
 */
import { db } from "../db";
import { cosine, type Embedder } from "./embedder";

db.exec(`
  CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id     TEXT PRIMARY KEY,      -- \`\${note_id}#\${idx}\`
    note_id      TEXT NOT NULL,
    idx          INTEGER NOT NULL,
    model        TEXT NOT NULL,         -- embedder id; rows from other models are ignored
    dim          INTEGER NOT NULL,
    vec          BLOB NOT NULL,         -- Float32 LE
    text         TEXT NOT NULL,         -- chunk plain text (for snippets)
    content_hash TEXT NOT NULL,         -- hash of the source note content
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS embeddings_note  ON embeddings(note_id);
  CREATE INDEX IF NOT EXISTS embeddings_model ON embeddings(model);
`);

const delByNote = db.prepare("DELETE FROM embeddings WHERE note_id = ?");
const insertChunk = db.prepare(
  `INSERT INTO embeddings (chunk_id, note_id, idx, model, dim, vec, text, content_hash, updated_at)
   VALUES (@chunk_id, @note_id, @idx, @model, @dim, @vec, @text, @content_hash, @updated_at)
   ON CONFLICT(chunk_id) DO UPDATE SET
     model=@model, dim=@dim, vec=@vec, text=@text, content_hash=@content_hash, updated_at=@updated_at`,
);
const selectHashForNote = db.prepare(
  "SELECT content_hash FROM embeddings WHERE note_id = ? AND model = ? LIMIT 1",
);
const selectByModel = db.prepare(
  "SELECT chunk_id, note_id, idx, vec, text FROM embeddings WHERE model = ?",
);
const countByModel = db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?");
const countNotesByModel = db.prepare(
  "SELECT COUNT(DISTINCT note_id) AS n FROM embeddings WHERE model = ?",
);

function vecToBuf(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function bufToVec(b: Buffer): Float32Array {
  // Copy into an aligned buffer (SQLite blobs aren't guaranteed 4-byte aligned).
  return new Float32Array(new Uint8Array(b).buffer.slice(0));
}

export interface StoredChunk {
  chunkId: string;
  noteId: string;
  idx: number;
  vec: Float32Array;
  text: string;
}

export interface ChunkInput {
  idx: number;
  text: string;
  vec: Float32Array;
}

/** Replace all chunks for a note atomically (delete + insert in one tx). */
export const upsertNoteChunks = db.transaction(
  (noteId: string, contentHash: string, model: string, chunks: ChunkInput[]) => {
    delByNote.run(noteId);
    const ts = Date.now();
    for (const c of chunks) {
      insertChunk.run({
        chunk_id: `${noteId}#${c.idx}`,
        note_id: noteId,
        idx: c.idx,
        model,
        dim: c.vec.length,
        vec: vecToBuf(c.vec),
        text: c.text,
        content_hash: contentHash,
        updated_at: ts,
      });
    }
  },
);

export function removeNoteChunks(noteId: string): void {
  delByNote.run(noteId);
}

/** The content hash currently indexed for a note under `model`, or null. */
export function indexedHash(noteId: string, model: string): string | null {
  const row = selectHashForNote.get(noteId, model) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

export interface ScoredChunk {
  noteId: string;
  idx: number;
  text: string;
  score: number;
}

/**
 * Brute-force cosine top-K chunks for a query vector under one model. Returns
 * chunks (a note may appear multiple times); callers collapse to notes.
 */
export function queryTopK(model: string, query: Float32Array, k: number): ScoredChunk[] {
  const rows = selectByModel.all(model) as Array<{
    note_id: string;
    idx: number;
    vec: Buffer;
    text: string;
  }>;
  const scored = rows.map((r) => ({
    noteId: r.note_id,
    idx: r.idx,
    text: r.text,
    score: cosine(query, bufToVec(r.vec)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function indexStats(embedder: Embedder): { model: string; chunks: number; notes: number } {
  const chunks = (countByModel.get(embedder.id) as { n: number }).n;
  const notes = (countNotesByModel.get(embedder.id) as { n: number }).n;
  return { model: embedder.id, chunks, notes };
}
