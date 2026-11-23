import type { ReactNode } from "react";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { useNote } from "../../app/hooks/useParachute";
import { PropertyBar } from "./PropertyBar";

/**
 * The property bar for a surface that only knows a note id (the live
 * collaborative editor). Without a VaultClient (the public share route) it
 * renders `fallback` — the read-only details disclosure — unchanged.
 */
export function NotePropertyBar({ noteId, readOnly, fallback, detailsContent }: { noteId: string; readOnly?: boolean; fallback: ReactNode; detailsContent?: ReactNode }) {
  const client = useOptionalVaultClient();
  if (!client) return <>{fallback}</>;
  return <Loaded noteId={noteId} readOnly={readOnly} fallback={fallback} detailsContent={detailsContent} />;
}

function Loaded({ noteId, readOnly, fallback, detailsContent }: { noteId: string; readOnly?: boolean; fallback: ReactNode; detailsContent?: ReactNode }) {
  const { data: note } = useNote(noteId);
  if (!note) return <>{fallback}</>;
  return <PropertyBar note={note} readOnly={readOnly} trailing={detailsContent ? undefined : fallback} detailsContent={detailsContent} />;
}
