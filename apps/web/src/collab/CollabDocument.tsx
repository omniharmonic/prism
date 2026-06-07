import { useEffect, useState } from "react";
import type { Note } from "@prism/core";
import { GATEWAY_ORIGIN } from "../config";
import { CollabDoc } from "./CollabDoc";

/**
 * In-app live collaborative editor for a shared note (the CollabDocument seam
 * impl). The owner's main app renders this instead of the plain autosave editor
 * when a note has collaborators, so edits sync in real time without a refresh.
 */
export function CollabDocument({ noteId }: { noteId: string; note: Note }) {
  return <CollabDoc noteId={noteId} embedded />;
}

/**
 * Is this note shared (has people/links/tag-grants)? Owner-only `/acl` check;
 * returns false for non-owners (403) and empty ids, so only shared notes the
 * owner can see get the live editor.
 */
export function useIsShared(noteId: string): boolean {
  const [shared, setShared] = useState(false);
  useEffect(() => {
    setShared(false);
    if (!noteId) return;
    let cancelled = false;
    const check = () => {
      fetch(`${GATEWAY_ORIGIN}/acl/notes/${encodeURIComponent(noteId)}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((a) => {
          if (cancelled || !a) return;
          const count = (a.people?.length ?? 0) + (a.links?.length ?? 0) + (a.tagAccess?.length ?? 0);
          setShared(count > 0);
        })
        .catch(() => {});
    };
    check();
    // Re-check when sharing changes for this note (share dialog) or on refocus,
    // so sharing a currently-open note flips it to the live editor immediately.
    const onAcl = (e: Event) => {
      const id = (e as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (!id || id === noteId) check();
    };
    const onFocus = () => check();
    window.addEventListener("prism:acl-changed", onAcl);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("prism:acl-changed", onAcl);
      window.removeEventListener("focus", onFocus);
    };
  }, [noteId]);
  return shared;
}
