/**
 * Reciprocal Rank Fusion (RRF) — combine several ranked lists into one without
 * tuning per-signal score scales. Each list contributes 1/(k + rank) to an
 * item's fused score; items ranked highly by multiple signals rise. This is the
 * standard way to merge dense (vector) and sparse (full-text) retrieval into
 * "best of both": vectors catch paraphrase/semantics, FTS catches exact terms
 * and rare tokens. k=60 is the well-known default (Cormack et al.).
 */
export interface FusedItem {
  id: string;
  score: number;
  /** Which input rankings contributed, with the rank (0-based) in each. */
  ranks: Record<string, number>;
}

export function reciprocalRankFusion(
  rankings: Record<string, string[]>,
  k = 60,
): FusedItem[] {
  const acc = new Map<string, FusedItem>();
  for (const [source, ids] of Object.entries(rankings)) {
    ids.forEach((id, rank) => {
      let item = acc.get(id);
      if (!item) {
        item = { id, score: 0, ranks: {} };
        acc.set(id, item);
      }
      item.score += 1 / (k + rank);
      item.ranks[source] = rank;
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}
