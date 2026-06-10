/**
 * RAG service: index notes into the vector store, and answer queries with
 * HYBRID retrieval (dense vectors + sparse full-text), fused via RRF. The server
 * owns the index and the query path; the Rust backend's scheduled indexer feeds
 * the same store through the owner-only HTTP routes (see routes/rag.ts), so the
 * heavy embedding workflow lives in Rust while web/server get search instantly.
 */
import { createHash } from "node:crypto";
import { vault, type Note } from "../parachute";
import { getEmbedder } from "./embedder";
import { chunkNote } from "./chunk";
import {
  upsertNoteChunks,
  removeNoteChunks,
  indexedHash,
  queryTopK,
  indexStats,
  type ChunkInput,
} from "./store";
import { reciprocalRankFusion } from "./fusion";

const contentHash = (s: string): string => createHash("sha1").update(s).digest("hex");

export interface IndexResult {
  noteId: string;
  status: "indexed" | "skipped" | "empty";
  chunks: number;
}

/**
 * Embed and store a note's chunks. Skips work when the note content is unchanged
 * since last index (same hash, same model) unless `force`. An empty note clears
 * its rows.
 */
export async function indexNote(
  noteId: string,
  content: string,
  force = false,
): Promise<IndexResult> {
  const embedder = getEmbedder();
  const hash = contentHash(content ?? "");
  if (!force && indexedHash(noteId, embedder.id) === hash) {
    return { noteId, status: "skipped", chunks: 0 };
  }
  const chunks = chunkNote(content ?? "");
  if (chunks.length === 0) {
    removeNoteChunks(noteId);
    return { noteId, status: "empty", chunks: 0 };
  }
  const vectors = await embedder.embed(chunks.map((c) => c.text));
  const inputs: ChunkInput[] = chunks.map((c, i) => ({ idx: c.index, text: c.text, vec: vectors[i]! }));
  upsertNoteChunks(noteId, hash, embedder.id, inputs);
  return { noteId, status: "indexed", chunks: inputs.length };
}

export function deindexNote(noteId: string): void {
  removeNoteChunks(noteId);
}

/**
 * Rebuild the index from the vault (owner-triggered). Pulls notes with content
 * and indexes each (incrementally — unchanged notes are skipped).
 */
export async function reindexAll(opts: { force?: boolean; limit?: number } = {}): Promise<{
  total: number;
  indexed: number;
  skipped: number;
}> {
  const notes = await vault.listNotes({ includeContent: true, limit: opts.limit ?? 50000 });
  let indexed = 0;
  let skipped = 0;
  for (const n of notes) {
    const r = await indexNote(n.id, n.content ?? "", opts.force);
    if (r.status === "indexed") indexed++;
    else skipped++;
  }
  return { total: notes.length, indexed, skipped };
}

export interface SemanticHit {
  note: Note;
  score: number;
  snippet: string;
}

/**
 * Hybrid semantic search: dense (vector) + sparse (vault full-text), fused with
 * RRF. Returns full Note objects (with tags) so the caller can apply the same
 * effectiveLevel authorization as /search. `candidatePool` widens each signal
 * before fusion; the final list is truncated to `limit`.
 */
export async function semanticSearch(query: string, limit = 20): Promise<SemanticHit[]> {
  const q = query.trim();
  if (!q) return [];
  const embedder = getEmbedder();
  const pool = Math.max(limit * 3, 30);

  // Dense: top chunks → best chunk per note (preserves the snippet).
  const [qvec] = await embedder.embed([q]);
  const denseChunks = qvec ? queryTopK(embedder.id, qvec, pool * 2) : [];
  const bestChunk = new Map<string, { score: number; snippet: string }>();
  const denseOrder: string[] = [];
  for (const c of denseChunks) {
    if (!bestChunk.has(c.noteId)) denseOrder.push(c.noteId);
    const cur = bestChunk.get(c.noteId);
    if (!cur || c.score > cur.score) bestChunk.set(c.noteId, { score: c.score, snippet: c.text });
  }

  // Sparse: vault full-text (also gives us hydrated notes for free).
  let sparseNotes: Note[] = [];
  try {
    sparseNotes = await vault.search(q, [], pool);
  } catch {
    /* FTS unavailable — fall back to dense-only */
  }
  const sparseOrder = sparseNotes.map((n) => n.id);
  const noteById = new Map<string, Note>(sparseNotes.map((n) => [n.id, n]));

  // Fuse the two rankings.
  const fused = reciprocalRankFusion({ dense: denseOrder.slice(0, pool), sparse: sparseOrder });

  // Hydrate any fused note we don't already have (dense-only hits).
  const hits: SemanticHit[] = [];
  for (const f of fused) {
    if (hits.length >= limit) break;
    let note = noteById.get(f.id);
    if (!note) {
      try {
        note = await vault.getNote(f.id);
      } catch {
        continue; // note deleted since indexing — skip
      }
    }
    const snip = bestChunk.get(f.id)?.snippet ?? "";
    hits.push({ note, score: f.score, snippet: snip.slice(0, 280) });
  }
  return hits;
}

export function stats() {
  return indexStats(getEmbedder());
}
