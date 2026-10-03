import type { ReactNode } from "react";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { useNote } from "../../app/hooks/useParachute";
import { PropertyBar } from "./PropertyBar";

/**
 * The property bar for a surface that only knows a note id (the live
 * collaborative editor). Without a VaultClient (the public share route) it
 * renders `fallback` — the read-only details disclosure — unchanged.
 */
export function NotePropertyBar({ noteId, readOnly, fallback }: { noteId: string; readOnly?: boolean; fallback: ReactNode }) {
  const client = useOptionalVaultClient();
  if (!client) return <>{fallback}</>;
  return <Loaded noteId={noteId} readOnly={readOnly} fallback={fallback} />;
}

function Loaded({ noteId, readOnly, fallback }: { noteId: string; readOnly?: boolean; fallback: ReactNode }) {
  const { data: note } = useNote(noteId);
  if (!note) return <>{fallback}</>;
  return <PropertyBar note={note} readOnly={readOnly} trailing={fallback} />;
}
