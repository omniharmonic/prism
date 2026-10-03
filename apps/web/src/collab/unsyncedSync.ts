/**
 * Push one unsynced live document's local state to the server (the Yjs half of
 * `unsynced.ts`, loaded only when a document is waiting).
 */
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { COLLAB_SCHEMA_VERSION } from "@prism/core/shell";
import type { WriteScope } from "../offline/writeScope";
import { persistLocalDocument, localDocumentKey } from "./localDocument";
import { collabWsUrl, collabToken, serverFetch } from "../transport";
import { getCapabilityToken } from "../config";
import { markUnsynced, clearUnsynced, type UnsyncedDoc } from "./unsynced";

/** Push one document's local state to the server through a headless provider. */
export async function syncOne(scope: WriteScope, headers: Record<string, string>, entry: UnsyncedDoc): Promise<"synced" | "kept"> {
  // Fresh authorization first, exactly like opening the document.
  const response = await serverFetch(`${scope.api}/notes/${encodeURIComponent(entry.noteId)}`, { headers, cache: "no-store" });
  if ([401, 403, 404, 410].includes(response.status)) { markUnsynced(scope, entry.name, entry.noteId, "denied"); return "kept"; }
  if (!response.ok) return "kept";
  const level = ((await response.json()) as { _level?: string })._level ?? "own";
  // Below edit the server accepts no raw updates (suggest-only enforcement): keep the local state for the user.
  if (level !== "own" && level !== "edit") { markUnsynced(scope, entry.name, entry.noteId, "read-only"); return "kept"; }
  const doc = new Y.Doc();
  let persistence: Awaited<ReturnType<typeof persistLocalDocument>> | undefined;
  let provider: HocuspocusProvider | undefined;
  try {
    persistence = await persistLocalDocument(localDocumentKey(scope, entry.name), doc, () => {});
    const outcome = await new Promise<"synced" | "kept" | UnsyncedDoc["blocked"]>((resolve) => {
      const timer = window.setTimeout(() => resolve("kept"), 20_000);
      const done = (value: "synced" | "kept" | UnsyncedDoc["blocked"]) => { window.clearTimeout(timer); resolve(value); };
      provider = new HocuspocusProvider({
        url: `${collabWsUrl()}?schema=${COLLAB_SCHEMA_VERSION}`, name: entry.name, token: collabToken(getCapabilityToken()), document: doc,
        onAuthenticationFailed: ({ reason }) => done(reason?.startsWith("update_required") ? "update-required" : "denied"),
        onSynced: () => {
          if (provider?.authorizedScope === "readonly") { done("read-only"); return; }
          // The server has our state once nothing is left unacknowledged.
          const settle = () => { if ((provider?.unsyncedChanges ?? 0) === 0) done("synced"); };
          provider?.on("unsyncedChanges", settle);
          settle();
        },
      });
    });
    if (outcome === "synced") { clearUnsynced(scope, entry.name); return "synced"; }
    if (outcome && outcome !== "kept") markUnsynced(scope, entry.name, entry.noteId, outcome);
    return "kept";
  } catch {
    return "kept";
  } finally {
    provider?.destroy();
    await persistence?.flush().catch(() => undefined);
    persistence?.close();
    doc.destroy();
  }
}

