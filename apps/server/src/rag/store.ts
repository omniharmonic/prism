/** Exact cosine retrieval isolated by vault, model and chunker. No new infrastructure. */
import { db, resolveVaultEntry } from "../db";
import { cosine, type Embedder } from "./embedder";
import { CHUNKER_ID, initializeScopedIndex } from "./migration";

initializeScopedIndex(db, resolveVaultEntry().id);
export interface IndexScope { vaultId: string; chunker: string }
export const indexScope = (vaultId = resolveVaultEntry().id): IndexScope => ({ vaultId, chunker: CHUNKER_ID });
const namespace = (scope: IndexScope, model: string) => [scope.vaultId, model, scope.chunker];
const deleteNote = db.prepare("DELETE FROM embeddings_v2 WHERE vault_id = ? AND note_id = ?");
const deleteVersion = db.prepare("DELETE FROM embeddings_v2 WHERE vault_id = ? AND model = ? AND chunker = ? AND note_id = ?");
const insertChunk = db.prepare(`INSERT INTO embeddings_v2 (vault_id, model, chunker, note_id, idx, dim, vec, text, content_hash, updated_at)
  VALUES (@vault_id, @model, @chunker, @note_id, @idx, @dim, @vec, @text, @content_hash, @updated_at)`);
const selectHash = db.prepare("SELECT content_hash FROM embeddings_v2 WHERE vault_id = ? AND model = ? AND chunker = ? AND note_id = ? LIMIT 1");
const selectChunks = db.prepare("SELECT note_id, idx, dim, vec, text, content_hash FROM embeddings_v2 WHERE vault_id = ? AND model = ? AND chunker = ? AND dim = ?");
const countChunks = db.prepare("SELECT COUNT(*) AS n FROM embeddings_v2 WHERE vault_id = ? AND model = ? AND chunker = ?");
const countNotes = db.prepare("SELECT COUNT(DISTINCT note_id) AS n FROM embeddings_v2 WHERE vault_id = ? AND model = ? AND chunker = ?");
const selectIds = db.prepare("SELECT DISTINCT note_id FROM embeddings_v2 WHERE vault_id = ? AND model = ? AND chunker = ?");
const selectAllIds = db.prepare("SELECT DISTINCT note_id FROM embeddings_v2 WHERE vault_id = ?");

export interface StoredChunk { chunkId: string; noteId: string; idx: number; vec: Float32Array; text: string }
export interface ChunkInput { idx: number; text: string; vec: Float32Array }
export interface ScoredChunk { contentHash: string; noteId: string; idx: number; text: string; score: number }

/** Preserve previous model/chunker generations until explicit deletion or retirement. */
export const upsertNoteChunks = db.transaction((noteId: string, contentHash: string, model: string, chunks: ChunkInput[], scope = indexScope()) => {
  deleteVersion.run(...namespace(scope, model), noteId);
  for (const chunk of chunks) {
    if (!chunk.vec.length || ![...chunk.vec].every(Number.isFinite)) throw new Error("Invalid embedding vector");
    insertChunk.run({ vault_id: scope.vaultId, model, chunker: scope.chunker, note_id: noteId, idx: chunk.idx,
      dim: chunk.vec.length, vec: Buffer.from(chunk.vec.buffer, chunk.vec.byteOffset, chunk.vec.byteLength),
      text: chunk.text, content_hash: contentHash, updated_at: Date.now() });
  }
});

/** A removed note loses all model/chunker generations, only in its own vault. */
export function removeNoteChunks(noteId: string, scope = indexScope()): void { deleteNote.run(scope.vaultId, noteId); }
export function indexedHash(noteId: string, model: string, scope = indexScope()): string | null {
  return (selectHash.get(...namespace(scope, model), noteId) as { content_hash: string } | undefined)?.content_hash ?? null;
}
export function indexedNoteIds(model: string, scope = indexScope()): Set<string> {
  return new Set((selectIds.all(...namespace(scope, model)) as { note_id: string }[]).map(row => row.note_id));
}
export function allIndexedNoteIds(scope = indexScope()): Set<string> {
  return new Set((selectAllIds.all(scope.vaultId) as { note_id: string }[]).map(row => row.note_id));
}

/** Bounded top-K memory; mismatched dimensions and corrupt vectors cannot enter ranking. */
export function queryTopK(model: string, query: Float32Array, k: number, scope = indexScope()): ScoredChunk[] {
  const top: ScoredChunk[] = [];
  if (!Number.isInteger(k) || k < 1 || !query.length || ![...query].every(Number.isFinite)) return top;
  for (const raw of selectChunks.iterate(...namespace(scope, model), query.length)) {
    const row = raw as { note_id: string; idx: number; dim: number; vec: Buffer; text: string; content_hash: string };
    if (row.vec.byteLength !== row.dim * 4) continue;
    const vector = new Float32Array(new Uint8Array(row.vec).buffer);
    const score = cosine(query, vector);
    if (!Number.isFinite(score)) continue;
    const candidate = { noteId: row.note_id, idx: row.idx, text: row.text, contentHash: row.content_hash, score };
    const position = top.findIndex(item => score > item.score || (score === item.score && `${candidate.noteId}:${candidate.idx}` < `${item.noteId}:${item.idx}`));
    if (position >= 0) top.splice(position, 0, candidate);
    else if (top.length < k) top.push(candidate);
    if (top.length > k) top.pop();
  }
  return top;
}

export function indexStats(embedder: Embedder, scope = indexScope()) {
  return { model: embedder.id, vaultId: scope.vaultId, chunker: scope.chunker,
    chunks: (countChunks.get(...namespace(scope, embedder.id)) as { n: number }).n,
    notes: (countNotes.get(...namespace(scope, embedder.id)) as { n: number }).n };
}
