import { CollabDoc } from "./CollabDoc";
import { getCapabilityToken } from "../config";

/** Full-page share/collab route (/collab/:id) — just the document, Google-Docs
 *  style. Thin wrapper over the shared CollabDoc. */
export function CollabPage({ noteId }: { noteId: string }) {
  // Recipients can click between linked documents: route to the target's own
  // page, carrying the same capability token. The gateway enforces access — if
  // this link doesn't grant the target, CollabDoc shows a "Request access" page.
  const navigate = (target: string) => {
    const id = target.replace(/^vault\//, "");
    const t = getCapabilityToken();
    const q = t ? `?t=${encodeURIComponent(t)}` : "";
    window.location.href = `/collab/${encodeURIComponent(id)}${q}`;
  };
  return <CollabDoc noteId={noteId} onWikilinkNavigate={navigate} />;
}
