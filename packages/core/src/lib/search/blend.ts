/**
 * NP-SR-05: one result list from ranked (semantic) and keyword (full-text)
 * search. Both lists are already permission-filtered by the server; this only
 * orders and de-duplicates them.
 *
 *  1. keyword hits whose TITLE contains every query term (someone typing a
 *     page's name wants that page first),
 *  2. ranked hits, in rank order,
 *  3. the remaining keyword hits.
 *
 * A page found by both appears once, as the ranked row (it carries the matching
 * passage), at the better of its two positions.
 */
import { containerTitle } from "../pages/containerTitle";

export interface BlendRow { id: string; path?: string | null }

// The name the page is shown by: a container-named page (`…/food-chain/PROJECT`) matches on its folder's name.
const titleOf = (row: BlendRow) => (containerTitle(row.path) ?? (row.path ?? "").split("/").pop() ?? "").toLowerCase();

export function blendResults<T extends BlendRow>(ranked: T[], keyword: T[], terms: string[], limit = 100): T[] {
  const wanted = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const byId = new Map(ranked.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const out: T[] = [];
  const push = (row: T) => {
    if (seen.has(row.id) || out.length >= limit) return;
    seen.add(row.id);
    out.push(byId.get(row.id) ?? row);
  };
  if (wanted.length) for (const row of keyword) { const title = titleOf(row); if (wanted.every((t) => title.includes(t))) push(row); }
  for (const row of ranked) push(row);
  for (const row of keyword) push(row);
  return out;
}
