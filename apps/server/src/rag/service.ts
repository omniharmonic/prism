/**
 * RAG service: index notes into the vector store, and answer queries with
 * HYBRID retrieval (dense vectors + sparse full-text), fused via RRF. The server
 * owns indexing and retrieval; the legacy desktop can also submit notes through
 * the admin HTTP routes. Every index operation is scoped to a vault.
 */
import { createHash } from "node:crypto";
import { vaultClient, type Note } from "../parachute";
import { getEmbedder } from "./embedder";
import { chunkNote, toPlainText } from "./chunk";
import {
  upsertNoteChunks,
  removeNoteChunks,
  indexedHash,
  queryTopK,
  indexStats,
  indexScope,
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
  vaultId?: string,
): Promise<IndexResult> {
  const embedder = getEmbedder();
  const scope = indexScope(vaultId);
  const hash = contentHash(content ?? "");
  if (!force && indexedHash(noteId, embedder.id, scope) === hash) {
    return { noteId, status: "skipped", chunks: 0 };
  }
  const chunks = chunkNote(content ?? "");
  if (chunks.length === 0) {
    removeNoteChunks(noteId, scope);
    return { noteId, status: "empty", chunks: 0 };
  }
  const vectors = await embedder.embed(chunks.map((c) => c.text));
  const inputs: ChunkInput[] = chunks.map((c, i) => ({ idx: c.index, text: c.text, vec: vectors[i]! }));
  upsertNoteChunks(noteId, hash, embedder.id, inputs, scope);
  return { noteId, status: "indexed", chunks: inputs.length };
}

export function deindexNote(noteId: string, vaultId?: string): void {
  removeNoteChunks(noteId, indexScope(vaultId));
}

/**
 * Legacy synchronous rebuild contract. New clients use durable jobs. Keep only
 * one document body in memory; unchanged contents are hash-skipped.
 */
export async function reindexAll(opts: { force?: boolean; limit?: number; vaultId?: string } = {}): Promise<{
  total: number;
  indexed: number;
  skipped: number;
}> {
  const vault = vaultClient(opts.vaultId);
  const notes = await vault.listNotes({ limit: opts.limit ?? 50000 });
  let indexed = 0;
  let skipped = 0;
  for (const n of notes) {
    const current = await vault.getNote(n.id);
    const r = await indexNote(n.id, current.content ?? "", opts.force, opts.vaultId);
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
 * RRF. Returns full Note objects (with tags) and applies the caller’s
 * view authorization before selecting visible results. `candidatePool` widens each signal
 * before fusion; the final list is truncated to `limit`.
 */
export async function semanticSearch(query: string, limit: number, canRead: (note: Note) => boolean, vaultId: string): Promise<SemanticHit[]> {
  const q = query.trim();
  if (!q) return [];
  const embedder = getEmbedder();
  const pool = Math.max(limit * 3, 30);
  const vault = vaultClient(vaultId);
  const scope = indexScope(vaultId);

  // Dense: top chunks → best chunk per note (preserves the snippet).
  const [qvec] = await embedder.embed([q]);
  const denseChunks = qvec ? queryTopK(embedder.id, qvec, pool * 2, scope) : [];
  const bestChunk = new Map<string, { score: number; snippet: string; contentHash: string }>();
  const denseOrder: string[] = [];
  for (const c of denseChunks) {
    if (!bestChunk.has(c.noteId)) denseOrder.push(c.noteId);
    const cur = bestChunk.get(c.noteId);
    if (!cur || c.score > cur.score) bestChunk.set(c.noteId, { score: c.score, snippet: c.text, contentHash: c.contentHash });
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
    // Filter before the visible limit. A hidden hit must not consume a result slot.
    if (!canRead(note)) continue;
    const indexed = bestChunk.get(f.id);
    const current = indexed?.contentHash === contentHash(note.content ?? "");
    // Old vectors/snippets can contain removed private text even when the note is
    // now visible. Keep a fresh keyword match, otherwise wait for reindexing.
    if (indexed && !current && !noteById.has(f.id)) continue;
    const snip = indexed && current ? indexed.snippet : toPlainText(note.content ?? "");
    hits.push({ note, score: f.score, snippet: snip.slice(0, 280) });
  }
  return hits;
}

export function stats(vaultId?: string) {
  return indexStats(getEmbedder(), indexScope(vaultId));
}
