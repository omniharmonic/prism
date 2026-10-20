import { useMemo } from "react";
import { type Note, useVaultTree } from "@prism/core/shell";

/**
 * The pages a live document's `[[` and `@` suggestions choose from: the sidebar tree,
 * which is already in memory (never the full vault list with every body — NP-PF-01/09).
 * A tree row carries the page's path, tags, type, icon, and its `title` + `aliases`, so a
 * page is found by its title or an alias as well as by its path name.
 */
export function useLinkNotes(): Note[] {
  const { data: tree } = useVaultTree();
  return useMemo<Note[]>(
    () => (tree ?? []).map((n) => ({ id: n.id, path: n.path, tags: n.tags, metadata: n.metadata, content: "", createdAt: "", updatedAt: n.updatedAt ?? null })),
    [tree],
  );
}
