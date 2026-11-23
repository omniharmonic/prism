import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAgentChatStore } from "@prism/core/shell";
import { CollabDoc } from "./CollabDoc";
import { apiBase, contextHeaders, getCapabilityToken } from "../config";
import { httpVaultClient } from "../parachute/HttpVaultClient";
import { navigateWikilink } from "../../../../packages/core/src/lib/wikilinkNavigation";
import { WikilinkChooser } from "../../../../packages/core/src/components/layout/WikilinkChooser";
import { setSharePageHref } from "../../../../packages/core/src/lib/tiptap/prismLinks";

/** Where a page link opens for a share-link viewer: this route for the target, with the SAME link.
 *  Signed-in people (no token) keep `/page/<id>`. The token goes nowhere but our own `/collab/` URL. */
const sharePageHref = (id: string): string | null => {
  const t = getCapabilityToken();
  return t ? `${location.origin}/collab/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}` : null;
};

/** Full-page share/collab route (/collab/:id) — just the document, Google-Docs
 *  style. Thin wrapper over the shared CollabDoc. */
export function CollabPage({ noteId }: { noteId: string }) {
  const audience = useAgentChatStore(state => state.scope);
  const context = JSON.stringify([apiBase(), contextHeaders(), getCapabilityToken(), audience]);
  return <ScopedCollabPage key={JSON.stringify([context, noteId])} noteId={noteId} />;
}

function ScopedCollabPage({ noteId }: { noteId: string }) {
  const [queries] = useState(() => new QueryClient());
  const [canonicalId, setCanonicalId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false);
    // REST may resolve a path/title alias; the collaboration socket only accepts
    // the real ID returned by a fresh, authorized read. Never open a guessed room.
    void httpVaultClient.getNote(noteId, { fresh: true }).then(note => {
      if (!current) return;
      if (typeof note.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(note.id)) throw new Error("Invalid document identity");
      setCanonicalId(note.id);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; queries.clear(); };
  }, [noteId, retry, queries]);
  useEffect(() => setSharePageHref(sharePageHref), []);
  // Resolve only within the recipient’s accessible documents. Never turn an
  // unresolved path into a guessed ID; retain the capability on navigation.
  const navigate = (target: string) => {
    void navigateWikilink(httpVaultClient,target,note=>{
      const t = getCapabilityToken();
      const q = t ? `?t=${encodeURIComponent(t)}` : "";
      window.location.href = `/collab/${encodeURIComponent(note.id)}${q}`;
    });
  };
  return <QueryClientProvider client={queries}>
    {canonicalId ? <><CollabDoc noteId={canonicalId} onWikilinkNavigate={navigate} /><WikilinkChooser /></>
      : failed ? <div role="alert" className="p-6 text-sm"><p>This shared document could not be opened. Check your access or try again.</p><button className="focus-ring mt-3 min-h-control rounded-lg border border-[var(--glass-border)] px-4" onClick={() => setRetry(value => value + 1)}>Try again</button></div>
        : <p role="status" className="p-6 text-sm">Opening shared document…</p>}
  </QueryClientProvider>;
}
