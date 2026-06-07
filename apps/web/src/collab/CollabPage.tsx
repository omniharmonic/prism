import { CollabDoc } from "./CollabDoc";

/** Full-page share/collab route (/collab/:id) — just the document, Google-Docs
 *  style. Thin wrapper over the shared CollabDoc. */
export function CollabPage({ noteId }: { noteId: string }) {
  return <CollabDoc noteId={noteId} />;
}
