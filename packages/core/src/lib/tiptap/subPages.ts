import type { QueryClient } from "@tanstack/react-query";
import type { VaultClient } from "../../data/VaultClient";
import type { NoteTreeEntry } from "../types";
import { newContentParams } from "../../components/navigation/newContent";

/** A title typed into the editor, made safe as ONE path segment (null = unusable). */
export function pageNameFromQuery(query: string): string | null {
  const name = query.replace(/[\u0000-\u001f\\/[\]|#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return name && name !== "." && name !== ".." ? name : null;
}

/**
 * Create a page INSIDE the page at `parentPath` (NP-PG-15 `/page`, NP-RF-01
 * "Create page"). The name is made unique among the pages the caller can see;
 * the gateway still decides whether the caller may create there (a taken path
 * is refused, never overwritten). Returns the new page's id.
 */
export async function createSubPage(client: VaultClient, queryClient: QueryClient | null, parentPath: string, title = ""): Promise<string | null> {
  const cached = queryClient?.getQueryData<NoteTreeEntry[]>(["vault", "tree"]);
  const tree = cached ?? (await client.listTree().catch(() => [] as NoteTreeEntry[]));
  const { params } = newContentParams("document", title, parentPath, tree);
  const note = await client.createNote(params);
  void queryClient?.invalidateQueries({ queryKey: ["vault"] });
  return note?.id ?? null;
}
