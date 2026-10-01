import { CollabDoc } from "./CollabDoc";
import { getCapabilityToken } from "../config";
import { httpVaultClient } from "../parachute/HttpVaultClient";
import { navigateWikilink } from "../../../../packages/core/src/lib/wikilinkNavigation";
import { WikilinkChooser } from "../../../../packages/core/src/components/layout/WikilinkChooser";

/** Full-page share/collab route (/collab/:id) — just the document, Google-Docs
 *  style. Thin wrapper over the shared CollabDoc. */
export function CollabPage({ noteId }: { noteId: string }) {
  // Resolve only within the recipient’s accessible documents. Never turn an
  // unresolved path into a guessed ID; retain the capability on navigation.
  const navigate = (target: string) => {
    void navigateWikilink(httpVaultClient,target,note=>{
      const t = getCapabilityToken();
      const q = t ? `?t=${encodeURIComponent(t)}` : "";
      window.location.href = `/collab/${encodeURIComponent(note.id)}${q}`;
    });
  };
  return <><CollabDoc noteId={noteId} onWikilinkNavigate={navigate} /><WikilinkChooser /></>;
}
