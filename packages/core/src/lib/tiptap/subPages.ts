import type { QueryClient } from "@tanstack/react-query";
import type { VaultClient } from "../../data/VaultClient";
import type { NoteTreeEntry } from "../types";
import { newContentParams } from "../../components/navigation/newContent";
import { isTrashed } from "../pages/model";
import { noteLinkTitle } from "../wikilinks";

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
/** Thrown when a sub-page cannot be created right now; `message` is fit to show. */
export class SubPageError extends Error {}
export const SUB_PAGE_OFFLINE = "Creating a page here needs a connection. Nothing was added.";

export async function createSubPage(client: VaultClient, queryClient: QueryClient | null, parentPath: string, title = ""): Promise<string | null> {
  // A page created offline only has a temporary `offline-…` id until it syncs; a document
  // must never store one (it would point at nothing for everyone else). Refuse up front…
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new SubPageError(SUB_PAGE_OFFLINE);
  const cached = queryClient?.getQueryData<NoteTreeEntry[]>(["vault", "tree"]);
  const tree = cached ?? (await client.listTree().catch(() => [] as NoteTreeEntry[]));
  const { params } = newContentParams("document", title, parentPath, tree);
  const note = await client.createNote(params);
  void queryClient?.invalidateQueries({ queryKey: ["vault"] });
  // …and again on the answer: the outbox may have queued the create (server unreachable).
  if (!note?.id || note.id.startsWith("offline-")) throw new SubPageError(SUB_PAGE_OFFLINE);
  return note.id;
}

/** The page behind a sub-page row, read with the caller's own access (null = cannot view / gone / trashed). */
export function describeSubPage(client: () => VaultClient | null) {
  return async (pageId: string): Promise<{ title: string; path: string | null } | null> => {
    const c = client();
    if (!c) return null;
    try {
      const note = await c.getNote(pageId);
      if (!note || note.id !== pageId || isTrashed(note)) return null;
      return { title: noteLinkTitle(note), path: note.path ?? null };
    } catch {
      return null;
    }
  };
}
