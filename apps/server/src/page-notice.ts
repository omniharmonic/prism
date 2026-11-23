/**
 * Tell the OPEN live documents of pages whose NAME changed — the path (a move, a rename) or the
 * stored title (`metadata.title`) — that they should look again: each socket then re-reads the
 * page with its own access. The message (`prism:page-changed`) carries nothing, so nothing a
 * reader could not read anyway travels with it (NP-PG-03). Best effort, never awaited by a write.
 */
export async function tellPagesChanged(vaultId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const collab = await import("./collab");
    if (!collab.hocuspocus.documents.size) return;
    const message = JSON.stringify({ type: "prism:page-changed" });
    for (const id of ids) collab.hocuspocus.documents.get(collab.docNameFor(vaultId, id))?.broadcastStateless(message);
  } catch {
    /* collab unavailable (tests, offline) — the title follows at the next read */
  }
}

/** Does this JSON write body set (or clear) a note's stored title? Linear; a parse failure is "no". */
export function writesTitle(body: unknown): boolean {
  if (typeof body === "string") {
    if (!body.includes('"title"')) return false;
    try { body = JSON.parse(body); } catch { return false; }
  }
  const metadata = (body as { metadata?: unknown } | null)?.metadata;
  return !!metadata && typeof metadata === "object" && Object.prototype.hasOwnProperty.call(metadata, "title");
}
