import type { Note } from "./parachute";
import { leafTitle } from "@prism/core/pages";

export interface Neighborhood {
  nodes: Array<{
    id: string;
    path: string | null;
    title: string;
    tags: string[];
  }>;
  edges: Array<{ source: string; target: string; relationship: string }>;
  truncated: boolean;
}

/** Callers filter notes with fresh permissions BEFORE this traversal. Hidden
 * nodes cannot connect two visible islands or affect the truncation signal. */
export function graphNeighborhood(
  notes: Note[],
  center: string,
  depth: number,
  limit: number,
): Neighborhood | null {
  const byId = new Map(notes.map((note) => [note.id, note]));
  if (!byId.has(center)) return null;
  const edges = new Map<string, Neighborhood["edges"][number]>();
  const adjacent = new Map<string, Set<string>>();
  for (const note of notes) {
    for (const link of note.links ?? []) {
      if (!byId.has(link.sourceId) || !byId.has(link.targetId)) continue;
      const key = JSON.stringify([
        link.sourceId,
        link.targetId,
        link.relationship,
      ]);
      if (edges.has(key)) continue;
      if (edges.size >= 250_000) throw new Error("graph_inventory_too_large");
      edges.set(key, {
        source: link.sourceId,
        target: link.targetId,
        relationship: link.relationship,
      });
      for (const [a, b] of [
        [link.sourceId, link.targetId],
        [link.targetId, link.sourceId],
      ] as const) {
        if (!adjacent.has(a)) adjacent.set(a, new Set());
        adjacent.get(a)!.add(b);
      }
    }
  }
  const visited = new Set([center]);
  let frontier = [center];
  let truncated = false;
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of [...(adjacent.get(id) ?? [])].sort()) {
        if (visited.has(neighbor)) continue;
        if (visited.size >= limit) {
          truncated = true;
          continue;
        }
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  const visibleEdges = [...edges.values()]
    .filter((edge) => visited.has(edge.source) && visited.has(edge.target))
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        a.relationship.localeCompare(b.relationship),
    );
  if (visibleEdges.length > 2000) truncated = true;
  return {
    nodes: [...visited].map((id) => {
      const note = byId.get(id)!;
      return {
        id,
        path: note.path,
        title:
          (typeof note.metadata?.title === "string" &&
            note.metadata.title.trim()) ||
          // A container-named note (`…/opencivics/PROJECT`) is a node named by its folder, not "PROJECT".
          leafTitle(note.path, note.metadata) ||
          id,
        tags: note.tags ?? [],
      };
    }),
    edges: visibleEdges.slice(0, 2000),
    truncated,
  };
}
